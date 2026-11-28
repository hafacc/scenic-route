//! `tiler build`: every pass of a tile build in one process, each stamped, driven by a plan file.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::dem::{Dem, MosaicTiles};
use crate::manifest::{Bounds, City, Manifest};
use crate::{
    Fallible, canopy, caster_chunks, chunks, commercial, elevation, genus_field, graph,
    graph_cache, heights, raster, shade,
};

/// The by-convention sources, `data/<kind>/<id>.bin`, kept out of the versioned manifest schema.
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Source {
    Sidewalks,
    Ferries,
    Transit,
    Landmarks,
    Art,
    Highways,
    Industrial,
    Historic,
    Buildings,
}

impl Source {
    /// Every variant, so `key_space_files` must decide about each one by name.
    const ALL: [Source; 9] = [
        Source::Sidewalks,
        Source::Ferries,
        Source::Transit,
        Source::Landmarks,
        Source::Art,
        Source::Highways,
        Source::Industrial,
        Source::Historic,
        Source::Buildings,
    ];

    fn directory(self) -> &'static str {
        match self {
            Source::Sidewalks => "sidewalks",
            Source::Ferries => "ferries",
            Source::Transit => "transit",
            Source::Landmarks => "landmarks",
            Source::Art => "art",
            Source::Highways => "highways",
            Source::Industrial => "industrial",
            Source::Historic => "historic",
            Source::Buildings => "buildings",
        }
    }
}

const SRC: &str = "crates/tiler/src";

/// The shade pyramid's modules: the transitive closure of shade.rs's imports and nothing wider.
const SHADE_CODE: [&str; 6] = [
    "shade.rs",
    "crown.rs",
    "raster.rs",
    "geometry.rs",
    "binfmt.rs",
    "manifest.rs",
];

/// The graph topology's modules: the transitive closure of graph.rs's imports; keys the base.
const GRAPH_CODE: [&str; 24] = [
    "graph.rs",
    "association.rs",
    "binfmt.rs",
    "bridge.rs",
    "canopy_runs.rs",
    "conflate.rs",
    "corners.rs",
    "cover_tiles.rs",
    "crown.rs",
    "dem.rs",
    "direct_canopy.rs",
    "geometry.rs",
    "graph_cache.rs",
    "heights.rs",
    "historic.rs",
    "industrial.rs",
    "invariants.rs",
    "manifest.rs",
    "raster.rs",
    "relief.rs",
    "sampling.rs",
    "scenic.rs",
    "shade.rs",
    "sidewalks.rs",
];

/// The relief column's modules: the DEM resample and the ascent/descent bytes read off it.
const RELIEF_CODE: [&str; 7] = [
    "relief.rs",
    "dem.rs",
    "binfmt.rs",
    "geometry.rs",
    "heights.rs",
    "manifest.rs",
    "raster.rs",
];

/// The street chunks' modules, for both cuts: the transitive closure of chunks.rs's imports.
const CHUNKS_CODE: [&str; 6] = [
    "chunks.rs",
    "binfmt.rs",
    "geometry.rs",
    "manifest.rs",
    "raster.rs",
    "sidewalks.rs",
];

/// The commercial signals' modules; chunks.rs is in it for the `Chunks` handle the pass reads.
const COMMERCIAL_CODE: [&str; 7] = [
    "commercial.rs",
    "binfmt.rs",
    "chunks.rs",
    "geometry.rs",
    "manifest.rs",
    "raster.rs",
    "sidewalks.rs",
];

/// The caster chunks' modules: they cut with shade.rs's halo and crown.rs's crowns.
const CASTERS_CODE: [&str; 7] = [
    "caster_chunks.rs",
    "binfmt.rs",
    "crown.rs",
    "geometry.rs",
    "manifest.rs",
    "raster.rs",
    "shade.rs",
];

/// The elevation pyramid's modules: the DEM resample, including the projections it opens with.
const ELEVATION_CODE: [&str; 7] = [
    "elevation.rs",
    "binfmt.rs",
    "dem.rs",
    "geometry.rs",
    "heights.rs",
    "manifest.rs",
    "raster.rs",
];

/// The canopy pyramid's modules: the transitive closure of canopy.rs's imports.
const CANOPY_CODE: [&str; 5] = [
    "canopy.rs",
    "binfmt.rs",
    "geometry.rs",
    "manifest.rs",
    "raster.rs",
];

/// The genus field's modules: the transitive closure of genus_field.rs's imports.
const GENUS_FIELD_CODE: [&str; 5] = [
    "genus_field.rs",
    "binfmt.rs",
    "geometry.rs",
    "manifest.rs",
    "raster.rs",
];

/// Modules no stamp hashes: this driver and the crate root, whose values reach stamps directly, and ingest/ndsm.
// The driver's path plumbing is still unstamped: after editing where a pass reads or writes, use --force.
#[cfg(test)]
const UNSTAMPED: [&str; 5] = [
    "build.rs",
    "densities.rs",
    "ingest.rs",
    "main.rs",
    "ndsm.rs",
];

/// Every scope a stamp names with how many leading modules its pass calls into, for the closure tests.
#[cfg(test)]
const SCOPES: [(&[&str], usize); 9] = [
    (&SHADE_CODE, 1),
    (&GRAPH_CODE, 1),
    (&RELIEF_CODE, 2),
    (&CHUNKS_CODE, 1),
    (&COMMERCIAL_CODE, 1),
    (&CASTERS_CODE, 1),
    (&ELEVATION_CODE, 1),
    (&CANOPY_CODE, 1),
    (&GENUS_FIELD_CODE, 1),
];

/// Crate-root items a scope may name; each sets only speed or reporting, never a pass's output.
#[cfg(test)]
const OUTPUT_NEUTRAL_ROOT_ITEMS: [&str; 5] =
    ["Fallible", "gib", "peak_rss", "trim_heap", "write_report"];

/// `tiler key-probe`'s mode, which a build never runs; stamped so a flip reruns the graph.
const GRAPH_PROBE: bool = false;
/// Where the graph pass writes its stats line; a build writes none, and a change reruns it.
const GRAPH_REPORT: Option<&str> = None;

/// The DEM resample bounds the graph pass gets: the city's, when it has terrain.
fn graph_elevation_bounds(city: &City, planned: &PlanCity) -> Option<crate::manifest::Bounds> {
    (!planned.elevation.is_empty()).then_some(city.bounds)
}

/// Where the graph pass writes where a city's edges are under canopy, beside the graph it keys to.
fn canopy_runs_file(plan: &Plan, city: &City) -> PathBuf {
    plan.routing.join(format!("{}.canopy.bin", city.id))
}

/// Where the graph pass writes the same cover as a low-zoom pyramid, beside the other per-city ones.
fn cover_tiles_dir(plan: &Plan, city: &City) -> PathBuf {
    plan.tiles.join("tree-cover").join(&city.id)
}

/// One city's graph pass: what it clears before it reruns, and what must be there for its stamp to hold.
fn graph_pass(plan: &Plan, city: &City, stamp: String, bake: Option<&PathBuf>) -> Pass {
    let blob = plan.routing.join(format!("{}.bin", city.id));
    let stranded = plan.routing.join(format!("{}.stranded.bin", city.id));
    let canopy_runs = canopy_runs_file(plan, city);
    let cover_tiles = cover_tiles_dir(plan, city);
    Pass {
        stamp,
        stamp_file: plan.routing.join(format!(".stamp-{}", city.id)),
        share: None,
        pieces: vec![
            blob.clone(),
            plan.routing.join(format!("{}.version.json", city.id)),
            stranded.clone(),
            canopy_runs.clone(),
            cover_tiles.clone(),
            plan.routing.join("shade").join(&city.id),
        ],
        // The runs and their pyramid only where a canopy is measured: elsewhere the pass writes neither.
        witnesses: [blob, stranded]
            .into_iter()
            .chain(
                city.field
                    .canopy
                    .iter()
                    .flat_map(|_| [canopy_runs.clone(), cover_tiles.clone()]),
            )
            .chain(bake.cloned())
            .collect(),
    }
}

/// The land mask the graph pass reads for the bridge column; every city carries one.
fn graph_land(data: &Path, city: &City) -> Option<PathBuf> {
    Some(data.join("land").join(&city.field.land.file))
}

/// Build inputs in every scope: a dependency, feature flag or compiler bump can move the output.
const BUILD_FILES: [&str; 4] = [
    "Cargo.toml",
    "Cargo.lock",
    "crates/tiler/Cargo.toml",
    "rust-toolchain.toml",
];

/// One DEM mosaic; the projection is named because a GeoTIFF carries only an EPSG code.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Elevation {
    crs: String,
    #[serde(default)]
    band: usize,
    tiles: Vec<PathBuf>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanCity {
    id: String,
    /// Whether this city's centerline classifies alleys; defaults to true, New York's meaning.
    #[serde(default = "classifies_alleys")]
    alleys: bool,
    /// The existence gate's ceilings; absent means `graph::SURVEYED_CEILINGS`.
    #[serde(default)]
    existence_ceilings: Option<graph::ExistenceCeilings>,
    #[serde(default)]
    sources: Vec<Source>,
    #[serde(default)]
    shade: Option<shade::Params>,
    /// Empty for a city with no elevation product, whose edges are then flat.
    #[serde(default)]
    elevation: Vec<Elevation>,
}

fn classifies_alleys() -> bool {
    true
}

impl PlanCity {
    fn source(&self, data: &Path, kind: Source) -> Option<PathBuf> {
        self.sources
            .contains(&kind)
            .then(|| data.join(kind.directory()).join(format!("{}.bin", self.id)))
    }
}

/// One module hashed by its token stream, ignoring comments, whitespace and `#[cfg(test)]` items;
/// `None` if unlexable.
fn token_oid(path: &Path) -> Option<String> {
    let source = fs::read_to_string(path).ok()?;
    let stream = proc_macro2::TokenStream::from_str(&source).ok()?;
    let mut digest = Sha256::new();
    field(
        &mut digest,
        without_test_items(stream).to_string().as_bytes(),
    );
    Some(hex(&digest.finalize()))
}

/// Whether an attribute's bracketed body is exactly `cfg(test)`.
fn is_cfg_test(body: &proc_macro2::Group) -> bool {
    let tokens: Vec<proc_macro2::TokenTree> = body.stream().into_iter().collect();
    match tokens.as_slice() {
        [
            proc_macro2::TokenTree::Ident(name),
            proc_macro2::TokenTree::Group(arguments),
        ] => {
            name == "cfg"
                && arguments.delimiter() == proc_macro2::Delimiter::Parenthesis
                && arguments.stream().to_string() == "test"
        }
        _ => false,
    }
}

/// The stream with every `#[cfg(test)]` item dropped, at any depth, attributes and all.
fn without_test_items(stream: proc_macro2::TokenStream) -> proc_macro2::TokenStream {
    use proc_macro2::{Delimiter, Group, TokenTree};
    let tokens: Vec<TokenTree> = stream.into_iter().collect();
    let mut kept: Vec<TokenTree> = Vec::with_capacity(tokens.len());
    // An item's outer attributes, held until the item shows whether one of them is cfg(test).
    let mut attributes: Vec<TokenTree> = Vec::new();
    let mut test_item = false;
    let mut index = 0;
    while index < tokens.len() {
        if let (TokenTree::Punct(pound), Some(TokenTree::Group(body))) =
            (&tokens[index], tokens.get(index + 1))
            && pound.as_char() == '#'
            && body.delimiter() == Delimiter::Bracket
        {
            test_item |= is_cfg_test(body);
            attributes.push(tokens[index].clone());
            attributes.push(tokens[index + 1].clone());
            index += 2;
            continue;
        }
        if test_item {
            // Stops at the first brace group, semicolon or comma, none of which can come after the
            // item's end, so a misread only ever hashes more than it must.
            while index < tokens.len() {
                let token = &tokens[index];
                index += 1;
                match token {
                    TokenTree::Punct(punct) if matches!(punct.as_char(), ';' | ',') => break,
                    TokenTree::Group(group) if group.delimiter() == Delimiter::Brace => {
                        if let Some(TokenTree::Punct(punct)) = tokens.get(index)
                            && punct.as_char() == ';'
                        {
                            index += 1;
                        }
                        break;
                    }
                    _ => (),
                }
            }
            attributes.clear();
            test_item = false;
            continue;
        }
        kept.append(&mut attributes);
        kept.push(match &tokens[index] {
            TokenTree::Group(group) => {
                let mut inner = Group::new(group.delimiter(), without_test_items(group.stream()));
                inner.set_span(group.span());
                TokenTree::Group(inner)
            }
            other => other.clone(),
        });
        index += 1;
    }
    kept.extend(attributes);
    kept.into_iter().collect()
}

/// The whole build; unknown fields are rejected so a misspelled directory fails loudly.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    /// The tiler crate's files by repo-relative path, per file so a pass can scope to its modules.
    code: BTreeMap<String, String>,
    manifest: PathBuf,
    data: PathBuf,
    chunks: PathBuf,
    casters: PathBuf,
    commercial_signals: PathBuf,
    commercial_lines: PathBuf,
    tiles: PathBuf,
    canopy_tiles: PathBuf,
    genus_field_tiles: PathBuf,
    routing: PathBuf,
    /// `.build/graph-cache`: the graph pass's content-keyed entries, safe to delete.
    graph_cache: PathBuf,
    cities: Vec<PlanCity>,
}

impl Plan {
    /// Each manifest city beside its plan entry in manifest order; a city on one side only errors.
    fn pair<'a>(&'a self, manifest: &'a Manifest) -> Fallible<Vec<(&'a City, &'a PlanCity)>> {
        let mut seen: HashSet<&str> = HashSet::new();
        for city in &self.cities {
            if !seen.insert(city.id.as_str()) {
                return Err(format!("the plan names {} twice", city.id).into());
            }
            if !manifest.cities.iter().any(|entry| entry.id == city.id) {
                return Err(
                    format!("the plan names {}, which the manifest does not", city.id).into(),
                );
            }
        }
        manifest
            .cities
            .iter()
            .map(|city| {
                let planned = self
                    .cities
                    .iter()
                    .find(|entry| entry.id == city.id)
                    .ok_or_else(|| format!("the plan has no entry for {}", city.id))?;
                Ok((city, planned))
            })
            .collect()
    }

    /// Rehashes `.rs` entries over their tokens; sound only without `line!`/`file!`/`include_*!`.
    fn hash_source_tokens(&mut self) {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let prefix = format!("{SRC}/");
        for (path, oid) in &mut self.code {
            let Some(module) = path.strip_prefix(&prefix).filter(|m| m.ends_with(".rs")) else {
                continue;
            };
            if let Some(hashed) = token_oid(&src.join(module)) {
                *oid = hashed;
            }
        }
    }

    /// One pass's scope as a hash; a named module the plan doesn't carry is an error.
    fn code_scope(&self, modules: &[&str]) -> Fallible<String> {
        let mut named: Vec<String> = modules
            .iter()
            .map(|module| format!("{SRC}/{module}"))
            .chain(BUILD_FILES.iter().map(|file| (*file).to_owned()))
            .collect();
        named.sort();
        let mut digest = Sha256::new();
        for path in named {
            let oid = self
                .code
                .get(&path)
                .ok_or_else(|| format!("the plan carries no hash for {path}"))?;
            field(&mut digest, path.as_bytes());
            field(&mut digest, oid.as_bytes());
        }
        Ok(hex(&digest.finalize()))
    }

    const PYRAMIDS: [&'static str; 4] = ["shade", "tree-shade", "elevation", "tree-cover"];

    /// Removes output no pass claims, such as a dropped city's; unknown names are left alone.
    fn reconcile(&self, manifest: &Manifest) -> Fallible<()> {
        let claimed: HashSet<&str> = manifest
            .cities
            .iter()
            .map(|city| city.id.as_str())
            .collect();
        for pyramid in Self::PYRAMIDS {
            for entry in listing(&self.tiles.join(pyramid))? {
                if !claimed.contains(city_of(&entry).as_str()) {
                    discard(&entry)?;
                }
            }
        }
        for entry in listing(&self.routing.join("shade"))? {
            if !claimed.contains(city_of(&entry).as_str()) {
                discard(&entry)?;
            }
        }
        for entry in listing(&self.graph_cache)? {
            if !claimed.contains(city_of(&entry).as_str()) {
                discard(&entry)?;
            }
        }
        for entry in listing(&self.routing)? {
            let name = file_name(&entry);
            // <id>.bin, <id>.{stranded,canopy}.bin, <id>.version.json, .stamp-<id>; shade is swept above.
            let named = name
                .strip_prefix(".stamp-")
                .map(str::to_owned)
                .or_else(|| name.ends_with(".bin").then(|| city_of(&entry)))
                .or_else(|| name.ends_with(".version.json").then(|| city_of(&entry)));
            if let Some(city) = named
                && !claimed.contains(city.as_str())
            {
                discard(&entry)?;
            }
        }
        let ids: Vec<&str> = claimed.iter().copied().collect();
        for (root, exempt) in self.shared_roots() {
            discard(&root.join(STAMP))?;
            for entry in listing(root)? {
                let name = file_name(&entry);
                let named = name
                    .strip_prefix(STRANDED_STAMP)
                    .or_else(|| name.strip_prefix(CITY_STAMP))
                    .or_else(|| name.strip_prefix(LEDGER));
                if let Some(city) = named
                    && !claimed.contains(city)
                {
                    discard(&entry)?;
                }
            }
            // Also the migration from one stamp per directory: no ledger yet, so every city reruns.
            for path in unclaimed(root, &ids, exempt)? {
                discard(&root.join(path))?;
            }
            prune(root)?;
        }
        discard(&self.chunks.join(".stamp-stranded"))?;
        for entry in listing(&self.commercial_lines)? {
            if !claimed.contains(city_of(&entry).as_str()) {
                discard(&entry)?;
            }
        }
        Ok(())
    }

    /// The directories every city writes into, each with the root-level names no city claims.
    fn shared_roots(&self) -> [(&Path, &'static [&'static str]); 5] {
        [
            (&self.chunks, &[]),
            (&self.commercial_signals, &[]),
            (&self.casters, CASTER_EXEMPT),
            (&self.canopy_tiles, &[]),
            (&self.genus_field_tiles, &[]),
        ]
    }
}

const STAMP: &str = ".stamp";
/// A city's stamp in a directory the cities share: `.stamp-<city>`.
const CITY_STAMP: &str = ".stamp-";
/// A city's ledger of the files it wrote into a shared directory: `.files-<city>`.
const LEDGER: &str = ".files-";
/// The re-chunk's per-city stamp inside the chunk directory: `.stamp-stranded-<city>`.
const STRANDED_STAMP: &str = ".stamp-stranded-";
/// Root-level names in the caster directory that no city claims: the index every city shares.
const CASTER_EXEMPT: &[&str] = &["manifest.json"];

/// One pass's freshness; the stamp lives inside its output, so a cache restore carries it.
struct Pass {
    stamp: String,
    /// Written only after the pass succeeds, so a killed run leaves no claim.
    stamp_file: PathBuf,
    /// A city's share of a directory other cities write into too.
    share: Option<Share>,
    /// A per-city piece, removed and not recreated: absence means "no such layer here".
    pieces: Vec<PathBuf>,
    /// Paths that must exist for the stamp to be believed; existence only, not completeness.
    witnesses: Vec<PathBuf>,
}

/// A city's files inside a directory every city writes into, told apart by per-city ledgers.
struct Share {
    /// The directory every city writes into.
    root: PathBuf,
    /// The city whose files these are.
    city: String,
    /// Every other manifest city, whose ledgers this city's clear must respect.
    others: Vec<String>,
    /// Root-level names no city claims.
    exempt: &'static [&'static str],
}

impl Share {
    /// `city`'s share of `root`, among `ids`, every manifest city.
    fn new(root: &Path, city: &str, ids: &[&str], exempt: &'static [&'static str]) -> Share {
        Share {
            root: root.to_path_buf(),
            city: city.to_owned(),
            others: ids
                .iter()
                .filter(|id| **id != city)
                .map(|id| (*id).to_owned())
                .collect(),
            exempt,
        }
    }

    /// What no other city's ledger claims, which after this city's run is exactly its own.
    fn unclaimed(&self) -> Fallible<Vec<String>> {
        let others: Vec<&str> = self.others.iter().map(String::as_str).collect();
        unclaimed(&self.root, &others, self.exempt)
    }
}

impl Pass {
    /// A pass writing `share`, stamped beside its ledger, which is also its witness.
    fn shared(stamp: String, share: Share, pieces: Vec<PathBuf>) -> Pass {
        Pass {
            stamp,
            stamp_file: share.root.join(format!("{CITY_STAMP}{}", share.city)),
            witnesses: vec![ledger_file(&share.root, &share.city)],
            pieces,
            share: Some(share),
        }
    }

    fn is_fresh(&self) -> bool {
        let Ok(recorded) = fs::read_to_string(&self.stamp_file) else {
            return false;
        };
        recorded.trim() == self.stamp && self.witnesses.iter().all(|path| path.exists())
    }

    /// Clears the output and creates the directory the stamp is written into.
    fn restart(&self) -> Fallible<()> {
        self.clear()?;
        if let Some(parent) = self.stamp_file.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(())
    }

    /// Clears the output without recording a stamp, also for a pass rendering nothing this build.
    fn clear(&self) -> Fallible<()> {
        if let Some(share) = &self.share {
            // The stamp goes first, so a clear killed halfway leaves no claim.
            discard(&self.stamp_file)?;
            discard(&ledger_file(&share.root, &share.city))?;
            for path in share.unclaimed()? {
                discard(&share.root.join(path))?;
            }
            prune(&share.root)?;
            fs::create_dir_all(&share.root)?;
        }
        for path in &self.pieces {
            discard(path)?;
        }
        Ok(())
    }

    fn record(&self) -> Fallible<()> {
        if let Some(parent) = self.stamp_file.parent() {
            fs::create_dir_all(parent)?;
        }
        if let Some(share) = &self.share {
            let ledger: String = share
                .unclaimed()?
                .iter()
                .map(|path| format!("{path}\n"))
                .collect();
            fs::write(ledger_file(&share.root, &share.city), ledger)?;
        }
        Ok(fs::write(&self.stamp_file, &self.stamp)?)
    }
}

/// `city`'s ledger inside `root`.
fn ledger_file(root: &Path, city: &str) -> PathBuf {
    root.join(format!("{LEDGER}{city}"))
}

/// The files a city's ledger lists, relative to `root`; a missing ledger claims nothing.
fn claims(root: &Path, city: &str) -> Fallible<Vec<String>> {
    match fs::read_to_string(ledger_file(root, city)) {
        Ok(ledger) => Ok(ledger.lines().map(str::to_owned).collect()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

/// Files under `root` no listed city's ledger claims, `/`-separated relative to `root`, sorted.
fn unclaimed(root: &Path, claimants: &[&str], exempt: &[&str]) -> Fallible<Vec<String>> {
    let mut claimed: HashSet<String> = HashSet::new();
    for city in claimants {
        claimed.extend(claims(root, city)?);
    }
    let mut pending: Vec<(PathBuf, String)> = Vec::new();
    for entry in listing(root)? {
        let name = file_name(&entry);
        if !name.starts_with('.') && !exempt.contains(&name.as_str()) {
            pending.push((entry, name));
        }
    }
    let mut found: Vec<String> = Vec::new();
    while let Some((path, relative)) = pending.pop() {
        if path.is_dir() {
            for entry in listing(&path)? {
                let name = format!("{relative}/{}", file_name(&entry));
                pending.push((entry, name));
            }
        } else if !claimed.contains(&relative) {
            found.push(relative);
        }
    }
    found.sort();
    Ok(found)
}

/// Removes every directory under `root` left empty, bottom-up, and never `root` itself.
fn prune(root: &Path) -> Fallible<()> {
    for entry in listing(root)? {
        if entry.is_dir() {
            prune(&entry)?;
            if listing(&entry)?.is_empty() {
                fs::remove_dir(&entry)?;
            }
        }
    }
    Ok(())
}

/// One city's shade pyramid; bucket directories are matched to buckets by content key, not index.
struct ShadePyramid {
    buildings: PathBuf,
    /// `<tiles>/tree-shade/<city>`, claimed by the same key since the same render writes it.
    trees: PathBuf,
    keys: Vec<String>,
}

/// A staging prefix inside the pyramid, so moves stay renames on one filesystem.
const MOVING: &str = ".moving-";

impl ShadePyramid {
    /// Removes both pyramids, not recreated: absence means "no shade layer here".
    fn clear(&self) -> Fallible<()> {
        discard(&self.buildings)?;
        discard(&self.trees)
    }

    fn bucket(root: &Path, index: usize) -> PathBuf {
        root.join(index.to_string())
    }

    /// The key a bucket directory records, or none if its render was killed before recording.
    fn key_of(directory: &Path) -> Fallible<Option<String>> {
        match fs::read_to_string(directory.join(STAMP)) {
            Ok(key) => Ok(Some(key.trim().to_owned())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Moves matched directories to their new indices, discards the rest, returns what to render.
    fn reconcile(&self) -> Fallible<Vec<shade::Render>> {
        let mut held: Vec<(usize, Option<String>)> = Vec::new();
        for entry in listing(&self.buildings)? {
            match file_name(&entry).parse::<usize>() {
                Ok(index) if entry.is_dir() => held.push((index, Self::key_of(&entry)?)),
                // Staging leftovers, old stamps, and buckets.json, which is rewritten afterwards.
                _ => discard(&entry)?,
            }
        }

        let mut by_key: HashMap<&str, usize> = HashMap::new();
        for (index, key) in &held {
            if let Some(key) = key {
                by_key.entry(key.as_str()).or_insert(*index);
            }
        }
        let mut claimed: HashSet<usize> = HashSet::new();
        let mut moves: Vec<(usize, usize)> = Vec::new();
        let mut render: Vec<shade::Render> = Vec::new();
        for (index, key) in self.keys.iter().enumerate() {
            // Taken rather than read, so two buckets with one key can't both claim one directory.
            match by_key.remove(key.as_str()) {
                Some(from) => {
                    claimed.insert(from);
                    if from != index {
                        moves.push((from, index));
                    }
                }
                None => render.push(shade::Render {
                    index,
                    stamp: Self::bucket(&self.buildings, index).join(STAMP),
                    key: key.clone(),
                }),
            }
        }

        for (index, _) in &held {
            if !claimed.contains(index) {
                discard(&Self::bucket(&self.buildings, *index))?;
            }
        }
        for entry in listing(&self.trees)? {
            let index = file_name(&entry).parse::<usize>();
            if !index.is_ok_and(|index| claimed.contains(&index)) {
                discard(&entry)?;
            }
        }
        for root in [&self.buildings, &self.trees] {
            shift(root, &moves)?;
        }
        Ok(render)
    }
}

/// Moves buckets via a staging name, since one bucket's new index is often another's old one.
fn shift(root: &Path, moves: &[(usize, usize)]) -> Fallible<()> {
    for (from, to) in moves {
        let source = ShadePyramid::bucket(root, *from);
        if source.is_dir() {
            fs::rename(&source, root.join(format!("{MOVING}{to}")))?;
        }
    }
    for (_, to) in moves {
        let staged = root.join(format!("{MOVING}{to}"));
        if staged.is_dir() {
            fs::rename(&staged, ShadePyramid::bucket(root, *to))?;
        }
    }
    Ok(())
}

fn absent(error: std::io::Error) -> std::io::Result<()> {
    if error.kind() == std::io::ErrorKind::NotFound {
        Ok(())
    } else {
        Err(error)
    }
}

fn discard(path: &Path) -> Fallible<()> {
    if path.is_dir() {
        fs::remove_dir_all(path).or_else(absent)?;
    } else {
        fs::remove_file(path).or_else(absent)?;
    }
    Ok(())
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

/// The city an output path belongs to: pyramids name a directory after it, routing prefixes files.
fn city_of(path: &Path) -> String {
    let name = file_name(path);
    name.split_once('.')
        .map_or(name.clone(), |(id, _)| id.to_owned())
}

fn listing(dir: &Path) -> Fallible<Vec<PathBuf>> {
    match fs::read_dir(dir) {
        Ok(entries) => {
            let mut paths: Vec<PathBuf> = entries
                .map(|entry| Ok(entry?.path()))
                .collect::<Fallible<Vec<PathBuf>>>()?;
            paths.sort();
            Ok(paths)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

/// One stamp field, NUL-terminated so abutting values can't collide.
fn field(digest: &mut Sha256, bytes: &[u8]) {
    digest.update(bytes);
    digest.update([0]);
}

/// A DEM's identity from its tiles' names, sizes and georeferencing, not its (immutable) pixels.
fn dem_identity(digest: &mut Sha256, elevation: &[Elevation]) -> Fallible<()> {
    if elevation.is_empty() {
        field(digest, b"no elevation");
        return Ok(());
    }
    field(digest, &elevation.len().to_le_bytes());
    for mosaic in elevation {
        field(digest, mosaic.crs.as_bytes());
        field(digest, &mosaic.band.to_le_bytes());
        field(digest, &mosaic.tiles.len().to_le_bytes());
        let mut tiles: Vec<(String, u64)> = mosaic
            .tiles
            .iter()
            .map(|tile| {
                let bytes = fs::metadata(tile)
                    .map_err(|error| format!("{}: {error}", tile.display()))?
                    .len();
                Ok((file_name(tile), bytes))
            })
            .collect::<Fallible<Vec<(String, u64)>>>()?;
        tiles.sort();
        for (name, bytes) in tiles {
            field(digest, name.as_bytes());
            field(digest, &bytes.to_le_bytes());
        }
    }
    Ok(())
}

/// Per-pass stamps: SHA-256 over code, the manifest entries read, plan values, input contents and
/// upstream stamps.
struct Stamps<'a> {
    plan: &'a Plan,
    shade_code: String,
    graph_code: String,
    relief_code: String,
    chunks_code: String,
    commercial_code: String,
    casters_code: String,
    elevation_code: String,
    canopy_code: String,
    genus_field_code: String,
    oids: HashMap<PathBuf, String>,
}

impl<'a> Stamps<'a> {
    fn new(plan: &'a Plan) -> Fallible<Stamps<'a>> {
        Ok(Stamps {
            shade_code: plan.code_scope(&SHADE_CODE)?,
            graph_code: plan.code_scope(&GRAPH_CODE)?,
            relief_code: plan.code_scope(&RELIEF_CODE)?,
            chunks_code: plan.code_scope(&CHUNKS_CODE)?,
            commercial_code: plan.code_scope(&COMMERCIAL_CODE)?,
            casters_code: plan.code_scope(&CASTERS_CODE)?,
            elevation_code: plan.code_scope(&ELEVATION_CODE)?,
            canopy_code: plan.code_scope(&CANOPY_CODE)?,
            genus_field_code: plan.code_scope(&GENUS_FIELD_CODE)?,
            plan,
            oids: HashMap::new(),
        })
    }

    /// A digest seeded with the pass and its code scope.
    fn scoped(&self, pass: &str, code: &str) -> Sha256 {
        let mut digest = Sha256::new();
        field(&mut digest, pass.as_bytes());
        field(&mut digest, code.as_bytes());
        digest
    }

    /// A digest seeded as `scoped`, then with each manifest entry the pass reads, as parsed, so an
    /// edit to one city's entry leaves every other city's passes standing.
    fn scoped_to<'c>(
        &self,
        pass: &str,
        code: &str,
        cities: impl IntoIterator<Item = &'c City>,
    ) -> Fallible<Sha256> {
        let mut digest = self.scoped(pass, code);
        for city in cities {
            field(&mut digest, &serde_json::to_vec(city)?);
        }
        Ok(digest)
    }

    /// One input: its data-relative path, then its content or absence, since appearing rebuilds.
    fn file(&mut self, digest: &mut Sha256, path: &Path) -> Fallible<()> {
        let name = path
            .strip_prefix(&self.plan.data)
            .map_err(|_| format!("{} is not under the plan's data root", path.display()))?;
        field(digest, name.to_string_lossy().as_bytes());
        if path.is_file() {
            if !self.oids.contains_key(path) {
                let oid = input_oid(path)?;
                self.oids.insert(path.to_path_buf(), oid);
            }
            field(digest, self.oids[path].as_bytes());
        } else {
            field(digest, b"absent");
        }
        Ok(())
    }

    fn files(&mut self, digest: &mut Sha256, paths: &[PathBuf]) -> Fallible<()> {
        for path in paths {
            self.file(digest, path)?;
        }
        Ok(())
    }

    fn chunks(&mut self, city: &City) -> Fallible<String> {
        let mut digest = self.scoped_to("chunks", &self.chunks_code, [city])?;
        field(&mut digest, city.id.as_bytes());
        let mut inputs = vec![self.plan.data.join("streets").join(&city.streets.file)];
        inputs.extend(
            city.paths
                .as_ref()
                .map(|layer| self.plan.data.join("paths").join(&layer.file)),
        );
        self.files(&mut digest, &inputs)?;
        Ok(hex(&digest.finalize()))
    }

    /// Pass 2, over the city's pass 1 stamp since its signals are keyed on the chunks' segment order.
    fn commercial(&mut self, city: &City, chunks: &str) -> Fallible<String> {
        let mut digest = self.scoped_to("commercial", &self.commercial_code, [city])?;
        field(&mut digest, city.id.as_bytes());
        field(&mut digest, chunks.as_bytes());
        let inputs: Vec<PathBuf> = ["landuse", "buildings", "openstreets", "dining"]
            .iter()
            .map(|kind| self.plan.data.join(kind).join(format!("{}.bin", city.id)))
            .collect();
        self.files(&mut digest, &inputs)?;
        Ok(hex(&digest.finalize()))
    }

    /// Pass 3: only the grid's `maxShadowMeters` enters, since the chunks carry no sun position.
    fn casters(&mut self, city: &City, sun: Option<&shade::Params>) -> Fallible<String> {
        let mut digest = self.scoped_to("caster-chunks", &self.casters_code, [city])?;
        field(&mut digest, city.id.as_bytes());
        match sun {
            Some(params) => field(&mut digest, &params.max_shadow_meters.to_le_bytes()),
            None => field(&mut digest, b"no sun"),
        }
        let mut inputs = vec![
            self.plan
                .data
                .join("buildings")
                .join(format!("{}.bin", city.id)),
            self.plan.data.join("trees").join(&city.field.trees.file),
        ];
        inputs.extend(
            city.field
                .canopy
                .as_ref()
                .map(|layer| self.plan.data.join("canopy").join(&layer.file)),
        );
        self.files(&mut digest, &inputs)?;
        Ok(hex(&digest.finalize()))
    }

    /// Pass 4, one sun bucket of one city; the rest of the schedule is deliberately absent.
    fn shade_bucket(
        &mut self,
        city: &City,
        params: &shade::Params,
        bucket: &shade::Bucket,
    ) -> Fallible<String> {
        let mut digest = self.scoped_to("shade-bucket", &self.shade_code, [city])?;
        field(&mut digest, city.id.as_bytes());
        field(&mut digest, &params.max_zoom.to_le_bytes());
        field(&mut digest, &params.max_shadow_meters.to_le_bytes());
        // Serialized so a new bin field can't be missed.
        field(&mut digest, &serde_json::to_vec(bucket)?);
        let mut inputs = vec![
            self.plan
                .data
                .join("buildings")
                .join(format!("{}.bin", city.id)),
        ];
        inputs.extend(
            city.field
                .canopy
                .as_ref()
                .map(|layer| self.plan.data.join("canopy").join(&layer.file)),
        );
        self.files(&mut digest, &inputs)?;
        Ok(hex(&digest.finalize()))
    }

    fn elevation(&mut self, city: &City, planned: &PlanCity) -> Fallible<String> {
        let mut digest = self.scoped_to("elevation", &self.elevation_code, [city])?;
        field(&mut digest, city.id.as_bytes());
        dem_identity(&mut digest, &planned.elevation)?;
        let land = self.plan.data.join("land").join(&city.field.land.file);
        self.file(&mut digest, &land)?;
        Ok(hex(&digest.finalize()))
    }

    fn canopy(&mut self, city: &City) -> Fallible<String> {
        let mut digest = self.scoped_to("canopy", &self.canopy_code, [city])?;
        field(&mut digest, city.id.as_bytes());
        match &city.field.canopy {
            Some(layer) => {
                let inputs = vec![
                    self.plan.data.join("canopy").join(&layer.file),
                    self.plan.data.join("land").join(&city.field.land.file),
                ];
                self.files(&mut digest, &inputs)?;
            }
            None => field(&mut digest, b"blank"),
        }
        Ok(hex(&digest.finalize()))
    }

    fn genus_field(&mut self, city: &City) -> Fallible<String> {
        let mut digest = self.scoped_to("genus-field", &self.genus_field_code, [city])?;
        field(&mut digest, city.id.as_bytes());
        if city.field.genus.is_some() {
            let inputs = vec![
                self.plan.data.join("trees").join(&city.field.trees.file),
                self.plan.data.join("land").join(&city.field.land.file),
            ];
            self.files(&mut digest, &inputs)?;
        } else {
            field(&mut digest, b"blank");
        }
        Ok(hex(&digest.finalize()))
    }

    /// Pass 8's keys: the topology base, and one per attribute column that folds the base.
    fn graph_keys(
        &mut self,
        city: &City,
        planned: &PlanCity,
        commercial: &str,
        bakes_shade: bool,
    ) -> Fallible<graph_cache::Keys> {
        let mut digest = self.scoped_to("graph-base", &self.graph_code, [city])?;
        field(&mut digest, city.id.as_bytes());
        field(
            &mut digest,
            if planned.alleys { b"alleys" } else { b"none" },
        );
        // The existence gate runs inside the cached topology, so a tighter ceiling must rerun it.
        let graph::ExistenceCeilings {
            dropped_sidewalk_fraction,
            cell_demoted_share,
        } = planned
            .existence_ceilings
            .unwrap_or(graph::SURVEYED_CEILINGS);
        field(&mut digest, &dropped_sidewalk_fraction.to_le_bytes());
        field(&mut digest, &cell_demoted_share.to_le_bytes());
        // The value settings the call site passes, read through the same consts and fns.
        field(&mut digest, if GRAPH_PROBE { b"probe" } else { b"build" });
        field(&mut digest, GRAPH_REPORT.unwrap_or("").as_bytes());
        field(
            &mut digest,
            if graph_elevation_bounds(city, planned).is_some() {
                b"terrain"
            } else {
                b"flat"
            },
        );
        field(
            &mut digest,
            if graph_land(&self.plan.data, city).is_some() {
                b"land"
            } else {
                b"no land"
            },
        );
        let mut inputs = vec![self.plan.data.join("streets").join(&city.streets.file)];
        inputs.extend(
            city.paths
                .as_ref()
                .map(|layer| self.plan.data.join("paths").join(&layer.file)),
        );
        for source in Source::ALL {
            let topology = match source {
                Source::Sidewalks | Source::Ferries | Source::Transit => true,
                // Each bakes one column over final edges, so it stays out of the base.
                Source::Landmarks
                | Source::Art
                | Source::Highways
                | Source::Industrial
                | Source::Historic
                | Source::Buildings => false,
            };
            if topology {
                inputs.extend(planned.source(&self.plan.data, source));
            }
        }
        self.files(&mut digest, &inputs)?;
        let base = hex(&digest.finalize());

        let canopy_file = city
            .field
            .canopy
            .as_ref()
            .map(|layer| self.plan.data.join("canopy").join(&layer.file));
        // Every city carries one: the bridge column reads it.
        let land_file = self.plan.data.join("land").join(&city.field.land.file);
        let buildings = planned.source(&self.plan.data, Source::Buildings);
        let mut shade = Vec::new();
        if let Some(params) = &planned.shade
            && bakes_shade
        {
            for bucket in &params.buckets {
                let mut digest = self.scoped("graph-shade", &self.shade_code);
                field(&mut digest, base.as_bytes());
                field(&mut digest, &params.max_zoom.to_le_bytes());
                field(&mut digest, &params.max_shadow_meters.to_le_bytes());
                // Serialized so a new bin field can't be missed; this bin alone, like the pyramid.
                field(&mut digest, &serde_json::to_vec(bucket)?);
                let files: Vec<PathBuf> = buildings.iter().chain(&canopy_file).cloned().collect();
                self.files(&mut digest, &files)?;
                shade.push(hex(&digest.finalize()));
            }
        }

        let mut relief = self.scoped("graph-relief", &self.relief_code);
        field(&mut relief, base.as_bytes());
        dem_identity(&mut relief, &planned.elevation)?;
        let mut commercial_key = self.scoped("graph-commercial", &self.graph_code);
        field(&mut commercial_key, base.as_bytes());
        field(&mut commercial_key, commercial.as_bytes());
        Ok(graph_cache::Keys {
            dir: self.plan.graph_cache.join(&city.id),
            landmarks: self.graph_column(
                &base,
                "graph-landmarks",
                planned.source(&self.plan.data, Source::Landmarks).as_ref(),
            )?,
            art: self.graph_column(
                &base,
                "graph-art",
                planned.source(&self.plan.data, Source::Art).as_ref(),
            )?,
            highways: self.graph_column(
                &base,
                "graph-highways",
                planned.source(&self.plan.data, Source::Highways).as_ref(),
            )?,
            industrial: self.graph_column(
                &base,
                "graph-industrial",
                planned.source(&self.plan.data, Source::Industrial).as_ref(),
            )?,
            historic: self.graph_column(
                &base,
                "graph-historic",
                planned.source(&self.plan.data, Source::Historic).as_ref(),
            )?,
            bridge: self.graph_column(&base, "graph-bridge", Some(&land_file))?,
            canopy: self.graph_column(&base, "graph-canopy", canopy_file.as_ref())?,
            commercial: hex(&commercial_key.finalize()),
            relief: hex(&relief.finalize()),
            base,
            shade,
        })
    }

    fn graph_column(
        &mut self,
        base: &str,
        name: &str,
        input: Option<&PathBuf>,
    ) -> Fallible<String> {
        let mut digest = self.scoped(name, &self.graph_code);
        field(&mut digest, base.as_bytes());
        match input {
            Some(path) => self.file(&mut digest, path)?,
            None => field(&mut digest, b"no source"),
        }
        Ok(hex(&digest.finalize()))
    }

    /// Pass 8's stamp, which is exactly its keys.
    fn graph(&self, keys: &graph_cache::Keys) -> String {
        let mut digest = self.scoped("graph", &self.graph_code);
        for key in [
            &keys.base,
            &keys.landmarks,
            &keys.art,
            &keys.highways,
            &keys.commercial,
            &keys.relief,
            &keys.canopy,
            &keys.industrial,
            // Only this makes a re-ingested district file rerun the pass.
            &keys.historic,
            &keys.bridge,
        ] {
            field(&mut digest, key.as_bytes());
        }
        // The count too, so a city that stopped baking shade moves the stamp.
        field(&mut digest, &keys.shade.len().to_le_bytes());
        for key in &keys.shade {
            field(&mut digest, key.as_bytes());
        }
        hex(&digest.finalize())
    }

    /// Pass 9: the city's pass 1 stamp plus its stranded set, so a rerun with the same islands skips it.
    fn stranded_chunks(&self, city: &City, chunks: &str, ways: &[u32]) -> Fallible<String> {
        let mut digest = self.scoped_to("chunks-stranded", &self.chunks_code, [city])?;
        field(&mut digest, city.id.as_bytes());
        field(&mut digest, chunks.as_bytes());
        for way in ways {
            digest.update(way.to_le_bytes());
        }
        Ok(hex(&digest.finalize()))
    }
}

const STAGES: usize = 9;

fn stage(number: usize, name: &str, started: &Instant) {
    crate::trim_heap();
    let peak = crate::peak_rss()
        .map(|bytes| format!(", peak RSS {}", crate::gib(bytes)))
        .unwrap_or_default();
    eprintln!(
        "[{number}/{STAGES}] {name} ({:.1}s in{peak})",
        started.elapsed().as_secs_f64()
    );
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum PassName {
    Chunks,
    Commercial,
    CasterChunks,
    Shade,
    Elevation,
    Canopy,
    GenusField,
    Graph,
    ChunksStranded,
}

impl PassName {
    const ALL: [PassName; STAGES] = [
        PassName::Chunks,
        PassName::Commercial,
        PassName::CasterChunks,
        PassName::Shade,
        PassName::Elevation,
        PassName::Canopy,
        PassName::GenusField,
        PassName::Graph,
        PassName::ChunksStranded,
    ];

    fn name(self) -> &'static str {
        match self {
            PassName::Chunks => "chunks",
            PassName::Commercial => "commercial",
            PassName::CasterChunks => "caster-chunks",
            PassName::Shade => "shade",
            PassName::Elevation => "elevation",
            PassName::Canopy => "canopy",
            PassName::GenusField => "genus-field",
            PassName::Graph => "graph",
            PassName::ChunksStranded => "chunks-stranded",
        }
    }
}

enum Cities {
    All,
    Named(HashSet<String>),
}

/// Which passes this build may run and whether it believes their stamps.
pub struct Selection {
    only: Option<HashMap<PassName, Cities>>,
    force: bool,
}

impl Selection {
    /// `--only` as typed: pass names, each optionally `<pass>:<city>`; empty means all nine.
    pub fn new(only: &[String], force: bool) -> Fallible<Selection> {
        if only.is_empty() {
            Ok(Selection { only: None, force })
        } else {
            let mut passes: HashMap<PassName, Cities> = HashMap::new();
            for term in only {
                let (name, city) = match term.split_once(':') {
                    Some((name, city)) => (name, Some(city)),
                    None => (term.as_str(), None),
                };
                let pass = PassName::ALL
                    .into_iter()
                    .find(|pass| pass.name() == name)
                    .ok_or_else(|| {
                        let names: Vec<&str> =
                            PassName::ALL.iter().map(|pass| pass.name()).collect();
                        format!("--only {term}: no pass is called {name}; they are {names:?}")
                    })?;
                match city {
                    Some(city) => match passes
                        .entry(pass)
                        .or_insert_with(|| Cities::Named(HashSet::new()))
                    {
                        Cities::All => (),
                        Cities::Named(named) => {
                            named.insert(city.to_owned());
                        }
                    },
                    None => {
                        passes.insert(pass, Cities::All);
                    }
                }
            }
            Ok(Selection {
                only: Some(passes),
                force,
            })
        }
    }

    fn partial(&self) -> bool {
        self.only.is_some()
    }

    /// Checks every narrowed city against the manifest, since a typo would select no work.
    fn check(&self, manifest: &Manifest) -> Fallible<()> {
        let known: HashSet<&str> = manifest
            .cities
            .iter()
            .map(|city| city.id.as_str())
            .collect();
        for (pass, cities) in self.only.iter().flatten() {
            if let Cities::Named(named) = cities {
                for city in named {
                    if !known.contains(city.as_str()) {
                        return Err(format!(
                            "--only {}:{city}: the manifest has no city called {city}",
                            pass.name()
                        )
                        .into());
                    }
                }
            }
        }
        Ok(())
    }

    /// Whether `--only` left this pass in; without a city, whether it did for any city.
    fn selected(&self, pass: PassName, city: Option<&str>) -> bool {
        match &self.only {
            None => true,
            Some(only) => match only.get(&pass) {
                None => false,
                Some(Cities::All) => true,
                Some(Cities::Named(named)) => city.is_none_or(|city| named.contains(city)),
            },
        }
    }

    /// Whether `--force` set aside this pass's stamp, which it does only for selected passes.
    fn forces(&self, pass: PassName, city: Option<&str>) -> bool {
        self.force && self.selected(pass, city)
    }

    /// Whether a selected pass would read output from a producer this build isn't running.
    fn handoff(&self, consumer: PassName, producer: PassName, city: Option<&str>) -> bool {
        self.selected(consumer, city) && !self.selected(producer, city)
    }

    fn verdict(&self, pass: PassName, city: Option<&str>, fresh: bool) -> Verdict {
        if !self.selected(pass, city) {
            Verdict::Excluded
        } else if fresh && !self.force {
            Verdict::Current
        } else {
            Verdict::Run
        }
    }
}

#[derive(Clone, Copy)]
enum Verdict {
    /// Left out by `--only`: not run, and nothing of its output touched.
    Excluded,
    Current,
    Run,
}

impl Verdict {
    fn runs(self) -> bool {
        matches!(self, Verdict::Run)
    }

    /// Prints what a pass does instead of running; silent for a pass that runs.
    fn announce(self, city: Option<&str>) {
        let why = match self {
            Verdict::Excluded => Some("not selected"),
            Verdict::Current => Some("up to date"),
            Verdict::Run => None,
        };
        if let Some(why) = why {
            match city {
                Some(city) => eprintln!("{city}: {why}"),
                None => eprintln!("{why}"),
            }
        }
    }
}

/// The stamp a downstream pass folds: the computed one if selected, else the recorded one.
fn upstream(
    selection: &Selection,
    name: PassName,
    city: Option<&str>,
    pass: &Pass,
) -> Fallible<String> {
    if selection.selected(name, city) {
        Ok(pass.stamp.clone())
    } else {
        match fs::read_to_string(&pass.stamp_file) {
            Ok(recorded) => Ok(recorded.trim().to_owned()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(UNRECORDED.to_owned()),
            Err(error) => Err(format!("{}: {error}", pass.stamp_file.display()).into()),
        }
    }
}

/// Stands in for an unrecorded upstream stamp; never 64 hex digits, so the next real one reruns.
const UNRECORDED: &str = "unrecorded";

/// Checks that a selected pass's upstream output exists; stale is fine, missing is not.
fn handoffs(plan: &Plan, cities: &[(&City, &PlanCity)], selection: &Selection) -> Fallible<()> {
    let mut wanted: Vec<(PassName, PassName, PathBuf)> = Vec::new();
    for (city, _) in cities {
        let id = Some(city.id.as_str());
        for consumer in [PassName::Commercial, PassName::ChunksStranded] {
            if selection.handoff(consumer, PassName::Chunks, id) {
                wanted.push((
                    consumer,
                    PassName::Chunks,
                    ledger_file(&plan.chunks, &city.id),
                ));
            }
        }
        if selection.handoff(PassName::Graph, PassName::Commercial, id) {
            wanted.push((
                PassName::Graph,
                PassName::Commercial,
                ledger_file(&plan.commercial_signals, &city.id),
            ));
        }
    }
    for (city, _) in cities {
        if selection.handoff(PassName::ChunksStranded, PassName::Graph, Some(&city.id)) {
            wanted.push((
                PassName::ChunksStranded,
                PassName::Graph,
                plan.routing.join(format!("{}.stranded.bin", city.id)),
            ));
        }
    }
    match wanted.into_iter().find(|(_, _, path)| !path.exists()) {
        Some((consumer, producer, path)) => Err(format!(
            "the {} pass reads {}, which is not there; run --only {} first",
            consumer.name(),
            path.display(),
            producer.name()
        )
        .into()),
        None => Ok(()),
    }
}

/// The re-chunk's stamp for `city`.
fn stranded_stamp_file(plan: &Plan, city: &City) -> PathBuf {
    plan.chunks.join(format!("{STRANDED_STAMP}{}", city.id))
}

/// Fails on two cities sharing a z9 tile, since each city's share of a tile tree is its own tiles.
fn disjoint(cities: &[(&City, &PlanCity)]) -> Fallible<()> {
    let bounds: Vec<Bounds> = cities.iter().map(|(city, _)| city.bounds).collect();
    for tile in raster::plan_bounds(&bounds, raster::MIN_ZOOM) {
        if let [first, second, ..] = tile.members[..] {
            return Err(format!(
                "{} and {} share the z{} tile {}/{}; two regions that share a z{} tile must be one \
                 manifest entry",
                cities[first].0.id,
                cities[second].0.id,
                tile.zoom,
                tile.x,
                tile.y,
                raster::MIN_ZOOM
            )
            .into());
        }
    }
    Ok(())
}

/// A build on `jobs` rayon threads, sized before any parallel iterator builds the default pool.
/// `memory` is the caches' budget in bytes and its provenance; it only trades memory for time,
/// so no stamp or cache key ever reads it.
pub fn run(
    plan_file: &Path,
    jobs: Option<usize>,
    memory: (u64, String),
    selection: &Selection,
) -> Fallible<()> {
    let started = Instant::now();
    if let Some(threads) = jobs {
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build_global()?;
    }
    let threads = rayon::current_num_threads();
    eprintln!(
        "building on {threads} thread{}",
        if threads == 1 { "" } else { "s" }
    );
    let (budget, provenance) = memory;
    eprintln!("memory budget {} ({provenance})", crate::gib(budget));
    let memory_budget = usize::try_from(budget).unwrap_or(usize::MAX);
    let mut plan: Plan = serde_json::from_slice(&fs::read(plan_file)?)?;
    plan.hash_source_tokens();
    let manifest: Manifest = serde_json::from_slice(&fs::read(&plan.manifest)?)?;
    let cities = plan.pair(&manifest)?;
    disjoint(&cities)?;
    selection.check(&manifest)?;
    handoffs(&plan, &cities, selection)?;
    // A partial build sweeps nothing, since the reconcile reaches into unselected passes' output.
    if !selection.partial() {
        plan.reconcile(&manifest)?;
    }

    // The caster chunks carry no sun position, so any city's grid supplies the halo.
    let sun = cities
        .iter()
        .find_map(|(_, planned)| planned.shade.as_ref());
    let any_casters = cities.iter().any(|(city, planned)| {
        planned.source(&plan.data, Source::Buildings).is_some() || city.field.canopy.is_some()
    });
    let baked: Vec<Option<PathBuf>> = cities
        .iter()
        .map(|(city, planned)| {
            (planned.source(&plan.data, Source::Buildings).is_some() && planned.shade.is_some())
                .then(|| plan.routing.join("shade").join(&city.id))
        })
        .collect();

    // Every stamp before any pass runs, since which DEMs to open depends on which passes are stale.
    let mut stamps = Stamps::new(&plan)?;
    let ids: Vec<&str> = cities.iter().map(|(city, _)| city.id.as_str()).collect();
    let chunk_passes: Vec<Pass> = cities
        .iter()
        .map(|(city, _)| {
            Ok(Pass::shared(
                stamps.chunks(city)?,
                Share::new(&plan.chunks, &city.id, &ids, &[]),
                // So a rerun chunk cannot leave a fresh-looking stranded stamp over empty bitmaps.
                vec![stranded_stamp_file(&plan, city)],
            ))
        })
        .collect::<Fallible<Vec<Pass>>>()?;
    // Handovers enter as what this build will leave, so a partial build claims nothing unbuilt.
    let chunks_upstream: Vec<String> = cities
        .iter()
        .zip(&chunk_passes)
        .map(|((city, _), pass)| upstream(selection, PassName::Chunks, Some(&city.id), pass))
        .collect::<Fallible<Vec<String>>>()?;
    let commercial_passes: Vec<Pass> = cities
        .iter()
        .zip(&chunks_upstream)
        .map(|((city, _), chunks)| {
            Ok(Pass::shared(
                stamps.commercial(city, chunks)?,
                Share::new(&plan.commercial_signals, &city.id, &ids, &[]),
                vec![plan.commercial_lines.join(format!("{}.bin", city.id))],
            ))
        })
        .collect::<Fallible<Vec<Pass>>>()?;
    let caster_passes: Vec<Pass> = cities
        .iter()
        .map(|(city, _)| {
            Ok(Pass::shared(
                stamps.casters(city, sun)?,
                Share::new(&plan.casters, &city.id, &ids, CASTER_EXEMPT),
                Vec::new(),
            ))
        })
        .collect::<Fallible<Vec<Pass>>>()?;
    // Shade is stamped per sun bucket, since no bucket is a function of another.
    let shade_pyramids: Vec<ShadePyramid> = cities
        .iter()
        .map(|(city, planned)| {
            Ok(ShadePyramid {
                buildings: plan.tiles.join("shade").join(&city.id),
                trees: plan.tiles.join("tree-shade").join(&city.id),
                keys: match &planned.shade {
                    Some(params) => params
                        .buckets
                        .iter()
                        .map(|bucket| stamps.shade_bucket(city, params, bucket))
                        .collect::<Fallible<Vec<String>>>()?,
                    None => Vec::new(),
                },
            })
        })
        .collect::<Fallible<Vec<ShadePyramid>>>()?;
    let elevation_passes: Vec<Pass> = cities
        .iter()
        .map(|(city, planned)| {
            let root = plan.tiles.join("elevation").join(&city.id);
            Ok(Pass {
                stamp: stamps.elevation(city, planned)?,
                stamp_file: root.join(STAMP),
                share: None,
                pieces: vec![root.clone()],
                witnesses: vec![root],
            })
        })
        .collect::<Fallible<Vec<Pass>>>()?;
    let canopy_passes: Vec<Pass> = cities
        .iter()
        .map(|(city, _)| {
            Ok(Pass::shared(
                stamps.canopy(city)?,
                Share::new(&plan.canopy_tiles, &city.id, &ids, &[]),
                Vec::new(),
            ))
        })
        .collect::<Fallible<Vec<Pass>>>()?;
    let genus_passes: Vec<Pass> = cities
        .iter()
        .map(|(city, _)| {
            Ok(Pass::shared(
                stamps.genus_field(city)?,
                Share::new(&plan.genus_field_tiles, &city.id, &ids, &[]),
                Vec::new(),
            ))
        })
        .collect::<Fallible<Vec<Pass>>>()?;
    let commercial_upstream: Vec<String> = cities
        .iter()
        .zip(&commercial_passes)
        .map(|((city, _), pass)| upstream(selection, PassName::Commercial, Some(&city.id), pass))
        .collect::<Fallible<Vec<String>>>()?;
    let graph_keys: Vec<graph_cache::Keys> = cities
        .iter()
        .zip(&baked)
        .zip(&commercial_upstream)
        .map(|(((city, planned), bake), commercial)| {
            stamps.graph_keys(city, planned, commercial, bake.is_some())
        })
        .collect::<Fallible<Vec<graph_cache::Keys>>>()?;
    let graph_passes: Vec<Pass> = cities
        .iter()
        .zip(&baked)
        .enumerate()
        .map(|(index, ((city, _), bake))| {
            Ok(graph_pass(
                &plan,
                city,
                stamps.graph(&graph_keys[index]),
                bake.as_ref(),
            ))
        })
        .collect::<Fallible<Vec<Pass>>>()?;

    // Opens each stale pass's DEMs up front (georeferencing only, seconds), once per city.
    let mut dems: HashMap<&str, Dem> = HashMap::new();
    for (index, (_, planned)) in cities.iter().enumerate() {
        // A graph whose relief column is cached reads no DEM.
        let keys = &graph_keys[index];
        let city = cities[index].0.id.as_str();
        // A forced graph recomputes its relief column, so it opens the DEM.
        let graph_reads_dem = selection
            .verdict(PassName::Graph, Some(city), graph_passes[index].is_fresh())
            .runs()
            && (selection.forces(PassName::Graph, Some(city))
                || !graph_cache::holds(&keys.dir, graph_cache::RELIEF, &keys.relief));
        let terrain_runs = selection
            .verdict(
                PassName::Elevation,
                Some(city),
                elevation_passes[index].is_fresh(),
            )
            .runs();
        if !planned.elevation.is_empty() && (terrain_runs || graph_reads_dem) {
            let mosaics = planned
                .elevation
                .iter()
                .map(|mosaic| {
                    Ok(MosaicTiles {
                        projection: heights::projection(&mosaic.crs)?,
                        band: mosaic.band,
                        paths: mosaic.tiles.clone(),
                    })
                })
                .collect::<Fallible<Vec<MosaicTiles>>>()?;
            let dem = Dem::open_mosaics(&mosaics)
                .map_err(|error| format!("{}'s DEM: {error}", planned.id))?;
            dems.insert(planned.id.as_str(), dem);
        }
    }

    let chunk_args = chunks::Args {
        data: plan.data.clone(),
        chunks: plan.chunks.clone(),
    };
    stage(1, "chunks", &started);
    for ((city, _), pass) in cities.iter().zip(&chunk_passes) {
        let verdict = selection.verdict(PassName::Chunks, Some(&city.id), pass.is_fresh());
        if verdict.runs() {
            pass.restart()?;
            chunks::run(&chunk_args, city, &[])?;
            pass.record()?;
        } else {
            verdict.announce(Some(&city.id));
        }
    }
    let chunk_files = chunks::Chunks {
        dir: plan.chunks.clone(),
    };

    // The commercial signals are keyed on the chunks' segment index.
    stage(2, "commercial", &started);
    let commercial_args = commercial::Args {
        data: plan.data.clone(),
        signals: plan.commercial_signals.clone(),
        lines: plan.commercial_lines.clone(),
    };
    for ((city, _), pass) in cities.iter().zip(&commercial_passes) {
        let verdict = selection.verdict(PassName::Commercial, Some(&city.id), pass.is_fresh());
        if verdict.runs() {
            pass.restart()?;
            fs::create_dir_all(&plan.commercial_lines)?;
            commercial::run(&commercial_args, city, &chunk_files)?;
            pass.record()?;
        } else {
            verdict.announce(Some(&city.id));
        }
    }
    let lines = commercial::Lines::written(&plan.commercial_lines, &manifest);

    stage(3, "caster-chunks", &started);
    let caster_args = caster_chunks::Args {
        data: plan.data.clone(),
        chunks: plan.casters.clone(),
    };
    for ((city, planned), pass) in cities.iter().zip(&caster_passes) {
        let casts = sun.is_some()
            && (planned.source(&plan.data, Source::Buildings).is_some()
                || city.field.canopy.is_some());
        let verdict = selection.verdict(PassName::CasterChunks, Some(&city.id), pass.is_fresh());
        if !selection.selected(PassName::CasterChunks, Some(&city.id)) {
            verdict.announce(Some(&city.id));
        } else if !casts {
            pass.clear()?;
        } else if verdict.runs() {
            pass.restart()?;
            caster_chunks::run(&caster_args, city)?;
            pass.record()?;
        } else {
            verdict.announce(Some(&city.id));
        }
    }
    if selection.selected(PassName::CasterChunks, None) {
        let index = plan.casters.join(caster_chunks::INDEX);
        match sun {
            Some(params) if any_casters => {
                let ledgers = ids
                    .iter()
                    .map(|id| claims(&plan.casters, id))
                    .collect::<Fallible<Vec<Vec<String>>>>()?;
                caster_chunks::write_index(&plan.casters, params.max_shadow_meters, &ledgers)?;
            }
            _ => {
                discard(&index)?;
                eprintln!("no sun grid or nothing to cast a shadow; no caster chunks");
            }
        }
    }

    // One pyramid per city, since a bin's sun position is synthesized at the city's latitude.
    stage(4, "shade", &started);
    for ((city, planned), pyramid) in cities.iter().zip(&shade_pyramids) {
        let footprints = planned.source(&plan.data, Source::Buildings).is_some();
        let selected = selection.selected(PassName::Shade, Some(&city.id));
        match &planned.shade {
            Some(params) if footprints && selected => {
                // A forced pyramid is removed first, so every bin renders again.
                if selection.forces(PassName::Shade, Some(&city.id)) {
                    pyramid.clear()?;
                }
                let render = pyramid.reconcile()?;
                // Written before rendering, since the reconcile has moved buckets to new indices.
                shade::write_schedule(&pyramid.buildings, params)?;
                if render.is_empty() {
                    Verdict::Current.announce(Some(&city.id));
                } else {
                    eprintln!(
                        "{}: {} of {} buckets to render",
                        city.id,
                        render.len(),
                        params.buckets.len()
                    );
                    shade::run(&shade::Args {
                        manifest: plan.manifest.clone(),
                        data: plan.data.clone(),
                        tiles: plan.tiles.clone(),
                        params: params.clone(),
                        city: city.id.clone(),
                        render,
                        memory_budget,
                    })?;
                }
            }
            _ if !selected => Verdict::Excluded.announce(Some(&city.id)),
            _ => pyramid.clear()?,
        }
    }

    stage(5, "elevation", &started);
    for ((city, planned), pass) in cities.iter().zip(&elevation_passes) {
        let verdict = selection.verdict(PassName::Elevation, Some(&city.id), pass.is_fresh());
        if !selection.selected(PassName::Elevation, Some(&city.id)) {
            verdict.announce(Some(&city.id));
        } else if planned.elevation.is_empty() {
            pass.clear()?;
        } else if !verdict.runs() {
            verdict.announce(Some(&city.id));
        } else {
            let dem = dems
                .get_mut(city.id.as_str())
                .ok_or_else(|| format!("{}'s DEM was never opened", city.id))?;
            pass.restart()?;
            elevation::run(
                &elevation::Args {
                    manifest: plan.manifest.clone(),
                    tiles: plan.tiles.clone(),
                    city: city.id.clone(),
                    // The DEM answers over water too, so the overlay is clipped to land.
                    land: plan.data.join("land").join(&city.field.land.file),
                },
                dem,
            )?;
            pass.record()?;
        }
    }

    stage(6, "canopy", &started);
    let any_canopy = cities.iter().any(|(city, _)| city.field.canopy.is_some());
    let canopy_args = canopy::Args {
        data: plan.data.clone(),
        tiles: plan.canopy_tiles.clone(),
    };
    for ((city, _), pass) in cities.iter().zip(&canopy_passes) {
        let verdict = selection.verdict(PassName::Canopy, Some(&city.id), pass.is_fresh());
        if !selection.selected(PassName::Canopy, Some(&city.id)) {
            verdict.announce(Some(&city.id));
        } else if !any_canopy {
            pass.clear()?;
        } else if verdict.runs() {
            pass.restart()?;
            canopy::run(&canopy_args, city)?;
            pass.record()?;
        } else {
            verdict.announce(Some(&city.id));
        }
    }

    stage(7, "genus-field", &started);
    let any_genus = cities.iter().any(|(city, _)| city.field.genus.is_some());
    let genus_args = genus_field::Args {
        data: plan.data.clone(),
        tiles: plan.genus_field_tiles.clone(),
    };
    for ((city, _), pass) in cities.iter().zip(&genus_passes) {
        let verdict = selection.verdict(PassName::GenusField, Some(&city.id), pass.is_fresh());
        if !selection.selected(PassName::GenusField, Some(&city.id)) {
            verdict.announce(Some(&city.id));
        } else if !any_genus {
            pass.clear()?;
        } else if verdict.runs() {
            pass.restart()?;
            genus_field::run(&genus_args, city)?;
            pass.record()?;
        } else {
            verdict.announce(Some(&city.id));
        }
    }

    stage(8, "graph", &started);
    let mut stranded = chunks::Stranded::default();
    for (index, (city, planned)) in cities.iter().enumerate() {
        let pass = &graph_passes[index];
        let stranded_file = plan.routing.join(format!("{}.stranded.bin", city.id));
        let verdict = selection.verdict(PassName::Graph, Some(&city.id), pass.is_fresh());
        if !verdict.runs() {
            verdict.announce(Some(&city.id));
            // Read only when the re-chunk runs, so `--only graph:nyc` opens no other city's file.
            if selection.selected(PassName::ChunksStranded, Some(&city.id)) {
                stranded.insert(&city.id, graph::read_stranded(&stranded_file)?);
            }
            continue;
        }
        // A forced graph clears this city's cache entries along with its stamp.
        if selection.forces(PassName::Graph, Some(&city.id)) {
            discard(&graph_keys[index].dir)?;
        }
        let (buildings, shade_params, shade_dir) = match &baked[index] {
            Some(dir) => (
                planned.source(&plan.data, Source::Buildings),
                planned.shade.clone(),
                Some(dir.clone()),
            ),
            None => (None, None, None),
        };
        let dem = dems.get_mut(city.id.as_str());
        pass.restart()?;
        // The previous city's graph leaves freed pages this city's field and grids can't reuse.
        crate::trim_heap();
        let ways = graph::run(
            &graph::Args {
                streets: plan.data.join("streets").join(&city.streets.file),
                paths: city
                    .paths
                    .as_ref()
                    .map(|layer| plan.data.join("paths").join(&layer.file)),
                sidewalks: planned.source(&plan.data, Source::Sidewalks),
                ferries: planned.source(&plan.data, Source::Ferries),
                transit: planned.source(&plan.data, Source::Transit),
                landmarks: planned.source(&plan.data, Source::Landmarks),
                art: planned.source(&plan.data, Source::Art),
                highways: planned.source(&plan.data, Source::Highways),
                commercial: lines.get(&city.id).map(Path::to_path_buf),
                industrial: planned.source(&plan.data, Source::Industrial),
                historic: planned.source(&plan.data, Source::Historic),
                land: graph_land(&plan.data, city),
                out: plan.routing.join(format!("{}.bin", city.id)),
                // Written for the record; the re-chunk reads the same ids from memory.
                stranded_out: Some(stranded_file),
                canopy_runs_out: Some(canopy_runs_file(&plan, city)),
                cover_tiles_out: Some(cover_tiles_dir(&plan, city)),
                buildings,
                shade_params,
                shade_dir,
                // The measured canopy feeds the direct-canopy byte and also occludes edges.
                canopy: city
                    .field
                    .canopy
                    .as_ref()
                    .map(|layer| plan.data.join("canopy").join(&layer.file)),
                elevation_bounds: graph_elevation_bounds(city, planned),
                alleys: planned.alleys,
                existence_ceilings: planned
                    .existence_ceilings
                    .unwrap_or(graph::SURVEYED_CEILINGS),
                cache: Some(graph_keys[index].clone()),
                probe: GRAPH_PROBE,
                report: GRAPH_REPORT.map(PathBuf::from),
                memory_budget,
            },
            dem,
        )?;
        pass.record()?;
        stranded.insert(&city.id, ways);
    }

    // Re-cut with the graph's stranded set; only the trailing bitmap changes.
    stage(9, "chunks (stranded)", &started);
    for (index, (city, _)) in cities.iter().enumerate() {
        // A city without paths has no stranded bits, so pass 1's bytes stand.
        if city.paths.is_none() {
            continue;
        }
        let ways = stranded.ways(&city.id);
        // Rewrites pass 1's files in place, so it clears nothing and keeps pass 1's ledger.
        let pass = Pass {
            stamp: stamps.stranded_chunks(city, &chunks_upstream[index], ways)?,
            stamp_file: stranded_stamp_file(&plan, city),
            share: None,
            pieces: Vec::new(),
            witnesses: vec![ledger_file(&plan.chunks, &city.id)],
        };
        let verdict = selection.verdict(PassName::ChunksStranded, Some(&city.id), pass.is_fresh());
        if verdict.runs() {
            chunks::run(&chunk_args, city, ways)?;
            pass.record()?;
        } else {
            verdict.announce(Some(&city.id));
        }
    }

    eprintln!(
        "build: {STAGES} passes in {:.1}s",
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

const LFS_POINTER: &str = "version https://git-lfs.github.com/spec/v1";
/// A pointer is ~130 bytes.
const POINTER_HEAD: usize = 512;
const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .flat_map(|byte| {
            [
                HEX_DIGITS[usize::from(byte >> 4)],
                HEX_DIGITS[usize::from(byte & 0xf)],
            ]
        })
        .map(char::from)
        .collect()
}

fn pointer_oid(bytes: &[u8]) -> Fallible<Option<String>> {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(POINTER_HEAD)]);
    if head.starts_with(LFS_POINTER) {
        match head
            .lines()
            .find_map(|line| line.strip_prefix("oid sha256:"))
            .filter(|oid| oid.len() == 64 && oid.bytes().all(|byte| byte.is_ascii_hexdigit()))
        {
            Some(oid) => Ok(Some(oid.to_owned())),
            None => Err("an LFS pointer with no sha256 oid to name its object".into()),
        }
    } else {
        Ok(None)
    }
}

/// An input's oid; an LFS pointer's oid is its object's sha256, so both checkouts hash alike.
fn input_oid(path: &Path) -> Fallible<String> {
    let bytes = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    match pointer_oid(&bytes)? {
        Some(oid) => Ok(oid),
        None => Ok(hex(&Sha256::digest(&bytes))),
    }
}

/// What `bun run check-shed-inputs` compares against each `public/sheds/<city>/inputs.json`.
#[derive(Serialize)]
struct GraphInputs {
    cities: BTreeMap<String, CityInputs>,
}

#[derive(Serialize, Debug, PartialEq)]
struct CityInputs {
    stamp: String,
    files: usize,
}

/// What the graph's durable key space is a function of, stamped for the committed shed artifact.
impl Plan {
    /// The files that can put a key in the space; the exhaustive match forces a call per source.
    fn key_space_files(&self, city: &City, planned: &PlanCity) -> Vec<PathBuf> {
        let mut files = vec![
            Some(self.data.join("streets").join(&city.streets.file)),
            city.paths
                .as_ref()
                .map(|layer| self.data.join("paths").join(&layer.file)),
        ];
        for source in Source::ALL {
            files.push(match source {
                Source::Sidewalks => planned.source(&self.data, source),
                Source::Ferries
                | Source::Transit
                | Source::Landmarks
                | Source::Art
                | Source::Highways
                | Source::Industrial
                | Source::Historic
                | Source::Buildings => None,
            });
        }
        files.into_iter().flatten().collect()
    }

    /// The stamp and its file count, over data-relative paths in manifest order.
    fn key_space_stamp(&self, cities: &[(&City, &PlanCity)]) -> Fallible<(String, usize)> {
        let mut digest = Sha256::new();
        let mut files = 0;
        for (city, planned) in cities {
            digest.update(planned.id.as_bytes());
            digest.update([0]);
            digest.update(if planned.alleys { "alleys" } else { "none" });
            digest.update([0]);
            for path in self.key_space_files(city, planned) {
                let name = path
                    .strip_prefix(&self.data)
                    .map_err(|_| format!("{} is not under the plan's data root", path.display()))?;
                digest.update(name.to_string_lossy().as_bytes());
                digest.update([0]);
                digest.update(input_oid(&path)?.as_bytes());
                digest.update([0]);
                files += 1;
            }
        }
        Ok((hex(&digest.finalize()), files))
    }

    /// One stamp per city, so a city's shed artifact goes stale on its own sources alone.
    fn key_space_stamps(
        &self,
        cities: &[(&City, &PlanCity)],
    ) -> Fallible<BTreeMap<String, CityInputs>> {
        cities
            .iter()
            .map(|&pair| {
                let (stamp, files) = self.key_space_stamp(&[pair])?;
                Ok((pair.1.id.clone(), CityInputs { stamp, files }))
            })
            .collect()
    }
}

/// `tiler graph-inputs`: stamps the key space of the plan's sources decision without building.
pub fn graph_inputs(plan_file: &Path, report: &Path) -> Fallible<()> {
    let plan: Plan = serde_json::from_slice(&fs::read(plan_file)?)?;
    let manifest: Manifest = serde_json::from_slice(&fs::read(&plan.manifest)?)?;
    let cities = plan.key_space_stamps(&plan.pair(&manifest)?)?;
    for (id, CityInputs { stamp, files }) in &cities {
        eprintln!("graph inputs: {id}: {files} files stamped {stamp}");
    }
    crate::write_report(report, &GraphInputs { cities })
}

#[cfg(test)]
mod tests {
    use proc_macro2::{Delimiter, TokenStream, TokenTree};

    use super::*;

    /// A module's hashed text, as `token_oid` reads it.
    fn hashed(source: &str) -> String {
        without_test_items(TokenStream::from_str(source).expect("a token stream")).to_string()
    }

    #[test]
    fn a_module_s_test_items_leave_its_hash_alone() {
        let plain = "pub fn f() -> u8 { 1 } impl S { pub fn g(&self) {} }";
        let tested = "pub fn f() -> u8 { 1 } #[cfg(test)] use std::{fs, io}; \
                      impl S { pub fn g(&self) {} #[cfg(test)] /// doc\n fn h() {} } \
                      #[cfg(test)] const X: S = S { a: 1 }; \
                      #[cfg(test)] mod tests { fn t() {} }";
        assert_eq!(hashed(plain), hashed(tested));
        // Everything else still counts: a non-test attribute, and the code itself.
        let other_cfg = "pub fn f() -> u8 { 1 } #[cfg(any(test, unix))] fn h() {} \
                         impl S { pub fn g(&self) {} }";
        assert_ne!(hashed(plain), hashed(other_cfg));
        assert_ne!(
            hashed(plain),
            hashed("pub fn f() -> u8 { 2 } impl S { pub fn g(&self) {} }")
        );
    }

    #[test]
    fn a_test_field_leaves_the_fields_after_it_hashed() {
        let with_field = "struct S { #[cfg(test)] a: u8, b: u8 }";
        assert_eq!(hashed(with_field), hashed("struct S { b: u8 }"));
        assert_ne!(
            hashed(with_field),
            hashed("struct S { #[cfg(test)] a: u8, b: u16 }")
        );
    }

    /// Two cities, one with neither a canopy nor a genus layer.
    const MANIFEST: &str = r#"{
      "cities": [
        {
          "id": "nyc",
          "bounds": {"south": 40.5, "west": -74.3, "north": 40.9, "east": -73.7},
          "field": {
            "trees": {"file": "nyc.bin"},
            "land": {"file": "nyc.bin"},
            "canopy": {"file": "nyc.bin"},
            "genus": {}
          },
          "streets": {"file": "nyc.bin", "sidewalkInsetMeters": 2},
          "paths": {"file": "nyc.bin"}
        },
        {
          "id": "sf",
          "bounds": {"south": 37.7, "west": -122.5, "north": 37.8, "east": -122.3},
          "field": {"trees": {"file": "sf.bin"}, "land": {"file": "sf.bin"}},
          "streets": {"file": "sf.bin", "sidewalkInsetMeters": 2}
        }
      ]
    }"#;

    fn plan_json(cities: &str) -> String {
        format!(
            r#"{{
              "code": {{}},
              "manifest": "src/tree-cover/manifest.json",
              "data": "data",
              "chunks": "public/streets",
              "casters": "public/casters",
              "commercialSignals": "public/commercial",
              "commercialLines": "public/commercial-lines",
              "tiles": "public/tiles",
              "canopyTiles": "public/tiles/canopy",
              "genusFieldTiles": "public/tiles/genus-field",
              "routing": "public/routing",
              "graphCache": ".build/graph-cache",
              "cities": {cities}
            }}"#
        )
    }

    fn plan(cities: &str) -> Plan {
        let mut plan: Plan = serde_json::from_str(&plan_json(cities)).expect("a plan");
        plan.code = code_map();
        plan
    }

    /// Every file some scope claims, hashed to its own name.
    fn code_map() -> BTreeMap<String, String> {
        claimed()
            .into_iter()
            .map(|module| format!("{SRC}/{module}"))
            .chain(BUILD_FILES.iter().map(|file| (*file).to_owned()))
            .map(|path| (path.clone(), format!("the bytes of {path}")))
            .collect()
    }

    /// Every module some scope or `UNSTAMPED` names, sorted and once each.
    fn claimed() -> Vec<String> {
        let mut claimed: Vec<String> = SCOPES
            .iter()
            .flat_map(|(scope, _)| scope.iter())
            .chain(&UNSTAMPED)
            .map(|module| (*module).to_owned())
            .collect();
        claimed.sort();
        claimed.dedup();
        claimed
    }

    /// New York with a two-bin sun grid and footprints to cast it.
    const SUNNY: &str = r#"[
      {"id": "nyc", "sources": ["buildings", "landmarks", "industrial", "historic"],
       "shade": {"maxZoom": 14, "maxShadowMeters": 500,
                 "buckets": [
                   {"season": 0, "hourAngle": -30.0, "elevation": 20.0, "azimuth": 120.0,
                    "intensity": 0.34, "samples": [{"east": 0.5, "north": 0.5,
                                                    "shadowPerHeight": 2.7}]},
                   {"season": 0, "hourAngle": 30.0, "elevation": 22.0, "azimuth": 240.0,
                    "intensity": 0.37, "samples": [{"east": -0.5, "north": 0.5,
                                                    "shadowPerHeight": 2.5}]}]}},
      {"id": "sf"}
    ]"#;

    fn manifest() -> Manifest {
        serde_json::from_str(MANIFEST).expect("a manifest")
    }

    const BOTH: &str = r#"[{"id": "nyc"}, {"id": "sf"}]"#;

    #[test]
    fn a_plan_entry_carries_the_sun_grid_and_the_dem_the_argv_lists_used_to() {
        let plan = plan(
            r#"[
              {"id": "nyc", "sources": ["sidewalks", "ferries", "buildings"], "alleys": true,
               "shade": {"maxZoom": 14, "maxShadowMeters": 500,
                         "buckets": [{"season": 0, "hourAngle": -30.0, "elevation": 20.0,
                                      "azimuth": 120.0, "intensity": 0.34,
                                      "samples": [{"east": 0.5, "north": 0.5,
                                                   "shadowPerHeight": 2.7}]}]}},
              {"id": "sf", "alleys": false,
               "elevation": [{"crs": "sf-cs13", "band": 0, "tiles": ["a.tif", "b.tif"]}]}
            ]"#,
        );

        let nyc = &plan.cities[0];
        let shade = nyc.shade.as_ref().expect("new york's sun grid");
        assert_eq!(shade.max_zoom, 14);
        assert_eq!(shade.buckets.len(), 1);
        assert_eq!(
            nyc.source(Path::new("data"), Source::Ferries),
            Some(PathBuf::from("data/ferries/nyc.bin"))
        );
        assert_eq!(nyc.source(Path::new("data"), Source::Art), None);
        let sf = &plan.cities[1];
        assert!(!sf.alleys);
        assert_eq!(sf.elevation.len(), 1);
        assert_eq!(sf.elevation[0].tiles.len(), 2);
    }

    #[test]
    fn a_city_that_says_nothing_about_alleys_gets_new_yorks_meaning() {
        assert!(plan(BOTH).cities[0].alleys);
    }

    #[test]
    fn a_source_kind_no_stage_reads_is_rejected() {
        let error = serde_json::from_str::<Plan>(&plan_json(
            r#"[{"id": "nyc", "sources": ["parks"]}, {"id": "sf"}]"#,
        ))
        .err()
        .expect("an unknown source kind");

        assert!(error.to_string().contains("parks"), "{error}");
    }

    #[test]
    fn a_misspelled_key_is_rejected_rather_than_skipping_its_stage() {
        let error = serde_json::from_str::<Plan>(&plan_json(BOTH).replace("casters", "castors"))
            .err()
            .expect("an unknown plan key");

        assert!(error.to_string().contains("castors"), "{error}");
    }

    #[test]
    fn the_manifest_and_the_plan_are_paired_in_manifest_order() {
        let manifest = manifest();
        let out_of_order = plan(r#"[{"id": "sf"}, {"id": "nyc"}]"#);
        let paired = out_of_order.pair(&manifest).expect("a pairing");

        let ids: Vec<&str> = paired.iter().map(|(city, _)| city.id.as_str()).collect();
        assert_eq!(ids, ["nyc", "sf"]);
        assert_eq!(paired[0].1.id, "nyc");
    }

    #[test]
    fn a_plan_city_the_manifest_does_not_carry_is_rejected() {
        let manifest = manifest();
        let error = plan(r#"[{"id": "nyc"}, {"id": "sf"}, {"id": "boston"}]"#)
            .pair(&manifest)
            .err()
            .expect("a city the manifest has never heard of");

        assert!(error.to_string().contains("boston"), "{error}");
    }

    #[test]
    fn a_manifest_city_the_plan_leaves_out_is_rejected() {
        let manifest = manifest();
        let error = plan(r#"[{"id": "nyc"}]"#)
            .pair(&manifest)
            .err()
            .expect("a city with no plan entry");

        assert!(error.to_string().contains("sf"), "{error}");
    }

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "tiler-build-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::remove_dir_all(&root)
            .or_else(absent)
            .expect("a clearing");
        root
    }

    fn planted(name: &str) -> Plan {
        let root = scratch(name);
        let mut plan = plan(BOTH);
        plan.canopy_tiles = root.join("tiles/canopy");
        plan.genus_field_tiles = root.join("tiles/genus-field");
        plan.tiles = root.join("tiles");
        plan.chunks = root.join("streets");
        plan.casters = root.join("casters");
        plan.commercial_signals = root.join("commercial");
        plan.commercial_lines = root.join("commercial-lines");
        plan.routing = root.join("routing");
        plan.graph_cache = root.join("graph-cache");
        plan
    }

    /// One city's share of `root`, among New York and San Francisco.
    fn share_pass(root: &Path, city: &str, stamp: &str) -> Pass {
        Pass::shared(
            stamp.to_owned(),
            Share::new(root, city, &["nyc", "sf"], &[]),
            Vec::new(),
        )
    }

    /// A tile at `relative` under `root`, as a pass would write it.
    fn plant(root: &Path, relative: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().expect("a row directory")).expect("a row");
        fs::write(path, relative).expect("a tile");
    }

    #[test]
    fn a_pass_is_fresh_only_when_its_stamp_and_its_output_both_hold() {
        let root = scratch("fresh");
        let pass = share_pass(&root.join("streets"), "nyc", "5eaf00d");
        assert!(!pass.is_fresh(), "nothing has recorded a stamp yet");

        pass.restart().expect("the output directory");
        pass.record().expect("the stamp");
        assert!(pass.is_fresh());

        fs::remove_file(ledger_file(&root.join("streets"), "nyc")).expect("a removal");
        assert!(!pass.is_fresh());
    }

    /// A tree restored with its stamp and its runs and no pyramid would ship Rain with nothing at z13.
    #[test]
    fn a_graph_is_stale_without_its_canopy_runs_or_their_pyramid() {
        let plan = planted("graph-witnesses");
        let manifest = manifest();
        let (leafy, bare) = (&manifest.cities[0], &manifest.cities[1]);
        assert!(leafy.field.canopy.is_some() && bare.field.canopy.is_none());
        for city in [leafy, bare] {
            let pass = graph_pass(&plan, city, "5eaf00d".to_owned(), None);
            fs::create_dir_all(&plan.routing).expect("the routing directory");
            for suffix in ["bin", "stranded.bin"] {
                fs::write(plan.routing.join(format!("{}.{suffix}", city.id)), b"x")
                    .expect("an artifact");
            }
            pass.record().expect("the stamp");
        }
        let fresh = |city: &City| graph_pass(&plan, city, "5eaf00d".to_owned(), None).is_fresh();

        assert!(fresh(bare), "a city with no canopy writes neither");
        assert!(!fresh(leafy), "neither is there yet");
        fs::write(canopy_runs_file(&plan, leafy), b"runs").expect("the runs");
        assert!(!fresh(leafy), "the runs without the pyramid");
        fs::create_dir_all(cover_tiles_dir(&plan, leafy)).expect("the pyramid");
        assert!(fresh(leafy));
        fs::remove_file(canopy_runs_file(&plan, leafy)).expect("a removal");
        assert!(!fresh(leafy), "the pyramid without the runs");
    }

    #[test]
    fn a_pass_that_reruns_clears_its_own_output_and_leaves_its_neighbors_alone() {
        let root = scratch("clearing");
        let mine = share_pass(&root.join("streets"), "nyc", "a");
        let theirs = share_pass(&root.join("casters"), "nyc", "b");
        for pass in [&mine, &theirs] {
            pass.restart().expect("a directory");
            fs::write(pass.stamp_file.with_file_name("last-build.bin"), b"stale")
                .expect("a stale file");
            pass.record().expect("a stamp");
        }

        mine.restart().expect("a clearing");

        assert!(root.join("streets").is_dir(), "the root is recreated");
        assert!(!root.join("streets").join("last-build.bin").exists());
        assert!(!mine.is_fresh(), "its own stamp went with its output");
        assert!(root.join("casters").join("last-build.bin").is_file());
        assert!(
            theirs.is_fresh(),
            "a neighbor rerunning is not this pass's business"
        );
    }

    #[test]
    fn a_city_s_restart_deletes_its_own_files_and_leaves_the_other_city_s() {
        let root = scratch("share-restart");
        let nyc = share_pass(&root, "nyc", "a");
        let sf = share_pass(&root, "sf", "b");
        nyc.restart().expect("a clearing");
        plant(&root, "1203/1536.bin");
        nyc.record().expect("new york's ledger");
        sf.restart().expect("a clearing");
        plant(&root, "654/1581.bin");
        sf.record().expect("san francisco's ledger");
        fs::write(root.join(".stamp-stranded-nyc"), b"a root dotfile").expect("a dotfile");

        nyc.restart().expect("a clearing");

        assert!(!root.join("1203").exists(), "its own tiles and their row");
        assert!(root.join("654/1581.bin").is_file());
        assert!(sf.is_fresh(), "the other city's claim stands");
        assert!(root.join(".stamp-stranded-nyc").is_file());
        assert!(!nyc.is_fresh());
    }

    #[test]
    fn a_record_ledgers_only_what_the_other_city_does_not_claim() {
        let root = scratch("share-record");
        let nyc = share_pass(&root, "nyc", "a");
        let sf = share_pass(&root, "sf", "b");
        sf.restart().expect("a clearing");
        plant(&root, "654/1581.bin");
        sf.record().expect("san francisco's ledger");
        nyc.restart().expect("a clearing");
        plant(&root, "1203/1537.bin");
        plant(&root, "1203/1536.bin");
        plant(&root, "1204/1536.bin");
        nyc.record().expect("new york's ledger");

        assert_eq!(
            fs::read_to_string(ledger_file(&root, "nyc")).expect("the ledger"),
            "1203/1536.bin\n1203/1537.bin\n1204/1536.bin\n"
        );
        assert_eq!(claims(&root, "sf").expect("a ledger"), ["654/1581.bin"]);
    }

    #[test]
    fn a_file_no_ledger_claims_and_the_legacy_stamp_are_deleted_by_the_reconcile() {
        let plan = planted("share-orphans");
        let nyc = share_pass(&plan.canopy_tiles, "nyc", "a");
        nyc.restart().expect("a clearing");
        plant(&plan.canopy_tiles, "9/150/192.webp");
        nyc.record().expect("new york's ledger");
        plant(&plan.canopy_tiles, "9/81/197.webp");
        plant(&plan.casters, "5232/12000.bin");
        fs::write(plan.casters.join(caster_chunks::INDEX), b"{}").expect("the index");
        for root in [&plan.canopy_tiles, &plan.chunks] {
            fs::create_dir_all(root).expect("a shared directory");
            fs::write(root.join(STAMP), b"one stamp for every city").expect("a legacy stamp");
        }
        fs::write(plan.chunks.join(".stamp-stranded"), b"legacy").expect("a legacy stamp");

        plan.reconcile(&manifest()).expect("a reconciliation");

        assert!(plan.canopy_tiles.join("9/150/192.webp").is_file());
        assert!(nyc.is_fresh());
        assert!(
            !plan.canopy_tiles.join("9/81").exists(),
            "a killed run's tile"
        );
        assert!(!plan.casters.join("5232").exists(), "the old layout's");
        assert!(plan.casters.join(caster_chunks::INDEX).is_file());
        assert!(!plan.canopy_tiles.join(STAMP).exists());
        assert!(!plan.chunks.join(STAMP).exists());
        assert!(!plan.chunks.join(".stamp-stranded").exists());
    }

    #[test]
    fn a_dropped_city_s_files_ledger_and_stamps_are_deleted_by_the_reconcile() {
        let plan = planted("share-dropped");
        for city in ["nyc", "boston"] {
            let pass = Pass::shared(
                "a".to_owned(),
                Share::new(&plan.chunks, city, &["nyc", "boston"], &[]),
                Vec::new(),
            );
            pass.restart().expect("a clearing");
            plant(&plan.chunks, &format!("{city}/1.bin"));
            pass.record().expect("a ledger");
            fs::write(plan.chunks.join(format!(".stamp-stranded-{city}")), b"a")
                .expect("a stranded stamp");
        }
        fs::create_dir_all(&plan.commercial_lines).expect("the lines");
        for city in ["nyc", "boston"] {
            fs::write(plan.commercial_lines.join(format!("{city}.bin")), b"lines")
                .expect("a city's lines");
        }

        plan.reconcile(&manifest()).expect("a reconciliation");

        for kept in [
            "nyc/1.bin",
            ".stamp-nyc",
            ".files-nyc",
            ".stamp-stranded-nyc",
        ] {
            assert!(plan.chunks.join(kept).is_file(), "{kept}");
        }
        for dropped in [
            "boston",
            ".stamp-boston",
            ".files-boston",
            ".stamp-stranded-boston",
        ] {
            assert!(!plan.chunks.join(dropped).exists(), "{dropped}");
        }
        assert!(plan.commercial_lines.join("nyc.bin").is_file());
        assert!(!plan.commercial_lines.join("boston.bin").exists());
    }

    #[test]
    fn a_chunk_restart_removes_its_own_city_s_stranded_stamp_and_not_the_other_s() {
        let plan = planted("share-stranded");
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        let passes: Vec<Pass> = cities
            .iter()
            .map(|(city, _)| {
                Pass::shared(
                    "a".to_owned(),
                    Share::new(&plan.chunks, &city.id, &["nyc", "sf"], &[]),
                    vec![stranded_stamp_file(&plan, city)],
                )
            })
            .collect();
        for ((city, _), pass) in cities.iter().zip(&passes) {
            pass.restart().expect("a clearing");
            pass.record().expect("a ledger");
            fs::write(stranded_stamp_file(&plan, city), b"a").expect("a stranded stamp");
        }

        passes[0].restart().expect("a clearing");

        assert!(!stranded_stamp_file(&plan, cities[0].0).exists());
        assert!(stranded_stamp_file(&plan, cities[1].0).is_file());
    }

    #[test]
    fn two_regions_sharing_a_z9_tile_fail_the_guard() {
        let plan = plan(BOTH);
        let apart = manifest();
        disjoint(&plan.pair(&apart).expect("a pairing")).expect("two cities a continent apart");

        let mut adjacent = manifest();
        adjacent.cities[1].bounds = Bounds {
            south: 40.6,
            west: -74.0,
            north: 40.7,
            east: -73.9,
        };
        let error = disjoint(&plan.pair(&adjacent).expect("a pairing"))
            .expect_err("a second region inside new york's tiles");

        assert!(error.to_string().contains("nyc and sf"), "{error}");
        assert!(error.to_string().contains("one manifest entry"), "{error}");
    }

    /// A pyramid or graph blob is removed and not recreated, since absence means "no such layer".
    #[test]
    fn a_city_that_stops_rendering_leaves_no_directory_behind() {
        let root = scratch("pieces");
        let overlay = root.join("tiles/elevation/nyc");
        let pass = Pass {
            stamp: "a".to_owned(),
            stamp_file: overlay.join(STAMP),
            share: None,
            pieces: vec![overlay.clone(), root.join("routing/shade/nyc")],
            witnesses: vec![overlay.clone()],
        };
        pass.restart().expect("the overlay");
        fs::create_dir_all(root.join("routing/shade/nyc")).expect("the per-edge bake");
        pass.record().expect("a stamp");
        assert!(pass.is_fresh());

        pass.clear().expect("a clearing");

        assert!(!overlay.exists());
        assert!(!root.join("routing/shade/nyc").exists());
    }

    #[test]
    fn output_a_dropped_city_left_behind_is_deleted() {
        let plan = planted("reconcile");
        for pyramid in Plan::PYRAMIDS {
            for city in ["nyc", "sf", "boston"] {
                fs::create_dir_all(plan.tiles.join(pyramid).join(city)).expect("a pyramid");
            }
        }
        for city in ["nyc", "sf", "boston"] {
            fs::create_dir_all(plan.routing.join("shade").join(city)).expect("a per-edge bake");
            fs::create_dir_all(plan.graph_cache.join(city)).expect("a cache directory");
            for suffix in ["bin", "stranded.bin", "canopy.bin", "version.json"] {
                fs::write(plan.routing.join(format!("{city}.{suffix}")), b"stale")
                    .expect("a routing artifact");
            }
            fs::write(plan.routing.join(format!(".stamp-{city}")), b"stale").expect("a stamp");
        }

        plan.reconcile(&manifest()).expect("a reconciliation");

        for pyramid in Plan::PYRAMIDS {
            assert!(plan.tiles.join(pyramid).join("nyc").is_dir(), "{pyramid}");
            assert!(
                !plan.tiles.join(pyramid).join("boston").exists(),
                "{pyramid}"
            );
        }
        for kept in [
            "nyc.bin",
            "nyc.stranded.bin",
            "nyc.canopy.bin",
            "nyc.version.json",
            ".stamp-nyc",
        ] {
            assert!(plan.routing.join(kept).is_file(), "{kept}");
        }
        for dropped in [
            "boston.bin",
            "boston.stranded.bin",
            "boston.canopy.bin",
            "boston.version.json",
            ".stamp-boston",
        ] {
            assert!(!plan.routing.join(dropped).exists(), "{dropped}");
        }
        assert!(plan.routing.join("shade").join("nyc").is_dir());
        assert!(!plan.routing.join("shade").join("boston").exists());
        assert!(plan.graph_cache.join("nyc").is_dir());
        assert!(!plan.graph_cache.join("boston").exists(), "its cache too");
    }

    fn only(terms: &[&str]) -> Selection {
        let terms: Vec<String> = terms.iter().map(|term| (*term).to_owned()).collect();
        Selection::new(&terms, false).expect("a selection")
    }

    #[test]
    fn a_pass_only_named_runs_and_one_it_left_out_does_not() {
        let selection = only(&["graph", "shade"]);

        assert!(
            selection
                .verdict(PassName::Graph, Some("nyc"), false)
                .runs()
        );
        assert!(selection.verdict(PassName::Shade, Some("sf"), false).runs());
        assert!(matches!(
            selection.verdict(PassName::Canopy, None, false),
            Verdict::Excluded
        ));
    }

    #[test]
    fn a_pass_narrowed_to_a_city_leaves_the_other_cities_out() {
        let selection = only(&["graph:nyc"]);

        assert!(
            selection
                .verdict(PassName::Graph, Some("nyc"), false)
                .runs()
        );
        assert!(matches!(
            selection.verdict(PassName::Graph, Some("sf"), false),
            Verdict::Excluded
        ));
    }

    #[test]
    fn a_pass_name_no_stage_answers_to_is_rejected() {
        let error = Selection::new(&["pyramid".to_owned()], false)
            .err()
            .expect("a name no pass answers to");

        assert!(error.to_string().contains("pyramid"), "{error}");
    }

    #[test]
    fn a_city_the_manifest_does_not_carry_is_rejected() {
        let error = only(&["graph:bosotn"])
            .check(&manifest())
            .expect_err("a city the manifest has never heard of");

        assert!(error.to_string().contains("bosotn"), "{error}");
    }

    /// A pass `--only` leaves out runs nothing and clears nothing, so its stale claim stands.
    #[test]
    fn a_pass_left_out_keeps_its_stale_stamp_for_the_next_full_build() {
        let root = scratch("only-untouched");
        let last = share_pass(&root.join("casters"), "nyc", "what the last build read");
        last.restart().expect("a directory");
        fs::write(last.stamp_file.with_file_name("chunk.bin"), b"last build").expect("a chunk");
        last.record().expect("a stamp");
        let now = share_pass(&root.join("casters"), "nyc", "what this one reads");
        assert!(!now.is_fresh(), "its inputs moved");

        let partial = only(&["graph"]);
        assert!(matches!(
            partial.verdict(PassName::CasterChunks, Some("nyc"), now.is_fresh()),
            Verdict::Excluded
        ));

        assert_eq!(
            fs::read_to_string(&now.stamp_file).expect("the stamp"),
            "what the last build read",
            "nothing of this build was recorded for it"
        );
        assert!(root.join("casters").join("chunk.bin").is_file());
        assert!(
            only(&[])
                .verdict(PassName::CasterChunks, Some("nyc"), now.is_fresh())
                .runs(),
            "and the next full build catches it"
        );
    }

    #[test]
    fn force_reruns_a_selected_pass_whose_stamp_holds() {
        let forced = Selection::new(&["shade".to_owned()], true).expect("a selection");

        assert!(forced.verdict(PassName::Shade, Some("nyc"), true).runs());
        assert!(forced.forces(PassName::Shade, Some("nyc")));
    }

    #[test]
    fn force_does_not_reach_a_pass_only_left_out() {
        let forced = Selection::new(&["shade".to_owned()], true).expect("a selection");

        assert!(matches!(
            forced.verdict(PassName::Graph, Some("nyc"), true),
            Verdict::Excluded
        ));
        assert!(!forced.forces(PassName::Graph, Some("nyc")));
    }

    /// A selected pass may run over stale output but not over missing output.
    #[test]
    fn a_selected_pass_whose_upstream_output_is_missing_says_which_pass_to_run_first() {
        let plan = planted("handoff-graph");
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        let partial = only(&["graph"]);

        let error = handoffs(&plan, &cities, &partial).expect_err("signals no pass has written");
        assert!(error.to_string().contains("commercial"), "{error}");

        fs::create_dir_all(&plan.commercial_signals).expect("the signals");
        for city in ["nyc", "sf"] {
            fs::write(ledger_file(&plan.commercial_signals, city), b"").expect("a ledger");
        }
        handoffs(&plan, &cities, &partial).expect("signals that are there, however old");
    }

    /// Both cities' chunk ledgers and an empty signal directory, as a chunks pass leaves them.
    fn plant_chunk_ledgers(plan: &Plan) {
        fs::create_dir_all(&plan.chunks).expect("the chunks");
        fs::create_dir_all(&plan.commercial_signals).expect("the signals");
        for city in ["nyc", "sf"] {
            fs::write(ledger_file(&plan.chunks, city), b"").expect("a ledger");
        }
    }

    #[test]
    fn a_narrowed_commercial_pass_needs_only_its_own_city_s_chunks() {
        let plan = planted("handoff-commercial");
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        fs::create_dir_all(&plan.chunks).expect("the chunks");
        fs::write(ledger_file(&plan.chunks, "nyc"), b"").expect("a ledger");

        handoffs(&plan, &cities, &only(&["commercial:nyc"])).expect("new york's chunks");
        let error =
            handoffs(&plan, &cities, &only(&["commercial"])).expect_err("san francisco's chunks");
        assert!(error.to_string().contains(".files-sf"), "{error}");
    }

    #[test]
    fn the_re_chunk_will_not_run_over_a_stranded_set_no_graph_has_written() {
        let plan = planted("handoff-stranded");
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        let partial = only(&["chunks-stranded"]);
        plant_chunk_ledgers(&plan);

        let error =
            handoffs(&plan, &cities, &partial).expect_err("a stranded set no graph has written");

        assert!(error.to_string().contains("nyc.stranded.bin"), "{error}");
        assert!(error.to_string().contains("--only graph"), "{error}");
    }

    /// A pass keyed on an upstream this build won't run folds the recorded upstream stamp.
    #[test]
    fn a_selected_pass_folds_the_upstream_stamp_that_is_actually_on_disk() {
        let root = scratch("upstream");
        let chunks = share_pass(&root.join("streets"), "nyc", "what the chunks will be");
        chunks.restart().expect("a directory");
        fs::write(&chunks.stamp_file, "what the chunks are").expect("a stamp");

        assert_eq!(
            upstream(
                &only(&["commercial"]),
                PassName::Chunks,
                Some("nyc"),
                &chunks
            )
            .expect("a stamp"),
            "what the chunks are",
            "the claim over the chunks the commercial pass is about to read"
        );
        assert_eq!(
            upstream(
                &only(&["chunks", "commercial"]),
                PassName::Chunks,
                Some("nyc"),
                &chunks
            )
            .expect("a stamp"),
            "what the chunks will be",
            "a pass this build is running leaves the stamp it just computed"
        );
        assert_eq!(
            upstream(&only(&[]), PassName::Chunks, Some("nyc"), &chunks).expect("a stamp"),
            "what the chunks will be",
            "and so does every pass of a full build"
        );

        fs::remove_file(&chunks.stamp_file).expect("a removal");
        assert_eq!(
            upstream(
                &only(&["commercial"]),
                PassName::Chunks,
                Some("nyc"),
                &chunks
            )
            .expect("a stamp"),
            UNRECORDED
        );
    }

    #[test]
    fn a_graph_narrowed_to_one_city_does_not_answer_for_the_others() {
        let plan = planted("handoff-narrowed");
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        plant_chunk_ledgers(&plan);
        // The graph's handoff is checked first, so this keeps the error on the narrowed city.
        fs::write(ledger_file(&plan.commercial_signals, "nyc"), b"").expect("a ledger");
        fs::create_dir_all(&plan.routing).expect("the routing directory");
        fs::write(plan.routing.join("nyc.stranded.bin"), b"a stranded set")
            .expect("new york's stranded set");

        let error = handoffs(&plan, &cities, &only(&["chunks-stranded", "graph:nyc"]))
            .expect_err("san francisco's stranded set");

        assert!(error.to_string().contains("sf.stranded.bin"), "{error}");
    }

    #[test]
    fn a_full_build_needs_no_handoff() {
        let plan = planted("handoff-full");
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");

        handoffs(&plan, &cities, &only(&[])).expect("nothing to ask for");
    }

    fn planted_pyramid(name: &str, keys: &[&str]) -> ShadePyramid {
        let root = scratch(name);
        ShadePyramid {
            buildings: root.join("tiles/shade/nyc"),
            trees: root.join("tiles/tree-shade/nyc"),
            keys: keys.iter().map(|key| (*key).to_owned()).collect(),
        }
    }

    /// A finished bucket: a tile named after its bin, and its key (`None` for a killed render).
    fn plant_bucket(root: &Path, index: usize, key: Option<&str>) {
        let directory = root.join(index.to_string());
        fs::create_dir_all(&directory).expect("a bucket");
        fs::write(directory.join("tile.webp"), format!("bin {index}")).expect("a tile");
        if let Some(key) = key {
            fs::write(directory.join(STAMP), key).expect("a key");
        }
    }

    fn tile_of(root: &Path, index: usize) -> Option<String> {
        fs::read_to_string(root.join(index.to_string()).join("tile.webp")).ok()
    }

    /// A bin inserted at the front shifts every index; the later bins move rather than re-render.
    #[test]
    fn a_bucket_the_schedule_kept_is_moved_into_its_new_index_rather_than_rendered() {
        let pyramid = planted_pyramid("shade-insert", &["new", "morning", "noon"]);
        plant_bucket(&pyramid.buildings, 0, Some("morning"));
        plant_bucket(&pyramid.buildings, 1, Some("noon"));

        let render = pyramid.reconcile().expect("a reconciliation");

        assert_eq!(render.len(), 1, "only the bin nothing on disk claimed");
        assert_eq!(render[0].index, 0);
        assert_eq!(render[0].key, "new");
        assert_eq!(render[0].stamp, pyramid.buildings.join("0").join(STAMP));
        assert_eq!(tile_of(&pyramid.buildings, 1).as_deref(), Some("bin 0"));
        assert_eq!(tile_of(&pyramid.buildings, 2).as_deref(), Some("bin 1"));
        assert!(!pyramid.buildings.join("0").exists(), "the bin to render");
    }

    #[test]
    fn a_bucket_the_schedule_dropped_costs_moves_and_nothing_else() {
        let pyramid = planted_pyramid("shade-drop", &["morning", "noon"]);
        plant_bucket(&pyramid.buildings, 0, Some("dawn"));
        plant_bucket(&pyramid.buildings, 1, Some("morning"));
        plant_bucket(&pyramid.buildings, 2, Some("noon"));

        let render = pyramid.reconcile().expect("a reconciliation");

        assert!(render.is_empty());
        assert_eq!(tile_of(&pyramid.buildings, 0).as_deref(), Some("bin 1"));
        assert_eq!(tile_of(&pyramid.buildings, 1).as_deref(), Some("bin 2"));
        assert!(!pyramid.buildings.join("2").exists());
    }

    #[test]
    fn a_bucket_nothing_claims_is_deleted() {
        let pyramid = planted_pyramid("shade-zombie", &["morning"]);
        plant_bucket(&pyramid.buildings, 0, Some("morning"));
        plant_bucket(
            &pyramid.buildings,
            1,
            Some("a bin the sun grid no longer has"),
        );
        plant_bucket(&pyramid.trees, 0, None);
        plant_bucket(&pyramid.trees, 1, None);

        let render = pyramid.reconcile().expect("a reconciliation");

        assert!(render.is_empty());
        assert!(!pyramid.buildings.join("1").exists());
        assert!(!pyramid.trees.join("1").exists(), "the twin goes with it");
    }

    #[test]
    fn the_tree_twin_moves_with_its_bucket() {
        let pyramid = planted_pyramid("shade-twin", &["new", "morning"]);
        plant_bucket(&pyramid.buildings, 0, Some("morning"));
        plant_bucket(&pyramid.trees, 0, None);

        let render = pyramid.reconcile().expect("a reconciliation");

        assert_eq!(render.len(), 1);
        assert_eq!(tile_of(&pyramid.trees, 1).as_deref(), Some("bin 0"));
        assert!(!pyramid.trees.join("0").exists());
    }

    #[test]
    fn a_bucket_left_half_written_claims_nothing() {
        let pyramid = planted_pyramid("shade-killed", &["morning"]);
        plant_bucket(&pyramid.buildings, 0, None);

        let render = pyramid.reconcile().expect("a reconciliation");

        assert_eq!(render.len(), 1);
        assert_eq!(render[0].index, 0);
        assert!(!pyramid.buildings.join("0").exists());
    }

    /// The schedule is rewritten every build, since the reconcile moves directories.
    #[test]
    fn the_schedule_is_written_again_every_build() {
        let pyramid = planted_pyramid("shade-schedule", &["morning"]);
        plant_bucket(&pyramid.buildings, 0, Some("morning"));
        let schedule = pyramid.buildings.join("buckets.json");
        fs::write(&schedule, b"[{\"index\": 7}]").expect("a stale schedule");

        let render = pyramid.reconcile().expect("a reconciliation");

        assert!(render.is_empty());
        assert!(
            !schedule.exists(),
            "the stale one does not outlive the moves"
        );
        let params: shade::Params = serde_json::from_str(
            r#"{"maxZoom": 14, "maxShadowMeters": 500,
                "buckets": [{"season": 0, "hourAngle": -30.0, "elevation": 20.0, "azimuth": 120.0,
                             "intensity": 0.34, "samples": []}]}"#,
        )
        .expect("a sun grid");
        shade::write_schedule(&pyramid.buildings, &params).expect("a schedule");
        assert!(schedule.is_file());
    }

    #[test]
    fn a_city_that_stops_casting_leaves_neither_pyramid_behind() {
        let pyramid = planted_pyramid("shade-cleared", &[]);
        plant_bucket(&pyramid.buildings, 0, Some("morning"));
        plant_bucket(&pyramid.trees, 0, None);

        pyramid.clear().expect("a clearing");

        assert!(!pyramid.buildings.exists());
        assert!(!pyramid.trees.exists());
    }

    /// Every file a pass could name, each containing its path; dining and open streets absent.
    const INPUTS: [(&str, &str); 15] = [
        ("streets", "nyc.bin"),
        ("streets", "sf.bin"),
        ("paths", "nyc.bin"),
        ("sidewalks", "nyc.bin"),
        ("sidewalks", "sf.bin"),
        ("land", "nyc.bin"),
        ("land", "sf.bin"),
        ("trees", "nyc.bin"),
        ("trees", "sf.bin"),
        ("canopy", "nyc.bin"),
        ("landuse", "nyc.bin"),
        ("buildings", "nyc.bin"),
        ("landmarks", "nyc.bin"),
        ("industrial", "nyc.bin"),
        ("historic", "nyc.bin"),
    ];

    fn stamping_plan(name: &str) -> Plan {
        let root = scratch(name);
        let data = root.join("data");
        for (kind, file) in INPUTS {
            fs::create_dir_all(data.join(kind)).expect("a source directory");
            fs::write(data.join(kind).join(file), format!("{kind}/{file}")).expect("a source");
        }
        fs::write(root.join("manifest.json"), MANIFEST).expect("a manifest");
        let mut plan = plan(SUNNY);
        plan.data = data;
        plan.manifest = root.join("manifest.json");
        plan.graph_cache = root.join("graph-cache");
        plan
    }

    /// One stamp per pass, all New York's.
    struct Stamped {
        chunks: String,
        commercial: String,
        casters: String,
        buckets: Vec<String>,
        elevation: String,
        canopy: String,
        genus_field: String,
        graph: String,
        keys: graph_cache::Keys,
    }

    fn bucket_keys(plan: &Plan) -> Vec<String> {
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        let mut stamps = Stamps::new(plan).expect("the stamps");
        let (city, planned) = cities[0];
        let params = planned.shade.as_ref().expect("a sun grid");
        params
            .buckets
            .iter()
            .map(|bucket| {
                stamps
                    .shade_bucket(city, params, bucket)
                    .expect("a bucket key")
            })
            .collect()
    }

    fn stamped_passes(plan: &Plan) -> Stamped {
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        let mut stamps = Stamps::new(plan).expect("the stamps");
        let (city, planned) = cities[0];
        let chunks = stamps.chunks(city).expect("the chunks stamp");
        let commercial = stamps
            .commercial(city, &chunks)
            .expect("the commercial stamp");
        let keys = stamps
            .graph_keys(city, planned, &commercial, true)
            .expect("the graph keys");
        Stamped {
            casters: stamps
                .casters(city, planned.shade.as_ref())
                .expect("the caster-chunks stamp"),
            buckets: bucket_keys(plan),
            elevation: stamps
                .elevation(city, planned)
                .expect("the elevation stamp"),
            canopy: stamps.canopy(city).expect("the canopy stamp"),
            genus_field: stamps.genus_field(city).expect("the genus-field stamp"),
            graph: stamps.graph(&keys),
            keys,
            chunks,
            commercial,
        }
    }

    /// Every stamp of one city, in pass order, graph keys included.
    fn every_stamp(plan: &Plan, manifest: &Manifest, index: usize) -> Vec<String> {
        let cities = plan.pair(manifest).expect("a pairing");
        let mut stamps = Stamps::new(plan).expect("the stamps");
        let (city, planned) = cities[index];
        let chunks = stamps.chunks(city).expect("the chunks stamp");
        let commercial = stamps
            .commercial(city, &chunks)
            .expect("the commercial stamp");
        let keys = stamps
            .graph_keys(city, planned, &commercial, true)
            .expect("the graph keys");
        let mut every = vec![
            chunks.clone(),
            commercial.clone(),
            stamps
                .casters(city, planned.shade.as_ref())
                .expect("the caster-chunks stamp"),
            stamps
                .elevation(city, planned)
                .expect("the elevation stamp"),
            stamps.canopy(city).expect("the canopy stamp"),
            stamps.genus_field(city).expect("the genus-field stamp"),
            stamps.graph(&keys),
            stamps
                .stranded_chunks(city, &chunks, &[30, 31])
                .expect("the stranded stamp"),
        ];
        if let Some(params) = &planned.shade {
            for bucket in &params.buckets {
                every.push(
                    stamps
                        .shade_bucket(city, params, bucket)
                        .expect("a bucket key"),
                );
            }
        }
        every.extend([
            keys.base,
            keys.landmarks,
            keys.art,
            keys.highways,
            keys.industrial,
            keys.historic,
            keys.bridge,
            keys.canopy,
            keys.commercial,
            keys.relief,
        ]);
        every.extend(keys.shade);
        every
    }

    #[test]
    fn an_edit_to_one_city_s_entry_moves_none_of_the_other_city_s_stamps() {
        let plan = stamping_plan("stamps-other-city");
        let mut edited = manifest();
        edited.cities[1].streets.sidewalk_inset_meters += 1.0;

        assert_eq!(
            every_stamp(&plan, &edited, 0),
            every_stamp(&plan, &manifest(), 0),
            "New York's passes stand"
        );
        assert_ne!(
            every_stamp(&plan, &edited, 1)[0],
            every_stamp(&plan, &manifest(), 1)[0],
            "San Francisco's chunks rerun"
        );
    }

    #[test]
    fn the_graph_s_commercial_key_moves_with_its_own_city_s_commercial_stamp_alone() {
        let plan = stamping_plan("stamps-commercial-key");
        let commercial_key = |plan: &Plan| {
            let manifest = manifest();
            let cities = plan.pair(&manifest).expect("a pairing");
            let mut stamps = Stamps::new(plan).expect("the stamps");
            cities
                .iter()
                .map(|(city, planned)| {
                    let chunks = stamps.chunks(city).expect("the chunks stamp");
                    let commercial = stamps
                        .commercial(city, &chunks)
                        .expect("the commercial stamp");
                    stamps
                        .graph_keys(city, planned, &commercial, false)
                        .expect("the graph keys")
                        .commercial
                })
                .collect::<Vec<String>>()
        };
        let before = commercial_key(&plan);

        fs::write(plan.data.join("landuse").join("nyc.bin"), b"re-ingested").expect("a source");
        let after = commercial_key(&plan);

        assert_ne!(after[0], before[0], "New York's commercial column");
        assert_eq!(after[1], before[1], "San Francisco's");
    }

    #[test]
    fn a_build_over_inputs_that_have_not_moved_stamps_every_pass_the_same() {
        let plan = stamping_plan("stamps-still");
        let before = stamped_passes(&plan);
        let again = stamped_passes(&plan);

        assert_eq!(again.chunks, before.chunks);
        assert_eq!(again.commercial, before.commercial);
        assert_eq!(again.casters, before.casters);
        assert_eq!(again.buckets, before.buckets);
        assert_eq!(again.elevation, before.elevation);
        assert_eq!(again.canopy, before.canopy);
        assert_eq!(again.genus_field, before.genus_field);
        assert_eq!(again.graph, before.graph);
    }

    /// A re-ingested source reruns the passes that read it and nothing else.
    #[test]
    fn a_re_ingested_source_moves_only_the_stamps_of_the_passes_that_read_it() {
        let plan = stamping_plan("stamps-moved");
        let before = stamped_passes(&plan);

        fs::write(plan.data.join("landuse").join("nyc.bin"), b"re-ingested").expect("a source");
        let after = stamped_passes(&plan);

        assert_ne!(after.commercial, before.commercial);
        assert_ne!(after.graph, before.graph);
        assert_eq!(after.chunks, before.chunks);
        assert_eq!(after.casters, before.casters);
        assert_eq!(after.buckets, before.buckets, "the twenty-minute pass");
        assert_eq!(after.elevation, before.elevation);
        assert_eq!(after.canopy, before.canopy);
        assert_eq!(after.genus_field, before.genus_field);
    }

    /// The genus field clips and normalizes its blur by the land, so a new shoreline repaints it.
    #[test]
    fn a_re_ingested_shoreline_moves_the_genus_field() {
        let plan = stamping_plan("stamps-land");
        let before = stamped_passes(&plan);

        fs::write(plan.data.join("land").join("nyc.bin"), b"re-ingested").expect("a source");
        let after = stamped_passes(&plan);

        assert_ne!(after.genus_field, before.genus_field);
        assert_ne!(after.canopy, before.canopy);
        assert_eq!(after.chunks, before.chunks);
    }

    /// A pass reruns when its upstream does: commercial signals are keyed on chunk segment order.
    #[test]
    fn a_pass_reruns_when_the_pass_it_consumes_does() {
        let plan = stamping_plan("stamps-upstream");
        let before = stamped_passes(&plan);

        fs::write(plan.data.join("streets").join("nyc.bin"), b"re-ingested").expect("a source");
        let after = stamped_passes(&plan);

        assert_ne!(after.chunks, before.chunks);
        assert_ne!(after.commercial, before.commercial);
        assert_ne!(after.graph, before.graph);
        assert_eq!(after.buckets, before.buckets);
        assert_eq!(after.canopy, before.canopy);
    }

    #[test]
    fn a_source_that_was_not_there_last_build_moves_the_stamp_by_appearing() {
        let plan = stamping_plan("stamps-appeared");
        let before = stamped_passes(&plan);

        fs::create_dir_all(plan.data.join("dining")).expect("a source directory");
        fs::write(plan.data.join("dining").join("nyc.bin"), b"ingested").expect("a source");

        assert_ne!(stamped_passes(&plan).commercial, before.commercial);
    }

    fn edited(plan: &mut Plan, module: &str) {
        plan.code
            .insert(format!("{SRC}/{module}"), "a different tiler".to_owned());
    }

    /// A helper every scope reaches reruns every pass, since a format change moves no input file.
    #[test]
    fn an_edit_to_a_shared_helper_reruns_every_pass() {
        let mut plan = stamping_plan("stamps-helper");
        let before = stamped_passes(&plan);
        edited(&mut plan, "geometry.rs");
        let after = stamped_passes(&plan);

        assert_ne!(after.chunks, before.chunks);
        assert_ne!(after.commercial, before.commercial);
        assert_ne!(after.casters, before.casters);
        assert_ne!(after.buckets, before.buckets);
        assert_ne!(after.elevation, before.elevation);
        assert_ne!(after.canopy, before.canopy);
        assert_ne!(after.genus_field, before.genus_field);
        assert_ne!(after.graph, before.graph);
        assert_ne!(after.keys.relief, before.keys.relief);
    }

    /// A shade edit reruns the passes that call into shade.rs and leaves the rest standing.
    #[test]
    fn a_shade_edit_reruns_the_passes_that_read_shade_alone() {
        let mut plan = stamping_plan("stamps-shade-scope");
        let before = stamped_passes(&plan);
        edited(&mut plan, "shade.rs");
        let after = stamped_passes(&plan);

        assert_ne!(after.buckets, before.buckets);
        assert_ne!(after.casters, before.casters, "which cut with its halo");
        assert_ne!(after.graph, before.graph, "which bakes it per edge");
        assert_eq!(after.chunks, before.chunks);
        assert_eq!(after.commercial, before.commercial);
        assert_eq!(after.elevation, before.elevation, "the DEM resample");
        assert_eq!(after.canopy, before.canopy);
        assert_eq!(after.genus_field, before.genus_field);
    }

    #[test]
    fn an_edit_the_shade_pass_does_not_read_leaves_the_pyramid_standing() {
        let mut plan = stamping_plan("stamps-scope");
        let before = stamped_passes(&plan);
        edited(&mut plan, "graph.rs");
        let after = stamped_passes(&plan);

        assert_ne!(after.graph, before.graph);
        assert_eq!(after.buckets, before.buckets);
        assert_eq!(after.casters, before.casters);
        assert_eq!(after.chunks, before.chunks);
        assert_eq!(after.commercial, before.commercial);
        assert_eq!(after.elevation, before.elevation);
        assert_eq!(after.canopy, before.canopy);
        assert_eq!(after.genus_field, before.genus_field);
    }

    /// The existence gate runs in the cached topology, so its ceilings key the base.
    #[test]
    fn new_existence_ceilings_rerun_the_topology_and_the_default_spelled_out_does_not() {
        let mut plan = stamping_plan("stamps-ceilings");
        let before = stamped_passes(&plan);
        let with = |ceilings: &str| {
            SUNNY.replacen(
                r#"{"id": "nyc", "#,
                &format!(r#"{{"id": "nyc", "existenceCeilings": {ceilings}, "#),
                1,
            )
        };

        plan.cities = serde_json::from_str(&with(
            r#"{"droppedSidewalkFraction": 0.3, "cellDemotedShare": 0.3}"#,
        ))
        .expect("the default ceilings");
        let spelled = stamped_passes(&plan);
        assert_eq!(spelled.keys.base, before.keys.base);
        assert_eq!(spelled.graph, before.graph);

        plan.cities = serde_json::from_str(&with(
            r#"{"droppedSidewalkFraction": 0.2, "cellDemotedShare": 0.3}"#,
        ))
        .expect("tighter ceilings");
        let tighter = stamped_passes(&plan);
        assert_ne!(tighter.keys.base, before.keys.base);
        assert_ne!(tighter.graph, before.graph);
        assert_eq!(tighter.chunks, before.chunks, "no other pass reads them");
    }

    /// An edit to a module only `tiler ingest` runs moves no stamp, nor any graph column.
    #[test]
    fn an_edit_no_pass_reads_moves_no_stamp() {
        let mut plan = stamping_plan("stamps-unread");
        let before = stamped_passes(&plan);
        edited(&mut plan, "densities.rs");
        let after = stamped_passes(&plan);

        assert_eq!(after.chunks, before.chunks);
        assert_eq!(after.commercial, before.commercial);
        assert_eq!(after.casters, before.casters);
        assert_eq!(after.buckets, before.buckets);
        assert_eq!(after.elevation, before.elevation);
        assert_eq!(after.canopy, before.canopy);
        assert_eq!(after.genus_field, before.genus_field);
        assert_eq!(after.graph, before.graph);
        assert_eq!(after.keys.base, before.keys.base);
        assert_eq!(after.keys.relief, before.keys.relief, "no GeoTIFF read");
        assert_eq!(after.keys.shade, before.keys.shade, "no ray cast");
        assert_eq!(after.keys.commercial, before.keys.commercial);
        assert_eq!(after.keys.canopy, before.keys.canopy);
    }

    #[test]
    fn an_edit_the_relief_bake_reads_rebakes_it() {
        let mut plan = stamping_plan("stamps-relief-scope");
        let before = stamped_passes(&plan);
        edited(&mut plan, "dem.rs");
        let after = stamped_passes(&plan);

        assert_ne!(after.keys.relief, before.keys.relief);
        assert_ne!(after.keys.base, before.keys.base);
    }

    /// Comments and reformatting don't move the hash; doc comments do.
    #[test]
    fn a_comment_moves_no_module_hash_and_a_line_of_code_does() {
        let root = scratch("token-hash");
        fs::create_dir_all(&root).expect("a scratch tree");
        let module = root.join("module.rs");
        let write = |body: &str| fs::write(&module, body).expect("a module");

        write("/// doc\nfn area(side: f64) -> f64 {\n    // a comment\n    side * side\n}\n");
        let before = token_oid(&module).expect("a hash");
        write("/// doc\nfn area( side : f64 )->f64{ /* moved */ side*side }\n");
        assert_eq!(token_oid(&module).as_ref(), Some(&before), "a comment");
        write("/// doc\nfn area(side: f64) -> f64 {\n    side * 2.0\n}\n");
        assert_ne!(token_oid(&module).as_ref(), Some(&before), "an edit");
        write("/// other\nfn area(side: f64) -> f64 {\n    side * side\n}\n");
        assert_ne!(token_oid(&module).as_ref(), Some(&before), "a doc comment");
    }

    /// Only `.rs` entries are rehashed; a lockfile has no token stream.
    #[test]
    fn the_code_map_carries_token_hashes_for_its_modules_alone() {
        let mut plan = plan(BOTH);
        let lockfile = plan.code["Cargo.lock"].clone();
        plan.hash_source_tokens();

        assert_ne!(
            plan.code[&format!("{SRC}/shade.rs")],
            "the bytes of shade.rs"
        );
        assert_eq!(plan.code["Cargo.lock"], lockfile);
    }

    /// A bucket is stamped on its own bin, not on the schedule's shape.
    #[test]
    fn a_bucket_key_says_nothing_about_the_rest_of_the_schedule() {
        let plan = stamping_plan("stamps-bucket");
        let before = bucket_keys(&plan);
        let after = bucket_keys(&grown("stamps-bucket-grown"));

        assert_eq!(after.len(), before.len() + 1);
        assert_eq!(after[1..], before[..], "the bins that did not move");
    }

    /// The driver's grid with one more bin at the front, where an earlier hour sorts.
    fn grown(name: &str) -> Plan {
        let mut plan = stamping_plan(name);
        let inserted = r#"{"season": 0, "hourAngle": 0.0, "elevation": 30.0, "azimuth": 180.0,
                           "intensity": 0.5, "samples": [{"east": 0.0, "north": 1.0,
                                                          "shadowPerHeight": 1.7}]},"#;
        plan.cities = serde_json::from_str(
            &SUNNY.replace(r#""buckets": ["#, &format!(r#""buckets": [{inserted}"#)),
        )
        .expect("a grown schedule");
        plan
    }

    /// A re-ingested attribute source rekeys only its column.
    #[test]
    fn a_re_ingested_attribute_moves_one_column_and_leaves_the_topology_standing() {
        let plan = stamping_plan("keys-column");
        let before = stamped_passes(&plan);

        fs::write(plan.data.join("industrial").join("nyc.bin"), b"re-ingested").expect("a source");
        let after = stamped_passes(&plan);

        assert_ne!(after.keys.industrial, before.keys.industrial);
        assert_ne!(after.graph, before.graph, "so the pass reruns at all");
        assert_eq!(after.keys.base, before.keys.base, "the sequential half");
        assert_eq!(after.keys.landmarks, before.keys.landmarks);
        assert_eq!(after.keys.historic, before.keys.historic);
        assert_eq!(after.keys.canopy, before.keys.canopy);
        assert_eq!(after.keys.relief, before.keys.relief, "the DEM decode");
        assert_eq!(
            after.keys.shade, before.keys.shade,
            "the twenty-minute bake"
        );
    }

    /// Enforces that each column key reaches pass 8's stamp, which decides if the pass runs.
    #[test]
    fn a_re_ingested_historic_source_moves_the_graph_stamp() {
        let plan = stamping_plan("keys-historic");
        let before = stamped_passes(&plan);

        fs::write(plan.data.join("historic").join("nyc.bin"), b"re-ingested").expect("a source");
        let after = stamped_passes(&plan);

        assert_ne!(after.keys.historic, before.keys.historic);
        assert_ne!(after.graph, before.graph, "so the pass reruns at all");
        assert_eq!(after.keys.base, before.keys.base, "the sequential half");
        assert_eq!(after.keys.industrial, before.keys.industrial);
        assert_eq!(after.keys.canopy, before.keys.canopy);
        assert_eq!(
            after.keys.shade, before.keys.shade,
            "the twenty-minute bake"
        );
    }

    /// A street input moves the base and so rekeys every column.
    #[test]
    fn a_street_that_moved_moves_the_base_and_every_column_with_it() {
        let plan = stamping_plan("keys-base");
        let before = stamped_passes(&plan);

        fs::write(plan.data.join("streets").join("nyc.bin"), b"re-ingested").expect("a source");
        let after = stamped_passes(&plan);

        assert_ne!(after.keys.base, before.keys.base);
        for (moved, held) in [
            (&after.keys.landmarks, &before.keys.landmarks),
            (&after.keys.art, &before.keys.art),
            (&after.keys.highways, &before.keys.highways),
            (&after.keys.commercial, &before.keys.commercial),
            (&after.keys.relief, &before.keys.relief),
            (&after.keys.canopy, &before.keys.canopy),
            (&after.keys.industrial, &before.keys.industrial),
            (&after.keys.historic, &before.keys.historic),
        ] {
            assert_ne!(moved, held);
        }
        assert!(
            after
                .keys
                .shade
                .iter()
                .zip(&before.keys.shade)
                .all(|(after, before)| after != before)
        );
    }

    /// The shade bake is keyed per bin, so an inserted bin bakes only that bin.
    #[test]
    fn an_inserted_sun_bin_leaves_the_other_bins_shade_columns_alone() {
        let before = stamped_passes(&stamping_plan("keys-bins")).keys.shade;
        let after = stamped_passes(&grown("keys-bins-grown")).keys.shade;

        assert_eq!(after.len(), before.len() + 1);
        assert_eq!(after[1..], before[..], "the bins that did not move");
    }

    #[test]
    fn a_city_that_stops_baking_shade_moves_the_graph_stamp() {
        let plan = stamping_plan("keys-unshaded");
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        let mut stamps = Stamps::new(&plan).expect("the stamps");
        let (city, planned) = cities[0];
        let baked = stamps
            .graph_keys(city, planned, "commercial", true)
            .expect("the graph keys");
        let unbaked = stamps
            .graph_keys(city, planned, "commercial", false)
            .expect("the graph keys");

        assert_eq!(baked.base, unbaked.base);
        assert!(unbaked.shade.is_empty());
        assert_ne!(stamps.graph(&baked), stamps.graph(&unbaked));
    }

    /// An inserted bin leaves the caster chunks alone; a changed halo does not.
    #[test]
    fn the_caster_chunks_follow_the_halo_and_not_the_schedule() {
        let plan = stamping_plan("casters-halo");
        let before = stamped_passes(&plan).casters;

        assert_eq!(
            stamped_passes(&grown("casters-halo-grown")).casters,
            before,
            "one more bin is the same 166 MB of chunks"
        );

        let mut widened = stamping_plan("casters-halo-wider");
        widened.cities = serde_json::from_str(
            &SUNNY.replace(r#""maxShadowMeters": 500"#, r#""maxShadowMeters": 600"#),
        )
        .expect("a wider halo");
        assert_ne!(stamped_passes(&widened).casters, before);
    }

    /// The footprints are one city-wide file, so a re-ingest re-renders the whole pyramid.
    #[test]
    fn a_building_re_ingest_moves_every_bucket_key() {
        let plan = stamping_plan("stamps-buildings");
        let before = bucket_keys(&plan);
        fs::write(plan.data.join("buildings").join("nyc.bin"), b"re-ingested").expect("a source");
        let after = bucket_keys(&plan);

        assert!(
            after
                .iter()
                .zip(&before)
                .all(|(after, before)| after != before)
        );
    }

    /// Every module must be in some scope, checked against the directory.
    #[test]
    fn every_module_of_the_tiler_is_claimed_by_a_code_scope() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut found: Vec<String> = Vec::new();
        let mut pending = vec![src.clone()];
        while let Some(directory) = pending.pop() {
            for entry in listing(&directory).expect("the crate's modules") {
                if entry.is_dir() {
                    pending.push(entry);
                } else {
                    let name = entry.strip_prefix(&src).expect("a module inside the crate");
                    found.push(name.to_string_lossy().into_owned());
                }
            }
        }
        found.sort();

        assert_eq!(found, claimed());
    }

    /// A module no stamp names must be one no scope reaches, or the list is hiding a dependency.
    #[test]
    fn no_scope_reaches_a_module_listed_as_unstamped() {
        for (scope, _) in SCOPES {
            for module in closure_of(scope) {
                assert!(
                    !UNSTAMPED.contains(&module.as_str()),
                    "{} reaches {module}",
                    scope[0]
                );
            }
        }
    }

    /// Every item a `crate::` path names, including `pub use`, brace groups and qualified paths.
    fn crate_heads(stream: TokenStream, in_test: bool, found: &mut Vec<String>) {
        let trees: Vec<TokenTree> = stream.into_iter().collect();
        let colon = |tree: Option<&TokenTree>| matches!(tree, Some(TokenTree::Punct(punct)) if punct.as_char() == ':');
        // `#[cfg(test)] mod name { .. }`, whose `super::` paths are the test module's own.
        let test_module = |index: usize| {
            index >= 3
                && matches!(&trees[index - 1], TokenTree::Ident(name) if name != "mod")
                && matches!(&trees[index - 2], TokenTree::Ident(keyword) if keyword == "mod")
                && matches!(&trees[index - 3], TokenTree::Group(attribute)
                    if attribute.delimiter() == Delimiter::Bracket
                        && attribute.stream().to_string().replace(' ', "") == "cfg(test)")
        };
        for (index, tree) in trees.iter().enumerate() {
            match tree {
                TokenTree::Group(group) => {
                    crate_heads(group.stream(), in_test || test_module(index), found)
                }
                TokenTree::Ident(ident)
                    if ident == "super"
                        && colon(trees.get(index + 1))
                        && colon(trees.get(index + 2)) =>
                {
                    assert!(in_test, "a `super::` path outside a test module");
                }
                TokenTree::Ident(ident)
                    if ident == "crate"
                        && colon(trees.get(index + 1))
                        && colon(trees.get(index + 2)) =>
                {
                    match trees.get(index + 3) {
                        Some(TokenTree::Ident(name)) => found.push(name.to_string()),
                        // `use crate::{a, b::c}`: each path's head; the loop reaches nested groups.
                        Some(TokenTree::Group(group)) if group.delimiter() == Delimiter::Brace => {
                            let mut head = true;
                            for tree in group.stream() {
                                match tree {
                                    TokenTree::Punct(punct) if punct.as_char() == '*' && head => {
                                        panic!(
                                            "a `crate::{{*}}` glob hides which modules it reaches"
                                        )
                                    }
                                    TokenTree::Ident(name) if head => {
                                        found.push(name.to_string());
                                        head = false;
                                    }
                                    TokenTree::Punct(punct) if punct.as_char() == ',' => {
                                        head = true;
                                    }
                                    _ => {}
                                }
                            }
                        }
                        Some(TokenTree::Punct(punct)) if punct.as_char() == '*' => {
                            panic!("a `crate::*` glob hides which modules it reaches")
                        }
                        other => panic!("an unrecognized `crate::` path: {other:?}"),
                    }
                }
                _ => {}
            }
        }
    }

    /// Every module reachable from the heads through `crate::` paths, sorted.
    fn closure_of(heads: &[&str]) -> Vec<String> {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut reached: Vec<String> = heads.iter().map(|head| (*head).to_owned()).collect();
        let mut pending = reached.clone();
        while let Some(module) = pending.pop() {
            let body = fs::read_to_string(src.join(&module)).expect("a module of the crate");
            let mut named = Vec::new();
            crate_heads(
                TokenStream::from_str(&body).expect("a module that lexes"),
                false,
                &mut named,
            );
            for name in named {
                let file = format!("{name}.rs");
                // Not a module, so an item of the crate root, main.rs, which no stamp hashes.
                if !src.join(&file).is_file() {
                    assert!(
                        OUTPUT_NEUTRAL_ROOT_ITEMS.contains(&name.as_str()),
                        "{module} reaches main.rs's {name}, which may move output; scope it"
                    );
                    continue;
                }
                if reached.contains(&file) {
                    continue;
                }
                reached.push(file.clone());
                pending.push(file);
            }
        }
        reached.sort();
        reached
    }

    fn sorted(scope: &[&str]) -> Vec<String> {
        let mut declared: Vec<String> = scope.iter().map(|module| (*module).to_owned()).collect();
        declared.sort();
        declared
    }

    /// Each scope is the closure of the modules whose `run` its pass calls, so a new scope is checked too.
    #[test]
    fn every_scope_is_closed_under_its_own_imports() {
        for (scope, heads) in SCOPES {
            assert_eq!(closure_of(&scope[..heads]), sorted(scope), "{}", scope[0]);
        }
    }

    /// The graph pass's value settings are the ones its stamp folds, read through the same names.
    #[test]
    fn the_graph_call_site_passes_what_its_stamp_folds() {
        let body = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/build.rs"))
            .expect("the driver");
        let tokens = TokenStream::from_str(&body)
            .expect("a module that lexes")
            .to_string();
        for setting in [
            "probe : GRAPH_PROBE ,",
            "report : GRAPH_REPORT . map (PathBuf :: from) ,",
            "elevation_bounds : graph_elevation_bounds (city , planned) ,",
            "land : graph_land (& plan . data , city) ,",
        ] {
            assert!(tokens.contains(setting), "graph::Args lacks `{setting}`");
        }
    }

    /// Flipping a value the driver passes the graph reruns it, though no input file moved.
    #[test]
    fn the_graph_stamp_folds_the_value_settings_the_driver_passes() {
        let plan = stamping_plan("stamps-flat");
        let before = stamped_passes(&plan);
        let mut terrain = stamping_plan("stamps-terrain");
        let tile = terrain.data.join("dem.tif");
        fs::write(&tile, b"a dem").expect("a tile");
        terrain.cities[0].elevation.push(Elevation {
            crs: "sf-cs13".to_owned(),
            band: 0,
            tiles: vec![tile],
        });
        let after = stamped_passes(&terrain);
        assert_ne!(
            after.keys.base, before.keys.base,
            "the bounds it now passes"
        );
        assert_ne!(after.graph, before.graph);
    }

    /// The second chunks pass is stamped on the stranded set, not on the graph's stamp.
    #[test]
    fn the_second_chunks_pass_follows_the_stranded_set_and_not_the_graph() {
        let plan = stamping_plan("stamps-stranded");
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        let mut stamps = Stamps::new(&plan).expect("the stamps");
        let city = cities[0].0;
        let chunks = stamps.chunks(city).expect("the chunks stamp");
        let before = stamps
            .stranded_chunks(city, &chunks, &[30, 31])
            .expect("a stamp");

        assert_eq!(
            stamps
                .stranded_chunks(city, &chunks, &[30, 31])
                .expect("a stamp"),
            before
        );
        assert_ne!(
            stamps
                .stranded_chunks(city, &chunks, &[30])
                .expect("a stamp"),
            before
        );
    }

    #[test]
    fn a_city_named_twice_is_rejected() {
        let manifest = manifest();
        let error = plan(r#"[{"id": "nyc"}, {"id": "nyc"}, {"id": "sf"}]"#)
            .pair(&manifest)
            .err()
            .expect("a city named twice");

        assert!(error.to_string().contains("twice"), "{error}");
    }

    /// NY: sidewalks and three attribute sources; SF: sidewalks only; they differ on alleys.
    const KEY_SPACE: &str = r#"[
      {"id": "nyc", "alleys": true, "sources": ["sidewalks", "ferries", "buildings"]},
      {"id": "sf", "alleys": false, "sources": ["sidewalks"]}
    ]"#;

    /// Every file the manifest and plan can name, each containing its own path.
    const SOURCES: [(&str, &str); 5] = [
        ("streets", "nyc.bin"),
        ("streets", "sf.bin"),
        ("paths", "nyc.bin"),
        ("sidewalks", "nyc.bin"),
        ("sidewalks", "sf.bin"),
    ];

    fn planted_data(name: &str) -> PathBuf {
        let root = scratch(name);
        for (kind, file) in SOURCES {
            fs::create_dir_all(root.join(kind)).expect("a source directory");
            fs::write(root.join(kind).join(file), format!("{kind}/{file}")).expect("a source");
        }
        root
    }

    fn key_space_plan(data: &Path, cities: &str) -> Plan {
        let mut plan = plan(cities);
        plan.data = data.to_path_buf();
        plan
    }

    fn stamped(plan: &Plan) -> (String, usize) {
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        plan.key_space_stamp(&cities).expect("a stamp")
    }

    fn pointer_for(bytes: &[u8]) -> String {
        format!(
            "version https://git-lfs.github.com/spec/v1\noid sha256:{}\nsize {}\n",
            hex(&Sha256::digest(bytes)),
            bytes.len()
        )
    }

    #[test]
    fn the_stamp_is_the_files_a_durable_key_can_come_out_of_and_no_others() {
        let data = planted_data("stamp");
        let (_, files) = stamped(&key_space_plan(&data, KEY_SPACE));

        // New York's streets, paths, sidewalks; SF's streets, sidewalks. No ferries or buildings.
        assert_eq!(files, 5);
    }

    /// The stamp is compared across machines, so no checkout-local path may enter it.
    #[test]
    fn two_checkouts_holding_the_same_sources_stamp_alike() {
        let here = planted_data("stamp-here");
        let there = planted_data("stamp-there");

        assert_eq!(
            stamped(&key_space_plan(&here, KEY_SPACE)),
            stamped(&key_space_plan(&there, KEY_SPACE))
        );
    }

    #[test]
    fn a_checkout_that_took_the_lfs_pointers_stamps_what_one_that_smudged_them_does() {
        let smudged = planted_data("stamp-smudged");
        let pointers = planted_data("stamp-pointers");
        for (kind, file) in SOURCES {
            let object = fs::read(smudged.join(kind).join(file)).expect("an object");
            fs::write(pointers.join(kind).join(file), pointer_for(&object)).expect("a pointer");
        }

        // The pointer's oid is the object's sha256, so the `lfs: false` CI job agrees.
        assert_eq!(
            stamped(&key_space_plan(&smudged, KEY_SPACE)),
            stamped(&key_space_plan(&pointers, KEY_SPACE))
        );
    }

    #[test]
    fn a_source_whose_bytes_moved_moves_the_stamp() {
        let data = planted_data("stamp-moved");
        let before = stamped(&key_space_plan(&data, KEY_SPACE));
        fs::write(data.join("sidewalks").join("nyc.bin"), "re-ingested").expect("a source");

        assert_ne!(stamped(&key_space_plan(&data, KEY_SPACE)), before);
    }

    /// Each city's shed artifact is stamped apart, so one city's data never stales another's.
    #[test]
    fn a_city_s_stamp_does_not_move_with_another_city_s_sources() {
        let data = planted_data("stamp-per-city");
        let manifest = manifest();
        let plan = key_space_plan(&data, KEY_SPACE);
        let stamps = |plan: &Plan| {
            plan.key_space_stamps(&plan.pair(&manifest).expect("a pairing"))
                .expect("the stamps")
        };
        let before = stamps(&plan);
        fs::write(data.join("streets").join("sf.bin"), "re-ingested").expect("a source");
        fs::write(data.join("sidewalks").join("sf.bin"), "re-ingested").expect("a source");
        let after = stamps(&plan);

        // New York's streets, paths, sidewalks; SF's streets, sidewalks.
        assert_eq!(before["nyc"].files, 3);
        assert_eq!(before["sf"].files, 2);
        assert_eq!(after["nyc"], before["nyc"]);
        assert_ne!(after["sf"], before["sf"]);
    }

    /// A withheld source moves the stamp as much as a changed file.
    #[test]
    fn a_city_that_stops_handing_over_its_sidewalks_moves_the_stamp() {
        let data = planted_data("stamp-withheld");
        let before = stamped(&key_space_plan(&data, KEY_SPACE));
        let withheld = key_space_plan(
            &data,
            r#"[{"id": "nyc", "alleys": true, "sources": ["ferries", "buildings"]},
                {"id": "sf", "alleys": false, "sources": ["sidewalks"]}]"#,
        );

        let (stamp, files) = stamped(&withheld);
        assert_ne!(stamp, before.0);
        assert_eq!(files, 4);
    }

    #[test]
    fn a_city_that_changes_its_mind_about_alleys_moves_the_stamp() {
        let data = planted_data("stamp-alleys");
        let before = stamped(&key_space_plan(&data, KEY_SPACE));

        assert_ne!(
            stamped(&key_space_plan(&data, &KEY_SPACE.replace("false", "true"))),
            before
        );
    }

    /// Attribute-only sources `graph::run` reads are excluded: their edges were final.
    #[test]
    fn the_sources_that_only_bake_an_attribute_byte_are_not_in_the_stamp() {
        let data = planted_data("stamp-attributes");
        let before = stamped(&key_space_plan(&data, KEY_SPACE));

        assert_eq!(
            stamped(&key_space_plan(
                &data,
                r#"[{"id": "nyc", "alleys": true,
                     "sources": ["sidewalks", "landmarks", "art", "highways"]},
                    {"id": "sf", "alleys": false, "sources": ["sidewalks", "buildings"],
                     "elevation": [{"crs": "sf-cs13", "band": 0, "tiles": ["a.tif"]}]}]"#
            )),
            before
        );
    }

    /// A named file missing on disk is an error rather than silently left out.
    #[test]
    fn a_source_the_plan_names_and_the_checkout_lacks_is_rejected() {
        let data = planted_data("stamp-missing");
        fs::remove_file(data.join("paths").join("nyc.bin")).expect("a removal");
        let manifest = manifest();
        let plan = key_space_plan(&data, KEY_SPACE);
        let error = plan
            .key_space_stamp(&plan.pair(&manifest).expect("a pairing"))
            .expect_err("a source that is not there");

        assert!(error.to_string().contains("paths/nyc.bin"), "{error}");
    }

    #[test]
    fn bytes_that_are_not_a_pointer_are_hashed_as_themselves() {
        let object = b"not a pointer";

        assert_eq!(pointer_oid(object).expect("a verdict"), None);
        assert_eq!(
            pointer_oid(pointer_for(object).as_bytes()).expect("a verdict"),
            Some(hex(&Sha256::digest(object)))
        );
    }

    #[test]
    fn a_pointer_with_no_oid_is_an_error() {
        let truncated = "version https://git-lfs.github.com/spec/v1\nsize 12\n";

        assert!(pointer_oid(truncated.as_bytes()).is_err());
    }
}

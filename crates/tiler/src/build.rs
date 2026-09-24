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
use crate::manifest::{City, Manifest};
use crate::{
    Fallible, canopy, caster_chunks, chunks, commercial, elevation, genus_field, graph,
    graph_cache, heights, shade,
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
const GRAPH_CODE: [&str; 22] = [
    "graph.rs",
    "association.rs",
    "binfmt.rs",
    "bridge.rs",
    "conflate.rs",
    "corners.rs",
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

/// Every other module, so that together with the scopes above the lists cover the directory.
#[cfg(test)]
const OUTSIDE_SHADE: [&str; 27] = [
    "association.rs",
    "bridge.rs",
    "build.rs",
    "canopy.rs",
    "caster_chunks.rs",
    "chunks.rs",
    "commercial.rs",
    "conflate.rs",
    "corners.rs",
    "dem.rs",
    "densities.rs",
    "direct_canopy.rs",
    "elevation.rs",
    "genus_field.rs",
    "graph.rs",
    "graph_cache.rs",
    "heights.rs",
    "historic.rs",
    "industrial.rs",
    "ingest.rs",
    "invariants.rs",
    "main.rs",
    "ndsm.rs",
    "relief.rs",
    "sampling.rs",
    "scenic.rs",
    "sidewalks.rs",
];

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

/// One module hashed by its token stream, ignoring comments and whitespace; `None` if unlexable.
fn token_oid(path: &Path) -> Option<String> {
    let source = fs::read_to_string(path).ok()?;
    let stream = proc_macro2::TokenStream::from_str(&source).ok()?;
    let mut digest = Sha256::new();
    field(&mut digest, stream.to_string().as_bytes());
    Some(hex(&digest.finalize()))
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

    fn code_epoch(&self) -> String {
        let mut digest = Sha256::new();
        for (path, oid) in &self.code {
            field(&mut digest, path.as_bytes());
            field(&mut digest, oid.as_bytes());
        }
        hex(&digest.finalize())
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

    const PYRAMIDS: [&'static str; 3] = ["shade", "tree-shade", "elevation"];

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
            // <id>.bin, <id>.stranded.bin, <id>.version.json, .stamp-<id>; the shade bake is swept above.
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
        Ok(())
    }
}

const STAMP: &str = ".stamp";

/// One pass's freshness; the stamp lives inside its output, so a cache restore carries it.
struct Pass {
    stamp: String,
    /// Written only after the pass succeeds, so a killed run leaves no claim.
    stamp_file: PathBuf,
    /// A whole-build directory this pass owns, emptied and recreated before it reruns.
    root: Option<PathBuf>,
    /// A per-city piece, removed and not recreated: absence means "no such layer here".
    pieces: Vec<PathBuf>,
    /// Paths that must exist for the stamp to be believed; existence only, not completeness.
    witnesses: Vec<PathBuf>,
}

impl Pass {
    fn whole(stamp: String, root: &Path) -> Pass {
        Pass {
            stamp,
            stamp_file: root.join(STAMP),
            root: Some(root.to_path_buf()),
            pieces: Vec::new(),
            witnesses: vec![root.to_path_buf()],
        }
    }

    fn is_fresh(&self) -> bool {
        let Ok(recorded) = fs::read_to_string(&self.stamp_file) else {
            return false;
        };
        recorded.trim() == self.stamp && self.witnesses.iter().all(|path| path.exists())
    }

    /// Clears the output and creates the root, which the pass's manifest is written into.
    fn restart(&self) -> Fallible<()> {
        self.clear()?;
        if let Some(parent) = self.stamp_file.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(())
    }

    /// Clears the output without recording a stamp, also for a pass rendering nothing this build.
    fn clear(&self) -> Fallible<()> {
        for path in self.root.iter().chain(&self.pieces) {
            discard(path)?;
        }
        if let Some(root) = &self.root {
            fs::create_dir_all(root)?;
        }
        Ok(())
    }

    fn record(&self) -> Fallible<()> {
        if let Some(parent) = self.stamp_file.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(fs::write(&self.stamp_file, &self.stamp)?)
    }
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

/// Per-pass stamps: SHA-256 over code, manifest, plan values, input contents and upstream stamps.
struct Stamps<'a> {
    plan: &'a Plan,
    code: String,
    shade_code: String,
    graph_code: String,
    relief_code: String,
    manifest_oid: String,
    oids: HashMap<PathBuf, String>,
}

impl<'a> Stamps<'a> {
    fn new(plan: &'a Plan) -> Fallible<Stamps<'a>> {
        Ok(Stamps {
            code: plan.code_epoch(),
            shade_code: plan.code_scope(&SHADE_CODE)?,
            graph_code: plan.code_scope(&GRAPH_CODE)?,
            relief_code: plan.code_scope(&RELIEF_CODE)?,
            plan,
            manifest_oid: input_oid(&plan.manifest)?,
            oids: HashMap::new(),
        })
    }

    /// A digest seeded with the manifest and code every pass shares.
    fn open(&self, pass: &str) -> Sha256 {
        self.scoped(pass, &self.code)
    }

    fn scoped(&self, pass: &str, code: &str) -> Sha256 {
        let mut digest = Sha256::new();
        field(&mut digest, pass.as_bytes());
        field(&mut digest, code.as_bytes());
        field(&mut digest, self.manifest_oid.as_bytes());
        digest
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

    fn chunks(&mut self, cities: &[(&City, &PlanCity)]) -> Fallible<String> {
        let mut digest = self.open("chunks");
        for (city, _) in cities {
            let mut inputs = vec![self.plan.data.join("streets").join(&city.streets.file)];
            inputs.extend(
                city.paths
                    .as_ref()
                    .map(|layer| self.plan.data.join("paths").join(&layer.file)),
            );
            self.files(&mut digest, &inputs)?;
        }
        Ok(hex(&digest.finalize()))
    }

    /// Pass 2, over pass 1's stamp since its signals are keyed on the chunks' segment order.
    fn commercial(&mut self, cities: &[(&City, &PlanCity)], chunks: &str) -> Fallible<String> {
        let mut digest = self.open("commercial");
        field(&mut digest, chunks.as_bytes());
        for (city, _) in cities {
            let inputs: Vec<PathBuf> = ["landuse", "buildings", "openstreets", "dining"]
                .iter()
                .map(|kind| self.plan.data.join(kind).join(format!("{}.bin", city.id)))
                .collect();
            self.files(&mut digest, &inputs)?;
        }
        Ok(hex(&digest.finalize()))
    }

    /// Pass 3: only the grid's `maxShadowMeters` enters, since the chunks carry no sun position.
    fn casters(
        &mut self,
        cities: &[(&City, &PlanCity)],
        sun: Option<&shade::Params>,
    ) -> Fallible<String> {
        let mut digest = self.open("caster-chunks");
        match sun {
            Some(params) => field(&mut digest, &params.max_shadow_meters.to_le_bytes()),
            None => field(&mut digest, b"no sun"),
        }
        for (city, _) in cities {
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
        }
        Ok(hex(&digest.finalize()))
    }

    /// Pass 4, one sun bucket of one city; the rest of the schedule is deliberately absent.
    fn shade_bucket(
        &mut self,
        city: &City,
        params: &shade::Params,
        bucket: &shade::Bucket,
    ) -> Fallible<String> {
        let mut digest = self.scoped("shade-bucket", &self.shade_code);
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
        let mut digest = self.open("elevation");
        field(&mut digest, city.id.as_bytes());
        dem_identity(&mut digest, &planned.elevation)?;
        let land = self.plan.data.join("land").join(&city.field.land.file);
        self.file(&mut digest, &land)?;
        Ok(hex(&digest.finalize()))
    }

    fn canopy(&mut self, cities: &[(&City, &PlanCity)]) -> Fallible<String> {
        let mut digest = self.open("canopy");
        for (city, _) in cities {
            if let Some(layer) = &city.field.canopy {
                let inputs = vec![
                    self.plan.data.join("canopy").join(&layer.file),
                    self.plan.data.join("land").join(&city.field.land.file),
                ];
                self.files(&mut digest, &inputs)?;
            }
        }
        Ok(hex(&digest.finalize()))
    }

    fn genus_field(&mut self, cities: &[(&City, &PlanCity)]) -> Fallible<String> {
        let mut digest = self.open("genus-field");
        for (city, _) in cities {
            if city.field.genus.is_some() {
                let trees = self.plan.data.join("trees").join(&city.field.trees.file);
                self.file(&mut digest, &trees)?;
            }
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
        let mut digest = self.scoped("graph-base", &self.graph_code);
        field(&mut digest, city.id.as_bytes());
        field(
            &mut digest,
            if planned.alleys { b"alleys" } else { b"none" },
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
        let mut commercial_key = self.open("graph-commercial");
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
        let mut digest = self.open(name);
        field(&mut digest, base.as_bytes());
        match input {
            Some(path) => self.file(&mut digest, path)?,
            None => field(&mut digest, b"no source"),
        }
        Ok(hex(&digest.finalize()))
    }

    /// Pass 8's stamp, which is exactly its keys.
    fn graph(&self, keys: &graph_cache::Keys) -> String {
        let mut digest = self.open("graph");
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

    /// Pass 9: pass 1's stamp plus the stranded set, so a rerun with the same islands skips it.
    fn stranded_chunks(
        &mut self,
        cities: &[(&City, &PlanCity)],
        chunks: &str,
        stranded: &chunks::Stranded,
    ) -> Fallible<String> {
        let mut digest = self.open("chunks-stranded");
        field(&mut digest, chunks.as_bytes());
        for (city, _) in cities {
            field(&mut digest, city.id.as_bytes());
            for way in stranded.ways(&city.id) {
                digest.update(way.to_le_bytes());
            }
        }
        Ok(hex(&digest.finalize()))
    }
}

const STAGES: usize = 9;

fn stage(number: usize, name: &str, started: &Instant) {
    crate::trim_heap();
    eprintln!(
        "[{number}/{STAGES}] {name} ({:.1}s in)",
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

    /// Whether the pass is stamped per city and so can be narrowed to one.
    fn per_city(self) -> bool {
        matches!(
            self,
            PassName::Shade | PassName::Elevation | PassName::Graph
        )
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
                    Some(_) if !pass.per_city() => {
                        return Err(format!(
                            "--only {term}: the {name} pass is run over every city at once, so it takes no city"
                        )
                        .into());
                    }
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
fn upstream(selection: &Selection, name: PassName, pass: &Pass) -> Fallible<String> {
    if selection.selected(name, None) {
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
    if selection.handoff(PassName::Commercial, PassName::Chunks, None) {
        wanted.push((PassName::Commercial, PassName::Chunks, plan.chunks.clone()));
    }
    if selection.handoff(PassName::ChunksStranded, PassName::Chunks, None) {
        wanted.push((
            PassName::ChunksStranded,
            PassName::Chunks,
            plan.chunks.clone(),
        ));
    }
    if selection.handoff(PassName::Graph, PassName::Commercial, None) {
        wanted.push((
            PassName::Graph,
            PassName::Commercial,
            plan.commercial_lines.clone(),
        ));
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

/// A build on `jobs` rayon threads, sized before any parallel iterator builds the default pool.
pub fn run(plan_file: &Path, jobs: Option<usize>, selection: &Selection) -> Fallible<()> {
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
    let mut plan: Plan = serde_json::from_slice(&fs::read(plan_file)?)?;
    plan.hash_source_tokens();
    let manifest: Manifest = serde_json::from_slice(&fs::read(&plan.manifest)?)?;
    let cities = plan.pair(&manifest)?;
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
    let chunk_pass = Pass::whole(stamps.chunks(&cities)?, &plan.chunks);
    // Handovers enter as what this build will leave, so a partial build claims nothing unbuilt.
    let chunks_upstream = upstream(selection, PassName::Chunks, &chunk_pass)?;
    let commercial_pass = Pass {
        stamp: stamps.commercial(&cities, &chunks_upstream)?,
        stamp_file: plan.commercial_signals.join(STAMP),
        // That pass clears its own directories, since only it knows which cities write no file.
        root: None,
        pieces: Vec::new(),
        witnesses: vec![
            plan.commercial_signals.clone(),
            plan.commercial_lines.clone(),
        ],
    };
    let caster_pass = Pass::whole(stamps.casters(&cities, sun)?, &plan.casters);
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
                root: None,
                pieces: vec![root.clone()],
                witnesses: vec![root],
            })
        })
        .collect::<Fallible<Vec<Pass>>>()?;
    let canopy_pass = Pass::whole(stamps.canopy(&cities)?, &plan.canopy_tiles);
    let genus_pass = Pass::whole(stamps.genus_field(&cities)?, &plan.genus_field_tiles);
    let commercial_upstream = upstream(selection, PassName::Commercial, &commercial_pass)?;
    let graph_keys: Vec<graph_cache::Keys> = cities
        .iter()
        .zip(&baked)
        .map(|((city, planned), bake)| {
            stamps.graph_keys(city, planned, &commercial_upstream, bake.is_some())
        })
        .collect::<Fallible<Vec<graph_cache::Keys>>>()?;
    let graph_passes: Vec<Pass> = cities
        .iter()
        .zip(&baked)
        .enumerate()
        .map(|(index, ((city, _), bake))| {
            let blob = plan.routing.join(format!("{}.bin", city.id));
            let stranded = plan.routing.join(format!("{}.stranded.bin", city.id));
            Ok(Pass {
                stamp: stamps.graph(&graph_keys[index]),
                stamp_file: plan.routing.join(format!(".stamp-{}", city.id)),
                root: None,
                pieces: vec![
                    blob.clone(),
                    plan.routing.join(format!("{}.version.json", city.id)),
                    stranded.clone(),
                    plan.routing.join("shade").join(&city.id),
                ],
                witnesses: [blob, stranded].into_iter().chain(bake.clone()).collect(),
            })
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
        manifest: plan.manifest.clone(),
        data: plan.data.clone(),
        chunks: plan.chunks.clone(),
    };
    stage(1, "chunks", &started);
    let chunks_verdict = selection.verdict(PassName::Chunks, None, chunk_pass.is_fresh());
    let chunk_files = if chunks_verdict.runs() {
        chunk_pass.restart()?;
        let cut = chunks::run(&chunk_args, &chunks::Stranded::default())?;
        chunk_pass.record()?;
        cut
    } else {
        chunks_verdict.announce(None);
        chunks::Chunks {
            dir: plan.chunks.clone(),
        }
    };

    // The commercial signals are keyed on the chunks' segment index.
    stage(2, "commercial", &started);
    let commercial_verdict =
        selection.verdict(PassName::Commercial, None, commercial_pass.is_fresh());
    let lines = if !commercial_verdict.runs() {
        commercial_verdict.announce(None);
        commercial::Lines::written(&plan.commercial_lines, &manifest)
    } else {
        commercial_pass.restart()?;
        let written = commercial::run(
            &commercial::Args {
                manifest: plan.manifest.clone(),
                data: plan.data.clone(),
                signals: plan.commercial_signals.clone(),
                lines: plan.commercial_lines.clone(),
            },
            &chunk_files,
        )?;
        commercial_pass.record()?;
        written
    };

    stage(3, "caster-chunks", &started);
    let casters_verdict = selection.verdict(PassName::CasterChunks, None, caster_pass.is_fresh());
    match sun {
        Some(params) if any_casters => {
            if casters_verdict.runs() {
                caster_pass.restart()?;
                caster_chunks::run(&caster_chunks::Args {
                    manifest: plan.manifest.clone(),
                    data: plan.data.clone(),
                    chunks: plan.casters.clone(),
                    params: params.clone(),
                })?;
                caster_pass.record()?;
            } else {
                casters_verdict.announce(None);
            }
        }
        _ if !selection.selected(PassName::CasterChunks, None) => casters_verdict.announce(None),
        _ => {
            caster_pass.clear()?;
            eprintln!("no sun grid or nothing to cast a shadow; no caster chunks");
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
    let canopy_verdict = selection.verdict(PassName::Canopy, None, canopy_pass.is_fresh());
    if !selection.selected(PassName::Canopy, None) {
        canopy_verdict.announce(None);
    } else if manifest
        .cities
        .iter()
        .any(|city| city.field.canopy.is_some())
    {
        if !canopy_verdict.runs() {
            canopy_verdict.announce(None);
        } else {
            canopy_pass.restart()?;
            canopy::run(&canopy::Args {
                manifest: plan.manifest.clone(),
                data: plan.data.clone(),
                tiles: plan.canopy_tiles.clone(),
            })?;
            canopy_pass.record()?;
        }
    } else {
        canopy_pass.clear()?;
    }

    stage(7, "genus-field", &started);
    let genus_verdict = selection.verdict(PassName::GenusField, None, genus_pass.is_fresh());
    if !selection.selected(PassName::GenusField, None) {
        genus_verdict.announce(None);
    } else if manifest
        .cities
        .iter()
        .any(|city| city.field.genus.is_some())
    {
        if !genus_verdict.runs() {
            genus_verdict.announce(None);
        } else {
            genus_pass.restart()?;
            genus_field::run(&genus_field::Args {
                manifest: plan.manifest.clone(),
                data: plan.data.clone(),
                tiles: plan.genus_field_tiles.clone(),
            })?;
            genus_pass.record()?;
        }
    } else {
        genus_pass.clear()?;
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
            if selection.selected(PassName::ChunksStranded, None) {
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
                land: Some(plan.data.join("land").join(&city.field.land.file)),
                out: plan.routing.join(format!("{}.bin", city.id)),
                // Written for the record; the re-chunk reads the same ids from memory.
                stranded_out: Some(stranded_file),
                buildings,
                shade_params,
                shade_dir,
                // The measured canopy feeds the direct-canopy byte and also occludes edges.
                canopy: city
                    .field
                    .canopy
                    .as_ref()
                    .map(|layer| plan.data.join("canopy").join(&layer.file)),
                elevation_bounds: (!planned.elevation.is_empty()).then_some(city.bounds),
                alleys: planned.alleys,
                existence_ceilings: planned
                    .existence_ceilings
                    .unwrap_or(graph::SURVEYED_CEILINGS),
                cache: Some(graph_keys[index].clone()),
                probe: false,
                report: None,
            },
            dem,
        )?;
        pass.record()?;
        stranded.insert(&city.id, ways);
    }

    // Re-cut with the graph's stranded set; only the trailing bitmap changes.
    stage(9, "chunks (stranded)", &started);
    // Rewrites pass 1's output in place, so it clears nothing.
    let stranded_pass = Pass {
        stamp: stamps.stranded_chunks(&cities, &chunks_upstream, &stranded)?,
        stamp_file: plan.chunks.join(".stamp-stranded"),
        root: None,
        pieces: Vec::new(),
        witnesses: vec![plan.chunks.clone()],
    };
    let stranded_verdict =
        selection.verdict(PassName::ChunksStranded, None, stranded_pass.is_fresh());
    if !selection.selected(PassName::ChunksStranded, None) {
        stranded_verdict.announce(None);
    } else if manifest.cities.iter().any(|city| city.paths.is_some()) {
        if !stranded_verdict.runs() {
            stranded_verdict.announce(None);
        } else {
            chunks::run(&chunk_args, &stranded)?;
            stranded_pass.record()?;
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
}

/// What `bun run check-shed-inputs` compares against `public/sheds/inputs.json`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphInputs {
    stamp: String,
    files: usize,
}

/// `tiler graph-inputs`: stamps the key space of the plan's sources decision without building.
pub fn graph_inputs(plan_file: &Path, report: &Path) -> Fallible<()> {
    let plan: Plan = serde_json::from_slice(&fs::read(plan_file)?)?;
    let manifest: Manifest = serde_json::from_slice(&fs::read(&plan.manifest)?)?;
    let cities = plan.pair(&manifest)?;
    let (stamp, files) = plan.key_space_stamp(&cities)?;
    eprintln!("graph inputs: {files} files stamped {stamp}");
    crate::write_report(report, &GraphInputs { stamp, files })
}

#[cfg(test)]
mod tests {
    use proc_macro2::{Delimiter, TokenStream, TokenTree};

    use super::*;

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
        SHADE_CODE
            .iter()
            .chain(&OUTSIDE_SHADE)
            .map(|module| format!("{SRC}/{module}"))
            .chain(BUILD_FILES.iter().map(|file| (*file).to_owned()))
            .map(|path| (path.clone(), format!("the bytes of {path}")))
            .collect()
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

    #[test]
    fn a_pass_is_fresh_only_when_its_stamp_and_its_output_both_hold() {
        let root = scratch("fresh");
        let pass = Pass::whole("5eaf00d".to_owned(), &root.join("streets"));
        assert!(!pass.is_fresh(), "nothing has recorded a stamp yet");

        pass.restart().expect("the output directory");
        pass.record().expect("the stamp");
        assert!(pass.is_fresh());

        fs::remove_dir_all(root.join("streets")).expect("a removal");
        assert!(!pass.is_fresh());
    }

    #[test]
    fn a_pass_that_reruns_clears_its_own_output_and_leaves_its_neighbors_alone() {
        let root = scratch("clearing");
        let mine = Pass::whole("a".to_owned(), &root.join("streets"));
        let theirs = Pass::whole("b".to_owned(), &root.join("casters"));
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

    /// A pyramid or graph blob is removed and not recreated, since absence means "no such layer".
    #[test]
    fn a_city_that_stops_rendering_leaves_no_directory_behind() {
        let root = scratch("pieces");
        let overlay = root.join("tiles/elevation/nyc");
        let pass = Pass {
            stamp: "a".to_owned(),
            stamp_file: overlay.join(STAMP),
            root: None,
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
            for suffix in ["bin", "stranded.bin", "version.json"] {
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
            "nyc.version.json",
            ".stamp-nyc",
        ] {
            assert!(plan.routing.join(kept).is_file(), "{kept}");
        }
        for dropped in [
            "boston.bin",
            "boston.stranded.bin",
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
    fn a_city_on_a_pass_that_has_no_cities_is_rejected() {
        let error = Selection::new(&["chunks:nyc".to_owned()], false)
            .err()
            .expect("a pass with no cities to narrow to");

        assert!(error.to_string().contains("every city"), "{error}");
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
            .err()
            .expect("a city the manifest has never heard of");

        assert!(error.to_string().contains("bosotn"), "{error}");
    }

    /// A pass `--only` leaves out runs nothing and clears nothing, so its stale claim stands.
    #[test]
    fn a_pass_left_out_keeps_its_stale_stamp_for_the_next_full_build() {
        let root = scratch("only-untouched");
        let last = Pass::whole("what the last build read".to_owned(), &root.join("casters"));
        last.restart().expect("a directory");
        fs::write(last.stamp_file.with_file_name("chunk.bin"), b"last build").expect("a chunk");
        last.record().expect("a stamp");
        let now = Pass::whole("what this one reads".to_owned(), &root.join("casters"));
        assert!(!now.is_fresh(), "its inputs moved");

        let partial = only(&["graph"]);
        assert!(matches!(
            partial.verdict(PassName::CasterChunks, None, now.is_fresh()),
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
                .verdict(PassName::CasterChunks, None, now.is_fresh())
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

        let error = handoffs(&plan, &cities, &partial)
            .err()
            .expect("lines no pass has written");
        assert!(error.to_string().contains("commercial"), "{error}");

        fs::create_dir_all(&plan.commercial_lines).expect("the lines");
        handoffs(&plan, &cities, &partial).expect("lines that are there, however old");
    }

    #[test]
    fn the_re_chunk_will_not_run_over_a_stranded_set_no_graph_has_written() {
        let plan = planted("handoff-stranded");
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        let partial = only(&["chunks-stranded"]);
        fs::create_dir_all(&plan.chunks).expect("the chunks");

        let error = handoffs(&plan, &cities, &partial)
            .err()
            .expect("a stranded set no graph has written");

        assert!(error.to_string().contains("nyc.stranded.bin"), "{error}");
        assert!(error.to_string().contains("--only graph"), "{error}");
    }

    /// A pass keyed on an upstream this build won't run folds the recorded upstream stamp.
    #[test]
    fn a_selected_pass_folds_the_upstream_stamp_that_is_actually_on_disk() {
        let root = scratch("upstream");
        let chunks = Pass::whole("what the chunks will be".to_owned(), &root.join("streets"));
        chunks.restart().expect("a directory");
        fs::write(&chunks.stamp_file, "what the chunks are").expect("a stamp");

        assert_eq!(
            upstream(&only(&["commercial"]), PassName::Chunks, &chunks).expect("a stamp"),
            "what the chunks are",
            "the claim over the chunks the commercial pass is about to read"
        );
        assert_eq!(
            upstream(&only(&["chunks", "commercial"]), PassName::Chunks, &chunks).expect("a stamp"),
            "what the chunks will be",
            "a pass this build is running leaves the stamp it just computed"
        );
        assert_eq!(
            upstream(&only(&[]), PassName::Chunks, &chunks).expect("a stamp"),
            "what the chunks will be",
            "and so does every pass of a full build"
        );

        fs::remove_file(&chunks.stamp_file).expect("a removal");
        assert_eq!(
            upstream(&only(&["commercial"]), PassName::Chunks, &chunks).expect("a stamp"),
            UNRECORDED
        );
    }

    #[test]
    fn a_graph_narrowed_to_one_city_does_not_answer_for_the_others() {
        let plan = planted("handoff-narrowed");
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        fs::create_dir_all(&plan.chunks).expect("the chunks");
        // The graph's handoff is checked first, so these keep the error on the narrowed city.
        fs::create_dir_all(&plan.commercial_lines).expect("the commercial lines");
        fs::create_dir_all(&plan.routing).expect("the routing directory");
        fs::write(plan.routing.join("nyc.stranded.bin"), b"a stranded set")
            .expect("new york's stranded set");

        let error = handoffs(&plan, &cities, &only(&["chunks-stranded", "graph:nyc"]))
            .err()
            .expect("san francisco's stranded set");

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

    /// One stamp per pass, per-city ones being New York's.
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
        let chunks = stamps.chunks(&cities).expect("the chunks stamp");
        let commercial = stamps
            .commercial(&cities, &chunks)
            .expect("the commercial stamp");
        let (city, planned) = cities[0];
        let keys = stamps
            .graph_keys(city, planned, &commercial, true)
            .expect("the graph keys");
        Stamped {
            casters: stamps
                .casters(&cities, planned.shade.as_ref())
                .expect("the caster-chunks stamp"),
            buckets: bucket_keys(plan),
            elevation: stamps
                .elevation(city, planned)
                .expect("the elevation stamp"),
            canopy: stamps.canopy(&cities).expect("the canopy stamp"),
            genus_field: stamps.genus_field(&cities).expect("the genus-field stamp"),
            graph: stamps.graph(&keys),
            keys,
            chunks,
            commercial,
        }
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

    /// Every pass but shade folds the whole crate, since a format change moves no input file.
    #[test]
    fn a_new_tiler_reruns_every_pass_that_names_no_modules() {
        let mut plan = stamping_plan("stamps-epoch");
        let before = stamped_passes(&plan);
        edited(&mut plan, "shade.rs");
        let after = stamped_passes(&plan);

        assert_ne!(after.chunks, before.chunks);
        assert_ne!(after.commercial, before.commercial);
        assert_ne!(after.casters, before.casters);
        assert_ne!(after.elevation, before.elevation);
        assert_ne!(after.canopy, before.canopy);
        assert_ne!(after.genus_field, before.genus_field);
        assert_ne!(after.graph, before.graph);
        assert_ne!(
            after.buckets, before.buckets,
            "the pass that reads shade.rs"
        );
    }

    #[test]
    fn an_edit_the_shade_pass_does_not_read_leaves_the_pyramid_standing() {
        let mut plan = stamping_plan("stamps-scope");
        let before = stamped_passes(&plan);
        edited(&mut plan, "graph.rs");
        let after = stamped_passes(&plan);

        assert_ne!(after.graph, before.graph);
        assert_ne!(after.chunks, before.chunks);
        assert_eq!(after.buckets, before.buckets);
    }

    /// A graph edit reruns the graph pass but keeps the cached relief and shade columns.
    #[test]
    fn an_edit_the_graph_never_reads_keeps_the_dem_and_the_shade_bakes() {
        let mut plan = stamping_plan("stamps-graph-scope");
        let before = stamped_passes(&plan);
        edited(&mut plan, "densities.rs");
        let after = stamped_passes(&plan);

        assert_ne!(after.graph, before.graph, "the pass runs again");
        assert_eq!(after.keys.base, before.keys.base, "onto the same topology");
        assert_eq!(
            after.keys.relief, before.keys.relief,
            "and reads no GeoTIFF to do it"
        );
        assert_eq!(after.keys.shade, before.keys.shade, "nor casts a ray");
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
        let mut claimed: Vec<String> = SHADE_CODE
            .iter()
            .chain(&OUTSIDE_SHADE)
            .map(|module| (*module).to_owned())
            .collect();
        found.sort();
        claimed.sort();

        assert_eq!(found, claimed);
    }

    /// Every module a `crate::` path names, including `pub use`, brace groups and qualified paths.
    fn crate_heads(stream: TokenStream, found: &mut Vec<String>) {
        let trees: Vec<TokenTree> = stream.into_iter().collect();
        let colon = |tree: Option<&TokenTree>| matches!(tree, Some(TokenTree::Punct(punct)) if punct.as_char() == ':');
        for (index, tree) in trees.iter().enumerate() {
            match tree {
                TokenTree::Group(group) => crate_heads(group.stream(), found),
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
                        _ => {}
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
                &mut named,
            );
            for name in named {
                let file = format!("{name}.rs");
                // Items of lib.rs like `Fallible` are not modules.
                if !src.join(&file).is_file() || reached.contains(&file) {
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

    /// Each narrow scope must be closed under its modules' imports.
    #[test]
    fn the_shade_scope_is_closed_under_its_own_imports() {
        assert_eq!(closure_of(&[SHADE_CODE[0]]), sorted(&SHADE_CODE));
    }

    #[test]
    fn the_graph_and_relief_scopes_are_closed_under_their_own_imports() {
        assert_eq!(closure_of(&[GRAPH_CODE[0]]), sorted(&GRAPH_CODE));
        assert_eq!(
            closure_of(&[RELIEF_CODE[0], RELIEF_CODE[1]]),
            sorted(&RELIEF_CODE)
        );
    }

    /// The second chunks pass is stamped on the stranded set, not on the graph's stamp.
    #[test]
    fn the_second_chunks_pass_follows_the_stranded_set_and_not_the_graph() {
        let plan = stamping_plan("stamps-stranded");
        let manifest = manifest();
        let cities = plan.pair(&manifest).expect("a pairing");
        let mut stamps = Stamps::new(&plan).expect("the stamps");
        let chunks = stamps.chunks(&cities).expect("the chunks stamp");
        let mut islands = chunks::Stranded::default();
        islands.insert("nyc", vec![30, 31]);
        let before = stamps
            .stranded_chunks(&cities, &chunks, &islands)
            .expect("a stamp");

        let mut same = chunks::Stranded::default();
        same.insert("nyc", vec![30, 31]);
        assert_eq!(
            stamps
                .stranded_chunks(&cities, &chunks, &same)
                .expect("a stamp"),
            before
        );

        let mut moved = chunks::Stranded::default();
        moved.insert("nyc", vec![30]);
        assert_ne!(
            stamps
                .stranded_chunks(&cities, &chunks, &moved)
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
            .err()
            .expect("a source that is not there");

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

//! The shade pass: building and crown shadows as one WebP pyramid each per time-of-day bucket.
//! Canopy light transmittance is seasonal, so the client folds it in rather than the bake.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Instant;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::Fallible;
use crate::binfmt::{self, Coord, Polygon, Ring};
use crate::crown;
use crate::geometry::{self, METERS_PER_DEGREE_LAT, PolygonGrid, PolygonSet, round_half_up};
use crate::manifest::{Bounds, City, Manifest};
use crate::raster::{
    EQUATOR_METERS_PER_PIXEL, MIN_ALPHA, MIN_ZOOM, TILE_SIZE, Tile, encode_webp_lossless,
    lat_to_pixel_y, lng_to_pixel_x, pixel_x_to_lng, pixel_y_to_lat, plan_tiles,
};

// Alpha quantization step; keeps z15 inside the deploy size budget at ~3% opacity granularity.
const SHADE_ALPHA_STEP: u16 = 8;

// Supersampling factor that antialiases hard shadow edges.
const SUPERSAMPLE: usize = 4;
const SHADE_RGB: [u8; 3] = [51, 65, 85]; // cool slate
// Umbra opacity under a zenith sun; the bucket's intensity scales it down.
const MAX_SHADE_ALPHA: f64 = 190.0;

pub struct Args {
    pub manifest: PathBuf,
    pub data: PathBuf,
    pub tiles: PathBuf,
    /// The sun grid from scripts/shade-schedule.ts, which the client inverts to map "now" to a bin.
    pub params: Params,
    /// The city to render; a bin's sun position depends on latitude, so cities can't share a pyramid.
    pub city: String,
    /// Indices of the bins to render; the whole grid still comes since a bin is named by its index.
    pub render: Vec<Render>,
    /// Bytes the held tiles and subtree working sets may hold; 0 generates every tile's hulls for
    /// it alone. It never changes a tile, so it's never part of a stamp.
    pub memory_budget: usize,
}

/// One bin to render and its claim, recorded per bin so a killed build keeps finished bins.
pub struct Render {
    pub index: usize,   // which bin of `Params::buckets`
    pub stamp: PathBuf, // the file the claim goes in
    pub key: String,    // what the driver hashed this bin's tiles out of
}

/// One sun-disk sample: the anti-sun ground unit vector and shadow length per meter of height.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    east: f64,  // east component of the anti-sun ground direction
    north: f64, // north component
    shadow_per_height: f64,
}

/// One bin of the (declination, hourAngle) grid and the sun-disk samples of its penumbra.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    season: usize,   // declination band (season key)
    hour_angle: f64, // degrees, 0 at solar noon (time-of-day key)
    elevation: f64,  // echoed to the client; the geometry rides in `samples`
    azimuth: f64,
    intensity: f64, // ~sin(elevation); scales the bin's shade darkness
    samples: Vec<Sample>,
}

/// `Serialize` is for the build's freshness stamps, which hash the whole grid.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Params {
    pub max_zoom: u32,
    pub max_shadow_meters: f64, // clipped so a lone tower does not streak the city
    pub buckets: Vec<Bucket>,
}

/// The client's schedule: each bin index's (season, hourAngle) cell and sun position.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BucketEntry {
    index: usize,
    season: usize,
    hour_angle: f64,
    elevation: f64,
    azimuth: f64,
}

/// What throws a shadow: footprints and measured canopy crowns, with heights in meters.
pub struct Casters {
    polygons: Vec<Polygon>,
    heights: Vec<f64>,
    crowns: Vec<crown::Crown>,
    crown_heights: Vec<f64>,
}

/// One city's casters plus the footprints that punch building bases out of both shadows.
struct CityShade {
    casters: Casters,
    footprints: CasterIndex, // indexes `casters.polygons` themselves, unswept
    // Whether each footprint's shadow sweeps as one hull, which its byte estimate turns on.
    footprint_hulls: Vec<bool>,
    // The same per crown ring, level by level; crown `index`'s start at `crown_rings[index]`.
    ring_hulls: Vec<bool>,
    crown_rings: Vec<u32>,
}

// Hulls are flattened and filled this many at a time, so no pass holds a whole city's shadows.
const FILL_BATCH: usize = 1024;

/// A CSR grid over caster boxes: each cell lists the casters whose box overlaps it.
struct BoxGrid {
    bounds: Bounds,
    cols: usize,
    rows: usize,
    cell_lng: f64,
    cell_lat: f64,
    starts: Vec<u32>, // cols * rows + 1 offsets into `items`
    items: Vec<u32>,  // caster indices, grouped by the cell their box touches
}

impl BoxGrid {
    const TARGET_PER_CELL: usize = 16;

    /// An empty box, one whose west exceeds its east, is left out of every cell.
    fn new(boxes: &[Bounds]) -> Self {
        let mut bounds = Bounds {
            south: f64::INFINITY,
            west: f64::INFINITY,
            north: f64::NEG_INFINITY,
            east: f64::NEG_INFINITY,
        };
        let mut count = 0;
        for box_ in boxes.iter().filter(|box_| box_.west <= box_.east) {
            bounds.south = bounds.south.min(box_.south);
            bounds.west = bounds.west.min(box_.west);
            bounds.north = bounds.north.max(box_.north);
            bounds.east = bounds.east.max(box_.east);
            count += 1;
        }
        if count == 0 {
            return Self {
                bounds,
                cols: 1,
                rows: 1,
                cell_lng: 1.0,
                cell_lat: 1.0,
                starts: vec![0, 0],
                items: Vec::new(),
            };
        }
        let span_lng = (bounds.east - bounds.west).max(1e-9);
        let span_lat = (bounds.north - bounds.south).max(1e-9);
        let aspect = span_lng / span_lat;
        let target = (count / Self::TARGET_PER_CELL).max(1) as f64;
        let cols = ((target * aspect).sqrt().round() as usize).max(1);
        let rows = ((target / aspect).sqrt().round() as usize).max(1);
        let mut grid = Self {
            bounds,
            cols,
            rows,
            cell_lng: span_lng / cols as f64,
            cell_lat: span_lat / rows as f64,
            starts: vec![0u32; cols * rows + 1],
            items: Vec::new(),
        };
        let cells = |grid: &Self, box_: &Bounds| {
            let (west, east, south, north) = grid.cell_range(box_);
            (south..=north).flat_map(move |row| (west..=east).map(move |col| row * cols + col))
        };
        for box_ in boxes.iter().filter(|box_| box_.west <= box_.east) {
            for cell in cells(&grid, box_) {
                grid.starts[cell + 1] += 1;
            }
        }
        for cell in 0..cols * rows {
            grid.starts[cell + 1] += grid.starts[cell];
        }
        let mut items = vec![0u32; grid.starts[cols * rows] as usize];
        let mut cursors = grid.starts.clone();
        for (index, box_) in boxes.iter().enumerate() {
            if box_.west > box_.east {
                continue;
            }
            for cell in cells(&grid, box_) {
                items[cursors[cell] as usize] = index as u32;
                cursors[cell] += 1;
            }
        }
        grid.items = items;
        grid
    }

    /// The columns and rows a box spans, clamped into the grid.
    fn cell_range(&self, box_: &Bounds) -> (usize, usize, usize, usize) {
        let col_of = |lng: f64| {
            (((lng - self.bounds.west) / self.cell_lng).max(0.0) as usize).min(self.cols - 1)
        };
        let row_of = |lat: f64| {
            (((lat - self.bounds.south) / self.cell_lat).max(0.0) as usize).min(self.rows - 1)
        };
        (
            col_of(box_.west),
            col_of(box_.east),
            row_of(box_.south),
            row_of(box_.north),
        )
    }

    /// The deduplicated caster indices whose cells the clip overlaps, into `out`.
    fn candidates(&self, clip: &Bounds, out: &mut Vec<u32>) {
        out.clear();
        if !overlaps(clip, &self.bounds) {
            return;
        }
        let (west, east, south, north) = self.cell_range(clip);
        for row in south..=north {
            for col in west..=east {
                let cell = row * self.cols + col;
                out.extend_from_slice(
                    &self.items[self.starts[cell] as usize..self.starts[cell + 1] as usize],
                );
            }
        }
        out.sort_unstable();
        out.dedup();
    }
}

/// Whether two boxes share a point, edges included, as the scanline fill's clip test reads it.
fn overlaps(left: &Bounds, right: &Bounds) -> bool {
    !(left.east < right.west
        || left.west > right.east
        || left.north < right.south
        || left.south > right.north)
}

/// Casters of one kind: each one's box over all its hulls and their estimated heap, gridded per
/// tile. Both are worked out from the geometry, so building the index generates no hull.
struct CasterIndex {
    boxes: Vec<Bounds>,
    est: Vec<usize>,
    grid: BoxGrid,
}

impl CasterIndex {
    /// `measure(caster)` is a box holding its hulls over every slot, and their `hull_bytes` at most.
    fn new(count: usize, measure: impl Fn(usize) -> (Bounds, usize) + Sync) -> Self {
        let (boxes, est): (Vec<Bounds>, Vec<usize>) =
            (0..count).into_par_iter().map(&measure).unzip();
        let grid = BoxGrid::new(&boxes);
        Self { boxes, est, grid }
    }

    /// The casters whose box overlaps `clip`, into `out`.
    fn overlapping(&self, clip: &Bounds, out: &mut Vec<u32>) {
        self.grid.candidates(clip, out);
        out.retain(|caster| overlaps(&self.boxes[*caster as usize], clip));
    }

    /// The estimated heap of the hulls of the casters overlapping `clip`.
    fn bytes_over(&self, clip: &Bounds, scratch: &mut Vec<u32>) -> usize {
        self.overlapping(clip, scratch);
        scratch
            .iter()
            .map(|caster| self.est[*caster as usize])
            .sum()
    }
}

// A flattened hull's heap in PolygonSet's nested layout, malloc headers included: the
// per-polygon ring vector and box, each ring's two coordinate vectors, then 16 B a vertex.
const POLYGON_BYTES: usize = 72;
const RING_BYTES: usize = 80;
const VERTEX_BYTES: usize = 16;

/// The estimated heap `hulls` take once flattened.
fn hull_bytes(hulls: &[Polygon]) -> usize {
    hulls
        .iter()
        .map(|polygon| {
            POLYGON_BYTES
                + polygon
                    .iter()
                    .map(|ring| RING_BYTES + VERTEX_BYTES * ring.len())
                    .sum::<usize>()
        })
        .sum()
}

/// `hull_bytes` of `polygons` one-ring hulls carrying `vertices` between them.
fn one_ring_bytes(polygons: usize, vertices: usize) -> usize {
    polygons * (POLYGON_BYTES + RING_BYTES) + vertices * VERTEX_BYTES
}

/// The box that holds nothing, which any union leaves as the other side.
const EMPTY: Bounds = Bounds {
    south: f64::INFINITY,
    west: f64::INFINITY,
    north: f64::NEG_INFINITY,
    east: f64::NEG_INFINITY,
};

fn ring_box(ring: &[Coord]) -> Bounds {
    ring.iter().fold(EMPTY, |bounds, point| Bounds {
        south: bounds.south.min(point.lat),
        west: bounds.west.min(point.lng),
        north: bounds.north.max(point.lat),
        east: bounds.east.max(point.lng),
    })
}

/// A box moved as its vertices are: adding a constant is monotone in floating point, so the
/// moved box is exactly the box of the moved vertices.
fn shifted(bounds: &Bounds, (d_lng, d_lat): (f64, f64)) -> Bounds {
    Bounds {
        south: bounds.south + d_lat,
        west: bounds.west + d_lng,
        north: bounds.north + d_lat,
        east: bounds.east + d_lng,
    }
}

fn union(left: &Bounds, right: &Bounds) -> Bounds {
    Bounds {
        south: left.south.min(right.south),
        west: left.west.min(right.west),
        north: left.north.max(right.north),
        east: left.east.max(right.east),
    }
}

/// One tile of one bucket, counted once for each pyramid it fed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Stats {
    tiles: usize,
    painted: usize,
    bytes: usize,
    tree_painted: usize,
    tree_bytes: usize,
}

impl std::ops::Add for Stats {
    type Output = Self;

    fn add(self, other: Self) -> Self {
        Self {
            tiles: self.tiles + other.tiles,
            painted: self.painted + other.painted,
            bytes: self.bytes + other.bytes,
            tree_painted: self.tree_painted + other.tree_painted,
            tree_bytes: self.tree_bytes + other.tree_bytes,
        }
    }
}

// Outlines decoded and cut per batch, so a city's outlines and its slices never peak together.
const CROWN_BATCH: usize = 65_536;

/// A canopy file's crowns, cut, and heights; height 0 is the unknown sentinel, so those are dropped.
fn read_crowns(path: &Path) -> Fallible<(Vec<crown::Crown>, Vec<f64>)> {
    let mut canopy = binfmt::read_canopy_batches(path)?;
    let mut crowns = Vec::new();
    let mut heights = Vec::new();
    for batch in canopy.heights_m().chunks(CROWN_BATCH) {
        let (outlines, kept): (Vec<Polygon>, Vec<f64>) = canopy
            .next_polygons(batch.len())
            .into_iter()
            .zip(batch.iter().copied())
            .filter(|(_, height)| *height > 0.0)
            .unzip();
        crowns.extend(crown::slice_crowns(&outlines));
        heights.extend(kept);
    }
    Ok((crowns, heights))
}

/// The city's crowns, cut, empty when it has no canopy layer or the file is missing.
pub fn city_crowns(city: &City, data: &Path) -> Fallible<(Vec<crown::Crown>, Vec<f64>)> {
    let Some(layer) = &city.field.canopy else {
        return Ok((Vec::new(), Vec::new()));
    };
    let path = data.join("canopy").join(&layer.file);
    if path.exists() {
        read_crowns(&path)
    } else {
        Ok((Vec::new(), Vec::new()))
    }
}

/// The city's casters, its footprint index and each outline's sweep shape.
fn read_city_shade(city: &City, data: &Path) -> Fallible<Option<CityShade>> {
    let buildings = data.join("buildings").join(format!("{}.bin", city.id));
    if !buildings.exists() {
        return Ok(None);
    }
    let (polygons, heights) = binfmt::read_buildings(&buildings)?;
    let (crowns, crown_heights) = city_crowns(city, data)?;
    Ok(Some(CityShade::new(Casters {
        polygons,
        heights,
        crowns,
        crown_heights,
    })))
}

/// Monotone-chain convex hull as one ring; fewer than three distinct points return as-is.
fn convex_hull(points: &[Coord]) -> Vec<Coord> {
    let mut sorted = points.to_vec();
    sorted.sort_by(|left, right| {
        left.lng
            .total_cmp(&right.lng)
            .then(left.lat.total_cmp(&right.lat))
    });
    sorted.dedup_by(|left, right| left.lng == right.lng && left.lat == right.lat);
    if sorted.len() < 3 {
        return sorted;
    }
    // > 0 is a left turn; popping on <= 0 keeps the hull strictly convex and drops collinear points.
    let cross = |origin: &Coord, first: &Coord, second: &Coord| {
        (first.lng - origin.lng) * (second.lat - origin.lat)
            - (first.lat - origin.lat) * (second.lng - origin.lng)
    };
    let mut hull: Vec<Coord> = Vec::with_capacity(sorted.len() + 1);
    for point in &sorted {
        while hull.len() >= 2 && cross(&hull[hull.len() - 2], &hull[hull.len() - 1], point) <= 0.0 {
            hull.pop();
        }
        hull.push(*point);
    }
    let lower = hull.len() + 1; // the upper hull may not pop below the last lower-hull vertex
    for point in sorted.iter().rev() {
        while hull.len() >= lower
            && cross(&hull[hull.len() - 2], &hull[hull.len() - 1], point) <= 0.0
        {
            hull.pop();
        }
        hull.push(*point);
    }
    hull.pop(); // the first point closes both chains
    hull
}

// Hull over-fill (m²) below which a footprint is swept as its convex hull; sub-pixel at z15.
const MIN_CONCAVITY_M2: f64 = 200.0;

// Max vertices per swept run, so a long boundary's strip keeps a bounding box near its ground.
const MAX_SWEEP_RUN: usize = 16;

/// Twice the unsigned area of a ring (shoelace).
fn double_area(ring: &[Coord]) -> f64 {
    let mut sum = 0.0;
    let mut previous = ring.len() - 1;
    for current in 0..ring.len() {
        sum += (ring[previous].lng - ring[current].lng) * (ring[previous].lat + ring[current].lat);
        previous = current;
    }
    sum.abs()
}

/// Twice the signed area of a ring (shoelace), positive counter-clockwise.
fn signed_double_area(ring: &[Coord]) -> f64 {
    let mut sum = 0.0;
    let mut previous = ring.len() - 1;
    for current in 0..ring.len() {
        sum += (ring[current].lng - ring[previous].lng) * (ring[current].lat + ring[previous].lat);
        previous = current;
    }
    -sum
}

/// The ground a ring covers sliding from `base` to `base + delta` (degrees).
/// Only front-facing edges need strips, and a run of them is monotone, so each run is one polygon.
fn append_sweep(
    ring: &Ring,
    base: (f64, f64),
    delta: (f64, f64),
    meters_per_lng: f64,
    out: &mut Vec<Polygon>,
) {
    if ring.len() < 3 {
        return;
    }
    let at = |vertex: &Coord| Coord {
        lng: vertex.lng + base.0,
        lat: vertex.lat + base.1,
    };
    let shift = |vertex: &Coord| Coord {
        lng: vertex.lng + base.0 + delta.0,
        lat: vertex.lat + base.1 + delta.1,
    };
    if delta.0 == 0.0 && delta.1 == 0.0 {
        out.push(vec![ring.iter().map(at).collect()]);
        return;
    }

    let mut swept_hull = || {
        let mut points: Vec<Coord> = Vec::with_capacity(ring.len() * 2);
        for vertex in ring {
            points.push(at(vertex));
            points.push(shift(vertex));
        }
        let hull = convex_hull(&points);
        if hull.len() >= 3 {
            out.push(vec![hull]);
        }
    };
    if sweeps_as_hull(ring, meters_per_lng) {
        swept_hull();
        return;
    }

    // An edge faces the sweep when its outward normal does, read with the ring's winding.
    let winding = if signed_double_area(ring) >= 0.0 {
        1.0
    } else {
        -1.0
    };
    let facing = |index: usize| {
        let from = ring[index];
        let to = ring[(index + 1) % ring.len()];
        let cross = (to.lng - from.lng) * delta.1 - (to.lat - from.lat) * delta.0;
        winding * cross <= 0.0
    };
    // Start on an away-facing edge so a run never wraps past the ring's end.
    let Some(start) = (0..ring.len()).find(|index| !facing(*index)) else {
        swept_hull();
        return;
    };

    out.push(vec![ring.iter().map(at).collect()]);
    out.push(vec![ring.iter().map(shift).collect()]);
    let mut run: Vec<Coord> = Vec::new();
    let close = |run: &mut Vec<Coord>, out: &mut Vec<Polygon>| {
        if run.len() >= 2 {
            let mut strip: Vec<Coord> = Vec::with_capacity(run.len() * 2);
            strip.extend(run.iter().map(at));
            strip.extend(run.iter().rev().map(shift));
            out.push(vec![strip]);
        }
        // The next run carries on from this one's last vertex, so a run cut for length leaves no gap.
        let carry = run.last().copied();
        run.clear();
        run.extend(carry);
    };
    for step in 0..ring.len() {
        let index = (start + step) % ring.len();
        if facing(index) {
            if run.is_empty() {
                run.push(ring[index]);
            }
            run.push(ring[(index + 1) % ring.len()]);
            if run.len() >= MAX_SWEEP_RUN {
                close(&mut run, out);
            }
        } else {
            // A run that ends naturally still sweeps; only a length cut carries into the next.
            close(&mut run, out);
            run.clear();
        }
    }
    close(&mut run, out);
}

/// The displacement, in degrees, a shadow of `distance` meters carries at this latitude's scale.
fn offset(distance: f64, sample: &Sample, meters_per_lng: f64) -> (f64, f64) {
    (
        distance * sample.east / meters_per_lng,
        distance * sample.north / METERS_PER_DEGREE_LAT,
    )
}

/// Append one building's shadow for one sample: its footprint swept down-sun by its capped length.
fn append_shadow(
    footprint: &Polygon,
    height: f64,
    sample: &Sample,
    max_shadow_meters: f64,
    out: &mut Vec<Polygon>,
) {
    let Some(outer) = footprint.first() else {
        return;
    };
    if outer.len() < 3 || height <= 0.0 {
        return;
    }
    let distance = (height * sample.shadow_per_height).min(max_shadow_meters);
    if distance <= 0.0 {
        return;
    }
    let meters_per_lng = ring_meters_per_lng(outer);
    let (d_lng, d_lat) = offset(distance, sample, meters_per_lng);
    let shift = |vertex: &Coord| Coord {
        lng: vertex.lng + d_lng,
        lat: vertex.lat + d_lat,
    };

    if sweeps_as_hull(outer, meters_per_lng) {
        let mut points: Vec<Coord> = Vec::with_capacity(outer.len() * 2);
        for vertex in outer {
            points.push(*vertex);
            points.push(shift(vertex));
        }
        let hull = convex_hull(&points);
        if hull.len() >= 3 {
            out.push(vec![hull]);
        }
        return;
    }

    out.push(vec![outer.clone()]);
    out.push(vec![outer.iter().map(shift).collect()]);
    for pair in outer.windows(2) {
        out.push(vec![vec![
            pair[0],
            pair[1],
            shift(&pair[1]),
            shift(&pair[0]),
        ]]);
    }
    // `windows` omits the closing edge when the ring is not explicitly closed; sweep it too.
    if let (Some(first), Some(last)) = (outer.first(), outer.last())
        && (first.lng != last.lng || first.lat != last.lat)
    {
        out.push(vec![vec![*last, *first, shift(first), shift(last)]]);
    }
}

/// Append one crown's shadow for one sample: slices swept across its airborne span, not a wall.
fn append_crown_shadow(
    crown: &crown::Crown,
    height: f64,
    sample: &Sample,
    max_shadow_meters: f64,
    meters_per_pixel: f64,
    out: &mut Vec<Polygon>,
) {
    for segment in crown::crown_segments(
        height,
        sample.shadow_per_height,
        max_shadow_meters,
        meters_per_pixel,
    ) {
        let Some(rings) = crown.levels.get(segment.level) else {
            continue;
        };
        for ring in rings {
            if ring.len() < 3 {
                continue;
            }
            let meters_per_lng = ring_meters_per_lng(ring);
            let base = offset(segment.from_m, sample, meters_per_lng);
            let end = offset(segment.to_m, sample, meters_per_lng);
            append_sweep(
                ring,
                base,
                (end.0 - base.0, end.1 - base.1),
                meters_per_lng,
                out,
            );
        }
    }
}

/// Ground per pixel at the client's handover zoom, so baked and client sweeps cut the same slices.
fn meters_per_pixel(lat: f64, max_zoom: u32) -> f64 {
    EQUATOR_METERS_PER_PIXEL * lat.to_radians().cos() / f64::from(1u32 << (max_zoom + 1))
}

impl Casters {
    fn building_count(&self) -> usize {
        self.polygons.len().min(self.heights.len())
    }

    fn crown_count(&self) -> usize {
        self.crowns.len().min(self.crown_heights.len())
    }

    /// One building's shadow for one sun-disk sample, shared by the pyramid and the per-edge bake.
    fn building_hulls(
        &self,
        index: usize,
        sample: &Sample,
        max_shadow_meters: f64,
        out: &mut Vec<Polygon>,
    ) {
        #[cfg(test)]
        tests::count_hull_call();
        append_shadow(
            &self.polygons[index],
            self.heights[index],
            sample,
            max_shadow_meters,
            out,
        );
    }

    /// One measured crown's shadow for one sun-disk sample; the crown mirror of `building_hulls`.
    fn crown_hulls(
        &self,
        index: usize,
        sample: &Sample,
        max_shadow_meters: f64,
        max_zoom: u32,
        out: &mut Vec<Polygon>,
    ) {
        #[cfg(test)]
        tests::count_hull_call();
        let crown = &self.crowns[index];
        let Some(ring) = crown.levels.first().and_then(|level| level.first()) else {
            return;
        };
        append_crown_shadow(
            crown,
            self.crown_heights[index],
            sample,
            max_shadow_meters,
            meters_per_pixel(ring[0].lat, max_zoom),
            out,
        );
    }
}

/// Whether a ring sweeps as one convex hull: its hull over-fills it by under MIN_CONCAVITY_M2.
fn sweeps_as_hull(ring: &[Coord], meters_per_lng: f64) -> bool {
    let hull = convex_hull(ring);
    let concavity_m2 =
        0.5 * (double_area(&hull) - double_area(ring)) * METERS_PER_DEGREE_LAT * meters_per_lng;
    concavity_m2 < MIN_CONCAVITY_M2
}

/// The east-west scale at a ring's latitude; city-scale, so its first vertex stands in.
fn ring_meters_per_lng(ring: &[Coord]) -> f64 {
    METERS_PER_DEGREE_LAT * ring[0].lat.to_radians().cos()
}

impl CityShade {
    /// The footprint index and each outline's sweep shape, worked out once for every bucket.
    fn new(casters: Casters) -> Self {
        let footprint_hulls = casters
            .polygons
            .par_iter()
            .map(|polygon| {
                polygon.first().is_some_and(|outer| {
                    outer.len() >= 3 && sweeps_as_hull(outer, ring_meters_per_lng(outer))
                })
            })
            .collect();
        let per_crown: Vec<Vec<bool>> = casters
            .crowns
            .par_iter()
            .map(|crown| {
                crown
                    .levels
                    .iter()
                    .flatten()
                    .map(|ring| ring.len() >= 3 && sweeps_as_hull(ring, ring_meters_per_lng(ring)))
                    .collect()
            })
            .collect();
        let mut crown_rings = Vec::with_capacity(per_crown.len() + 1);
        let mut ring_hulls = Vec::new();
        for rings in per_crown {
            crown_rings.push(ring_hulls.len() as u32);
            ring_hulls.extend(rings);
        }
        crown_rings.push(ring_hulls.len() as u32);
        let footprints = CasterIndex::new(casters.polygons.len(), |index| {
            let polygon = std::slice::from_ref(&casters.polygons[index]);
            (geometry::box_of(polygon), hull_bytes(polygon))
        });
        Self {
            casters,
            footprints,
            footprint_hulls,
            ring_hulls,
            crown_rings,
        }
    }

    /// `append_shadow`'s box over every sample and its hulls' bytes at most, without a hull: the
    /// footprint's box unioned with that box moved by each sample's offset.
    fn building_measure(
        &self,
        index: usize,
        samples: &[Sample],
        max_shadow_meters: f64,
    ) -> (Bounds, usize) {
        let height = self.casters.heights[index];
        let Some(outer) = self.casters.polygons[index].first() else {
            return (EMPTY, 0);
        };
        if outer.len() < 3 || height <= 0.0 {
            return (EMPTY, 0);
        }
        let meters_per_lng = ring_meters_per_lng(outer);
        let ground = ring_box(outer);
        let vertices = outer.len();
        // One hull of every vertex moved and not, or both rings and a quad per edge.
        let bytes = if self.footprint_hulls[index] {
            one_ring_bytes(1, 2 * vertices)
        } else {
            one_ring_bytes(vertices + 2, 6 * vertices)
        };
        let mut bounds = EMPTY;
        let mut est = 0;
        for sample in samples {
            let distance = (height * sample.shadow_per_height).min(max_shadow_meters);
            if distance <= 0.0 {
                continue;
            }
            let moved = shifted(&ground, offset(distance, sample, meters_per_lng));
            bounds = union(&bounds, &union(&ground, &moved));
            est += bytes;
        }
        (bounds, est)
    }

    /// `append_crown_shadow`'s box and bytes at most: each swept ring's box at the segment's
    /// base, unioned with it moved on by the sweep, as `append_sweep` adds the two.
    fn crown_measure(
        &self,
        index: usize,
        sample: &Sample,
        max_shadow_meters: f64,
        max_zoom: u32,
    ) -> (Bounds, usize) {
        let crown = &self.casters.crowns[index];
        let Some(first) = crown.levels.first().and_then(|level| level.first()) else {
            return (EMPTY, 0);
        };
        let mut bounds = EMPTY;
        let mut est = 0;
        for segment in crown::crown_segments(
            self.casters.crown_heights[index],
            sample.shadow_per_height,
            max_shadow_meters,
            meters_per_pixel(first[0].lat, max_zoom),
        ) {
            let Some(rings) = crown.levels.get(segment.level) else {
                continue;
            };
            let level_start = self.crown_rings[index] as usize
                + crown.levels[..segment.level]
                    .iter()
                    .map(Vec::len)
                    .sum::<usize>();
            for (at, ring) in rings.iter().enumerate() {
                if ring.len() < 3 {
                    continue;
                }
                let meters_per_lng = ring_meters_per_lng(ring);
                let base = offset(segment.from_m, sample, meters_per_lng);
                let end = offset(segment.to_m, sample, meters_per_lng);
                let delta = (end.0 - base.0, end.1 - base.1);
                let moved = shifted(&ring_box(ring), base);
                bounds = union(&bounds, &union(&moved, &shifted(&moved, delta)));
                let vertices = ring.len();
                est += if delta.0 == 0.0 && delta.1 == 0.0 {
                    one_ring_bytes(1, vertices)
                } else if self.ring_hulls[level_start + at] {
                    one_ring_bytes(1, 2 * vertices)
                } else {
                    // Both rings and the strips: a run needs a facing edge and ends on one that
                    // isn't, or is cut every MAX_SWEEP_RUN vertices, and a strip doubles its run.
                    let strips = vertices / 2 + vertices / (MAX_SWEEP_RUN - 1) + 1;
                    one_ring_bytes(2 + strips, 2 * vertices + 2 * (vertices + strips))
                };
            }
        }
        (bounds, est)
    }
}

/// A city's shadow indexes for one bucket; crowns cast from the center sample only (~5 cm penumbra).
struct CityShadows {
    buildings: CasterIndex,
    trees: Option<CasterIndex>,
}

fn city_shadows(shade: &CityShade, bucket: &Bucket, params: &Params) -> CityShadows {
    let casters = &shade.casters;
    let max_shadow_meters = params.max_shadow_meters;
    let trees = bucket
        .samples
        .first()
        .filter(|_| !casters.crowns.is_empty())
        .map(|sample| {
            CasterIndex::new(casters.crown_count(), |index| {
                shade.crown_measure(index, sample, max_shadow_meters, params.max_zoom)
            })
        });
    let buildings = CasterIndex::new(casters.building_count(), |index| {
        shade.building_measure(index, &bucket.samples, max_shadow_meters)
    });
    CityShadows { buildings, trees }
}

/// One pass of a tile's shadows: a sun sample's buildings, the crowns' center sample, or the
/// footprints punched out of both.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Layer {
    Building(usize),
    Crown,
    Footprint,
}

/// One city's shadows in one bucket: which casters each layer's hulls come from, and the hulls.
struct Scene<'a> {
    shade: &'a CityShade,
    shadows: &'a CityShadows,
    bucket: &'a Bucket,
    params: &'a Params,
}

impl Scene<'_> {
    /// The layers in order, each a held tile's mask slot as `slot` numbers it.
    fn layers(&self) -> impl Iterator<Item = Layer> + use<> {
        (0..self.bucket.samples.len())
            .map(Layer::Building)
            .chain(self.shadows.trees.is_some().then_some(Layer::Crown))
            .chain([Layer::Footprint])
    }

    /// A held tile's masks: one per sample, the crowns', then the footprints'.
    fn slots(&self) -> usize {
        self.bucket.samples.len() + 2
    }

    fn slot(&self, layer: Layer) -> usize {
        match layer {
            Layer::Building(sample) => sample,
            Layer::Crown => self.bucket.samples.len(),
            Layer::Footprint => self.bucket.samples.len() + 1,
        }
    }

    fn index(&self, layer: Layer) -> Option<&CasterIndex> {
        match layer {
            Layer::Building(_) => Some(&self.shadows.buildings),
            Layer::Crown => self.shadows.trees.as_ref(),
            Layer::Footprint => Some(&self.shade.footprints),
        }
    }

    /// One caster's hulls for one layer, appended to `out`.
    fn hulls(&self, layer: Layer, caster: usize, out: &mut Vec<Polygon>) {
        let casters = &self.shade.casters;
        let max_shadow_meters = self.params.max_shadow_meters;
        match layer {
            Layer::Building(sample) => {
                casters.building_hulls(caster, &self.bucket.samples[sample], max_shadow_meters, out)
            }
            Layer::Crown => casters.crown_hulls(
                caster,
                &self.bucket.samples[0],
                max_shadow_meters,
                self.params.max_zoom,
                out,
            ),
            Layer::Footprint => out.push(casters.polygons[caster].clone()),
        }
    }

    /// The estimated bytes of one whole-city pass of every layer's hulls.
    fn whole_pass(&self) -> usize {
        let est = |index: &CasterIndex| index.est.iter().sum::<usize>();
        est(&self.shadows.buildings)
            + self.shadows.trees.as_ref().map_or(0, est)
            + est(&self.shade.footprints)
    }

    /// Hull calls a whole-city pass of every layer makes, which the log measures against.
    fn caster_slots(&self) -> usize {
        let casters = &self.shade.casters;
        casters.building_count() * self.bucket.samples.len()
            + self
                .shadows
                .trees
                .as_ref()
                .map_or(0, |_| casters.crown_count())
            + casters.polygons.len()
    }
}

// A tile's supersampled mask is this wide and tall; a pixel holds SUBPIXELS of its cells.
const MASK_WIDTH: usize = TILE_SIZE * SUPERSAMPLE;
const SUBPIXELS: usize = SUPERSAMPLE * SUPERSAMPLE;

/// A quadtree node: a tile of the pyramid, planned or not.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct Node {
    zoom: u32,
    x: u32,
    y: u32,
}

impl Node {
    fn of(tile: &Tile) -> Self {
        Self {
            zoom: tile.zoom,
            x: tile.x,
            y: tile.y,
        }
    }

    fn children(self) -> [Node; 4] {
        let (zoom, x, y) = (self.zoom + 1, self.x * 2, self.y * 2);
        [(x, y), (x + 1, y), (x, y + 1), (x + 1, y + 1)].map(|(x, y)| Node { zoom, x, y })
    }
}

/// One tile's lng/lat window and its projection onto the supersampled mask. A child's window
/// nests exactly inside its parent's, since doubling a pixel and the world size divides the same.
#[derive(Clone, Copy)]
struct Frame {
    clip: Bounds,
    zoom: u32,
    origin_x: f64,
    origin_y: f64,
}

impl Frame {
    fn new(node: Node) -> Self {
        let zoom = node.zoom;
        let origin_x = f64::from(node.x) * TILE_SIZE as f64;
        let origin_y = f64::from(node.y) * TILE_SIZE as f64;
        Self {
            // Hulls already extend to where they land, so unlike canopy no reach halo is needed.
            clip: Bounds {
                west: pixel_x_to_lng(origin_x, zoom),
                east: pixel_x_to_lng(origin_x + TILE_SIZE as f64, zoom),
                north: pixel_y_to_lat(origin_y, zoom),
                south: pixel_y_to_lat(origin_y + TILE_SIZE as f64, zoom),
            },
            zoom,
            origin_x,
            origin_y,
        }
    }

    /// Lng/lat to supersampled mask coordinates.
    fn projection(&self) -> impl Fn(f64, f64) -> (f64, f64) + use<> {
        let scale = SUPERSAMPLE as f64;
        let (zoom, origin_x, origin_y) = (self.zoom, self.origin_x, self.origin_y);
        move |lng, lat| {
            (
                (lng_to_pixel_x(lng, zoom) - origin_x) * scale,
                (lat_to_pixel_y(lat, zoom) - origin_y) * scale,
            )
        }
    }

    /// Fill each polygon of `set` that reaches this tile into its mask, returning how many did.
    /// Fills set cells and never toggle them, each polygon on its own, so a mask is the union of
    /// the polygons filled into it, whatever their order, batching or repeats.
    fn fill(&self, mask: &mut [u8], set: &PolygonSet) -> usize {
        geometry::fill_polygons(
            mask,
            MASK_WIDTH,
            MASK_WIDTH,
            set,
            &self.clip,
            self.projection(),
        )
    }
}

/// Add each pixel's covered supersamples of `mask` into `counts`.
fn add_mask(mask: &[u8], counts: &mut [u8]) {
    for pixel_y in 0..TILE_SIZE {
        for pixel_x in 0..TILE_SIZE {
            let mut covered = 0u8;
            for sub_y in 0..SUPERSAMPLE {
                let row = (pixel_y * SUPERSAMPLE + sub_y) * MASK_WIDTH + pixel_x * SUPERSAMPLE;
                for sub_x in 0..SUPERSAMPLE {
                    covered += mask[row + sub_x];
                }
            }
            counts[pixel_y * TILE_SIZE + pixel_x] += covered;
        }
    }
}

/// The hulls of the casters overlapping `clip`, flattened a batch at a time for `each`.
fn stream(
    index: &CasterIndex,
    clip: &Bounds,
    candidates: &mut Vec<u32>,
    mut hulls_of: impl FnMut(usize, &mut Vec<Polygon>),
    mut each: impl FnMut(&PolygonSet),
) {
    index.overlapping(clip, candidates);
    let mut hulls: Vec<Polygon> = Vec::new();
    for caster in candidates.iter() {
        hulls_of(*caster as usize, &mut hulls);
        if hulls.len() >= FILL_BATCH {
            each(&geometry::flatten(&hulls));
            hulls.clear();
        }
    }
    if !hulls.is_empty() {
        each(&geometry::flatten(&hulls));
    }
}

/// One worker's reusable mask and candidate list.
struct Scratch {
    mask: Vec<u8>,
    candidates: Vec<u32>,
}

impl Scratch {
    fn new() -> Self {
        Self {
            mask: vec![0u8; MASK_WIDTH * MASK_WIDTH],
            candidates: Vec::new(),
        }
    }

    /// Add each pixel's covered supersamples of a whole set into `counts`; false if none reached.
    fn accumulate(
        &mut self,
        frame: &Frame,
        set: &PolygonSet,
        grid: &PolygonGrid,
        counts: &mut [u8],
    ) -> bool {
        grid.candidates(&frame.clip, &mut self.candidates);
        if self.candidates.is_empty() {
            return false;
        }
        self.mask.fill(0);
        let drawn = geometry::fill_polygons_indexed(
            &mut self.mask,
            MASK_WIDTH,
            MASK_WIDTH,
            set,
            &self.candidates,
            &frame.clip,
            frame.projection(),
        );
        if drawn == 0 {
            return false;
        }
        add_mask(&self.mask, counts);
        true
    }

    /// `accumulate` over hulls generated per overlapping caster and filled a batch at a time,
    /// each batch also handed to `paint` for the held tiles above.
    fn accumulate_shadows(
        &mut self,
        frame: &Frame,
        index: &CasterIndex,
        hulls_of: impl FnMut(usize, &mut Vec<Polygon>),
        counts: &mut [u8],
        mut paint: impl FnMut(&PolygonSet),
    ) -> bool {
        let Self { mask, candidates } = self;
        let mut cleared = false;
        let mut drawn = 0;
        stream(index, &frame.clip, candidates, hulls_of, |set| {
            if !cleared {
                mask.fill(0);
                cleared = true;
            }
            drawn += frame.fill(mask, set);
            paint(set);
        });
        if drawn == 0 {
            return false;
        }
        add_mask(mask, counts);
        true
    }
}

/// One tile's two shadow fractions, each None where nothing was cast onto it.
#[derive(Default)]
struct Coverage {
    buildings: Option<Vec<f32>>,
    trees: Option<Vec<f32>>,
}

/// A tile's covered supersamples per pixel, summed over each layer's passes: up to 16 a sample.
/// Each pass once added covered/16 into an f32; those are exact dyadics, so every such sum was
/// exact and equals the count over 16, which is how `finish` reads it.
struct Planes {
    buildings: Vec<u8>,
    trees: Vec<u8>,
    base: Vec<u8>,
    any_buildings: bool,
    any_trees: bool,
}

impl Planes {
    fn new() -> Self {
        Self {
            buildings: vec![0u8; TILE_SIZE * TILE_SIZE],
            trees: vec![0u8; TILE_SIZE * TILE_SIZE],
            base: vec![0u8; TILE_SIZE * TILE_SIZE],
            any_buildings: false,
            any_trees: false,
        }
    }

    /// Whether any shadow reached the tile, without which its footprints needn't be filled.
    fn any(&self) -> bool {
        self.any_buildings || self.any_trees
    }

    fn counts(&mut self, layer: Layer) -> &mut [u8] {
        match layer {
            Layer::Building(_) => &mut self.buildings,
            Layer::Crown => &mut self.trees,
            Layer::Footprint => &mut self.base,
        }
    }

    fn drew(&mut self, layer: Layer, drew: bool) {
        match layer {
            Layer::Building(_) => self.any_buildings |= drew,
            Layer::Crown => self.any_trees |= drew,
            Layer::Footprint => {}
        }
    }

    /// Per-pixel building and tree shadow fractions, punched by building footprints.
    /// Crowns aren't punched from their own shadow: the ground under a tree is the shadiest there is.
    fn finish(&self, samples: usize) -> Coverage {
        if !self.any() {
            return Coverage::default();
        }
        let fraction = |counts: &[u8]| -> Vec<f32> {
            counts
                .iter()
                .map(|count| f32::from(*count) / SUBPIXELS as f32)
                .collect()
        };
        let base = fraction(&self.base);
        let mut buildings = fraction(&self.buildings);
        let mut trees = fraction(&self.trees);
        Coverage {
            buildings: (self.any_buildings && resolve(&mut buildings, samples as f32, &base))
                .then_some(buildings),
            trees: (self.any_trees && resolve(&mut trees, 1.0, &base)).then_some({
                soften(&mut trees);
                trees
            }),
        }
    }
}

/// Average a plane over its samples and punch out footprints; false when nothing survives.
fn resolve(plane: &mut [f32], samples: f32, base: &[f32]) -> bool {
    let mut painted = false;
    for (value, base) in plane.iter_mut().zip(base) {
        *value = (*value / samples) * (1.0 - base);
        painted |= *value > 0.0;
    }
    painted
}

/// Softens a plane by one pixel with a separable 1-2-1 tent, antialiasing single-sample crowns.
fn soften(plane: &mut [f32]) {
    let mut pass = vec![0.0f32; plane.len()];
    for row in 0..TILE_SIZE {
        for column in 0..TILE_SIZE {
            let index = row * TILE_SIZE + column;
            let left = if column == 0 {
                plane[index]
            } else {
                plane[index - 1]
            };
            let right = if column + 1 == TILE_SIZE {
                plane[index]
            } else {
                plane[index + 1]
            };
            pass[index] = 0.25 * left + 0.5 * plane[index] + 0.25 * right;
        }
    }
    for row in 0..TILE_SIZE {
        for column in 0..TILE_SIZE {
            let index = row * TILE_SIZE + column;
            let up = if row == 0 {
                pass[index]
            } else {
                pass[index - TILE_SIZE]
            };
            let down = if row + 1 == TILE_SIZE {
                pass[index]
            } else {
                pass[index + TILE_SIZE]
            };
            plane[index] = 0.25 * up + 0.5 * pass[index] + 0.25 * down;
        }
    }
}

/// Paint every pixel the slate, alpha from shade and intensity; below MIN_ALPHA stays transparent.
fn paint(pixels: &mut [u8], fraction: &[f32], intensity: f64) -> bool {
    let mut painted = false;
    for (pixel, value) in fraction.iter().enumerate() {
        pixels[pixel * 4..pixel * 4 + 3].copy_from_slice(&SHADE_RGB);
        if *value <= 0.0 {
            continue;
        }
        let exact = round_half_up(f64::from(*value) * intensity * MAX_SHADE_ALPHA) as u16;
        let alpha =
            (((exact + SHADE_ALPHA_STEP / 2) / SHADE_ALPHA_STEP) * SHADE_ALPHA_STEP).min(255) as u8;
        if alpha < MIN_ALPHA {
            continue;
        }
        pixels[pixel * 4 + 3] = alpha;
        painted = true;
    }
    painted
}

fn write_tile(directory: &Path, tile: &Tile, pixels: &[u8]) -> Fallible<usize> {
    let encoded = encode_webp_lossless(pixels);
    fs::write(
        directory
            .join(tile.zoom.to_string())
            .join(tile.x.to_string())
            .join(format!("{}.webp", tile.y)),
        &encoded,
    )?;
    Ok(encoded.len())
}

/// A rendered tile's RGBA per pyramid, each None when nothing on it was painted.
#[derive(Clone, PartialEq, Eq, Debug)]
struct TilePixels {
    buildings: Option<Vec<u8>>,
    trees: Option<Vec<u8>>,
}

/// Paint the members' coverages in turn into one tile's two pyramids.
fn tile_pixels(coverages: impl IntoIterator<Item = Coverage>, intensity: f64) -> TilePixels {
    let mut building_pixels = vec![0u8; TILE_SIZE * TILE_SIZE * 4];
    let mut tree_pixels = vec![0u8; TILE_SIZE * TILE_SIZE * 4];
    let mut painted = false;
    let mut tree_painted = false;
    for fractions in coverages {
        if let Some(fraction) = fractions.buildings {
            painted |= paint(&mut building_pixels, &fraction, intensity);
        }
        if let Some(fraction) = fractions.trees {
            tree_painted |= paint(&mut tree_pixels, &fraction, intensity);
        }
    }
    TilePixels {
        buildings: painted.then_some(building_pixels),
        trees: tree_painted.then_some(tree_pixels),
    }
}

/// A split tile its descendants paint into, one supersampled mask per slot, so no hull is ever
/// generated for it. Whichever painter finishes last renders it and frees the masks.
struct Held {
    tile: usize, // its index in the plan
    city: usize,
    frame: Frame,
    masks: Vec<Mutex<Option<Vec<u8>>>>, // allocated on the first paint
    pending: AtomicUsize,               // jobs yet to paint it
}

impl Held {
    /// Fill a batch of one slot's hulls into the mask, returning how many reached it.
    fn paint(&self, slot: usize, set: &PolygonSet) -> usize {
        let mut mask = self.masks[slot]
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let mask = mask.get_or_insert_with(|| vec![0u8; MASK_WIDTH * MASK_WIDTH]);
        self.frame.fill(mask, set)
    }

    /// The painted counts, freeing the masks. A slot nothing reached is all zero, as the streamed
    /// path's is, and resolving zero planes paints nothing, as its early return does.
    fn planes(&self, scene: &Scene) -> Planes {
        let mut planes = Planes::new();
        planes.any_buildings = true;
        planes.any_trees = true;
        for layer in scene.layers() {
            let mask = self.masks[scene.slot(layer)]
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();
            if let Some(mask) = mask {
                add_mask(&mask, planes.counts(layer));
            }
        }
        planes
    }
}

/// What a worker does with one job.
#[derive(Debug)]
enum Work {
    /// Render the plan `tiles` in `node`'s subtree from one working set per layer, and paint the
    /// held tiles above with it; a virtual node (not in the plan) has no tiles and only paints.
    Root {
        node: Node,
        city: usize,
        tiles: Vec<usize>,
    },
    /// Render one tile from hulls generated for it alone, as ever, painting each batch into
    /// the held tiles above; without a `tile` it's virtual and only paints.
    Stream {
        node: Node,
        city: usize,
        tile: Option<usize>,
    },
    /// A tile several cities reach, rendered per member in turn as ever.
    Shared { tile: usize },
    /// Nothing, but a held tile nothing below paints is rendered once it's done.
    Finish,
}

#[derive(Debug)]
struct Job {
    work: Work,
    held: Vec<usize>, // the held tiles it paints, indices into `Schedule::held`
    cost: usize,      // estimated bytes of hulls it generates
}

/// One bucket's jobs, longest first, and the held tiles they paint.
struct Schedule {
    jobs: Vec<Job>,
    held: Vec<(usize, usize)>, // (plan index, city)
    held_bytes: usize,         // the held masks' bound
    max_working: usize,        // the largest root's working set and planes
    work: usize,               // estimated bytes of hulls generated, across every job
    roots: BTreeMap<u32, usize>,
    streamed: usize,
    leaves: usize,
}

impl Schedule {
    fn describe(&self, whole_pass: usize) -> String {
        let roots: Vec<String> = self
            .roots
            .iter()
            .map(|(zoom, count)| format!("{count} at z{zoom}"))
            .collect();
        format!(
            "{} held ({:.0} MiB), roots {}, {} streamed, {} leaves; working sets to {:.0} MiB, \
             ~{:.2} city passes of hulls",
            self.held.len(),
            self.held_bytes as f64 / 1024.0 / 1024.0,
            if roots.is_empty() {
                "none".to_owned()
            } else {
                roots.join(" ")
            },
            self.streamed,
            self.leaves,
            self.max_working as f64 / 1024.0 / 1024.0,
            self.work as f64 / whole_pass.max(1) as f64
        )
    }
}

// A held tile's masks, and a root's three count planes per tile it renders.
const MASK_BYTES: usize = MASK_WIDTH * MASK_WIDTH;
const PLANE_BYTES: usize = 3 * TILE_SIZE * TILE_SIZE;

/// What a subtree root generates: every layer's estimated hull bytes over its window, and the
/// largest single layer, which is all of a working set that's alive at once.
#[derive(Clone, Copy)]
struct Cost {
    all: usize,
    layer: usize,
}

/// Picks, per bucket, which split tiles are held and where subtrees are rendered whole.
struct Planner<'a> {
    scenes: &'a [Option<Scene<'a>>],
    plan: &'a [Tile],
    max_zoom: u32,
    threads: usize,
    tiles: HashMap<Node, usize>, // plan index by node
    below: HashMap<Node, usize>, // plan tiles in each planned node's subtree, itself included
    costs: HashMap<(Node, usize), Cost>,
    candidates: Vec<u32>,
}

impl<'a> Planner<'a> {
    fn new(
        scenes: &'a [Option<Scene<'a>>],
        plan: &'a [Tile],
        max_zoom: u32,
        threads: usize,
    ) -> Self {
        let tiles: HashMap<Node, usize> = plan
            .iter()
            .enumerate()
            .map(|(index, tile)| (Node::of(tile), index))
            .collect();
        let mut below: HashMap<Node, usize> = HashMap::new();
        for tile in plan {
            for zoom in MIN_ZOOM..=tile.zoom {
                let shift = tile.zoom - zoom;
                let node = Node {
                    zoom,
                    x: tile.x >> shift,
                    y: tile.y >> shift,
                };
                *below.entry(node).or_default() += 1;
            }
        }
        Self {
            scenes,
            plan,
            max_zoom,
            threads: threads.max(1),
            tiles,
            below,
            costs: HashMap::new(),
            candidates: Vec::new(),
        }
    }

    /// A tile's one city when only one reaches it and has buildings; anything else is Shared.
    fn single(&self, tile: &Tile) -> Option<usize> {
        match tile.members[..] {
            [city] if self.scenes[city].is_some() => Some(city),
            _ => None,
        }
    }

    fn cost(&mut self, node: Node, city: usize) -> Cost {
        if let Some(cost) = self.costs.get(&(node, city)) {
            return *cost;
        }
        let Some(scene) = &self.scenes[city] else {
            return Cost { all: 0, layer: 0 };
        };
        let clip = Frame::new(node).clip;
        let scratch = &mut self.candidates;
        let buildings = scene.shadows.buildings.bytes_over(&clip, scratch);
        let crowns = scene
            .shadows
            .trees
            .as_ref()
            .map_or(0, |trees| trees.bytes_over(&clip, scratch));
        let footprints = scene.shade.footprints.bytes_over(&clip, scratch);
        let per_sample = buildings / scene.bucket.samples.len().max(1);
        let cost = Cost {
            all: buildings + crowns + footprints,
            layer: per_sample.max(crowns).max(footprints),
        };
        self.costs.insert((node, city), cost);
        cost
    }

    /// What streaming one tile generates: each member's hulls over its window.
    fn tile_cost(&mut self, index: usize) -> usize {
        let tile = &self.plan[index];
        let node = Node::of(tile);
        let members = tile.members.clone();
        members
            .into_iter()
            .map(|city| self.cost(node, city).all)
            .sum()
    }

    /// The least-work schedule within `budget`: each depth to hold split tiles down to is tried,
    /// the masks it may hold taken off the budget before the rest is shared out per thread.
    fn schedule(&mut self, budget: usize) -> Schedule {
        let whole: usize = (0..self.plan.len())
            .filter(|index| self.plan[*index].zoom == MIN_ZOOM)
            .map(|index| self.tile_cost(index))
            .sum();
        let cap = whole / (4 * self.threads);
        let mask = self.mask_bytes();
        let mut best: Option<Schedule> = None;
        for depth in std::iter::once(None).chain((MIN_ZOOM..self.max_zoom).map(Some)) {
            let holdable = depth.map_or(0, |depth| {
                self.plan
                    .iter()
                    .filter(|tile| tile.zoom <= depth && self.single(tile).is_some())
                    .count()
            });
            let held_bound = mask * holdable;
            if held_bound > budget {
                break;
            }
            let schedule = self.schedule_with((budget - held_bound) / self.threads, depth, cap);
            if best.as_ref().is_none_or(|best| {
                (schedule.work, schedule.held_bytes) < (best.work, best.held_bytes)
            }) {
                best = Some(schedule);
            }
        }
        best.expect("holding nothing always fits")
    }

    fn mask_bytes(&self) -> usize {
        let slots = self.scenes.iter().flatten().map(Scene::slots).max();
        MASK_BYTES * slots.unwrap_or(0)
    }

    /// The schedule for roots of at most `per_task` bytes and `cap` work, holding the split
    /// tiles down to zoom `depth`.
    fn schedule_with(&mut self, per_task: usize, depth: Option<u32>, cap: usize) -> Schedule {
        let mut schedule = Schedule {
            jobs: Vec::new(),
            held: Vec::new(),
            held_bytes: 0,
            max_working: 0,
            work: 0,
            roots: BTreeMap::new(),
            streamed: 0,
            leaves: 0,
        };
        let tops: Vec<Node> = self
            .plan
            .iter()
            .filter(|tile| tile.zoom == MIN_ZOOM)
            .map(Node::of)
            .collect();
        let mut held = Vec::new();
        for node in tops {
            self.descend(node, None, &mut held, &mut schedule, (per_task, depth, cap));
        }
        schedule.held_bytes = schedule.held.len() * self.mask_bytes();
        // A held tile nothing paints still renders, blank, once a job says it's done.
        let mut painters = vec![0usize; schedule.held.len()];
        for job in &schedule.jobs {
            for held in &job.held {
                painters[*held] += 1;
            }
        }
        for (held, painters) in painters.into_iter().enumerate() {
            if painters == 0 {
                schedule.jobs.push(Job {
                    work: Work::Finish,
                    held: vec![held],
                    cost: 0,
                });
            }
        }
        schedule.work = schedule.jobs.iter().map(|job| job.cost).sum();
        schedule.jobs.sort_by_key(|job| std::cmp::Reverse(job.cost));
        schedule
    }

    /// Place `node`: a leaf streams; a subtree that fits is a root; anything else splits, held
    /// if planned for one city and no deeper than `depth`, else streamed, and its quadrants
    /// follow. Quadrants outside the plan are visited only under a held tile, which is what
    /// they catch shadows spilling past the city for.
    fn descend(
        &mut self,
        node: Node,
        inherited: Option<usize>,
        held: &mut Vec<usize>,
        schedule: &mut Schedule,
        limits: (usize, Option<u32>, usize),
    ) {
        let (per_task, depth, cap) = limits;
        let tile = self.tiles.get(&node).copied();
        let city = match tile {
            Some(index) => self.single(&self.plan[index]),
            None => inherited,
        };
        if node.zoom >= self.max_zoom {
            match (tile, city) {
                (Some(index), None) => {
                    let cost = self.tile_cost(index);
                    schedule.jobs.push(Job {
                        work: Work::Shared { tile: index },
                        held: Vec::new(),
                        cost,
                    });
                    schedule.leaves += 1;
                }
                (tile, Some(city)) => {
                    let cost = self.cost(node, city).all;
                    if tile.is_some() || cost > 0 {
                        schedule.jobs.push(Job {
                            work: Work::Stream { node, city, tile },
                            held: held.clone(),
                            cost,
                        });
                        schedule.leaves += 1;
                    }
                }
                (None, None) => {}
            }
            return;
        }
        if let Some(city) = city {
            let cost = self.cost(node, city);
            let working = cost.layer + PLANE_BYTES * self.below.get(&node).copied().unwrap_or(0);
            if working <= per_task && cost.all <= cap {
                if tile.is_some() || cost.all > 0 {
                    let mut tiles = Vec::new();
                    self.subtree(node, &mut tiles);
                    schedule.jobs.push(Job {
                        work: Work::Root { node, city, tiles },
                        held: held.clone(),
                        cost: cost.all,
                    });
                    *schedule.roots.entry(node.zoom).or_default() += 1;
                    schedule.max_working = schedule.max_working.max(working);
                }
                return;
            }
        }
        let holds =
            tile.is_some() && city.is_some() && depth.is_some_and(|depth| node.zoom <= depth);
        match (tile, city) {
            (Some(index), Some(city)) if holds => {
                held.push(schedule.held.len());
                schedule.held.push((index, city));
            }
            (Some(index), city) => {
                let (work, cost) = match city {
                    Some(city) => (
                        Work::Stream {
                            node,
                            city,
                            tile: Some(index),
                        },
                        self.cost(node, city).all,
                    ),
                    None => (Work::Shared { tile: index }, self.tile_cost(index)),
                };
                schedule.jobs.push(Job {
                    work,
                    held: Vec::new(), // its quadrants paint the held tiles above
                    cost,
                });
                schedule.streamed += 1;
            }
            (None, _) => {}
        }
        for child in node.children() {
            if self.tiles.contains_key(&child) || !held.is_empty() {
                self.descend(child, city, held, schedule, limits);
            }
        }
        if holds {
            held.pop();
        }
    }

    /// The plan tiles in `node`'s subtree, itself first if planned; the plan holds every
    /// planned tile's parent, so only planned nodes need visiting.
    fn subtree(&self, node: Node, out: &mut Vec<usize>) {
        let Some(index) = self.tiles.get(&node) else {
            return;
        };
        out.push(*index);
        if node.zoom < self.max_zoom {
            for child in node.children() {
                self.subtree(child, out);
            }
        }
    }
}

/// What rendering one bucket measured, for the log and the tests.
#[derive(Default)]
struct Report {
    stats: Stats,
    hulls: usize,           // hull calls, one per caster per layer
    virtual_painted: usize, // jobs outside the plan that painted a held tile
}

/// Hands a rendered tile on, to disk or a test, and counts it.
type Emit<'e> = &'e (dyn Fn(&Tile, &TilePixels) -> Fallible<Stats> + Sync);

/// What every job of one bucket renders from and where its tiles go.
struct BucketRender<'a> {
    scenes: &'a [Option<Scene<'a>>],
    plan: &'a [Tile],
    emit: Emit<'a>,
}

impl BucketRender<'_> {
    fn scene(&self, city: usize) -> &Scene<'_> {
        self.scenes[city]
            .as_ref()
            .expect("only a city with buildings is scheduled on its own")
    }

    /// Paint `planes`' coverage as `tile` and hand it on.
    fn emit(&self, scene: &Scene, tile: usize, planes: &Planes) -> Fallible<Stats> {
        let coverage = planes.finish(scene.bucket.samples.len());
        (self.emit)(
            &self.plan[tile],
            &tile_pixels([coverage], scene.bucket.intensity),
        )
    }
}

/// Runs a schedule on exactly `threads` workers, each taking the next longest job; the first
/// error stops them and is returned.
fn execute(render: &BucketRender, schedule: &Schedule, threads: usize) -> Fallible<Report> {
    let held: Vec<Held> = schedule
        .held
        .iter()
        .map(|&(tile, city)| Held {
            tile,
            city,
            frame: Frame::new(Node::of(&render.plan[tile])),
            masks: (0..render.scene(city).slots())
                .map(|_| Mutex::new(None))
                .collect(),
            pending: AtomicUsize::new(0),
        })
        .collect();
    for job in &schedule.jobs {
        for index in &job.held {
            held[*index].pending.fetch_add(1, Ordering::Relaxed);
        }
    }
    let next = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    let failure: Mutex<Option<Box<dyn std::error::Error + Send + Sync>>> = Mutex::new(None);
    let reports: Vec<Report> = (0..threads.max(1))
        .into_par_iter()
        .map(|_| {
            let mut report = Report::default();
            let mut scratch = Scratch::new();
            while !stop.load(Ordering::Relaxed) {
                let Some(job) = schedule.jobs.get(next.fetch_add(1, Ordering::Relaxed)) else {
                    break;
                };
                if let Err(error) = run_job(render, job, &held, &mut scratch, &mut report) {
                    stop.store(true, Ordering::Relaxed);
                    failure
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .get_or_insert(error);
                    break;
                }
            }
            report
        })
        .collect();
    if let Some(error) = failure.into_inner().unwrap_or_else(PoisonError::into_inner) {
        return Err(error);
    }
    Ok(reports
        .into_iter()
        .fold(Report::default(), |left, right| Report {
            stats: left.stats + right.stats,
            hulls: left.hulls + right.hulls,
            virtual_painted: left.virtual_painted + right.virtual_painted,
        }))
}

/// Do one job, then render each held tile it was the last to paint.
fn run_job(
    render: &BucketRender,
    job: &Job,
    held: &[Held],
    scratch: &mut Scratch,
    report: &mut Report,
) -> Fallible<()> {
    let above: Vec<&Held> = job.held.iter().map(|index| &held[*index]).collect();
    match &job.work {
        Work::Root { node, city, tiles } => {
            render_root(
                render,
                render.scene(*city),
                *node,
                tiles,
                &above,
                scratch,
                report,
            )?;
        }
        Work::Stream { node, city, tile } => {
            let scene = render.scene(*city);
            let frame = Frame::new(*node);
            if let Some(tile) = tile {
                let planes = render_streamed(scene, &frame, &above, scratch, report);
                report.stats = report.stats + render.emit(scene, *tile, &planes)?;
            } else {
                paint_streamed(scene, &frame, &above, scratch, report);
            }
        }
        Work::Shared { tile } => {
            report.stats = report.stats + render_shared(render, *tile, scratch, report)?;
        }
        Work::Finish => {}
    }
    for held in above {
        if held.pending.fetch_sub(1, Ordering::AcqRel) == 1 {
            let scene = render.scene(held.city);
            report.stats = report.stats + render.emit(scene, held.tile, &held.planes(scene))?;
        }
    }
    Ok(())
}

/// A subtree's plan tiles from one working set per layer, generated over the root's window and
/// dropped before the next: every hull reaching a tile below reaches the root, whose window
/// holds theirs exactly. Each set is also filled whole into the held tiles above.
fn render_root(
    render: &BucketRender,
    scene: &Scene,
    node: Node,
    tiles: &[usize],
    above: &[&Held],
    scratch: &mut Scratch,
    report: &mut Report,
) -> Fallible<()> {
    let root = Frame::new(node);
    let frames: Vec<Frame> = tiles
        .iter()
        .map(|tile| Frame::new(Node::of(&render.plan[*tile])))
        .collect();
    let mut planes: Vec<Planes> = tiles.iter().map(|_| Planes::new()).collect();
    let mut hulls: Vec<Polygon> = Vec::new();
    let mut painted = 0;
    for layer in scene.layers() {
        let Some(index) = scene.index(layer) else {
            continue;
        };
        let footprints = layer == Layer::Footprint;
        if footprints && above.is_empty() && !planes.iter().any(Planes::any) {
            continue;
        }
        index.overlapping(&root.clip, &mut scratch.candidates);
        if scratch.candidates.is_empty() {
            continue;
        }
        report.hulls += scratch.candidates.len();
        let mut parts = Vec::new();
        for caster in &scratch.candidates {
            scene.hulls(layer, *caster as usize, &mut hulls);
            if hulls.len() >= FILL_BATCH {
                parts.push(geometry::flatten(&hulls));
                hulls.clear();
            }
        }
        parts.push(geometry::flatten(&hulls));
        hulls.clear();
        let set = PolygonSet::concat(parts);
        let grid = PolygonGrid::new(&set);
        for (frame, planes) in frames.iter().zip(&mut planes) {
            if footprints && !planes.any() {
                continue;
            }
            let drew = scratch.accumulate(frame, &set, &grid, planes.counts(layer));
            planes.drew(layer, drew);
        }
        for held in above {
            painted += held.paint(scene.slot(layer), &set);
        }
    }
    if tiles.is_empty() && painted > 0 {
        report.virtual_painted += 1;
    }
    for (tile, planes) in tiles.iter().zip(&planes) {
        report.stats = report.stats + render.emit(scene, *tile, planes)?;
    }
    Ok(())
}

/// One tile's counts from hulls generated for it alone, each batch also painted into the held
/// tiles above.
fn render_streamed(
    scene: &Scene,
    frame: &Frame,
    above: &[&Held],
    scratch: &mut Scratch,
    report: &mut Report,
) -> Planes {
    let mut planes = Planes::new();
    for layer in scene.layers() {
        let Some(index) = scene.index(layer) else {
            continue;
        };
        if layer == Layer::Footprint && above.is_empty() && !planes.any() {
            continue;
        }
        let slot = scene.slot(layer);
        let hulls = &mut report.hulls;
        let drew = scratch.accumulate_shadows(
            frame,
            index,
            |caster, out| {
                *hulls += 1;
                scene.hulls(layer, caster, out);
            },
            planes.counts(layer),
            |set| {
                for held in above {
                    held.paint(slot, set);
                }
            },
        );
        planes.drew(layer, drew);
    }
    planes
}

/// A node outside the plan: its hulls generated only to paint the held tiles above.
fn paint_streamed(
    scene: &Scene,
    frame: &Frame,
    above: &[&Held],
    scratch: &mut Scratch,
    report: &mut Report,
) {
    let mut painted = 0;
    for layer in scene.layers() {
        let Some(index) = scene.index(layer) else {
            continue;
        };
        let slot = scene.slot(layer);
        let hulls = &mut report.hulls;
        stream(
            index,
            &frame.clip,
            &mut scratch.candidates,
            |caster, out| {
                *hulls += 1;
                scene.hulls(layer, caster, out);
            },
            |set| {
                for held in above {
                    painted += held.paint(slot, set);
                }
            },
        );
    }
    report.virtual_painted += usize::from(painted > 0);
}

/// A tile several cities reach: each member's coverage painted over the last, as ever.
fn render_shared(
    render: &BucketRender,
    tile: usize,
    scratch: &mut Scratch,
    report: &mut Report,
) -> Fallible<Stats> {
    let tile = &render.plan[tile];
    let frame = Frame::new(Node::of(tile));
    let mut coverages = Vec::new();
    let mut intensity = 0.0;
    for member in &tile.members {
        if let Some(scene) = &render.scenes[*member] {
            let planes = render_streamed(scene, &frame, &[], scratch, report);
            coverages.push(planes.finish(scene.bucket.samples.len()));
            intensity = scene.bucket.intensity;
        }
    }
    (render.emit)(tile, &tile_pixels(coverages, intensity))
}

/// Writes `<tiles>/shade/<city>/buckets.json` every build, since bins move before any render.
pub fn write_schedule(shade_dir: &Path, params: &Params) -> Fallible<()> {
    let schedule: Vec<BucketEntry> = params
        .buckets
        .iter()
        .enumerate()
        .map(|(index, bucket)| BucketEntry {
            index,
            season: bucket.season,
            hour_angle: bucket.hour_angle,
            elevation: bucket.elevation,
            azimuth: bucket.azimuth,
        })
        .collect();
    fs::create_dir_all(shade_dir)?;
    Ok(fs::write(
        shade_dir.join("buckets.json"),
        serde_json::to_vec(&schedule)?,
    )?)
}

pub fn run(args: &Args) -> Fallible<()> {
    let started = Instant::now();
    let mut manifest: Manifest = serde_json::from_slice(&fs::read(&args.manifest)?)?;
    let params = &args.params;
    manifest.cities.retain(|city| city.id == args.city);
    if manifest.cities.is_empty() {
        return Err(format!("no city {} in the manifest", args.city).into());
    }
    // A pixel's building count sums 16 a sample into a u8.
    if let Some(bucket) = params
        .buckets
        .iter()
        .find(|bucket| bucket.samples.len() * SUBPIXELS > usize::from(u8::MAX))
    {
        return Err(format!("a bin has {} sun samples, past 15", bucket.samples.len()).into());
    }

    let mut cities: Vec<Option<CityShade>> = Vec::with_capacity(manifest.cities.len());
    for city in &manifest.cities {
        cities.push(read_city_shade(city, &args.data)?);
    }
    if cities.iter().all(Option::is_none) {
        eprintln!("no city has a buildings layer; nothing to render");
        return Ok(());
    }
    for (city, shade) in manifest.cities.iter().zip(&cities) {
        if let Some(shade) = shade {
            eprintln!(
                "{}: {} building footprints, {} crowns with a measured height",
                city.id,
                shade.casters.polygons.len(),
                shade.casters.crowns.len(),
            );
        }
    }

    let plan = plan_tiles(&manifest.cities, params.max_zoom);
    let shade_dir = args.tiles.join("shade").join(&args.city);
    fs::create_dir_all(&shade_dir)?;
    // No measured heights anywhere: no tree pyramid, and the client uses building tiles alone.
    let tree_root = cities
        .iter()
        .flatten()
        .any(|shade| !shade.casters.crowns.is_empty())
        .then(|| args.tiles.join("tree-shade").join(&args.city));
    if let Some(root) = &tree_root {
        fs::create_dir_all(root)?;
    }

    let threads = rayon::current_num_threads();
    let mut total = Stats::default();
    for job in &args.render {
        let index = job.index;
        let bucket = params
            .buckets
            .get(index)
            .ok_or_else(|| format!("bin {index} is not in a grid of {}", params.buckets.len()))?;
        let building_dir = shade_dir.join(index.to_string());
        let tree_dir = tree_root.as_ref().map(|root| root.join(index.to_string()));
        for tile in &plan {
            for directory in [Some(&building_dir), tree_dir.as_ref()]
                .into_iter()
                .flatten()
            {
                fs::create_dir_all(
                    directory
                        .join(tile.zoom.to_string())
                        .join(tile.x.to_string()),
                )?;
            }
        }
        let shadows: Vec<Option<CityShadows>> = cities
            .iter()
            .map(|city| {
                city.as_ref()
                    .map(|shade| city_shadows(shade, bucket, params))
            })
            .collect();
        let scenes: Vec<Option<Scene>> = cities
            .iter()
            .zip(&shadows)
            .map(|(shade, shadows)| {
                Some(Scene {
                    shade: shade.as_ref()?,
                    shadows: shadows.as_ref()?,
                    bucket,
                    params,
                })
            })
            .collect();
        let schedule =
            Planner::new(&scenes, &plan, params.max_zoom, threads).schedule(args.memory_budget);
        let whole_pass: usize = scenes.iter().flatten().map(Scene::whole_pass).sum();
        eprintln!(
            "bin {index} (el {:.0}° az {:.0}°): rendering {} tiles across {threads} threads",
            bucket.elevation,
            bucket.azimuth,
            plan.len(),
        );
        eprintln!("  {}", schedule.describe(whole_pass));

        let emit = |tile: &Tile, pixels: &TilePixels| -> Fallible<Stats> {
            // Each pyramid's WebP is written only if painted; the client reads 404 as clear.
            let bytes = match &pixels.buildings {
                Some(rgba) => write_tile(&building_dir, tile, rgba)?,
                None => 0,
            };
            let tree_bytes = match (&tree_dir, &pixels.trees) {
                (Some(directory), Some(rgba)) => write_tile(directory, tile, rgba)?,
                _ => 0,
            };
            Ok(Stats {
                tiles: 1,
                painted: usize::from(pixels.buildings.is_some()),
                bytes,
                tree_painted: usize::from(tree_bytes > 0),
                tree_bytes,
            })
        };
        let render = BucketRender {
            scenes: &scenes,
            plan: &plan,
            emit: &emit,
        };
        let report = execute(&render, &schedule, threads)?;
        fs::write(&job.stamp, &job.key)?;
        let stats = report.stats;
        let caster_slots: usize = scenes.iter().flatten().map(Scene::caster_slots).sum();
        eprintln!(
            "  wrote {} tiles ({} building painted, {:.1} MiB; {} tree painted, {:.1} MiB); \
             hulls generated {:.2}x per caster-slot",
            stats.tiles,
            stats.painted,
            stats.bytes as f64 / 1024.0 / 1024.0,
            stats.tree_painted,
            stats.tree_bytes as f64 / 1024.0 / 1024.0,
            report.hulls as f64 / caster_slots.max(1) as f64
        );
        total = total + stats;
    }

    eprintln!(
        "wrote {} shade tiles across {} buckets ({} building painted, {:.1} MiB; {} tree painted, {:.1} MiB) in {:.1}s",
        total.tiles,
        args.render.len(),
        total.painted,
        total.bytes as f64 / 1024.0 / 1024.0,
        total.tree_painted,
        total.tree_bytes as f64 / 1024.0 / 1024.0,
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

/// One bin's grid cell and sun position for SHDE, keyed on season/hourAngle like buckets.json.
pub struct BinPosition {
    pub season: usize,
    pub hour_angle: f64,
    pub elevation: f64,
    pub azimuth: f64,
}

const SHADE_SAMPLE_METERS: f64 = 5.0; // spacing of the along-edge shade probes
const SHADE_CELL_METERS: f64 = 5.0; // halving would just add cost
const SHADE_COARSE_CELL_METERS: f64 = 8.0; // fallback cell for a bbox too large for a 5 m grid
const SHADE_CELL_BUDGET: usize = 128_000_000; // ~128 MB per bin grid before the coarser cell kicks in

/// A bin's shadow-coverage grid over the edges' bbox; a point outside it is sunlit.
struct CoverageGrid {
    cells: Vec<u8>,
    cols: usize,
    rows: usize,
    west: f64,
    south: f64,
    meters_per_lng: f64,
    cell: f64,
}

impl CoverageGrid {
    fn shaded(&self, lng: f64, lat: f64) -> bool {
        let col = (lng - self.west) * self.meters_per_lng / self.cell;
        let row = (lat - self.south) * METERS_PER_DEGREE_LAT / self.cell;
        if col < 0.0 || row < 0.0 || col > self.cols as f64 || row > self.rows as f64 {
            false
        } else {
            // A probe on the east/north bbox edge lands on cols/rows; clamp it into the last cell.
            let col = (col as usize).min(self.cols - 1);
            let row = (row as usize).min(self.rows - 1);
            self.cells[row * self.cols + col] != 0
        }
    }
}

/// Fraction of an edge's polyline in shadow, probed every ~SHADE_SAMPLE_METERS; None if empty.
fn edge_shaded_fraction(poly: &[Coord], grid: &CoverageGrid) -> Option<f64> {
    if poly.is_empty() {
        return None;
    }
    let mut shaded = 0usize;
    let mut probes = 0usize;
    let mut probe = |lng: f64, lat: f64| {
        if grid.shaded(lng, lat) {
            shaded += 1;
        }
        probes += 1;
    };
    probe(poly[0].lng, poly[0].lat);
    for pair in poly.windows(2) {
        let (from, to) = (pair[0], pair[1]);
        let meters_per_lng = METERS_PER_DEGREE_LAT * ((from.lat + to.lat) / 2.0).to_radians().cos();
        let east = (to.lng - from.lng) * meters_per_lng;
        let north = (to.lat - from.lat) * METERS_PER_DEGREE_LAT;
        let steps = (east.hypot(north) / SHADE_SAMPLE_METERS).ceil().max(1.0) as usize;
        for step in 1..=steps {
            let fraction = step as f64 / steps as f64;
            probe(
                from.lng + (to.lng - from.lng) * fraction,
                from.lat + (to.lat - from.lat) * fraction,
            );
        }
    }
    Some(shaded as f64 / probes as f64)
}

/// Encodes a shadow fraction in [0, 1] as u8; the client applies intensity and transmittance.
fn encode_fraction(fraction: f64) -> u8 {
    round_half_up(fraction * 255.0).clamp(0.0, 255.0) as u8
}

/// The edges' meter bbox and cell grid, shared across bins; None when no edge has geometry.
struct GridSpec {
    bounds: Bounds,
    cols: usize,
    rows: usize,
    west: f64,
    south: f64,
    meters_per_lng: f64,
    cell: f64,
}

fn grid_spec(edge_polys: &[Vec<Coord>]) -> Option<GridSpec> {
    let mut west = f64::INFINITY;
    let mut east = f64::NEG_INFINITY;
    let mut south = f64::INFINITY;
    let mut north = f64::NEG_INFINITY;
    for poly in edge_polys {
        for point in poly {
            west = west.min(point.lng);
            east = east.max(point.lng);
            south = south.min(point.lat);
            north = north.max(point.lat);
        }
    }
    if !west.is_finite() {
        return None;
    }
    let mid_lat = (south + north) / 2.0;
    let meters_per_lng = METERS_PER_DEGREE_LAT * mid_lat.to_radians().cos();
    let width_m = (east - west) * meters_per_lng;
    let height_m = (north - south) * METERS_PER_DEGREE_LAT;
    // 5 m cells unless the grid would exceed SHADE_CELL_BUDGET, then 8 m.
    let fine_cols = (width_m / SHADE_CELL_METERS).ceil().max(1.0) as usize;
    let fine_rows = (height_m / SHADE_CELL_METERS).ceil().max(1.0) as usize;
    let cell = if fine_cols.saturating_mul(fine_rows) > SHADE_CELL_BUDGET {
        SHADE_COARSE_CELL_METERS
    } else {
        SHADE_CELL_METERS
    };
    let cols = (width_m / cell).ceil().max(1.0) as usize;
    let rows = (height_m / cell).ceil().max(1.0) as usize;
    Some(GridSpec {
        bounds: Bounds {
            west,
            east,
            south,
            north,
        },
        cols,
        rows,
        west,
        south,
        meters_per_lng,
        cell,
    })
}

/// The share of each edge's polyline the casters' hulls cover, `encode_fraction`d, via a coverage grid.
fn edge_fractions(
    count: usize,
    hulls_of: impl Fn(usize, &mut Vec<Polygon>),
    spec: &GridSpec,
    edge_polys: &[Vec<Coord>],
) -> Vec<u8> {
    let mut cells = vec![0u8; spec.cols * spec.rows];
    let fill = |cells: &mut [u8], hulls: &mut Vec<Polygon>| {
        geometry::fill_polygons(
            cells,
            spec.cols,
            spec.rows,
            &geometry::flatten(hulls),
            &spec.bounds,
            |lng, lat| {
                (
                    (lng - spec.west) * spec.meters_per_lng / spec.cell,
                    (lat - spec.south) * METERS_PER_DEGREE_LAT / spec.cell,
                )
            },
        );
        hulls.clear();
    };
    let mut hulls: Vec<Polygon> = Vec::new();
    for caster in 0..count {
        hulls_of(caster, &mut hulls);
        if hulls.len() >= FILL_BATCH {
            fill(&mut cells, &mut hulls);
        }
    }
    fill(&mut cells, &mut hulls);
    let grid = CoverageGrid {
        cells,
        cols: spec.cols,
        rows: spec.rows,
        west: spec.west,
        south: spec.south,
        meters_per_lng: spec.meters_per_lng,
        cell: spec.cell,
    };
    edge_polys
        .iter()
        .map(|poly| match edge_shaded_fraction(poly, &grid) {
            Some(fraction) => encode_fraction(fraction),
            None => 0,
        })
        .collect()
}

/// Where the sun stands in one bin, as the SHDE manifest reports it.
pub fn bin_position(bucket: &Bucket) -> BinPosition {
    BinPosition {
        season: bucket.season,
        hour_angle: bucket.hour_angle,
        elevation: bucket.elevation,
        azimuth: bucket.azimuth,
    }
}

// Vertices a transient fill batch's hull is assumed to carry, for the bake's per-bin estimate.
const BATCH_HULL_VERTICES: usize = 32;

/// The heap one bin in flight holds in `bake_edge_shade`: its coverage grid (at most
/// SHADE_CELL_BUDGET cells), its two output rows, and one hull batch both unflattened and flat.
pub fn bake_bin_bytes(edge_polys: &[Vec<Coord>]) -> usize {
    let Some(spec) = grid_spec(edge_polys) else {
        return 0;
    };
    let hull = POLYGON_BYTES + RING_BYTES + BATCH_HULL_VERTICES * VERTEX_BYTES;
    spec.cols * spec.rows + 2 * edge_polys.len() + 2 * FILL_BATCH * hull
}

/// Bins to bake at once: as many as `budget` holds, at least `floor`, and no more than
/// `threads` can run at once (or `floor`, if that is larger).
pub fn bake_in_flight(budget: usize, per_bin: usize, threads: usize, floor: usize) -> usize {
    let ceiling = threads.max(floor);
    budget
        .checked_div(per_bin)
        .unwrap_or(usize::MAX)
        .clamp(floor, ceiling)
}

/// Per bin, per edge, the building and crown occlusion fractions from the center sample.
pub fn bake_edge_shade(
    casters: &Casters,
    bins: &[Bucket],
    max_shadow_meters: f64,
    max_zoom: u32,
    edge_polys: &[Vec<Coord>],
) -> Vec<(Vec<u8>, Vec<u8>)> {
    let edge_count = edge_polys.len();
    let Some(spec) = grid_spec(edge_polys) else {
        // No edge carries geometry (all ferries/empty): nothing occludes anything.
        return bins
            .iter()
            .map(|_| (vec![0u8; edge_count], vec![0u8; edge_count]))
            .collect();
    };

    let mut rows: Vec<(usize, Vec<u8>, Vec<u8>)> = bins
        .par_iter()
        .enumerate()
        .map(|(bin, bucket)| {
            let Some(sample) = bucket.samples.first() else {
                return (bin, vec![0u8; edge_count], vec![0u8; edge_count]);
            };
            // One grid alive at a time per bin, each up to SHADE_CELL_BUDGET.
            let buildings = edge_fractions(
                casters.building_count(),
                |index, out| casters.building_hulls(index, sample, max_shadow_meters, out),
                &spec,
                edge_polys,
            );
            let trees = if casters.crowns.is_empty() {
                vec![0u8; edge_count]
            } else {
                edge_fractions(
                    casters.crown_count(),
                    |index, out| {
                        casters.crown_hulls(index, sample, max_shadow_meters, max_zoom, out)
                    },
                    &spec,
                    edge_polys,
                )
            };
            (bin, buildings, trees)
        })
        .collect();
    rows.sort_by_key(|(bin, _, _)| *bin);
    rows.into_iter()
        .map(|(_, buildings, trees)| (buildings, trees))
        .collect()
}

/// What a city casts onto its own edges: buildings and, if present, canopy crowns.
pub fn edge_shade_casters(buildings_path: &Path, canopy_path: Option<&Path>) -> Fallible<Casters> {
    let (polygons, heights) = binfmt::read_buildings(buildings_path)?;
    let (crowns, crown_heights) = match canopy_path {
        Some(path) => read_crowns(path)?,
        None => (Vec::new(), Vec::new()),
    };
    Ok(Casters {
        polygons,
        heights,
        crowns,
        crown_heights,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::raster;

    thread_local! {
        static HULL_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    /// Counts a building or crown hull call on this thread, so a test can see the index make none.
    pub(super) fn count_hull_call() {
        HULL_CALLS.with(|calls| calls.set(calls.get() + 1));
    }

    fn coord(lng: f64, lat: f64) -> Coord {
        Coord { lng, lat }
    }

    /// A 40 x 40 block of towers, every third an L concave enough to sweep as strips, and crowns.
    fn city_block() -> Casters {
        city_grid(40, 1)
    }

    /// `city_block` thinned to a `side` x `side` grid, `pitch` times as far apart.
    fn city_grid(side: usize, pitch: usize) -> Casters {
        let meters_per_lng = METERS_PER_DEGREE_LAT * 40.7f64.to_radians().cos();
        let at = |lng: f64, lat: f64, east: f64, north: f64| {
            coord(
                lng + east / meters_per_lng,
                lat + north / METERS_PER_DEGREE_LAT,
            )
        };
        let mut polygons: Vec<Polygon> = Vec::new();
        let mut heights = Vec::new();
        let mut outlines: Vec<Polygon> = Vec::new();
        let mut crown_heights = Vec::new();
        for column in (0..side).map(|column| column * pitch) {
            for row in (0..side).map(|row| row * pitch) {
                let (lng, lat) = (-74.0 + column as f64 * 0.0008, 40.70 + row as f64 * 0.0006);
                let ring = if (column + row) % 3 == 0 {
                    vec![
                        at(lng, lat, 0.0, 0.0),
                        at(lng, lat, 60.0, 0.0),
                        at(lng, lat, 60.0, 20.0),
                        at(lng, lat, 20.0, 20.0),
                        at(lng, lat, 20.0, 60.0),
                        at(lng, lat, 0.0, 60.0),
                    ]
                } else {
                    vec![
                        at(lng, lat, 0.0, 0.0),
                        at(lng, lat, 25.0, 0.0),
                        at(lng, lat, 25.0, 25.0),
                        at(lng, lat, 0.0, 25.0),
                    ]
                };
                polygons.push(vec![ring]);
                heights.push(5.0 + ((column * 7 + row * 13) % 30) as f64 * 5.0);
                if row % 4 == 0 {
                    outlines.push(vec![
                        (0..12)
                            .map(|step| {
                                let angle = step as f64 * std::f64::consts::TAU / 12.0;
                                at(lng, lat, 70.0 + 5.0 * angle.cos(), 30.0 + 5.0 * angle.sin())
                            })
                            .collect(),
                    ]);
                    crown_heights.push(8.0 + (column % 5) as f64 * 3.0);
                }
            }
        }
        Casters {
            polygons,
            heights,
            crowns: crown::slice_crowns(&outlines),
            crown_heights,
        }
    }

    fn sample(east: f64, north: f64, shadow_per_height: f64) -> Sample {
        Sample {
            east,
            north,
            shadow_per_height,
        }
    }

    /// The first `samples` of six sun-disk samples around a low western-ish sun, so shadows
    /// spill west of the city.
    fn fixture_bucket(samples: usize) -> Bucket {
        Bucket {
            season: 0,
            hour_angle: 40.0,
            elevation: 25.0,
            azimuth: 110.0,
            intensity: 0.7,
            samples: vec![
                sample(-0.94, 0.34, 2.1),
                sample(-0.92, 0.39, 2.0),
                sample(-0.96, 0.28, 2.2),
                sample(-0.90, 0.44, 1.9),
                sample(-0.97, 0.24, 2.3),
                sample(-0.93, 0.37, 2.05),
            ]
            .into_iter()
            .take(samples)
            .collect(),
        }
    }

    /// Two samples to z12: every tile a render fills costs a supersampled pass per layer, so the
    /// fixture keeps few of both.
    fn fixture_params() -> Params {
        Params {
            max_zoom: 12,
            max_shadow_meters: 500.0,
            buckets: vec![fixture_bucket(2)],
        }
    }

    /// Square footprints `size` meters on a side, `spacing` apart on a `side` x `side` grid.
    fn towers(
        (lng, lat): (f64, f64),
        side: usize,
        spacing: f64,
        size: f64,
        height: impl Fn(usize) -> f64,
    ) -> (Vec<Polygon>, Vec<f64>) {
        let meters_per_lng = METERS_PER_DEGREE_LAT * lat.to_radians().cos();
        let at = |east: f64, north: f64| {
            coord(
                lng + east / meters_per_lng,
                lat + north / METERS_PER_DEGREE_LAT,
            )
        };
        let mut polygons = Vec::new();
        let mut heights = Vec::new();
        for index in 0..side * side {
            let (east, north) = (
                (index % side) as f64 * spacing,
                (index / side) as f64 * spacing,
            );
            polygons.push(vec![vec![
                at(east, north),
                at(east + size, north),
                at(east + size, north + size),
                at(east, north + size),
            ]]);
            heights.push(height(index));
        }
        (polygons, heights)
    }

    /// A thinned city block either side of the z10 row boundary at 40.714, a dense cluster of
    /// tall towers south of it, and four taller ones at the corners of a 2 km square whose west
    /// pair shadows past the z11 column boundary at -74.0039 into the quadrant beyond.
    fn fixture_city() -> Casters {
        let casters = with_towers(city_grid(10, 4), (-73.992, 40.708), 6, 14.0, 9.0, |index| {
            150.0 + (index % 7) as f64 * 25.0
        });
        with_towers(casters, (-74.003, 40.702), 2, 2000.0, 20.0, |_| 200.0)
    }

    /// The whole city block and a 16 x 16 cluster of tall towers inside one z14 tile.
    fn large_fixture_city() -> Casters {
        with_towers(city_block(), (-73.992, 40.708), 16, 14.0, 9.0, |index| {
            150.0 + (index % 7) as f64 * 25.0
        })
    }

    /// `casters` with `towers` added.
    fn with_towers(
        mut casters: Casters,
        corner: (f64, f64),
        side: usize,
        spacing: f64,
        size: f64,
        height: impl Fn(usize) -> f64,
    ) -> Casters {
        let (polygons, heights) = towers(corner, side, spacing, size, height);
        casters.polygons.extend(polygons);
        casters.heights.extend(heights);
        casters
    }

    /// A small second city south of the first, sharing its z9 and z10 tiles but with a z11 of
    /// its own.
    fn second_city() -> Casters {
        let (polygons, heights) = towers((-73.95, 40.55), 4, 60.0, 20.0, |index| {
            20.0 + (index % 5) as f64 * 15.0
        });
        Casters {
            polygons,
            heights,
            crowns: Vec::new(),
            crown_heights: Vec::new(),
        }
    }

    /// The fixture's cities as `run` reads them, each planned over its footprints' bounds.
    struct World {
        params: Params,
        shades: Vec<Option<CityShade>>,
        bounds: Vec<Bounds>,
    }

    impl World {
        fn new(cities: Vec<Casters>) -> Self {
            Self::with(fixture_params(), cities)
        }

        fn with(params: Params, cities: Vec<Casters>) -> Self {
            let bounds = cities
                .iter()
                .map(|casters| geometry::box_of(&casters.polygons))
                .collect();
            Self {
                params,
                shades: cities
                    .into_iter()
                    .map(|casters| Some(CityShade::new(casters)))
                    .collect(),
                bounds,
            }
        }

        fn bucket(&self) -> &Bucket {
            &self.params.buckets[0]
        }

        fn shadows(&self) -> Vec<Option<CityShadows>> {
            self.shades
                .iter()
                .map(|shade| {
                    shade
                        .as_ref()
                        .map(|shade| city_shadows(shade, self.bucket(), &self.params))
                })
                .collect()
        }

        fn scenes<'a>(&'a self, shadows: &'a [Option<CityShadows>]) -> Vec<Option<Scene<'a>>> {
            self.shades
                .iter()
                .zip(shadows)
                .map(|(shade, shadows)| {
                    Some(Scene {
                        shade: shade.as_ref()?,
                        shadows: shadows.as_ref()?,
                        bucket: self.bucket(),
                        params: &self.params,
                    })
                })
                .collect()
        }

        fn plan(&self, cities: usize) -> Vec<Tile> {
            raster::plan_bounds(&self.bounds[..cities], self.params.max_zoom)
        }
    }

    type Rendered = HashMap<Node, TilePixels>;

    /// Stats as `run`'s emit counts them, with the pixel bytes standing in for the WebP's.
    fn tile_stats(pixels: &TilePixels) -> Stats {
        let bytes = pixels.buildings.as_ref().map_or(0, Vec::len);
        let tree_bytes = pixels.trees.as_ref().map_or(0, Vec::len);
        Stats {
            tiles: 1,
            painted: usize::from(bytes > 0),
            bytes,
            tree_painted: usize::from(tree_bytes > 0),
            tree_bytes,
        }
    }

    /// Takes each emitted tile, at most once, with `tile_stats`.
    #[derive(Default)]
    struct Collector(Mutex<Rendered>);

    impl Collector {
        fn emit(&self, tile: &Tile, pixels: &TilePixels) -> Fallible<Stats> {
            let node = Node::of(tile);
            let fresh = self
                .0
                .lock()
                .unwrap()
                .insert(node, pixels.clone())
                .is_none();
            assert!(fresh, "{node:?} rendered twice");
            Ok(tile_stats(pixels))
        }
    }

    /// The per-tile streamed reference: every plan tile rendered from hulls generated for it alone.
    fn per_tile(scenes: &[Option<Scene>], plan: &[Tile]) -> (Rendered, Stats) {
        let collector = Collector::default();
        let emit = |tile: &Tile, pixels: &TilePixels| collector.emit(tile, pixels);
        let render = BucketRender {
            scenes,
            plan,
            emit: &emit,
        };
        let stats = (0..plan.len())
            .into_par_iter()
            .map_init(Scratch::new, |scratch, tile| {
                render_shared(&render, tile, scratch, &mut Report::default()).unwrap()
            })
            .reduce(Stats::default, |left, right| left + right);
        (collector.0.into_inner().unwrap(), stats)
    }

    fn scheduled(
        scenes: &[Option<Scene>],
        plan: &[Tile],
        schedule: &Schedule,
        threads: usize,
    ) -> (Rendered, Report) {
        let collector = Collector::default();
        let emit = |tile: &Tile, pixels: &TilePixels| collector.emit(tile, pixels);
        let render = BucketRender {
            scenes,
            plan,
            emit: &emit,
        };
        let report = execute(&render, schedule, threads).unwrap();
        (collector.0.into_inner().unwrap(), report)
    }

    fn node_at(zoom: u32, lng: f64, lat: f64) -> Node {
        Node {
            zoom,
            x: raster::tile_index(lng_to_pixel_x(lng, zoom), zoom),
            y: raster::tile_index(lat_to_pixel_y(lat, zoom), zoom),
        }
    }

    // However the quadtree is cut, held, rooted or streamed, every tile comes out as it does
    // rendered alone from its own hulls, down to the byte, and is counted the same.
    #[test]
    fn scheduled_render_matches_per_tile_streaming() {
        let world = World::new(vec![fixture_city(), second_city()]);
        let max_zoom = world.params.max_zoom;
        let shadows = world.shadows();
        let scenes = world.scenes(&shadows);
        let top = node_at(MIN_ZOOM, -73.99, 40.71);
        for cities in [1, 2] {
            let plan = world.plan(cities);
            let (want, want_stats) = per_tile(&scenes, &plan);
            assert_eq!(want.len(), plan.len());
            assert!(want_stats.painted > plan.len() / 2 && want_stats.tree_painted > 0);
            let check = |label: &str, schedule: &Schedule, threads: usize| -> Report {
                let (got, report) = scheduled(&scenes, &plan, schedule, threads);
                assert_eq!(report.stats, want_stats, "{label}");
                assert_eq!(got.len(), want.len(), "{label}");
                for (node, pixels) in &want {
                    assert!(got.get(node) == Some(pixels), "{label}: {node:?} differs");
                }
                report
            };

            let mut planner = Planner::new(&scenes, &plan, max_zoom, 2);
            let none = planner.schedule(0);
            assert!(none.held.is_empty() && none.roots.is_empty());
            check("no budget", &none, 2);

            let whole = planner.schedule_with(usize::MAX, None, usize::MAX);
            if cities == 1 {
                assert_eq!(whole.roots, BTreeMap::from([(MIN_ZOOM, 1)]));
            }
            check("one root", &whole, 2);

            let roomy = Planner::new(&scenes, &plan, max_zoom, 4).schedule(1 << 30);
            assert!(
                roomy.roots.values().sum::<usize>() >= 2,
                "the balance cap splits"
            );
            check("balanced over four", &roomy, 4);

            if cities == 2 {
                assert!(
                    roomy
                        .jobs
                        .iter()
                        .any(|job| matches!(job.work, Work::Shared { .. }))
                );
                continue;
            }

            let below_top = planner.cost(top, 0).all - 1;
            let held_top = planner.schedule_with(usize::MAX, Some(MIN_ZOOM), below_top);
            assert_eq!(held_top.held.len(), 1);
            assert!(!held_top.roots.is_empty());
            check("held z9", &held_top, 3);

            // Held down to z11 with working sets too small for the upper zooms, so roots land at
            // several depths and the quadrant west of the city catches the spill into it.
            let mut mixed = 0;
            for per_task in (16..256).map(|step| step << 14) {
                let schedule = planner.schedule_with(per_task, Some(11), usize::MAX);
                if schedule.roots.len() < 2 || schedule.held.is_empty() {
                    continue;
                }
                let report = check("mixed", &schedule, 2);
                mixed += usize::from(report.virtual_painted > 0);
                if mixed > 0 {
                    break;
                }
            }
            assert!(
                mixed > 0,
                "no schedule mixed root zooms with a painting virtual node"
            );
        }
    }

    // One whole set per layer, gridded, must paint what hulls streamed per tile in batches do.
    #[test]
    fn streamed_shadows_match_a_whole_city_set() {
        let world = World::new(vec![fixture_city()]);
        let shadows = world.shadows();
        let scenes = world.scenes(&shadows);
        let scene = scenes[0].as_ref().unwrap();
        let (mut checked, mut tried) = (0, 0);
        for layer in scene.layers() {
            let index = scene.index(layer).unwrap();
            let mut hulls = Vec::new();
            for caster in 0..index.boxes.len() {
                scene.hulls(layer, caster, &mut hulls);
            }
            let set = geometry::flatten(&hulls);
            let grid = PolygonGrid::new(&set);
            for (zoom, lng, lat) in [
                (12, -73.985, 40.71),
                (14, -73.985, 40.71),
                (15, -73.99, 40.705),
                (15, -73.97, 40.72),
                (16, -73.98, 40.715),
                (14, -74.005, 40.71),
            ] {
                let frame = Frame::new(node_at(zoom, lng, lat));
                let mut scratch = Scratch::new();
                let mut want = vec![0u8; TILE_SIZE * TILE_SIZE];
                let drew = scratch.accumulate(&frame, &set, &grid, &mut want);
                let mut got = vec![0u8; TILE_SIZE * TILE_SIZE];
                let streamed = scratch.accumulate_shadows(
                    &frame,
                    index,
                    |caster, out| scene.hulls(layer, caster, out),
                    &mut got,
                    |_| {},
                );
                assert_eq!(drew, streamed);
                assert!(got == want);
                checked += usize::from(drew);
                tried += 1;
            }
        }
        assert!(
            2 * checked > tried,
            "most tiles should see shadows, saw {checked} of {tried}"
        );
    }

    // The index's boxes come from the geometry alone, yet hold every hull and, where there are
    // any, are exactly their box; the byte estimates bound the hulls without overshooting much.
    #[test]
    fn analytic_boxes_bound_the_hulls() {
        let world = World::new(vec![fixture_city()]);
        let shadows = world.shadows();
        let scenes = world.scenes(&shadows);
        let scene = scenes[0].as_ref().unwrap();
        let bits = |bounds: &Bounds| {
            [bounds.west, bounds.east, bounds.south, bounds.north].map(f64::to_bits)
        };
        for (kind, index, layers) in [
            (
                "buildings",
                &scene.shadows.buildings,
                (0..world.bucket().samples.len())
                    .map(Layer::Building)
                    .collect::<Vec<_>>(),
            ),
            (
                "crowns",
                scene.shadows.trees.as_ref().unwrap(),
                vec![Layer::Crown],
            ),
            (
                "footprints",
                &scene.shade.footprints,
                vec![Layer::Footprint],
            ),
        ] {
            let (mut estimated, mut actual) = (0, 0);
            for caster in 0..index.boxes.len() {
                let mut hulls = Vec::new();
                for layer in &layers {
                    scene.hulls(*layer, caster, &mut hulls);
                }
                let (analytic, hulled) = (index.boxes[caster], geometry::box_of(&hulls));
                assert!(
                    analytic.west <= hulled.west
                        && analytic.east >= hulled.east
                        && analytic.south <= hulled.south
                        && analytic.north >= hulled.north,
                    "{kind} {caster}"
                );
                if !hulls.is_empty() {
                    assert_eq!(bits(&analytic), bits(&hulled), "{kind} {caster}");
                }
                let bytes = hull_bytes(&hulls);
                assert!(index.est[caster] >= bytes, "{kind} {caster}");
                estimated += index.est[caster];
                actual += bytes;
            }
            assert!(
                actual > 0 && estimated <= 3 * actual,
                "{kind}: {estimated} vs {actual}"
            );
        }
    }

    // Given the room, the schedule hulls each caster about once per slot, and building the index
    // hulls nothing; with none, every zoom regenerates the hulls its tiles see.
    #[test]
    fn each_caster_is_hulled_about_once() {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .unwrap();
        let (world, index_calls) = pool.install(|| {
            HULL_CALLS.with(|calls| calls.set(0));
            let world = World::new(vec![fixture_city()]);
            let shadows = world.shadows();
            drop(shadows);
            (world, HULL_CALLS.with(std::cell::Cell::get))
        });
        assert_eq!(index_calls, 0);
        let shadows = world.shadows();
        let scenes = world.scenes(&shadows);
        let plan = world.plan(1);
        let slots = scenes[0].as_ref().unwrap().caster_slots();
        let ratio = |budget: usize| {
            let schedule = Planner::new(&scenes, &plan, world.params.max_zoom, 1).schedule(budget);
            let (_, report) = scheduled(&scenes, &plan, &schedule, 1);
            report.hulls as f64 / slots as f64
        };
        let (roomy, none) = (ratio(1 << 30), ratio(0));
        assert!(roomy <= 1.3, "{roomy:.2}x with room");
        assert!(none >= 4.0, "{none:.2}x without");
    }

    // Every root fits its share of what the held masks leave, and no budget holds nothing and
    // roots nothing that casts.
    #[test]
    fn schedules_keep_to_the_budget() {
        let world = World::new(vec![fixture_city(), second_city()]);
        let shadows = world.shadows();
        let scenes = world.scenes(&shadows);
        for cities in [1, 2] {
            let plan = world.plan(cities);
            for threads in [1, 3, 8] {
                let mut planner = Planner::new(&scenes, &plan, world.params.max_zoom, threads);
                for budget in [0, 1 << 20, 4 << 20, 16 << 20, 64 << 20, 256 << 20, 1 << 34] {
                    let schedule = planner.schedule(budget);
                    assert!(
                        schedule.held_bytes + threads * schedule.max_working <= budget,
                        "{cities} cities, {threads} threads, {budget} B"
                    );
                    if budget == 0 {
                        assert!(schedule.held.is_empty());
                        assert!(schedule.jobs.iter().all(|job| {
                            !matches!(job.work, Work::Root { .. }) || job.cost == 0
                        }));
                    }
                }
            }
        }
    }

    // `cargo test --release fixture_timing -- --ignored --nocapture`: streamed vs scheduled.
    #[test]
    #[ignore]
    fn fixture_timing() {
        let params = Params {
            max_zoom: 14,
            max_shadow_meters: 500.0,
            buckets: vec![fixture_bucket(6)],
        };
        let world = World::with(params, vec![large_fixture_city()]);
        let shadows = world.shadows();
        let scenes = world.scenes(&shadows);
        let plan = world.plan(1);
        let whole_pass = scenes[0].as_ref().unwrap().whole_pass();
        let top = node_at(MIN_ZOOM, -73.99, 40.71);
        for threads in [1, rayon::current_num_threads()] {
            let mut planner = Planner::new(&scenes, &plan, world.params.max_zoom, threads);
            let below_top = planner.cost(top, 0).all - 1;
            for (label, schedule) in [
                ("streamed", planner.schedule(0)),
                ("scheduled", planner.schedule(1 << 30)),
                (
                    "held z9",
                    planner.schedule_with(usize::MAX, Some(MIN_ZOOM), below_top),
                ),
                (
                    "one root",
                    planner.schedule_with(usize::MAX, None, usize::MAX),
                ),
            ] {
                let started = Instant::now();
                let (_, report) = scheduled(&scenes, &plan, &schedule, threads);
                eprintln!(
                    "{label}: {:.3}s on {threads} threads, {} hull calls; {}",
                    started.elapsed().as_secs_f64(),
                    report.hulls,
                    schedule.describe(whole_pass)
                );
            }
        }
    }

    // Filling the coverage grid a batch at a time must match filling it from every hull at once.
    #[test]
    fn streamed_edge_fractions_match_one_fill() {
        let casters = city_block();
        let sample = Sample {
            east: 0.3,
            north: 0.95,
            shadow_per_height: 1.2,
        };
        let edge_polys: Vec<Vec<Coord>> = (0..200)
            .map(|edge| {
                let lat = 40.70 + edge as f64 * 0.00012;
                vec![coord(-74.001, lat), coord(-73.968, lat + 0.0001)]
            })
            .collect();
        let spec = grid_spec(&edge_polys).expect("edges with geometry");
        let count = casters.building_count();
        let hulls_of = |index: usize, out: &mut Vec<Polygon>| {
            casters.building_hulls(index, &sample, 500.0, out);
        };
        let all_at_once = |_: usize, out: &mut Vec<Polygon>| {
            for index in 0..count {
                hulls_of(index, out);
            }
        };
        let streamed = edge_fractions(count, hulls_of, &spec, &edge_polys);
        assert_eq!(streamed, edge_fractions(1, all_at_once, &spec, &edge_polys));
        assert!(streamed.iter().any(|fraction| *fraction > 0));

        // However many bins are in flight per call, the bake comes out the same.
        let bins: Vec<Bucket> = [
            (0.3, 0.95, 1.2),
            (-0.6, 0.8, 2.5),
            (0.9, -0.44, 0.7),
            (0.0, 1.0, 3.0),
        ]
        .iter()
        .enumerate()
        .map(|(season, &(east, north, shadow_per_height))| Bucket {
            season,
            hour_angle: 0.0,
            elevation: 45.0,
            azimuth: 180.0,
            intensity: 1.0,
            samples: vec![Sample {
                east,
                north,
                shadow_per_height,
            }],
        })
        .collect();
        let all = bake_edge_shade(&casters, &bins, 500.0, 15, &edge_polys);
        assert_eq!(all[0].0, streamed);
        for step in [1, 2, 3] {
            let chunked: Vec<(Vec<u8>, Vec<u8>)> = bins
                .chunks(step)
                .flat_map(|chunk| bake_edge_shade(&casters, chunk, 500.0, 15, &edge_polys))
                .collect();
            assert_eq!(chunked, all, "{step} bins in flight");
        }
    }

    // The bake keeps its floor of bins in flight on no budget, and never runs more than the threads.
    #[test]
    fn bins_in_flight_follow_the_budget_between_the_floor_and_the_threads() {
        let per_bin = 128 << 20;
        assert_eq!(bake_in_flight(0, per_bin, 4, 3), 3);
        assert_eq!(bake_in_flight(10 << 30, per_bin, 4, 3), 4);
        assert_eq!(bake_in_flight(10 << 30, per_bin, 64, 3), 64);
        assert_eq!(bake_in_flight(5 * per_bin, per_bin, 64, 3), 5);
        assert_eq!(bake_in_flight(10 << 30, per_bin, 2, 3), 3);
        assert_eq!(bake_in_flight(0, 0, 8, 3), 8);
        let edges = vec![vec![coord(-74.0, 40.70), coord(-73.99, 40.71)]];
        let spec = grid_spec(&edges).expect("an edge with geometry");
        assert!(bake_bin_bytes(&edges) >= spec.cols * spec.rows);
        assert_eq!(bake_bin_bytes(&[Vec::new()]), 0);
    }

    // A 100 m building, a 10 m crown and an unknown-height crown under a 5 m/m due-north shadow.
    #[test]
    fn bakes_building_and_crown_fractions() {
        let building: Polygon = vec![vec![
            coord(-74.0000, 40.7000),
            coord(-73.9999, 40.7000),
            coord(-73.9999, 40.7001),
            coord(-74.0000, 40.7001),
        ]];
        let heights = vec![100.0];
        let crown = |lng: f64| -> Polygon {
            vec![vec![
                coord(lng, 40.7000),
                coord(lng + 0.0002, 40.7000),
                coord(lng + 0.0002, 40.7002),
                coord(lng, 40.7002),
            ]]
        };
        let crowns = vec![crown(-73.9901), crown(-73.9801)];
        let crown_heights = vec![10.0, 0.0]; // 0 is the canopy file's unknown-height sentinel
        // The center sample throws a 500 m shadow due north.
        let north_shadow = || Sample {
            east: 0.0,
            north: 1.0,
            shadow_per_height: 5.0,
        };
        let bins = vec![
            Bucket {
                season: 0,
                hour_angle: -30.0,
                elevation: 30.0,
                azimuth: 180.0,
                intensity: 0.8,
                samples: vec![north_shadow()],
            },
            Bucket {
                season: 3,
                hour_angle: 0.0,
                elevation: 60.0,
                azimuth: 200.0,
                intensity: 1.0,
                samples: vec![north_shadow()],
            },
        ];
        let building_shaded = vec![coord(-73.99995, 40.7020), coord(-73.99993, 40.7021)];
        // Under the crown's shadow, and under where the unknown crown's would land.
        let crown_shaded = vec![coord(-73.99000, 40.70025), coord(-73.98995, 40.70030)];
        let unknown_crown = vec![coord(-73.98000, 40.70025), coord(-73.97995, 40.70030)];
        let sunlit_edge = vec![coord(-73.99995, 40.6900), coord(-73.99993, 40.6901)];
        let ferry_edge: Vec<Coord> = Vec::new();
        let edge_polys = vec![
            building_shaded,
            crown_shaded,
            unknown_crown,
            sunlit_edge,
            ferry_edge,
        ];

        let casters = Casters {
            polygons: vec![building],
            heights,
            crowns: crown::slice_crowns(&crowns),
            crown_heights,
        };
        let rows = bake_edge_shade(&casters, &bins, 500.0, 15, &edge_polys);
        // One bin in flight at a time bakes what both at once did.
        let one_at_a_time: Vec<(Vec<u8>, Vec<u8>)> = bins
            .chunks(1)
            .flat_map(|chunk| bake_edge_shade(&casters, chunk, 500.0, 15, &edge_polys))
            .collect();
        assert_eq!(rows, one_at_a_time);

        assert_eq!(rows.len(), 2);
        let edge_count = edge_polys.len();
        for (buildings, trees) in &rows {
            assert_eq!(buildings.len(), edge_count);
            assert_eq!(trees.len(), edge_count);
            let building_at = |edge: usize| buildings[edge];
            let tree_at = |edge: usize| trees[edge];
            assert_eq!(
                building_at(0),
                255,
                "the swept shadow covers the whole edge"
            );
            assert_eq!(tree_at(0), 0, "no crown is anywhere near it");
            assert_eq!(building_at(1), 0);
            assert_eq!(tree_at(1), 255, "the crown's swept smear covers it");
            // A crown of unknown height casts nothing, so its edge is unoccluded by either caster.
            assert_eq!(building_at(2), 0);
            assert_eq!(tree_at(2), 0);
            assert_eq!(building_at(3), 0);
            assert_eq!(tree_at(3), 0);
            // The empty ferry polyline reads 0 in both, which the client never consults.
            assert_eq!(building_at(4), 0);
            assert_eq!(tree_at(4), 0);
        }
    }

    /// Whether `point` lies inside any polygon's outer ring (even-odd crossing test).
    fn covered(polygons: &[Polygon], point: Coord) -> bool {
        polygons.iter().any(|polygon| {
            let ring = &polygon[0];
            let mut inside = false;
            let mut previous = ring.len() - 1;
            for current in 0..ring.len() {
                let (a, b) = (ring[previous], ring[current]);
                if (a.lat > point.lat) != (b.lat > point.lat)
                    && point.lng < a.lng + (point.lat - a.lat) / (b.lat - a.lat) * (b.lng - a.lng)
                {
                    inside = !inside;
                }
                previous = current;
            }
            inside
        })
    }

    // A U swept up and right has two facing runs, split by its notch; both must leave strips.
    #[test]
    fn sweeps_every_facing_run_of_a_concave_ring() {
        let meters_per_lng = METERS_PER_DEGREE_LAT * 40.7f64.to_radians().cos();
        let at = |east: f64, north: f64| {
            coord(
                -74.0 + east / meters_per_lng,
                40.7 + north / METERS_PER_DEGREE_LAT,
            )
        };
        let ring: Ring = [
            (0.0, 0.0),
            (60.0, 0.0),
            (60.0, 60.0),
            (40.0, 60.0),
            (40.0, 20.0),
            (20.0, 20.0),
            (20.0, 60.0),
            (0.0, 60.0),
        ]
        .iter()
        .map(|(east, north)| at(*east, *north))
        .collect();
        let base = (5.0 / meters_per_lng, 3.0 / METERS_PER_DEGREE_LAT);
        let delta = (25.0 / meters_per_lng, 35.0 / METERS_PER_DEGREE_LAT);
        let mut swept: Vec<Polygon> = Vec::new();
        append_sweep(&ring, base, delta, meters_per_lng, &mut swept);

        // The reference: the ring stamped at many small steps along the sweep.
        let steps = 200;
        let stamps: Vec<Polygon> = (0..=steps)
            .map(|step| {
                let t = step as f64 / steps as f64;
                let shift = |vertex: &Coord| Coord {
                    lng: vertex.lng + base.0 + t * delta.0,
                    lat: vertex.lat + base.1 + t * delta.1,
                };
                vec![ring.iter().map(shift).collect()]
            })
            .collect();
        let (mut reference, mut missed, mut extra) = (0, 0, 0);
        for column in 0..220 {
            for row in 0..240 {
                let point = at(
                    -10.0 + column as f64 * 0.5 + 0.25,
                    -10.0 + row as f64 * 0.5 + 0.25,
                );
                let want = covered(&stamps, point);
                let got = covered(&swept, point);
                reference += usize::from(want);
                missed += usize::from(want && !got);
                extra += usize::from(got && !want);
            }
        }
        assert!(reference > 0);
        assert!(
            missed * 100 < reference && extra * 100 < reference,
            "missed {missed} and added {extra} of {reference} swept cells"
        );
    }
}

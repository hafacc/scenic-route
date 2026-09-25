//! The shade pass: building and crown shadows as one WebP pyramid each per time-of-day bucket.
//! Canopy light transmittance is seasonal, so the client folds it in rather than the bake.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::Fallible;
use crate::binfmt::{self, Coord, Polygon, Ring};
use crate::crown;
use crate::geometry::{self, METERS_PER_DEGREE_LAT, round_half_up};
#[cfg(test)]
use crate::geometry::{PolygonGrid, PolygonSet};
use crate::manifest::{Bounds, City, Manifest};
use crate::raster::{
    EQUATOR_METERS_PER_PIXEL, MIN_ALPHA, TILE_SIZE, Tile, encode_webp_lossless, lat_to_pixel_y,
    lng_to_pixel_x, pixel_x_to_lng, pixel_y_to_lat, plan_tiles,
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
    footprints: ShadowIndex, // indexes `casters.polygons` themselves, unswept
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

/// Casters of one kind: each one's box over all its hulls, gridded per tile.
struct ShadowIndex {
    boxes: Vec<Bounds>,
    grid: BoxGrid,
}

impl ShadowIndex {
    fn new(count: usize, hulls_of: impl Fn(usize, &mut Vec<Polygon>) + Sync) -> Self {
        let boxes: Vec<Bounds> = (0..count)
            .into_par_iter()
            .map_init(Vec::new, |hulls, caster| {
                hulls.clear();
                hulls_of(caster, hulls);
                geometry::box_of(hulls)
            })
            .collect();
        let grid = BoxGrid::new(&boxes);
        Self { boxes, grid }
    }
}

/// One tile of one bucket, counted once for each pyramid it fed.
#[derive(Clone, Copy, Default)]
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

fn read_city_shade(city: &City, data: &Path) -> Fallible<Option<CityShade>> {
    let buildings = data.join("buildings").join(format!("{}.bin", city.id));
    if !buildings.exists() {
        return Ok(None);
    }
    let (polygons, heights) = binfmt::read_buildings(&buildings)?;
    let (crowns, crown_heights) = city_crowns(city, data)?;
    let footprints = ShadowIndex::new(polygons.len(), |index, out| {
        out.push(polygons[index].clone());
    });
    Ok(Some(CityShade {
        casters: Casters {
            polygons,
            heights,
            crowns,
            crown_heights,
        },
        footprints,
    }))
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

    let ring_hull = convex_hull(ring);
    let concavity_m2 = 0.5
        * (double_area(&ring_hull) - double_area(ring))
        * METERS_PER_DEGREE_LAT
        * meters_per_lng;
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
    if concavity_m2 < MIN_CONCAVITY_M2 {
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
    // The east-west scale at the footprint's latitude; city-scale, so its first vertex stands in.
    let meters_per_lng = METERS_PER_DEGREE_LAT * outer[0].lat.to_radians().cos();
    let (d_lng, d_lat) = offset(distance, sample, meters_per_lng);
    let shift = |vertex: &Coord| Coord {
        lng: vertex.lng + d_lng,
        lat: vertex.lat + d_lat,
    };

    let footprint_hull = convex_hull(outer);
    let concavity_m2 = 0.5
        * (double_area(&footprint_hull) - double_area(outer))
        * METERS_PER_DEGREE_LAT
        * meters_per_lng;
    if concavity_m2 < MIN_CONCAVITY_M2 {
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
            let meters_per_lng = METERS_PER_DEGREE_LAT * ring[0].lat.to_radians().cos();
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

/// A city's shadow indexes for one bucket; crowns cast from the center sample only (~5 cm penumbra).
struct CityShadows {
    buildings: ShadowIndex,
    trees: Option<ShadowIndex>,
}

fn city_shadows(shade: &CityShade, bucket: &Bucket, params: &Params) -> CityShadows {
    let casters = &shade.casters;
    let max_shadow_meters = params.max_shadow_meters;
    let buildings = ShadowIndex::new(casters.building_count(), |index, out| {
        for sample in &bucket.samples {
            casters.building_hulls(index, sample, max_shadow_meters, out);
        }
    });
    let trees = bucket
        .samples
        .first()
        .filter(|_| !casters.crowns.is_empty())
        .map(|sample| {
            ShadowIndex::new(casters.crown_count(), |index, out| {
                casters.crown_hulls(index, sample, max_shadow_meters, params.max_zoom, out);
            })
        });
    CityShadows { buildings, trees }
}

/// One tile's supersampled rasterizer: its lng/lat window, projection and reusable scratch.
struct TileRaster {
    clip: Bounds,
    zoom: u32,
    origin_x: f64,
    origin_y: f64,
    mask: Vec<u8>,
    candidates: Vec<u32>,
}

impl TileRaster {
    fn new(tile: &Tile) -> Self {
        let zoom = tile.zoom;
        let origin_x = f64::from(tile.x) * TILE_SIZE as f64;
        let origin_y = f64::from(tile.y) * TILE_SIZE as f64;
        let width = TILE_SIZE * SUPERSAMPLE;
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
            mask: vec![0u8; width * width],
            candidates: Vec::new(),
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

    /// Add each pixel's covered fraction of a whole set into `target`; the streamed path's reference.
    #[cfg(test)]
    fn accumulate(&mut self, set: &PolygonSet, grid: &PolygonGrid, target: &mut [f32]) -> bool {
        grid.candidates(&self.clip, &mut self.candidates);
        if self.candidates.is_empty() {
            return false;
        }
        self.mask.iter_mut().for_each(|cell| *cell = 0);
        let width = TILE_SIZE * SUPERSAMPLE;
        let project = self.projection();
        let drawn = geometry::fill_polygons_indexed(
            &mut self.mask,
            width,
            width,
            set,
            &self.candidates,
            &self.clip,
            project,
        );
        if drawn == 0 {
            return false;
        }
        self.add_mask(target);
        true
    }

    /// `accumulate` over hulls generated per candidate caster, filled a batch at a time.
    fn accumulate_shadows(
        &mut self,
        index: &ShadowIndex,
        hulls_of: impl Fn(usize, &mut Vec<Polygon>),
        target: &mut [f32],
    ) -> bool {
        index.grid.candidates(&self.clip, &mut self.candidates);
        if self.candidates.is_empty() {
            return false;
        }
        self.mask.iter_mut().for_each(|cell| *cell = 0);
        let width = TILE_SIZE * SUPERSAMPLE;
        let project = self.projection();
        let clip = self.clip;
        let mut drawn = 0;
        let mut fill = |mask: &mut [u8], hulls: &mut Vec<Polygon>| {
            drawn += geometry::fill_polygons(
                mask,
                width,
                width,
                &geometry::flatten(hulls),
                &clip,
                &project,
            );
            hulls.clear();
        };
        let mut hulls: Vec<Polygon> = Vec::new();
        for caster in &self.candidates {
            let caster = *caster as usize;
            if !overlaps(&index.boxes[caster], &clip) {
                continue;
            }
            hulls_of(caster, &mut hulls);
            if hulls.len() >= FILL_BATCH {
                fill(&mut self.mask, &mut hulls);
            }
        }
        fill(&mut self.mask, &mut hulls);
        if drawn == 0 {
            return false;
        }
        self.add_mask(target);
        true
    }

    /// Add each pixel's covered fraction of the mask into `target`.
    fn add_mask(&self, target: &mut [f32]) {
        let width = TILE_SIZE * SUPERSAMPLE;
        let subpixels = (SUPERSAMPLE * SUPERSAMPLE) as f32;
        for pixel_y in 0..TILE_SIZE {
            for pixel_x in 0..TILE_SIZE {
                let mut covered = 0u32;
                for sub_y in 0..SUPERSAMPLE {
                    let row = (pixel_y * SUPERSAMPLE + sub_y) * width + pixel_x * SUPERSAMPLE;
                    for sub_x in 0..SUPERSAMPLE {
                        covered += u32::from(self.mask[row + sub_x]);
                    }
                }
                target[pixel_y * TILE_SIZE + pixel_x] += covered as f32 / subpixels;
            }
        }
    }
}

/// One tile's two shadow fractions, each None where nothing was cast onto it.
#[derive(Default)]
struct Coverage {
    buildings: Option<Vec<f32>>,
    trees: Option<Vec<f32>>,
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

/// Per-pixel building and tree shadow fractions over one tile, punched by building footprints.
/// Crowns aren't punched from their own shadow: the ground under a tree is the shadiest there is.
fn coverage(
    shade: &CityShade,
    shadows: &CityShadows,
    bucket: &Bucket,
    params: &Params,
    tile: &Tile,
) -> Coverage {
    let mut raster = TileRaster::new(tile);
    let casters = &shade.casters;
    let max_shadow_meters = params.max_shadow_meters;
    let samples = &bucket.samples;

    let mut buildings = vec![0.0f32; TILE_SIZE * TILE_SIZE];
    let mut any_buildings = false;
    for sample in samples {
        any_buildings |= raster.accumulate_shadows(
            &shadows.buildings,
            |index, out| casters.building_hulls(index, sample, max_shadow_meters, out),
            &mut buildings,
        );
    }
    let mut trees = vec![0.0f32; TILE_SIZE * TILE_SIZE];
    let any_trees = shadows.trees.as_ref().is_some_and(|crowns| {
        let sample = &samples[0];
        raster.accumulate_shadows(
            crowns,
            |index, out| {
                casters.crown_hulls(index, sample, max_shadow_meters, params.max_zoom, out)
            },
            &mut trees,
        )
    });
    if !any_buildings && !any_trees {
        return Coverage::default();
    }

    let mut base = vec![0.0f32; TILE_SIZE * TILE_SIZE];
    raster.accumulate_shadows(
        &shade.footprints,
        |index, out| out.push(casters.polygons[index].clone()),
        &mut base,
    );
    Coverage {
        buildings: (any_buildings && resolve(&mut buildings, samples.len() as f32, &base))
            .then_some(buildings),
        trees: (any_trees && resolve(&mut trees, 1.0, &base)).then_some({
            soften(&mut trees);
            trees
        }),
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

/// What one bucket's tiles render from; `trees` and `tree_dir` are None without measured crowns.
struct BucketRender<'a> {
    cities: &'a [Option<CityShade>],
    shadows: Vec<Option<CityShadows>>,
    bucket: &'a Bucket,
    params: &'a Params,
    building_dir: PathBuf,
    tree_dir: Option<PathBuf>,
}

impl BucketRender<'_> {
    /// Render one tile, writing each pyramid's WebP only if painted (the client reads 404 as clear).
    fn render(&self, tile: &Tile) -> Fallible<Stats> {
        let mut building_pixels = vec![0u8; TILE_SIZE * TILE_SIZE * 4];
        let mut tree_pixels = vec![0u8; TILE_SIZE * TILE_SIZE * 4];
        let mut painted = false;
        let mut tree_painted = false;
        for member in &tile.members {
            if let (Some(shade), Some(shadows)) = (&self.cities[*member], &self.shadows[*member]) {
                let fractions = coverage(shade, shadows, self.bucket, self.params, tile);
                let intensity = self.bucket.intensity;
                if let Some(fraction) = fractions.buildings {
                    painted |= paint(&mut building_pixels, &fraction, intensity);
                }
                if let Some(fraction) = fractions.trees {
                    tree_painted |= paint(&mut tree_pixels, &fraction, intensity);
                }
            }
        }
        let bytes = if painted {
            write_tile(&self.building_dir, tile, &building_pixels)?
        } else {
            0
        };
        let tree_bytes = match &self.tree_dir {
            Some(directory) if tree_painted => write_tile(directory, tile, &tree_pixels)?,
            _ => 0,
        };
        Ok(Stats {
            tiles: 1,
            painted: usize::from(painted),
            bytes,
            tree_painted: usize::from(tree_bytes > 0),
            tree_bytes,
        })
    }
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

    let cities: Vec<Option<CityShade>> = manifest
        .cities
        .iter()
        .map(|city| read_city_shade(city, &args.data))
        .collect::<Fallible<Vec<Option<CityShade>>>>()?;
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
                shade.casters.crowns.len()
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
        let render = BucketRender {
            cities: &cities,
            shadows: cities
                .iter()
                .map(|city| {
                    city.as_ref()
                        .map(|shade| city_shadows(shade, bucket, params))
                })
                .collect(),
            bucket,
            params,
            building_dir,
            tree_dir,
        };

        eprintln!(
            "bin {index} (el {:.0}° az {:.0}°): rendering {} tiles across {} threads",
            bucket.elevation,
            bucket.azimuth,
            plan.len(),
            rayon::current_num_threads()
        );
        let stats = plan
            .par_iter()
            .map(|tile| render.render(tile))
            .try_reduce(Stats::default, |left, right| Ok(left + right))?;
        fs::write(&job.stamp, &job.key)?;
        eprintln!(
            "  wrote {} tiles ({} building painted, {:.1} MiB; {} tree painted, {:.1} MiB)",
            stats.tiles,
            stats.painted,
            stats.bytes as f64 / 1024.0 / 1024.0,
            stats.tree_painted,
            stats.tree_bytes as f64 / 1024.0 / 1024.0
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

    fn coord(lng: f64, lat: f64) -> Coord {
        Coord { lng, lat }
    }

    /// A 40 x 40 block of towers, every third an L concave enough to sweep as strips, and crowns.
    fn city_block() -> Casters {
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
        for column in 0..40 {
            for row in 0..40 {
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

    // Generating hulls per tile in batches must paint exactly what one whole-city set did.
    #[test]
    fn streamed_shadows_match_a_whole_city_set() {
        let casters = city_block();
        let samples: Vec<Sample> = [(0.3, 0.95, 1.2), (-0.6, 0.8, 2.5), (0.9, -0.44, 0.7)]
            .iter()
            .map(|&(east, north, shadow_per_height)| Sample {
                east,
                north,
                shadow_per_height,
            })
            .collect();
        let (max_shadow_meters, max_zoom) = (500.0, 14);
        let whole = |hulls_of: &dyn Fn(usize, &mut Vec<Polygon>), count: usize| {
            let mut hulls = Vec::new();
            for index in 0..count {
                hulls_of(index, &mut hulls);
            }
            let set = geometry::flatten(&hulls);
            let grid = PolygonGrid::new(&set);
            (set, grid)
        };
        let mut checked = 0;
        for (zoom, lng, lat) in [
            (12, -73.985, 40.71),
            (14, -73.985, 40.71),
            (15, -73.99, 40.705),
            (15, -73.97, 40.72),
            (16, -73.98, 40.715),
        ] {
            let tile = Tile {
                zoom,
                x: raster::tile_index(lng_to_pixel_x(lng, zoom), zoom),
                y: raster::tile_index(lat_to_pixel_y(lat, zoom), zoom),
                members: vec![0],
            };
            let mut streamed = TileRaster::new(&tile);
            let mut baseline = TileRaster::new(&tile);
            for sample in &samples {
                let building = |index: usize, out: &mut Vec<Polygon>| {
                    casters.building_hulls(index, sample, max_shadow_meters, out);
                };
                let crown = |index: usize, out: &mut Vec<Polygon>| {
                    casters.crown_hulls(index, sample, max_shadow_meters, max_zoom, out);
                };
                for (hulls_of, count) in [
                    (
                        &building as &(dyn Fn(usize, &mut Vec<Polygon>) + Sync),
                        casters.building_count(),
                    ),
                    (&crown, casters.crown_count()),
                ] {
                    let index = ShadowIndex::new(count, hulls_of);
                    let (set, grid) = whole(hulls_of, count);
                    let mut got = vec![0.0f32; TILE_SIZE * TILE_SIZE];
                    let mut want = vec![0.0f32; TILE_SIZE * TILE_SIZE];
                    let drew = streamed.accumulate_shadows(&index, hulls_of, &mut got);
                    assert_eq!(drew, baseline.accumulate(&set, &grid, &mut want));
                    assert!(
                        got.iter()
                            .zip(&want)
                            .all(|(a, b)| a.to_bits() == b.to_bits())
                    );
                    checked += usize::from(drew);
                }
            }
        }
        assert!(
            checked >= 20,
            "most tiles should see shadows, saw {checked}"
        );
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

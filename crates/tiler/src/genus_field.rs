//! The genus-field pass: each genus's crown cover, widely blurred for the wash's hue, as data.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use rayon::prelude::*;

use crate::Fallible;
use crate::binfmt::{self, LAND_FORMAT, Trees};
use crate::geometry::{self, Projection};
use crate::manifest::{City, Manifest};
use crate::raster::{
    EQUATOR_METERS_PER_PIXEL, LandMask, MIN_ZOOM, TILE_SIZE, Tile, encode_webp_lossless,
    lat_to_pixel_y, lng_to_pixel_x, pixel_x_to_lng, pixel_y_to_lat, plan_tiles, rasterize_land,
};

// z15 would triple the pyramid for detail the live dots already draw; the client magnifies z14.
const GENUS_MAX_ZOOM: u32 = 14;

/// The 11 ranked genera plus "Other"; must equal GENUS_COUNT in src/tree-cover/genus.ts.
const GENUS_BINS: usize = 12;
/// Three genera per tile in RGB with opaque alpha, since browsers premultiply RGB on decode.
const GENERA_PER_TILE: usize = 3;
const LAYERS: usize = GENUS_BINS.div_ceil(GENERA_PER_TILE);

// The meter-space bucket edge the tree index sorts into, so a box query scans one run per row.
const BUCKET_METERS: f64 = 60.0;

/// An opaque, tree-free pixel: RGB zero, alpha full.
const OPAQUE_ZERO: [u8; 4] = [0, 0, 0, 255];

// Color only, so it varies slowly across a neighborhood; the wash takes its cover from the canopy.
const SIGMA_METERS: f64 = 120.0;

// A floor in pixels, so a zoomed-out view still changes hue gradually on screen.
const MIN_SIGMA_PX: f64 = 4.0;

// A blurred land share under this is a sliver of shore whose quotient would be noise.
const MIN_LAND_SHARE: f32 = 0.05;

// A pixel mostly over land is painted, so a shore or a pond's edge doesn't speckle.
const LAND_PIXEL: f32 = 0.5;

// The land mask's cell (raster.rs rasterizes it at 20 m), and a cap on samples per pixel side.
const LAND_CELL_METERS: f64 = 20.0;
const MAX_LAND_SAMPLES: f64 = 16.0;

// Below a pixel's width a crown is a point, deposited bilinearly so its area survives.
const POINT_CROWN_PX: f64 = 1.0;

pub struct Args {
    pub manifest: PathBuf,
    pub data: PathBuf,
    pub tiles: PathBuf,
}

/// One city's trees in meter space and the land the blur is clipped back to.
struct Field {
    trees: TreeIndex,
    land: LandMask,
    projection: Projection,
    tree_count: usize,
}

#[derive(Clone, Copy, Default)]
struct Stats {
    tiles: usize,
    painted: usize,
    bytes: usize,
}

impl std::ops::Add for Stats {
    type Output = Self;

    fn add(self, other: Self) -> Self {
        Self {
            tiles: self.tiles + other.tiles,
            painted: self.painted + other.painted,
            bytes: self.bytes + other.bytes,
        }
    }
}

fn read_field(city: &City, data: &Path) -> Fallible<Option<Field>> {
    if city.field.genus.is_none() {
        return Ok(None);
    }
    let trees = binfmt::read_trees(&data.join("trees").join(&city.field.trees.file))?;
    let land = binfmt::read_polygons(
        &data.join("land").join(&city.field.land.file),
        "LAND",
        LAND_FORMAT,
    )?;
    let projection = Projection::new(&city.bounds);
    Ok(Some(Field {
        tree_count: trees.coords.len(),
        trees: TreeIndex::new(&trees, &projection),
        land: rasterize_land(&land, &city.bounds, &projection),
        projection,
    }))
}

/// Adds `amount` at a fractional pixel position, split over its four nearest pixel centers.
fn deposit_point(plane: &mut [f32], width: usize, x: f64, y: f64, amount: f64) {
    let (fx, fy) = (x - 0.5, y - 0.5);
    let (x0, y0) = (fx.floor(), fy.floor());
    let (tx, ty) = (fx - x0, fy - y0);
    for (dx, dy, weight) in [
        (0, 0, (1.0 - tx) * (1.0 - ty)),
        (1, 0, tx * (1.0 - ty)),
        (0, 1, (1.0 - tx) * ty),
        (1, 1, tx * ty),
    ] {
        let (px, py) = (x0 as i64 + dx, y0 as i64 + dy);
        if px >= 0 && py >= 0 && (px as usize) < width && (py as usize) < width {
            plane[py as usize * width + px as usize] += (amount * weight) as f32;
        }
    }
}

/// Adds an antialiased disc's per-pixel coverage.
fn deposit_disc(plane: &mut [f32], width: usize, x: f64, y: f64, radius: f64) {
    let x0 = (x - radius - 1.0).floor().max(0.0) as usize;
    let x1 = (x + radius + 1.0).ceil().clamp(0.0, width as f64) as usize;
    let y0 = (y - radius - 1.0).floor().max(0.0) as usize;
    let y1 = (y + radius + 1.0).ceil().clamp(0.0, width as f64) as usize;
    for iy in y0..y1 {
        let dy = iy as f64 + 0.5 - y;
        for ix in x0..x1 {
            let dx = ix as f64 + 0.5 - x;
            let coverage = (radius + 0.5 - dx.hypot(dy)).clamp(0.0, 1.0);
            if coverage > 0.0 {
                plane[iy * width + ix] += coverage as f32;
            }
        }
    }
}

/// One city's blurred cover per genus over a tile, added into `cover` (`GENUS_BINS` planes).
fn accumulate(cover: &mut [f32], field: &Field, tile: &Tile) {
    let zoom = tile.zoom;
    let origin_x = f64::from(tile.x) * TILE_SIZE as f64;
    let origin_y = f64::from(tile.y) * TILE_SIZE as f64;
    let center_lat = pixel_y_to_lat(origin_y + TILE_SIZE as f64 / 2.0, zoom);
    let meters_per_pixel =
        EQUATOR_METERS_PER_PIXEL * center_lat.to_radians().cos() / f64::from(1u32 << zoom);

    // The halo is what the kernel pulls in from past the tile's edge.
    let sigma_pixels = (SIGMA_METERS / meters_per_pixel).max(MIN_SIGMA_PX);
    let halo = (geometry::BLUR_RADII * sigma_pixels).ceil() as usize;
    let padded = TILE_SIZE + 2 * halo;
    let pad_origin_x = origin_x - halo as f64;
    let pad_origin_y = origin_y - halo as f64;

    let min_x = field.projection.x(pixel_x_to_lng(pad_origin_x, zoom));
    let max_x = field
        .projection
        .x(pixel_x_to_lng(pad_origin_x + padded as f64, zoom));
    let min_y = field
        .projection
        .y(pixel_y_to_lat(pad_origin_y + padded as f64, zoom));
    let max_y = field.projection.y(pixel_y_to_lat(pad_origin_y, zoom));

    let mut planes = vec![0f32; padded * padded * GENUS_BINS];
    let mut touched = [false; GENUS_BINS];
    field.trees.for_each_in_box(
        min_x,
        min_y,
        max_x,
        max_y,
        field.trees.max_crown_m(),
        |mx, my, crown_m, genus_id| {
            let genus = genus_id as usize;
            if genus >= GENUS_BINS {
                return;
            }
            let x = lng_to_pixel_x(field.projection.lng(mx), zoom) - pad_origin_x;
            let y = lat_to_pixel_y(field.projection.lat(my), zoom) - pad_origin_y;
            let radius = crown_m / meters_per_pixel;
            let plane = &mut planes[genus * padded * padded..(genus + 1) * padded * padded];
            if radius < POINT_CROWN_PX {
                deposit_point(plane, padded, x, y, std::f64::consts::PI * radius * radius);
            } else {
                deposit_disc(plane, padded, x, y, radius);
            }
            touched[genus] = true;
        },
    );
    if !touched.iter().any(|genus| *genus) {
        return;
    }

    // Each pixel's land share, sampled as finely as the mask, so a low zoom averages its shore.
    let samples = (meters_per_pixel / LAND_CELL_METERS)
        .ceil()
        .clamp(1.0, MAX_LAND_SAMPLES) as usize;
    let land_cols: Vec<Option<usize>> = (0..padded * samples)
        .map(|sample| {
            let x = pad_origin_x + (sample as f64 + 0.5) / samples as f64;
            field
                .land
                .column(field.projection.x(pixel_x_to_lng(x, zoom)))
        })
        .collect();
    let land_rows: Vec<Option<usize>> = (0..padded * samples)
        .map(|sample| {
            let y = pad_origin_y + (sample as f64 + 0.5) / samples as f64;
            field
                .land
                .row_base(field.projection.y(pixel_y_to_lat(y, zoom)))
        })
        .collect();
    let mut land = vec![0f32; padded * padded];
    for (row, base) in land_rows.iter().enumerate() {
        let Some(base) = base else { continue };
        let y = row / samples;
        for (col, column) in land_cols.iter().enumerate() {
            let Some(column) = column else { continue };
            if field.land.is_land(*base, *column) {
                land[y * padded + col / samples] += 1.0;
            }
        }
    }
    let per_pixel = (samples * samples) as f32;
    for share in &mut land {
        *share /= per_pixel;
    }
    // Divided by below, so cover by a shore is a share of the land around it, not of the water.
    let land_share = geometry::feather(&land, padded, padded, sigma_pixels);

    for genus in (0..GENUS_BINS).filter(|genus| touched[*genus]) {
        let plane = &planes[genus * padded * padded..(genus + 1) * padded * padded];
        let blurred = geometry::feather(plane, padded, padded, sigma_pixels);
        let out = &mut cover[genus * TILE_SIZE * TILE_SIZE..(genus + 1) * TILE_SIZE * TILE_SIZE];
        for y in 0..TILE_SIZE {
            for x in 0..TILE_SIZE {
                let at = (y + halo) * padded + (x + halo);
                if land[at] >= LAND_PIXEL && land_share[at] > MIN_LAND_SHARE {
                    out[y * TILE_SIZE + x] += blurred[at] / land_share[at];
                }
            }
        }
    }
}

/// Each genus's fraction of the ground under its crowns, `GENUS_BINS` planes of one tile.
fn cover(fields: &[Option<Field>], tile: &Tile) -> Vec<f32> {
    let mut cover = vec![0f32; TILE_SIZE * TILE_SIZE * GENUS_BINS];
    for member in &tile.members {
        if let Some(field) = &fields[*member] {
            accumulate(&mut cover, field, tile);
        }
    }
    cover
}

/// A cover fraction as a byte; square-rooted, so a z9 pixel's few percent keeps its precision.
fn quantize(cover: f32) -> u8 {
    (cover.clamp(0.0, 1.0).sqrt() * 255.0).round() as u8
}

/// Quantize one packed layer (genera `base..base + 3`) into a tile, or None when it's empty.
fn pack_layer(cover: &[f32], base: usize) -> Option<Vec<u8>> {
    let mut pixels = OPAQUE_ZERO.repeat(TILE_SIZE * TILE_SIZE);
    let mut painted = false;
    for channel in 0..GENERA_PER_TILE {
        let genus = base + channel;
        if genus >= GENUS_BINS {
            continue;
        }
        let plane = &cover[genus * TILE_SIZE * TILE_SIZE..(genus + 1) * TILE_SIZE * TILE_SIZE];
        for (pixel, value) in plane.iter().enumerate() {
            let byte = quantize(*value);
            pixels[pixel * 4 + channel] = byte;
            painted |= byte > 0;
        }
    }
    painted.then_some(pixels)
}

/// Render one tile position into `LAYERS` packed tiles; an empty layer gets the shared blank.
fn render(
    fields: &[Option<Field>],
    blank: &[u8],
    directories: &[PathBuf],
    tile: &Tile,
) -> Fallible<Stats> {
    let cover = cover(fields, tile);
    let mut stats = Stats::default();
    for (layer, directory) in directories.iter().enumerate() {
        let packed = pack_layer(&cover, layer * GENERA_PER_TILE);
        let painted = packed.is_some();
        let encoded = packed.map(|pixels| encode_webp_lossless(&pixels));
        let webp = encoded.as_deref().unwrap_or(blank);
        fs::write(
            directory
                .join(tile.zoom.to_string())
                .join(tile.x.to_string())
                .join(format!("{}.webp", tile.y)),
            webp,
        )?;
        stats = stats
            + Stats {
                tiles: 1,
                painted: usize::from(painted),
                bytes: webp.len(),
            };
    }
    Ok(stats)
}

pub fn run(args: &Args) -> Fallible<()> {
    let started = Instant::now();
    let manifest: Manifest = serde_json::from_slice(&fs::read(&args.manifest)?)?;

    let fields: Vec<Option<Field>> = manifest
        .cities
        .iter()
        .map(|city| read_field(city, &args.data))
        .collect::<Fallible<Vec<Option<Field>>>>()?;
    if fields.iter().all(Option::is_none) {
        eprintln!("no city has a genus layer; nothing to render");
        return Ok(());
    }
    for (city, field) in manifest.cities.iter().zip(&fields) {
        if let Some(field) = field {
            eprintln!("{}: {} trees", city.id, field.tree_count);
        }
    }

    // One lossless pyramid per packed layer under public/tiles/genus-field/{0,1,2,3}.
    let directories: Vec<PathBuf> = (0..LAYERS)
        .map(|layer| args.tiles.join(layer.to_string()))
        .collect();

    let plan = plan_tiles(&manifest.cities, GENUS_MAX_ZOOM);
    for directory in &directories {
        for tile in &plan {
            fs::create_dir_all(
                directory
                    .join(tile.zoom.to_string())
                    .join(tile.x.to_string()),
            )?;
        }
    }
    let blank = encode_webp_lossless(&OPAQUE_ZERO.repeat(TILE_SIZE * TILE_SIZE));

    eprintln!(
        "rendering {} genus-field tiles ({} positions x {LAYERS} layers) across {} threads",
        plan.len() * LAYERS,
        plan.len(),
        rayon::current_num_threads()
    );
    let stats = plan
        .par_iter()
        .map(|tile| render(&fields, &blank, &directories, tile))
        .try_reduce(Stats::default, |left, right| Ok(left + right))?;

    eprintln!(
        "wrote {} genus-field tiles (z{MIN_ZOOM}-z{GENUS_MAX_ZOOM}, {} painted, {:.1} MiB) in {:.1}s",
        stats.tiles,
        stats.painted,
        stats.bytes as f64 / 1024.0 / 1024.0,
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

/// The trees in a CSR meter-space index; a row's buckets are contiguous, one run per row.
struct TreeIndex {
    xs: Vec<f64>,
    ys: Vec<f64>,
    crown_radii_m: Vec<f64>, // in bucket order alongside xs/ys
    genus_ids: Vec<u8>,      // 0..GENUS_BINS, in the same bucket order
    starts: Vec<u32>,
    cols: usize,
    rows: usize,
    min_x: f64,
    min_y: f64,
    max_crown_m: f64, // the largest crown, so a query knows how far a dot can reach past the box
}

impl TreeIndex {
    fn new(trees: &Trees, projection: &Projection) -> Self {
        let tree_x: Vec<f64> = trees
            .coords
            .iter()
            .map(|tree| projection.x(tree.lng))
            .collect();
        let tree_y: Vec<f64> = trees
            .coords
            .iter()
            .map(|tree| projection.y(tree.lat))
            .collect();
        let max_crown_m = trees.crown_radii_m.iter().copied().fold(0.0, f64::max);
        let min_x = tree_x.iter().copied().fold(f64::INFINITY, f64::min);
        let min_y = tree_y.iter().copied().fold(f64::INFINITY, f64::min);
        let max_x = tree_x.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let max_y = tree_y.iter().copied().fold(f64::NEG_INFINITY, f64::max);

        let cols = (((max_x - min_x) / BUCKET_METERS).floor() as usize + 1).max(1);
        let rows = (((max_y - min_y) / BUCKET_METERS).floor() as usize + 1).max(1);
        let mut starts = vec![0u32; cols * rows + 1];
        let buckets: Vec<usize> = (0..trees.coords.len())
            .map(|tree| {
                let col = ((tree_x[tree] - min_x) / BUCKET_METERS).floor() as usize;
                let row = ((tree_y[tree] - min_y) / BUCKET_METERS).floor() as usize;
                row * cols + col
            })
            .collect();
        for bucket in &buckets {
            starts[bucket + 1] += 1;
        }
        for bucket in 0..cols * rows {
            starts[bucket + 1] += starts[bucket];
        }

        let mut xs = vec![0.0; trees.coords.len()];
        let mut ys = vec![0.0; trees.coords.len()];
        let mut crown_radii_m = vec![0.0; trees.coords.len()];
        let mut genus_ids = vec![0u8; trees.coords.len()];
        let mut cursors = starts.clone();
        for (tree, bucket) in buckets.iter().enumerate() {
            let slot = cursors[*bucket] as usize;
            cursors[*bucket] += 1;
            xs[slot] = tree_x[tree];
            ys[slot] = tree_y[tree];
            crown_radii_m[slot] = trees.crown_radii_m[tree];
            genus_ids[slot] = trees.genus_ids[tree];
        }
        Self {
            xs,
            ys,
            crown_radii_m,
            genus_ids,
            starts,
            cols,
            rows,
            min_x,
            min_y,
            max_crown_m,
        }
    }

    fn max_crown_m(&self) -> f64 {
        self.max_crown_m
    }

    /// Every tree within `reach` of the box, as (x, y, crown_radius_m, genus_id).
    fn for_each_in_box(
        &self,
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
        reach: f64,
        mut visit: impl FnMut(f64, f64, f64, u8),
    ) {
        let Some((low_col, high_col, low_row, high_row)) =
            self.span(min_x, min_y, max_x, max_y, reach)
        else {
            return;
        };
        let (low_x, high_x, low_y, high_y) =
            (min_x - reach, max_x + reach, min_y - reach, max_y + reach);
        for row in low_row..=high_row {
            let base = row * self.cols;
            let from = self.starts[base + low_col] as usize;
            let to = self.starts[base + high_col + 1] as usize;
            for tree in from..to {
                let x = self.xs[tree];
                let y = self.ys[tree];
                if x >= low_x && x <= high_x && y >= low_y && y <= high_y {
                    visit(x, y, self.crown_radii_m[tree], self.genus_ids[tree]);
                }
            }
        }
    }

    // The buckets a box grown by `radius` reaches, or None when it reaches none of them.
    fn span(
        &self,
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
        radius: f64,
    ) -> Option<(usize, usize, usize, usize)> {
        let low_col = ((min_x - radius - self.min_x) / BUCKET_METERS)
            .floor()
            .max(0.0);
        let high_col = ((max_x + radius - self.min_x) / BUCKET_METERS)
            .floor()
            .min((self.cols - 1) as f64);
        let low_row = ((min_y - radius - self.min_y) / BUCKET_METERS)
            .floor()
            .max(0.0);
        let high_row = ((max_y + radius - self.min_y) / BUCKET_METERS)
            .floor()
            .min((self.rows - 1) as f64);
        if low_col > high_col || low_row > high_row {
            None
        } else {
            Some((
                low_col as usize,
                high_col as usize,
                low_row as usize,
                high_row as usize,
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{deposit_disc, deposit_point};

    #[test]
    fn a_crown_deposits_its_area_whether_a_point_or_a_disc() {
        let width = 32;
        let mut point = vec![0f32; width * width];
        deposit_point(&mut point, width, 10.3, 12.8, 0.5);
        assert!((point.iter().sum::<f32>() - 0.5).abs() < 1e-5);

        let mut disc = vec![0f32; width * width];
        deposit_disc(&mut disc, width, 16.0, 16.0, 5.0);
        let area = std::f32::consts::PI * 25.0;
        assert!((disc.iter().sum::<f32>() - area).abs() / area < 0.02);
    }
}

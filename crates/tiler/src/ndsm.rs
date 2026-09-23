//! Roof heights from a raw LiDAR cloud: a highest-return surface less the bare-earth DEM, per footprint.
//! The East Bay's points are 87% unclassified, so roofs are separated geometrically, not by class.

use std::collections::VecDeque;
use std::f64::consts::PI;
use std::fs;
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, AtomicU32, Ordering};

use las::Reader;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tiff::encoder::{Compression, TiffEncoder, colortype};
use tiff::tags::Tag;

use crate::Fallible;
use crate::binfmt::{Coord, Polygon};
use crate::dem::{Dem, TileGrid, read_tile_grid};
use crate::heights::{self, Source, Tmerc};

/// Web mercator, which EPT publishes its points in regardless of the flown grid.
const EARTH_RADIUS_METERS: f64 = 6_378_137.0;
const MERCATOR_HALF_WIDTH_METERS: f64 = 20_037_508.342_789_244;

/// Unclassified: the only class above ground in this flight, which has no building or vegetation class.
const SURFACE_CLASS: u8 = 1;
/// Bare earth, read where the staged DEM has no ground.
const GROUND_CLASS: u8 = 2;

const CELL_METERS: f64 = 1.0;

/// One written tile, sized to heights.rs's mosaic band so each is decoded once.
const TILE_METERS: f64 = 500.0;

/// One block of work: the staged DEM's naming grid, so no 400 MB DEM tile is decoded twice.
const SQUARE_METERS: f64 = 10_000.0;

/// Written where no return landed or no ground was known; below the -9000 nodata cut.
const NODATA_METERS: f32 = -9999.0;

/// Grid margin past the window, covering the UTM grid convergence at the corners.
const MARGIN_METERS: f64 = 16.0;

const ROOF_PERCENTILE: f64 = 0.75;
/// A building stands on one ground height; the median of its footprint's cells.
const GROUND_PERCENTILE: f64 = 0.5;

/// Taller than any building, so it only drops residual noise returns inside a footprint.
const IMPLAUSIBLE_ROOF_METERS: f64 = 600.0;
/// The same filter over the ground mosaic, above the highest ground any city sits on.
const IMPLAUSIBLE_GROUND_METERS: f64 = 4_000.0;

/// The surface is a height above ground, the ground an elevation (Alameda's shoreline must read).
const ROOF: heights::Quantity = heights::Quantity::above_ground(IMPLAUSIBLE_ROOF_METERS);
const GROUND: heights::Quantity = heights::Quantity::elevation(IMPLAUSIBLE_GROUND_METERS);

/// How far known ground is carried into cells without; past it the surface isn't written.
const MAX_FILL_RINGS: usize = 64;

/// A published height this far under the measured one was built after the flight, not mismeasured.
const CONSTRUCTION_RATIO: f64 = 0.5;
const CONSTRUCTION_METERS: f64 = 20.0;

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

/// One cached EPT node and its octree cube's bounds, a superset of its points.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Node {
    path: PathBuf,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Params {
    /// The cached EPT nodes; duplicated points are harmless under a per-cell max.
    nodes: Vec<Node>,
    /// The staged bare-earth DEM tiles; cells none answers take the cloud's own ground returns.
    dem: Vec<PathBuf>,
    /// The DEM's projection name, which the surface is binned onto so the two subtract cell for cell.
    crs: String,
    window: Window,
    /// The directory the two mosaics are written under, as `ndsm/` and `ground/`.
    out: PathBuf,
    /// GeoJSON footprints to sample; absent, only the rasters are written.
    #[serde(default)]
    footprints: Option<PathBuf>,
    /// Where the per-footprint readings are written for the ingest to merge and encode.
    #[serde(default)]
    heights: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    nodes: usize,
    squares: usize,
    /// Cells whose ground came from the flight's own returns rather than the DEM.
    filled: u64,
    points: u64,
    /// Points of `SURFACE_CLASS` that landed in a grid.
    surface_points: u64,
    tiles: usize,
    /// Cells holding a return, and of those the ones a ground height was known under.
    returned: u64,
    grounded: u64,
    footprints: usize,
    measured: usize,
    based: usize,
}

/// A row-major rectangle of 1 m cells in the DEM's projection, origin at cell (0, 0)'s upper-left.
struct Grid {
    origin_x: f64,
    origin_y: f64,
    width: usize,
    height: usize,
}

impl Grid {
    /// The whole window, snapped out to `TILE_METERS` so every block's tiles read back as one mosaic.
    fn over(window: &Window, projection: Tmerc) -> Grid {
        // Edges too: a lng/lat rectangle is widest on the grid mid-edge, not at a corner.
        let lngs = [window.west, (window.west + window.east) / 2.0, window.east];
        let lats = [
            window.south,
            (window.south + window.north) / 2.0,
            window.north,
        ];
        let mut min_x = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        for lng in lngs {
            for lat in lats {
                let (x, y) = projection.forward(lng, lat);
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
            }
        }
        let west = ((min_x - MARGIN_METERS) / TILE_METERS).floor() * TILE_METERS;
        let east = ((max_x + MARGIN_METERS) / TILE_METERS).ceil() * TILE_METERS;
        let south = ((min_y - MARGIN_METERS) / TILE_METERS).floor() * TILE_METERS;
        let north = ((max_y + MARGIN_METERS) / TILE_METERS).ceil() * TILE_METERS;
        Grid {
            origin_x: west,
            origin_y: north,
            width: ((east - west) / CELL_METERS) as usize,
            height: ((north - south) / CELL_METERS) as usize,
        }
    }

    fn min_x(&self) -> f64 {
        self.origin_x
    }

    fn max_x(&self) -> f64 {
        self.origin_x + self.width as f64 * CELL_METERS
    }

    fn max_y(&self) -> f64 {
        self.origin_y
    }

    fn min_y(&self) -> f64 {
        self.origin_y - self.height as f64 * CELL_METERS
    }

    /// The part of this grid inside a rectangle, or nothing where the two do not meet.
    fn clipped(&self, west: f64, south: f64, east: f64, north: f64) -> Option<Grid> {
        let west = self.min_x().max(west);
        let east = self.max_x().min(east);
        let south = self.min_y().max(south);
        let north = self.max_y().min(north);
        if east <= west || north <= south {
            None
        } else {
            Some(Grid {
                origin_x: west,
                origin_y: north,
                width: ((east - west) / CELL_METERS) as usize,
                height: ((north - south) / CELL_METERS) as usize,
            })
        }
    }

    fn cell_of(&self, x: f64, y: f64) -> Option<usize> {
        let column = ((x - self.origin_x) / CELL_METERS).floor();
        let row = ((self.origin_y - y) / CELL_METERS).floor();
        if column < 0.0 || row < 0.0 || column >= self.width as f64 || row >= self.height as f64 {
            None
        } else {
            Some(row as usize * self.width + column as usize)
        }
    }
}

/// Web mercator meters back to degrees, the closed form.
fn to_degrees(x: f64, y: f64) -> (f64, f64) {
    let lng = x * 180.0 / MERCATOR_HALF_WIDTH_METERS;
    let lat = (2.0 * (y / EARTH_RADIUS_METERS).exp().atan() - PI / 2.0).to_degrees();
    (lng, lat)
}

/// A height as a u32 ordering like the height, so a cell's max is one `fetch_max`; 0 means no return.
fn ordered(meters: f32) -> u32 {
    let bits = meters.to_bits();
    if bits & 0x8000_0000 == 0 {
        bits | 0x8000_0000
    } else {
        !bits
    }
}

fn from_ordered(key: u32) -> f32 {
    if key & 0x8000_0000 == 0 {
        f32::from_bits(!key)
    } else {
        f32::from_bits(key & 0x7fff_ffff)
    }
}

/// A node's box on the output grid, projected over its edges too and margined like the window.
struct Reach {
    path: PathBuf,
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
}

fn reach_of(node: &Node, projection: Tmerc) -> Reach {
    let lngs = [node.west, (node.west + node.east) / 2.0, node.east];
    let lats = [node.south, (node.south + node.north) / 2.0, node.north];
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for lng in lngs {
        for lat in lats {
            let (x, y) = projection.forward(lng, lat);
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
        }
    }
    Reach {
        path: node.path.clone(),
        min_x: min_x - MARGIN_METERS,
        max_x: max_x + MARGIN_METERS,
        min_y: min_y - MARGIN_METERS,
        max_y: max_y + MARGIN_METERS,
    }
}

struct Binned {
    /// Per cell, the highest surface return as an `ordered` key, or 0 for none.
    surface: Vec<u32>,
    /// Ground returns' decimeter sum and count per cell; a cell holds one or two, so mean is median.
    ground_sum: Vec<i32>,
    ground_count: Vec<u32>,
    points: u64,
    surface_points: u64,
    /// Points per classification in the grid.
    classes: [u64; 256],
}

/// Bins a block: the highest surface return per cell, and the ground returns beside it.
fn bin(nodes: &[&Reach], grid: &Grid, projection: Tmerc) -> Fallible<Binned> {
    let cells = grid.width * grid.height;
    let surface: Vec<AtomicU32> = (0..cells).map(|_| AtomicU32::new(0)).collect();
    let ground_sum: Vec<AtomicI32> = (0..cells).map(|_| AtomicI32::new(0)).collect();
    let ground_count: Vec<AtomicU32> = (0..cells).map(|_| AtomicU32::new(0)).collect();
    let tallies = nodes
        .par_iter()
        .map(|node| -> Fallible<(u64, u64, [u64; 256])> {
            let path = &node.path;
            let points = Reader::from_path(path)
                .map_err(|error| format!("{}: {error}", path.display()))?
                .read_all()
                .map_err(|error| format!("{}: {error}", path.display()))?;
            let mut inside = 0u64;
            let mut counted = 0u64;
            let mut classes = [0u64; 256];
            for (((x, y), z), class) in points
                .x()
                .zip(points.y())
                .zip(points.z())
                .zip(points.classification())
            {
                let (lng, lat) = to_degrees(x, y);
                let (east, north) = projection.forward(lng, lat);
                let Some(cell) = grid.cell_of(east, north) else {
                    continue;
                };
                inside += 1;
                classes[class as usize] += 1;
                if class == SURFACE_CLASS {
                    counted += 1;
                    surface[cell].fetch_max(ordered(z as f32), Ordering::Relaxed);
                } else if class == GROUND_CLASS {
                    ground_sum[cell].fetch_add(decimeters(z), Ordering::Relaxed);
                    ground_count[cell].fetch_add(1, Ordering::Relaxed);
                }
            }
            Ok((inside, counted, classes))
        })
        .collect::<Fallible<Vec<(u64, u64, [u64; 256])>>>()?;

    let mut binned = Binned {
        surface: surface.into_iter().map(AtomicU32::into_inner).collect(),
        ground_sum: ground_sum.into_iter().map(AtomicI32::into_inner).collect(),
        ground_count: ground_count
            .into_iter()
            .map(AtomicU32::into_inner)
            .collect(),
        points: 0,
        surface_points: 0,
        classes: [0u64; 256],
    };
    for (inside, counted, classes) in tallies {
        binned.points += inside;
        binned.surface_points += counted;
        for (total, count) in binned.classes.iter_mut().zip(classes) {
            *total += count;
        }
    }
    Ok(binned)
}

/// A ground return in decimeters, signed: reclaimed land (the airport, Bay Farm) is below sea level.
fn decimeters(height: f64) -> i32 {
    (height * 10.0)
        .round()
        .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
}

/// Carries known heights breadth first into unknown cells up to `rings` away, nearest first.
fn fill_nearest(values: &mut [f32], width: usize, height: usize, rings: usize) {
    // Seeded only with known cells bordering an unknown one; a 10 km square holds 10^8 known cells.
    let mut frontier: VecDeque<(usize, usize)> = VecDeque::new();
    for index in 0..values.len() {
        let row = index / width;
        let column = index % width;
        let edge = (column > 0 && !values[index - 1].is_finite())
            || (column + 1 < width && !values[index + 1].is_finite())
            || (row > 0 && !values[index - width].is_finite())
            || (row + 1 < height && !values[index + width].is_finite());
        if values[index].is_finite() && edge {
            frontier.push_back((index, 0));
        }
    }
    while let Some((index, ring)) = frontier.pop_front() {
        if ring >= rings {
            continue;
        }
        let value = values[index];
        let row = index / width;
        let column = index % width;
        let mut spread = |neighbor: usize, values: &mut [f32]| {
            if !values[neighbor].is_finite() {
                values[neighbor] = value;
                frontier.push_back((neighbor, ring + 1));
            }
        };
        if column > 0 {
            spread(index - 1, values);
        }
        if column + 1 < width {
            spread(index + 1, values);
        }
        if row > 0 {
            spread(index - width, values);
        }
        if row + 1 < height {
            spread(index + width, values);
        }
    }
}

/// A block's ground: the staged DEM where it answers, else the flight's ground returns, cell by cell.
fn ground_of(
    grid: &Grid,
    staged: &[PathBuf],
    projection: Tmerc,
    binned: &Binned,
) -> Fallible<(Vec<f32>, u64)> {
    let mut ground = if staged.is_empty() {
        vec![f32::NAN; grid.width * grid.height]
    } else {
        let mut dem = Dem::open(staged, projection, 0)?;
        let sampled = dem.sample_grid(
            grid.origin_x,
            grid.origin_y,
            CELL_METERS,
            grid.width,
            grid.height,
        )?;
        dem.release();
        sampled
    };
    let mut filled = 0u64;
    for (index, height) in ground.iter_mut().enumerate() {
        let count = binned.ground_count[index];
        if !height.is_finite() && count > 0 {
            *height = binned.ground_sum[index] as f32 / count as f32 / 10.0;
            filled += 1;
        }
    }
    fill_nearest(&mut ground, grid.width, grid.height, MAX_FILL_RINGS);
    Ok((ground, filled))
}

/// Writes only the two tags `dem.rs` reads; no CRS keys, which is why readers are given a projection.
fn write_raster(
    path: &Path,
    origin_x: f64,
    origin_y: f64,
    side: usize,
    values: &[f32],
) -> Fallible<()> {
    let mut encoder =
        TiffEncoder::new(BufWriter::new(File::create(path)?))?.with_compression(Compression::Lzw);
    let mut image = encoder.new_image::<colortype::Gray32Float>(side as u32, side as u32)?;
    image.encoder().write_tag(
        Tag::ModelPixelScaleTag,
        &[CELL_METERS, CELL_METERS, 0.0][..],
    )?;
    image.encoder().write_tag(
        Tag::ModelTiepointTag,
        &[0.0, 0.0, 0.0, origin_x, origin_y, 0.0][..],
    )?;
    image.write_data(values)?;
    Ok(())
}

/// What one block wrote: the tiles of each mosaic, and how much of it held anything.
struct Written {
    ndsm: Vec<PathBuf>,
    ground: Vec<PathBuf>,
    returned: u64,
    grounded: u64,
}

/// Cuts the block into mosaic tiles, skipping ones with no ground in both mosaics so they stay aligned.
fn write_tiles(
    grid: &Grid,
    binned: &Binned,
    ground: &[f32],
    ndsm_dir: &Path,
    ground_dir: &Path,
) -> Fallible<Written> {
    let side = (TILE_METERS / CELL_METERS) as usize;
    if !grid.width.is_multiple_of(side) || !grid.height.is_multiple_of(side) {
        return Err(format!(
            "a {} x {} block does not divide into {side} m tiles",
            grid.width, grid.height
        )
        .into());
    }
    let across = grid.width / side;
    let down = grid.height / side;
    let tiles: Vec<(usize, usize)> = (0..down)
        .flat_map(|row| (0..across).map(move |column| (row, column)))
        .collect();
    let written = tiles
        .par_iter()
        .map(|&(row, column)| -> Fallible<Written> {
            let origin_x = grid.origin_x + (column * side) as f64 * CELL_METERS;
            let origin_y = grid.origin_y - (row * side) as f64 * CELL_METERS;
            let mut heights = vec![NODATA_METERS; side * side];
            let mut grounds = vec![NODATA_METERS; side * side];
            let mut returned = 0u64;
            let mut grounded = 0u64;
            for line in 0..side {
                let from = (row * side + line) * grid.width + column * side;
                for step in 0..side {
                    let key = binned.surface[from + step];
                    let base = ground[from + step];
                    if base.is_finite() {
                        grounds[line * side + step] = base;
                    }
                    if key != 0 {
                        returned += 1;
                        if base.is_finite() {
                            grounded += 1;
                            heights[line * side + step] = from_ordered(key) - base;
                        }
                    }
                }
            }
            if grounded == 0 {
                return Ok(Written {
                    ndsm: Vec::new(),
                    ground: Vec::new(),
                    returned,
                    grounded,
                });
            }
            let name = format!("{}-{}.tif", origin_x as i64, origin_y as i64);
            let ndsm = ndsm_dir.join(&name);
            let base = ground_dir.join(&name);
            write_raster(&ndsm, origin_x, origin_y, side, &heights)?;
            write_raster(&base, origin_x, origin_y, side, &grounds)?;
            Ok(Written {
                ndsm: vec![ndsm],
                ground: vec![base],
                returned,
                grounded,
            })
        })
        .collect::<Fallible<Vec<Written>>>()?;
    let mut total = Written {
        ndsm: Vec::new(),
        ground: Vec::new(),
        returned: 0,
        grounded: 0,
    };
    for one in written {
        total.ndsm.extend(one.ndsm);
        total.ground.extend(one.ground);
        total.returned += one.returned;
        total.grounded += one.grounded;
    }
    Ok(total)
}

/// A building to sample, with the height its source published for comparison and merging.
struct Footprint {
    /// The feature this came from, so the ingest puts the reading back on the right building.
    feature: usize,
    polygon: Polygon,
    name: Option<String>,
    published_meters: Option<f64>,
    /// OSM-surveyed rather than ML-modeled; this county's ML heights cap out at 32.5 m.
    surveyed: bool,
}

fn ring_of(coordinates: &serde_json::Value) -> Vec<Coord> {
    coordinates
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|point| {
            let pair = point.as_array()?;
            Some(Coord {
                lng: pair.first()?.as_f64()?,
                lat: pair.get(1)?.as_f64()?,
            })
        })
        .collect()
}

/// Footprints wholly inside the window; one crossing the edge would read as part of a building.
fn read_footprints(path: &Path, window: &Window) -> Fallible<Vec<Footprint>> {
    let document: serde_json::Value = serde_json::from_slice(&fs::read(path)?)?;
    let mut footprints = Vec::new();
    for (feature, value) in document["features"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let geometry = &value["geometry"];
        let parts: Vec<Polygon> = match geometry["type"].as_str() {
            Some("Polygon") => vec![
                geometry["coordinates"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(ring_of)
                    .collect(),
            ],
            Some("MultiPolygon") => geometry["coordinates"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|part| part.as_array().into_iter().flatten().map(ring_of).collect())
                .collect(),
            _ => Vec::new(),
        };
        let properties = &value["properties"];
        for polygon in parts {
            let inside = polygon.iter().flatten().all(|point| {
                point.lng >= window.west
                    && point.lng <= window.east
                    && point.lat >= window.south
                    && point.lat <= window.north
            });
            if inside && !polygon.is_empty() {
                footprints.push(Footprint {
                    feature,
                    polygon,
                    name: properties["name"].as_str().map(String::from),
                    published_meters: properties["height"].as_f64(),
                    surveyed: properties["surveyed"].as_bool().unwrap_or(false),
                });
            }
        }
    }
    Ok(footprints)
}

fn quantile(sorted: &[f64], quantile: f64) -> f64 {
    let rank = (sorted.len() as f64 * quantile).ceil() as usize;
    sorted.get(rank.max(1) - 1).copied().unwrap_or(f64::NAN)
}

/// Error against the surveyed heights at each candidate percentile.
fn describe_errors(footprints: &[Footprint], readings: &[Vec<u16>]) {
    let mut compared = 0;
    let mut construction = 0;
    let mut errors: Vec<(f64, Vec<f64>)> = [0.5, ROOF_PERCENTILE, 0.9, 0.98]
        .into_iter()
        .map(|percentile| (percentile, Vec::new()))
        .collect();
    for (footprint, sample) in footprints.iter().zip(readings) {
        let (Some(published), true) = (footprint.published_meters, footprint.surveyed) else {
            continue;
        };
        if sample.is_empty() {
            continue;
        }
        let at = |percentile: f64| ROOF.meters(heights::percentile_dm(sample, percentile));
        if published > CONSTRUCTION_METERS && at(0.9) < CONSTRUCTION_RATIO * published {
            construction += 1;
            continue;
        }
        compared += 1;
        for (percentile, collected) in &mut errors {
            collected.push(at(*percentile) - published);
        }
    }
    eprintln!(
        "  against {compared} surveyed heights, {construction} held out as built after the flight:"
    );
    for (percentile, collected) in &mut errors {
        let mut absolute: Vec<f64> = collected.iter().map(|error| error.abs()).collect();
        collected.sort_by(f64::total_cmp);
        absolute.sort_by(f64::total_cmp);
        eprintln!(
            "    p{:.0}: median {:+.2} m, mean absolute {:.2} m, p90 absolute {:.2} m",
            *percentile * 100.0,
            quantile(collected, 0.5),
            absolute.iter().sum::<f64>() / absolute.len().max(1) as f64,
            quantile(&absolute, 0.9),
        );
    }
}

/// The tallest measurements, named, to catch a raster offset that puts the tower on the wrong polygon.
fn describe_tallest(footprints: &[Footprint], readings: &[Vec<u16>], count: usize) {
    let mut tallest: Vec<(f64, &Footprint)> = footprints
        .iter()
        .zip(readings)
        .map(|(footprint, sample)| {
            (
                ROOF.meters(heights::percentile_dm(sample, ROOF_PERCENTILE)),
                footprint,
            )
        })
        .collect();
    tallest.sort_by(|left, right| right.0.total_cmp(&left.0));
    for (height, footprint) in tallest.iter().take(count) {
        eprintln!(
            "  {height:6.1} m  {} (published {})",
            footprint.name.as_deref().unwrap_or("unnamed"),
            footprint
                .published_meters
                .map_or("none".to_string(), |published| format!("{published:.1} m")),
        );
    }
}

/// What one footprint measured, for the ingest to merge with what its source published.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Reading {
    feature: usize,
    /// The 75th percentile of surface cells inside, in meters; absent where none.
    roof_meters: Option<f64>,
    /// The median of the ground cells under it, likewise.
    base_meters: Option<f64>,
    cells: u32,
}

/// The staged tiles a block reaches; a block across a seam needs all of them.
fn reaching_dem(tiles: &[TileGrid], grid: &Grid) -> Vec<PathBuf> {
    tiles
        .iter()
        .filter(|tile| {
            tile.min_x() < grid.max_x()
                && tile.max_x() > grid.min_x()
                && tile.min_y() < grid.max_y()
                && tile.max_y() > grid.min_y()
        })
        .map(|tile| tile.path.clone())
        .collect()
}

pub fn run(params_file: &Path, report_file: &Path) -> Fallible<()> {
    let params: Params = serde_json::from_slice(&fs::read(params_file)?)?;
    let projection = heights::projection(&params.crs)?;
    let whole = Grid::over(&params.window, projection);
    let staged: Vec<TileGrid> = params
        .dem
        .iter()
        .map(|path| read_tile_grid(path))
        .collect::<Fallible<Vec<TileGrid>>>()?;
    let reaches: Vec<Reach> = params
        .nodes
        .iter()
        .map(|node| reach_of(node, projection))
        .collect();
    let ndsm_dir = params.out.join("ndsm");
    let ground_dir = params.out.join("ground");
    fs::create_dir_all(&ndsm_dir)?;
    fs::create_dir_all(&ground_dir)?;
    eprintln!(
        "  ndsm: {} x {} m over ({}, {}), from {} point-cloud nodes and {} staged ground tiles",
        whole.width,
        whole.height,
        whole.origin_x,
        whole.origin_y,
        reaches.len(),
        staged.len(),
    );

    let mut report = Report {
        nodes: params.nodes.len(),
        squares: 0,
        filled: 0,
        points: 0,
        surface_points: 0,
        tiles: 0,
        returned: 0,
        grounded: 0,
        footprints: 0,
        measured: 0,
        based: 0,
    };
    let mut classes = [0u64; 256];
    let mut ndsm_tiles: Vec<PathBuf> = Vec::new();
    let mut ground_tiles: Vec<PathBuf> = Vec::new();
    let columns = (whole.width as f64 * CELL_METERS / SQUARE_METERS).ceil() as usize;
    let rows = (whole.height as f64 * CELL_METERS / SQUARE_METERS).ceil() as usize;
    let squares = rows * columns;
    for row in 0..rows {
        for column in 0..columns {
            let west = whole.origin_x + column as f64 * SQUARE_METERS;
            let north = whole.origin_y - row as f64 * SQUARE_METERS;
            let Some(grid) =
                whole.clipped(west, north - SQUARE_METERS, west + SQUARE_METERS, north)
            else {
                continue;
            };
            let reaching: Vec<&Reach> = reaches
                .iter()
                .filter(|reach| {
                    reach.min_x < grid.max_x()
                        && reach.max_x > grid.min_x()
                        && reach.min_y < grid.max_y()
                        && reach.max_y > grid.min_y()
                })
                .collect();
            if reaching.is_empty() {
                continue;
            }
            let cover = reaching_dem(&staged, &grid);
            report.squares += 1;
            let binned = bin(&reaching, &grid, projection)?;
            let (ground, filled) = ground_of(&grid, &cover, projection, &binned)?;
            report.filled += filled;
            let written = write_tiles(&grid, &binned, &ground, &ndsm_dir, &ground_dir)?;
            report.points += binned.points;
            report.surface_points += binned.surface_points;
            report.returned += written.returned;
            report.grounded += written.grounded;
            for (total, count) in classes.iter_mut().zip(binned.classes) {
                *total += count;
            }
            eprintln!(
                "  ndsm: square {}/{squares} at ({}, {}) — {} nodes, {} staged ground tiles, \
                 {} returned cells, {filled} cells grounded from the cloud, {} tiles",
                report.squares,
                grid.origin_x as i64,
                grid.origin_y as i64,
                reaching.len(),
                cover.len(),
                written.returned,
                written.ndsm.len(),
            );
            ndsm_tiles.extend(written.ndsm);
            ground_tiles.extend(written.ground);
        }
    }
    report.tiles = ndsm_tiles.len();
    for (class, count) in classes.iter().enumerate() {
        if *count > 0 {
            eprintln!(
                "  class {class:2}: {count:>12} points ({:.1}%)",
                100.0 * *count as f64 / report.points.max(1) as f64
            );
        }
    }
    eprintln!(
        "  ndsm: {} cells hold a return, {} of them over known ground, {} of the ground taken from \
         the flight's own returns, in {} tiles",
        report.returned, report.grounded, report.filled, report.tiles
    );

    let footprints = match &params.footprints {
        Some(path) => read_footprints(path, &params.window)?,
        None => Vec::new(),
    };
    report.footprints = footprints.len();
    if !footprints.is_empty() && !ndsm_tiles.is_empty() {
        let polygons: Vec<Polygon> = footprints
            .iter()
            .map(|footprint| footprint.polygon.clone())
            .collect();
        let roofs = heights::measure(
            &polygons,
            &Source::Mosaic {
                paths: ndsm_tiles,
                band: 0,
            },
            projection,
            ROOF,
        )?;
        let bases = heights::measure(
            &polygons,
            &Source::Mosaic {
                paths: ground_tiles,
                band: 0,
            },
            projection,
            GROUND,
        )?;
        let readings: Vec<Reading> = footprints
            .iter()
            .zip(&roofs.values)
            .zip(&bases.values)
            .zip(&roofs.cells)
            .map(|(((footprint, roof), base), cells)| Reading {
                feature: footprint.feature,
                roof_meters: (!roof.is_empty())
                    .then(|| ROOF.meters(heights::percentile_dm(roof, ROOF_PERCENTILE))),
                base_meters: (!base.is_empty())
                    .then(|| GROUND.meters(heights::percentile_dm(base, GROUND_PERCENTILE))),
                cells: *cells,
            })
            .collect();
        report.measured = readings
            .iter()
            .filter(|reading| reading.roof_meters.is_some())
            .count();
        report.based = readings
            .iter()
            .filter(|reading| reading.base_meters.is_some())
            .count();
        eprintln!(
            "  ndsm: {} of {} footprints measured, {} of them over known ground",
            report.measured, report.footprints, report.based
        );
        describe_tallest(&footprints, &roofs.values, 12);
        describe_errors(&footprints, &roofs.values);
        if let Some(path) = &params.heights {
            if let Some(directory) = path.parent() {
                fs::create_dir_all(directory)?;
            }
            fs::write(path, serde_json::to_vec(&readings)?)?;
            eprintln!("  ndsm: wrote {}", path.display());
        }
    }

    crate::write_report(report_file, &report)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{
        Binned, Grid, TileGrid, decimeters, fill_nearest, from_ordered, ground_of, ordered,
        reaching_dem, to_degrees,
    };
    use crate::heights::UTM_10N;

    /// One staged 1 m tile of the 10 km naming grid, six pixels wider than the square each side.
    fn staged(origin_x: f64, origin_y: f64) -> TileGrid {
        TileGrid {
            path: PathBuf::from(format!("{origin_x}-{origin_y}.tif")),
            width: 10_012,
            height: 10_012,
            origin_x,
            origin_y,
            cell: 1.0,
            bands: 1,
            mosaic: 0,
        }
    }

    /// A block snapped to the 500 m tile grid straddles four staged tiles and must read all of them.
    #[test]
    fn a_block_across_a_seam_reads_every_staged_tile_it_touches() {
        let tiles = [
            staged(550_000.0, 4_200_000.0),
            staged(560_000.0, 4_200_000.0),
            staged(550_000.0, 4_190_000.0),
            staged(560_000.0, 4_190_000.0),
        ];
        let block = Grid {
            origin_x: 554_500.0,
            origin_y: 4_196_500.0,
            width: 10_000,
            height: 10_000,
        };
        assert_eq!(reaching_dem(&tiles, &block).len(), 4);
        assert!(
            !tiles.iter().any(|tile| {
                tile.contains(block.min_x() + 0.5, block.max_y() - 0.5)
                    && tile.contains(block.max_x() - 0.5, block.min_y() + 0.5)
            }),
            "a block this size lands inside one staged tile after all"
        );
    }

    /// The key must order across zero, which the float's bits don't (sign bit).
    #[test]
    fn the_cell_key_orders_heights_the_way_they_read() {
        let heights = [-120.5f32, -1.0, -0.0, 0.0, 0.05, 1.0, 122.4, 253.0];
        for pair in heights.windows(2) {
            assert!(
                ordered(pair[0]) <= ordered(pair[1]),
                "{} sorts above {}",
                pair[0],
                pair[1]
            );
        }
        for height in heights {
            assert_eq!(from_ordered(ordered(height)), height);
        }
        assert!(from_ordered(0).is_nan(), "an empty cell reads as a height");
    }

    /// Must agree with scripts/lidar.ts's forward projection, or points bin away from their nodes.
    #[test]
    fn mercator_meters_come_back_as_the_degrees_they_were() {
        for (x, y, lng, lat) in [
            (
                -13_611_034.139_293_559,
                4_551_915.359_055_145,
                -122.27,
                37.805,
            ),
            (
                -13_609_698.305_404_041,
                4_553_042.561_245_359,
                -122.258,
                37.813,
            ),
        ] {
            let (west, north) = to_degrees(x, y);
            assert!((west - lng).abs() < 1e-9, "longitude {west} not {lng}");
            assert!((north - lat).abs() < 1e-9, "latitude {north} not {lat}");
        }
    }

    /// A footprint's hole fills from the nearest ground, not the first the sweep meets.
    #[test]
    fn the_fill_takes_the_nearest_ground_and_stops() {
        let mut ground = vec![f32::NAN; 25];
        ground[0] = 1.0;
        ground[24] = 9.0;
        fill_nearest(&mut ground, 5, 5, 8);
        assert_eq!(ground[1], 1.0, "the cell beside the 1 took something else");
        assert_eq!(ground[23], 9.0, "the cell beside the 9 took something else");

        let mut far = vec![f32::NAN; 25];
        far[0] = 1.0;
        fill_nearest(&mut far, 5, 5, 2);
        assert!(far[24].is_nan(), "ground carried past the ring limit");
        assert_eq!(far[2], 1.0, "ground not carried to the ring limit");
    }

    /// Reclaimed ground below sea level must survive the fill, or buildings there read taller.
    #[test]
    fn ground_below_sea_level_reaches_the_cells_it_fills() {
        let grid = Grid {
            origin_x: 560_000.0,
            origin_y: 4_180_000.0,
            width: 2,
            height: 1,
        };
        let binned = Binned {
            surface: vec![0; 2],
            ground_sum: vec![decimeters(-1.8) + decimeters(-2.2), 0],
            ground_count: vec![2, 0],
            points: 2,
            surface_points: 0,
            classes: [0u64; 256],
        };
        let (ground, filled) = ground_of(&grid, &[], UTM_10N, &binned).expect("ground");
        assert_eq!(filled, 1, "the flight's own ground was not read");
        assert!(
            (ground[0] + 2.0).abs() < 1e-4,
            "ground read as {} rather than -2 m",
            ground[0]
        );
        assert_eq!(ground[1], ground[0], "the fill carried something else");
    }
}

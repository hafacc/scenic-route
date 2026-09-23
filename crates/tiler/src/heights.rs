//! The crown height of each canopy polygon: the 75th percentile of the 1 m LiDAR cells inside it.
//! San Francisco's raster is height above ground for everything, roofs too, so never sample it unmasked.

use std::fs;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use rayon::prelude::*;
use serde::Serialize;
use tiff::decoder::{Decoder, DecodingResult};
use tiff::tags::Tag;

use crate::Fallible;
use crate::binfmt::{self, Polygon};
use crate::dem::{TileGrid, read_tile_grid};

pub struct Args {
    pub canopy: PathBuf,
    /// One per survey; the Bay Area needs two, since no one raster reaches both halves.
    pub rasters: Vec<Raster>,
}

/// One survey: where its heights are read from, and the grid they are published on.
pub struct Raster {
    pub source: Source,
    pub projection: Tmerc,
}

/// Where the heights are read from; both are 1 m rasters on a transverse Mercator.
pub enum Source {
    /// One tiled BigTIFF of 16-bit decimeters — New York's canopy height model.
    Single(PathBuf),
    /// Separate rasters tiling one grid, `band` being height above ground (San Francisco's 3DEP).
    Mosaic { paths: Vec<PathBuf>, band: usize },
}

const HEIGHT_PERCENTILE: f64 = 0.75;
const NODATA: u16 = 65535; // explicit in New York's CHM, 95% of its cells
const TALL_METERS: f64 = 20.0; // the cut the reported share of canopy area is taken above
/// Taller than any tree here, so a reading above it is a roof or defect; dropped, not clamped.
const IMPLAUSIBLE_CROWN_METERS: f64 = 65.0;
const PROGRESS_BANDS: usize = 40;

/// At or below this is no measurement: mosaic edge padding and height-above-ground noise.
const ABOVE_GROUND_FLOOR_METERS: f64 = 0.05;

/// The floor under a crown: canopy is mapped to a 4.57 m minimum, so lower cells are street or roof.
const CROWN_FLOOR_METERS: f64 = 0.5;

/// Below the lowest dry land (about -430 m) is nodata; also the datum, so sub-sea ground reads.
const ELEVATION_FLOOR_METERS: f64 = -1_000.0;

/// How a mosaic cell is read: the band it must fall in and the datum its decimeters count from.
#[derive(Clone, Copy)]
pub struct Quantity {
    /// A cell at or below this carries no measurement.
    floor_meters: f64,
    /// A cell above this is a source defect.
    ceiling_meters: f64,
    /// What a stored decimeter counts from; floor to ceiling must fit u16 decimeters (6553.4 m).
    datum_meters: f64,
}

impl Quantity {
    /// A height above ground, dropped above `ceiling_meters`.
    pub const fn above_ground(ceiling_meters: f64) -> Quantity {
        Quantity {
            floor_meters: ABOVE_GROUND_FLOOR_METERS,
            ceiling_meters,
            datum_meters: 0.0,
        }
    }

    /// A crown height: a height above ground on the canopy's own floor.
    const fn crown() -> Quantity {
        Quantity {
            floor_meters: CROWN_FLOOR_METERS,
            ceiling_meters: IMPLAUSIBLE_CROWN_METERS,
            datum_meters: 0.0,
        }
    }

    /// An elevation above sea level, dropped above the highest ground the city could stand on.
    pub const fn elevation(ceiling_meters: f64) -> Quantity {
        Quantity {
            floor_meters: ELEVATION_FLOOR_METERS,
            ceiling_meters,
            datum_meters: ELEVATION_FLOOR_METERS,
        }
    }

    /// A raster value in stored decimeters, or `None` outside the band (NaN included).
    fn decimeters(self, value: f32) -> Option<u16> {
        let meters = f64::from(value);
        (meters > self.floor_meters && meters <= self.ceiling_meters)
            // Rounded: 21.3 m arrives as float32 21.299999 and truncation loses a decimeter.
            .then_some(((meters - self.datum_meters) * 10.0).round() as u16)
    }

    /// Stored decimeters back to meters.
    pub fn meters(self, decimeters: u16) -> f64 {
        f64::from(decimeters) / 10.0 + self.datum_meters
    }
}

// GRS80. A raster's tags carry no CRS, so each city names its projection.
const SEMI_MAJOR_METERS: f64 = 6_378_137.0;
const INVERSE_FLATTENING: f64 = 298.257222101;

/// A transverse Mercator on GRS80.
#[derive(Clone, Copy)]
pub struct Tmerc {
    central_meridian: f64,
    /// The parallel the northing is measured from; zero for a UTM zone.
    lat_origin: f64,
    scale_factor: f64,
    false_easting: f64,
    false_northing: f64,
}

/// NAD83(2011) / UTM zone 18N — EPSG:6347, the CHM of Ma et al. 2023.
pub const UTM_18N: Tmerc = Tmerc {
    central_meridian: -75.0,
    lat_origin: 0.0,
    scale_factor: 0.9996,
    false_easting: 500_000.0,
    false_northing: 0.0,
};

/// NAD83 / UTM zone 10N, EPSG:26910, the East Bay's staged 1 m DEM; same numbers as NAD83(2011).
pub const UTM_10N: Tmerc = Tmerc {
    central_meridian: -123.0,
    lat_origin: 0.0,
    scale_factor: 0.9996,
    false_easting: 500_000.0,
    false_northing: 0.0,
};

/// NAD83(2011) / San Francisco CS13 — EPSG:7131, the 3DEP topographic COGs.
pub const SF_CS13: Tmerc = Tmerc {
    central_meridian: -122.45,
    lat_origin: 37.75,
    scale_factor: 1.000007,
    false_easting: 48_000.0,
    false_northing: 24_000.0,
};

/// The one table resolving a CRS name, so the graph's relief and the terrain overlay can't disagree.
pub fn projection(name: &str) -> crate::Fallible<Tmerc> {
    match name {
        "sf-cs13" => Ok(SF_CS13),
        "utm10n" => Ok(UTM_10N),
        "utm18n" => Ok(UTM_18N),
        other => Err(format!("unknown projection {other}").into()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    polygons: usize,
    measured: usize,      // polygons the CHM had at least one cell for
    skipped_tiles: usize, // raster tiles whose LZW stream would not decode
}

type Chm = Decoder<BufReader<File>>;

fn open(path: &Path) -> Fallible<Chm> {
    Ok(Decoder::new(BufReader::new(File::open(path)?))?)
}

/// The meridional arc from the equator to `phi`, the series Snyder's projection is built on.
fn meridian_arc(phi: f64, eccentricity2: f64) -> f64 {
    SEMI_MAJOR_METERS
        * ((1.0
            - eccentricity2 / 4.0
            - 3.0 * eccentricity2 * eccentricity2 / 64.0
            - 5.0 * eccentricity2 * eccentricity2 * eccentricity2 / 256.0)
            * phi
            - (3.0 * eccentricity2 / 8.0
                + 3.0 * eccentricity2 * eccentricity2 / 32.0
                + 45.0 * eccentricity2 * eccentricity2 * eccentricity2 / 1024.0)
                * (2.0 * phi).sin()
            + (15.0 * eccentricity2 * eccentricity2 / 256.0
                + 45.0 * eccentricity2 * eccentricity2 * eccentricity2 / 1024.0)
                * (4.0 * phi).sin()
            - (35.0 * eccentricity2 * eccentricity2 * eccentricity2 / 3072.0) * (6.0 * phi).sin())
}

impl Tmerc {
    /// Snyder's series, forward: degrees to grid meters, good to millimeters near the central meridian.
    pub fn forward(&self, lng: f64, lat: f64) -> (f64, f64) {
        let flattening = 1.0 / INVERSE_FLATTENING;
        let eccentricity2 = flattening * (2.0 - flattening);
        let second2 = eccentricity2 / (1.0 - eccentricity2);
        let phi = lat.to_radians();
        let (sin_phi, cos_phi) = phi.sin_cos();
        let tan_phi = sin_phi / cos_phi;
        let curvature = SEMI_MAJOR_METERS / (1.0 - eccentricity2 * sin_phi * sin_phi).sqrt();
        let tan2 = tan_phi * tan_phi;
        let eta2 = second2 * cos_phi * cos_phi;
        let east = (lng - self.central_meridian).to_radians() * cos_phi;
        let east2 = east * east;
        let meridian = meridian_arc(phi, eccentricity2)
            - meridian_arc(self.lat_origin.to_radians(), eccentricity2);
        let easting = self.scale_factor
            * curvature
            * (east
                + (1.0 - tan2 + eta2) * east * east2 / 6.0
                + (5.0 - 18.0 * tan2 + tan2 * tan2 + 72.0 * eta2 - 58.0 * second2)
                    * east
                    * east2
                    * east2
                    / 120.0)
            + self.false_easting;
        let northing = self.scale_factor
            * (meridian
                + curvature
                    * tan_phi
                    * (east2 / 2.0
                        + (5.0 - tan2 + 9.0 * eta2 + 4.0 * eta2 * eta2) * east2 * east2 / 24.0
                        + (61.0 - 58.0 * tan2 + tan2 * tan2 + 600.0 * eta2 - 330.0 * second2)
                            * east2
                            * east2
                            * east2
                            / 720.0))
            + self.false_northing;
        (easting, northing)
    }
}

/// The raster's shape and georeferencing; the origin is pixel (0, 0)'s upper-left corner.
struct Grid {
    width: usize,
    height: usize,
    tile: usize,
    tiles_across: usize,
    bands: usize, // rows of tiles, each decoded and rasterized as one unit
    origin_x: f64,
    origin_y: f64,
    cell: f64,
    projection: Tmerc,
}

impl Grid {
    /// Continuous pixel coordinates, so the center of pixel (col, row) is (col + 0.5, row + 0.5).
    fn pixel(&self, lng: f64, lat: f64) -> (f64, f64) {
        let (x, y) = self.projection.forward(lng, lat);
        (
            (x - self.origin_x) / self.cell,
            (self.origin_y - y) / self.cell,
        )
    }
}

/// One mosaic tile row, so most tiles land in a single band and are decoded once.
const MOSAIC_BAND_ROWS: usize = 500;

/// One grid spanning a mosaic's tiles, checked to share a cell size and whole-cell alignment.
fn mosaic_grid(tiles: &[TileGrid], projection: Tmerc) -> Fallible<Grid> {
    let first = tiles.first().ok_or("a canopy mosaic with no tiles")?;
    let cell = first.cell;
    let (mut min_x, mut max_x) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut min_y, mut max_y) = (f64::INFINITY, f64::NEG_INFINITY);
    for tile in tiles {
        if tile.cell != cell {
            return Err(format!(
                "{}: {} m cells against the mosaic's {cell} m",
                tile.path.display(),
                tile.cell
            )
            .into());
        }
        min_x = min_x.min(tile.min_x());
        max_x = max_x.max(tile.max_x());
        min_y = min_y.min(tile.min_y());
        max_y = max_y.max(tile.max_y());
    }
    // A tile off the shared grid would smear its readings by a fraction of a cell.
    for tile in tiles {
        let column = (tile.min_x() - min_x) / cell;
        let row = (max_y - tile.max_y()) / cell;
        if (column - column.round()).abs() > 1e-6 || (row - row.round()).abs() > 1e-6 {
            return Err(format!(
                "{}: sits at ({column}, {row}) cells from the mosaic's origin, not on its grid",
                tile.path.display()
            )
            .into());
        }
    }
    let width = ((max_x - min_x) / cell).round() as usize;
    let height = ((max_y - min_y) / cell).round() as usize;
    Ok(Grid {
        width,
        height,
        tile: MOSAIC_BAND_ROWS,
        tiles_across: width.div_ceil(MOSAIC_BAND_ROWS),
        bands: height.div_ceil(MOSAIC_BAND_ROWS),
        origin_x: min_x,
        origin_y: max_y,
        cell,
        projection,
    })
}

fn read_grid(decoder: &mut Chm, projection: Tmerc) -> Fallible<Grid> {
    let (width, height) = decoder.dimensions()?;
    let (tile_width, tile_height) = decoder.chunk_dimensions();
    let scale = decoder.get_tag_f64_vec(Tag::ModelPixelScaleTag)?;
    let tie = decoder.get_tag_f64_vec(Tag::ModelTiepointTag)?;
    // Only a tie at the origin and square cells make the pixel map a division, not an affine transform.
    if scale.len() < 2 || tie.len() < 6 || tie[..3] != [0.0, 0.0, 0.0] || scale[0] != scale[1] {
        return Err(format!(
            "the CHM is not an axis-aligned raster tied at its origin (scale {scale:?}, tie point {tie:?})"
        )
        .into());
    }
    if tile_width != tile_height {
        return Err(
            format!("the CHM's tiles are {tile_width} by {tile_height}, not square").into(),
        );
    }
    let tile = tile_width as usize;
    Ok(Grid {
        width: width as usize,
        height: height as usize,
        tile,
        tiles_across: (width as usize).div_ceil(tile),
        bands: (height as usize).div_ceil(tile),
        origin_x: tie[3],
        origin_y: tie[4],
        cell: scale[0],
        projection,
    })
}

/// Polygons in pixel space: `polygon_starts` indexes `ring_starts`, which indexes the coordinates.
struct Shapes {
    xs: Vec<f64>,
    ys: Vec<f64>,
    ring_starts: Vec<u32>,
    polygon_starts: Vec<u32>,
    first_rows: Vec<u32>, // per polygon, clamped to the raster
    last_rows: Vec<u32>,
}

fn project(polygons: &[Polygon], grid: &Grid) -> Shapes {
    let mut shapes = Shapes {
        xs: Vec::new(),
        ys: Vec::new(),
        ring_starts: Vec::new(),
        polygon_starts: Vec::with_capacity(polygons.len() + 1),
        first_rows: Vec::with_capacity(polygons.len()),
        last_rows: Vec::with_capacity(polygons.len()),
    };
    for polygon in polygons {
        shapes.polygon_starts.push(shapes.ring_starts.len() as u32);
        let mut lowest = f64::INFINITY;
        let mut highest = f64::NEG_INFINITY;
        let mut leftmost = f64::INFINITY;
        let mut rightmost = f64::NEG_INFINITY;
        for ring in polygon {
            shapes.ring_starts.push(shapes.xs.len() as u32);
            for point in ring {
                let (x, y) = grid.pixel(point.lng, point.lat);
                lowest = lowest.min(y);
                highest = highest.max(y);
                leftmost = leftmost.min(x);
                rightmost = rightmost.max(x);
                shapes.xs.push(x);
                shapes.ys.push(y);
            }
        }
        // A polygon beside the raster gets an empty row range, so no band scans it.
        let (first, last) = if rightmost < 0.0 || leftmost > grid.width as f64 {
            (0.0, 0.0)
        } else {
            let first = lowest.floor().clamp(0.0, grid.height as f64);
            (first, highest.ceil().clamp(first, grid.height as f64))
        };
        shapes.first_rows.push(first as u32);
        shapes.last_rows.push(last as u32);
    }
    shapes.polygon_starts.push(shapes.ring_starts.len() as u32);
    shapes.ring_starts.push(shapes.xs.len() as u32);
    shapes
}

/// Which polygons reach each band, CSR-style; a polygon spanning two bands is listed in both.
struct Bands {
    starts: Vec<u32>,
    polygons: Vec<u32>,
}

fn bucket_bands(shapes: &Shapes, grid: &Grid) -> Bands {
    let band_of = |row: u32| (row as usize / grid.tile).min(grid.bands - 1);
    let mut counts = vec![0u32; grid.bands + 1];
    for polygon in 0..shapes.first_rows.len() {
        if shapes.last_rows[polygon] > shapes.first_rows[polygon] {
            for band in band_of(shapes.first_rows[polygon])..=band_of(shapes.last_rows[polygon] - 1)
            {
                counts[band + 1] += 1;
            }
        }
    }
    for band in 0..grid.bands {
        counts[band + 1] += counts[band];
    }
    let mut polygons = vec![0u32; counts[grid.bands] as usize];
    let mut cursor = counts.clone();
    for polygon in 0..shapes.first_rows.len() {
        if shapes.last_rows[polygon] > shapes.first_rows[polygon] {
            for band in band_of(shapes.first_rows[polygon])..=band_of(shapes.last_rows[polygon] - 1)
            {
                polygons[cursor[band] as usize] = polygon as u32;
                cursor[band] += 1;
            }
        }
    }
    Bands {
        starts: counts,
        polygons,
    }
}

/// A worker's band source; the single raster keeps its decoder, sparing a BigTIFF reparse.
enum BandReader<'a> {
    /// Boxed: a BigTIFF decoder is far larger than the mosaic arm.
    Single(Box<Chm>),
    Mosaic {
        tiles: &'a [TileGrid],
        source_band: usize,
        quantity: Quantity,
    },
}

/// One band's readings for one polygon: cells covered, and the heights read there.
struct Reading {
    polygon: u32,
    cells: u32,
    values: Vec<u16>,
}

struct BandResult {
    readings: Vec<Reading>,
    skipped_tiles: usize,
    skipped_cells: u64, // polygon cells in skipped tiles
}

/// One band of a single tiled raster, read chunk by chunk from its own tile grid.
fn fill_single(
    decoder: &mut Chm,
    cells: &mut [u16],
    band: usize,
    grid: &Grid,
    rows: usize,
) -> Fallible<Vec<bool>> {
    let mut skipped = vec![false; grid.tiles_across];
    for (column, failed) in skipped.iter_mut().enumerate() {
        let chunk = (band * grid.tiles_across + column) as u32;
        let (chunk_width, chunk_rows) = decoder.chunk_data_dimensions(chunk);
        let values = match decoder.read_chunk(chunk) {
            Ok(DecodingResult::U16(values)) => values,
            Ok(_) => return Err(format!("CHM tile {chunk} is not 16-bit").into()),
            Err(_) => {
                *failed = true;
                continue;
            }
        };
        let chunk_width = chunk_width as usize;
        for row in 0..(chunk_rows as usize).min(rows) {
            let left = row * grid.width + column * grid.tile;
            cells[left..left + chunk_width]
                .copy_from_slice(&values[row * chunk_width..(row + 1) * chunk_width]);
        }
    }
    Ok(skipped)
}

/// One band of a mosaic, gathered from the tiles reaching its rows and converted to decimeters.
fn fill_mosaic(
    tiles: &[TileGrid],
    source_band: usize,
    quantity: Quantity,
    cells: &mut [u16],
    band: usize,
    grid: &Grid,
    rows: usize,
) -> Fallible<Vec<bool>> {
    let top = band * grid.tile;
    let mut skipped = vec![false; grid.tiles_across];
    for tile in tiles {
        let tile_top = ((grid.origin_y - tile.max_y()) / grid.cell).round() as usize;
        let tile_left = ((tile.min_x() - grid.origin_x) / grid.cell).round() as usize;
        if tile_top >= top + rows || tile_top + tile.height <= top {
            continue;
        }
        let values = match Decoder::new(BufReader::new(File::open(&tile.path)?))
            .and_then(|mut decoder| decoder.read_image())
        {
            Ok(DecodingResult::F32(values)) => values,
            Ok(_) => {
                return Err(format!(
                    "{}: unsupported sample type in a canopy mosaic",
                    tile.path.display()
                )
                .into());
            }
            Err(_) => {
                for column in tile_left / grid.tile..=(tile_left + tile.width - 1) / grid.tile {
                    if let Some(failed) = skipped.get_mut(column) {
                        *failed = true;
                    }
                }
                continue;
            }
        };
        let from = top.saturating_sub(tile_top);
        let to = tile.height.min(top + rows - tile_top);
        for row in from..to {
            let left = (tile_top + row - top) * grid.width + tile_left;
            for column in 0..tile.width {
                let value = values[(row * tile.width + column) * tile.bands + source_band];
                if let Some(sample) = quantity.decimeters(value) {
                    cells[left + column] = sample;
                }
            }
        }
    }
    Ok(skipped)
}

// Fills each polygon even-odd at cell centers: crossings at y = row + 0.5, spans over x = col + 0.5.
fn sample_band(
    source: &mut BandReader<'_>,
    cells: &mut [u16],
    band: usize,
    grid: &Grid,
    shapes: &Shapes,
    bands: &Bands,
) -> Fallible<BandResult> {
    let top = band * grid.tile;
    let rows = (grid.height - top).min(grid.tile);
    cells[..rows * grid.width].fill(NODATA);
    let skipped = match source {
        BandReader::Single(decoder) => fill_single(decoder, cells, band, grid, rows)?,
        BandReader::Mosaic {
            tiles,
            source_band,
            quantity,
        } => fill_mosaic(tiles, *source_band, *quantity, cells, band, grid, rows)?,
    };

    let mut result = BandResult {
        readings: Vec::new(),
        skipped_tiles: skipped.iter().filter(|failed| **failed).count(),
        skipped_cells: 0,
    };
    let mut crossings: Vec<f64> = Vec::new();
    for polygon in &bands.polygons[bands.starts[band] as usize..bands.starts[band + 1] as usize] {
        let polygon = *polygon as usize;
        let first_ring = shapes.polygon_starts[polygon] as usize;
        let last_ring = shapes.polygon_starts[polygon + 1] as usize;
        let mut reading = Reading {
            polygon: polygon as u32,
            cells: 0,
            values: Vec::new(),
        };
        let from_row = (shapes.first_rows[polygon] as usize).max(top);
        let to_row = (shapes.last_rows[polygon] as usize).min(top + rows);
        for row in from_row..to_row {
            let scan = row as f64 + 0.5;
            crossings.clear();
            for ring in first_ring..last_ring {
                let from = shapes.ring_starts[ring] as usize;
                let to = shapes.ring_starts[ring + 1] as usize;
                let (xs, ys) = (&shapes.xs[from..to], &shapes.ys[from..to]);
                let mut previous = xs.len() - 1;
                for index in 0..xs.len() {
                    if (ys[previous] <= scan) != (ys[index] <= scan) {
                        let along = (scan - ys[previous]) / (ys[index] - ys[previous]);
                        crossings.push(xs[previous] + along * (xs[index] - xs[previous]));
                    }
                    previous = index;
                }
            }
            crossings.sort_by(f64::total_cmp);
            for pair in crossings.as_chunks::<2>().0 {
                let from = (pair[0] - 0.5).ceil().max(0.0) as usize;
                let to = ((pair[1] - 0.5).ceil().max(0.0) as usize).min(grid.width);
                for column in from..to {
                    reading.cells += 1;
                    let value = cells[(row - top) * grid.width + column];
                    if value != NODATA {
                        reading.values.push(value);
                    } else if skipped[column / grid.tile] {
                        result.skipped_cells += 1;
                    }
                }
            }
        }
        if reading.cells > 0 {
            result.readings.push(reading);
        }
    }
    Ok(result)
}

fn sample(
    source: &Source,
    tiles: &[TileGrid],
    quantity: Quantity,
    grid: &Grid,
    shapes: &Shapes,
    bands: &Bands,
    started: Instant,
) -> Fallible<Vec<BandResult>> {
    let done = AtomicUsize::new(0);
    (0..grid.bands)
        .into_par_iter()
        .map_init(
            // One reader and one band buffer per worker; the buffer is a few tens of megabytes.
            || {
                let reader = match source {
                    Source::Single(path) => open(path)
                        .ok()
                        .map(|decoder| BandReader::Single(Box::new(decoder))),
                    Source::Mosaic { band, .. } => Some(BandReader::Mosaic {
                        tiles,
                        source_band: *band,
                        quantity,
                    }),
                };
                (reader, vec![NODATA; grid.width * grid.tile])
            },
            |(reader, cells), band| {
                let reader = reader
                    .as_mut()
                    .ok_or_else(|| "the canopy height raster could not be reopened".to_string())?;
                let result = sample_band(reader, cells, band, grid, shapes, bands)?;
                let finished = done.fetch_add(1, Ordering::Relaxed) + 1;
                if finished.is_multiple_of(PROGRESS_BANDS) {
                    eprintln!(
                        "  [{:>5.1}s] {finished}/{} raster bands sampled",
                        started.elapsed().as_secs_f64(),
                        grid.bands
                    );
                }
                Ok(result)
            },
        )
        .collect()
}

/// The height at which the polygons no taller than it first hold `quantile` of the measured area.
fn area_quantile(sorted: &[(f64, u64)], area: u64, quantile: f64) -> f64 {
    let target = (area as f64 * quantile) as u64;
    let mut seen = 0;
    for (height, weight) in sorted {
        seen += weight;
        if seen >= target {
            return *height;
        }
    }
    sorted.last().map_or(0.0, |(height, _)| *height)
}

fn describe(heights_m: &[f64], areas: &[u32]) -> usize {
    let mut measured: Vec<(f64, u64)> = heights_m
        .iter()
        .zip(areas)
        .filter(|(height, _)| **height > 0.0)
        .map(|(height, area)| (*height, u64::from(*area)))
        .collect();
    measured.sort_by(|left, right| left.0.total_cmp(&right.0));
    let total: u64 = areas.iter().map(|area| u64::from(*area)).sum();
    let area: u64 = measured.iter().map(|(_, weight)| weight).sum();
    eprintln!(
        "  {} of {} polygons ({:.2}%) carry a measured height, over {:.2} km2 of {:.2} km2 of polygon area ({:.2}%)",
        measured.len(),
        heights_m.len(),
        100.0 * measured.len() as f64 / heights_m.len() as f64,
        area as f64 / 1e6,
        total as f64 / 1e6,
        100.0 * area as f64 / total as f64
    );
    if !measured.is_empty() {
        let quartiles: Vec<f64> = [0.25, 0.5, 0.75]
            .iter()
            .map(|quantile| area_quantile(&measured, area, *quantile))
            .collect();
        let tall: u64 = measured
            .iter()
            .filter(|(height, _)| *height > TALL_METERS)
            .map(|(_, weight)| weight)
            .sum();
        eprintln!(
            "  area-weighted height: median {:.1} m, IQR {:.1}-{:.1} m ({:.1} m), {:.2}% of it above {TALL_METERS:.0} m",
            quartiles[1],
            quartiles[0],
            quartiles[2],
            quartiles[2] - quartiles[0],
            100.0 * tall as f64 / area as f64
        );
        // The upper tail, where a canopy polygon straying onto a roof shows.
        let implausible: u64 = measured
            .iter()
            .filter(|(height, _)| *height > IMPLAUSIBLE_CROWN_METERS)
            .map(|(_, weight)| weight)
            .sum();
        eprintln!(
            "  upper tail: p95 {:.1} m, p99 {:.1} m, max {:.1} m, {:.4}% of area above {IMPLAUSIBLE_CROWN_METERS:.0} m",
            area_quantile(&measured, area, 0.95),
            area_quantile(&measured, area, 0.99),
            measured.last().map_or(0.0, |(height, _)| *height),
            100.0 * implausible as f64 / area as f64
        );
    }
    measured.len()
}

/// A raster's readings per polygon in sorted decimeters, and the cells each covered.
pub struct Measured {
    pub values: Vec<Vec<u16>>,
    pub cells: Vec<u32>,
    pub skipped_tiles: usize,
}

/// Nearest-rank percentile, or 0 (unknown) for a polygon that caught no cell.
pub fn percentile_dm(sorted: &[u16], quantile: f64) -> u16 {
    let rank = (sorted.len() as f64 * quantile).ceil() as usize;
    sorted.get(rank.max(1) - 1).copied().unwrap_or(0)
}

/// Every polygon's readings from one raster; `quantity` decides what a mosaic cell reads as.
pub fn measure(
    polygons: &[Polygon],
    raster: &Source,
    projection: Tmerc,
    quantity: Quantity,
) -> Fallible<Measured> {
    let started = Instant::now();
    let tiles: Vec<TileGrid> = match raster {
        Source::Single(_) => Vec::new(),
        Source::Mosaic { paths, .. } => paths
            .iter()
            .map(|path| read_tile_grid(path))
            .collect::<Fallible<Vec<TileGrid>>>()?,
    };
    let grid = match raster {
        Source::Single(path) => read_grid(&mut open(path)?, projection)?,
        Source::Mosaic { .. } => mosaic_grid(&tiles, projection)?,
    };
    eprintln!(
        "  [{:>5.1}s] {} polygons against a {} x {} raster of {} m cells{}",
        started.elapsed().as_secs_f64(),
        polygons.len(),
        grid.width,
        grid.height,
        grid.cell,
        match raster {
            Source::Single(_) => String::new(),
            Source::Mosaic { paths, band } =>
                format!(", mosaicked from {} tiles at band {band}", paths.len()),
        }
    );

    let shapes = project(polygons, &grid);
    let bands = bucket_bands(&shapes, &grid);
    eprintln!(
        "  [{:>5.1}s] {} vertices projected into the raster's grid",
        started.elapsed().as_secs_f64(),
        shapes.xs.len()
    );

    let sampled = sample(raster, &tiles, quantity, &grid, &shapes, &bands, started)?;
    let mut cells = vec![0u32; polygons.len()];
    let mut values: Vec<Vec<u16>> = vec![Vec::new(); polygons.len()];
    let mut skipped_tiles = 0;
    let mut skipped_cells = 0;
    for band in sampled {
        skipped_tiles += band.skipped_tiles;
        skipped_cells += band.skipped_cells;
        for reading in band.readings {
            let polygon = reading.polygon as usize;
            cells[polygon] += reading.cells;
            values[polygon].extend(reading.values);
        }
    }
    eprintln!(
        "  [{:>5.1}s] {skipped_tiles} raster tiles would not decode, holding {skipped_cells} polygon cells",
        started.elapsed().as_secs_f64()
    );
    for sample in &mut values {
        sample.sort_unstable();
    }
    Ok(Measured {
        values,
        cells,
        skipped_tiles,
    })
}

pub fn run(args: &Args) -> Fallible<Report> {
    let started = Instant::now();
    let mut canopy = binfmt::read_canopy(&args.canopy)?;
    let mut heights = vec![0u16; canopy.polygons.len()];
    // Per polygon, the most cells any raster laid over it: its area, for weighting the summary.
    let mut covered = vec![0u32; canopy.polygons.len()];
    // The most cells any raster read decides the height, as a raster over a gap covers but reads none.
    let mut read = vec![0usize; canopy.polygons.len()];
    let mut skipped_tiles = 0;
    for raster in &args.rasters {
        let sampled = measure(
            &canopy.polygons,
            &raster.source,
            raster.projection,
            Quantity::crown(),
        )?;
        skipped_tiles += sampled.skipped_tiles;
        for (polygon, sample) in sampled.values.iter().enumerate() {
            covered[polygon] = covered[polygon].max(sampled.cells[polygon]);
            if sample.len() > read[polygon] {
                read[polygon] = sample.len();
                heights[polygon] = percentile_dm(sample, HEIGHT_PERCENTILE);
            }
        }
    }
    canopy.set_heights_dm(&heights);
    fs::write(&args.canopy, &canopy.bytes)?;
    let measured = describe(&canopy.heights_m(), &covered);
    eprintln!(
        "  [{:>5.1}s] wrote {}",
        started.elapsed().as_secs_f64(),
        args.canopy.display()
    );

    Ok(Report {
        polygons: canopy.polygons.len(),
        measured,
        skipped_tiles,
    })
}

#[cfg(test)]
mod tests {
    use super::{HEIGHT_PERCENTILE, Quantity, SF_CS13, Tmerc, UTM_10N, UTM_18N, percentile_dm};

    /// Decimeters are what the publisher wrote, not float32 truncation.
    #[test]
    fn a_cell_on_a_decimeter_reads_that_decimeter() {
        let crown = Quantity::crown();
        assert_eq!(crown.decimeters(21.30), Some(213));
        assert_eq!(crown.decimeters(6.0), Some(60));
        assert_eq!(Quantity::elevation(4_000.0).decimeters(-2.5), Some(9975));
    }

    /// A crown polygon's ring can enclose the street it overhangs, and those cells are ground.
    #[test]
    fn a_crowns_ground_cells_are_not_sampled() {
        let crown = Quantity::crown();
        let mut sample: Vec<u16> = [0.06f32, 0.1, 5.9, 6.0, 6.2]
            .into_iter()
            .filter_map(|cell| crown.decimeters(cell))
            .collect();
        assert_eq!(sample, vec![59, 60, 62]);
        sample.sort_unstable();
        assert_eq!(percentile_dm(&sample, HEIGHT_PERCENTILE), 62);
    }

    /// An elevation survives being negative or near zero; a height above ground does not.
    #[test]
    fn ground_at_the_tide_line_is_a_reading_and_a_crown_there_is_not() {
        let crown = Quantity::above_ground(65.0);
        let ground = Quantity::elevation(4_000.0);
        assert_eq!(crown.decimeters(0.04), None);
        assert_eq!(crown.decimeters(65.1), None);
        let shore = ground.decimeters(0.04).expect("the tide line is ground");
        assert!(ground.meters(shore).abs() < 0.05);
        let under = ground
            .decimeters(-2.5)
            .expect("ground under sea level is ground");
        assert!((ground.meters(under) + 2.5).abs() < 0.05);
        assert_eq!(ground.decimeters(-9999.0), None);
        assert_eq!(ground.decimeters(f32::NAN), None);
    }

    /// A grid origin maps to its false origin, which catches a dropped meridional arc term.
    #[test]
    fn a_grid_origin_lands_on_its_false_origin() {
        for (grid, lng, lat, east, north) in [
            (UTM_18N, -75.0, 0.0, 500_000.0, 0.0),
            (UTM_10N, -123.0, 0.0, 500_000.0, 0.0),
            (SF_CS13, -122.45, 37.75, 48_000.0, 24_000.0),
        ] {
            let (x, y) = grid.forward(lng, lat);
            assert!((x - east).abs() < 1e-3, "easting {x} not {east}");
            assert!((y - north).abs() < 1e-3, "northing {y} not {north}");
        }
    }

    /// 3DEP tile B23_05200290's upper-left corner is CS13 (52000, 29500), per its STAC entry.
    #[test]
    fn sf_cs13_agrees_with_a_published_tile() {
        let (x, y) = SF_CS13.forward(-122.404_585_177_429_87, 37.799_543_921_926_79);
        assert!((x - 52_000.0).abs() < 0.5, "easting {x} not 52000");
        assert!((y - 29_500.0).abs() < 0.5, "northing {y} not 29500");
    }

    /// DEM tile USGS_1M_10_x56y419's corner (559994, 4190006), placed by PROJ's EPSG:26910.
    #[test]
    fn utm_10n_agrees_with_a_published_tile() {
        let (x, y) = UTM_10N.forward(-122.318_015_920_842_7, 37.855_538_216_934_55);
        assert!((x - 559_994.0).abs() < 0.5, "easting {x} not 559994");
        assert!((y - 4_190_006.0).abs() < 0.5, "northing {y} not 4190006");
    }

    /// Unit scale, no offsets: zero easting on the central meridian, so a false-origin sign slip shows.
    #[test]
    fn the_central_meridian_carries_no_easting_offset() {
        let plain = Tmerc {
            central_meridian: -122.45,
            lat_origin: 0.0,
            scale_factor: 1.0,
            false_easting: 0.0,
            false_northing: 0.0,
        };
        let (x, _) = plain.forward(-122.45, 37.75);
        assert!(x.abs() < 1e-6, "easting {x} not 0 on the central meridian");
    }
}

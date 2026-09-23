//! The elevation overlay: height in the city's range (R), relief shade (G), ground share (alpha).

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use rayon::prelude::*;

use crate::Fallible;
use crate::binfmt::{self, LAND_FORMAT};
use crate::dem::{Dem, Field, resample};
use crate::geometry::PolygonIndex;
use crate::manifest::{Bounds, Manifest};
use crate::raster::{
    MIN_ZOOM, TILE_SIZE, Tile, encode_webp_lossless, pixel_x_to_lng, pixel_y_to_lat, plan_tiles,
};

/// The finest baked level, ~2.4 m a pixel; any coarser shows the land mask's staircase shore.
pub const ELEVATION_MAX_ZOOM: u32 = 16;

pub struct Args {
    pub manifest: PathBuf,
    pub tiles: PathBuf,
    pub city: String,
    /// The city's land polygons: 3DEP returns a surface over water, which would read as ground.
    pub land: PathBuf,
}

/// A relief shade lit from the north-west at 45 degrees; light from below reads inverted.
fn hillshade(field: &Field, lng: f64, lat: f64, meters_per_degree_lat: f64) -> f32 {
    let east = field.sample(lng + field.step_lng(), lat);
    let west = field.sample(lng - field.step_lng(), lat);
    let north = field.sample(lng, lat + field.step_lat());
    let south = field.sample(lng, lat - field.step_lat());
    if !east.is_finite() || !west.is_finite() || !north.is_finite() || !south.is_finite() {
        return 1.0;
    }
    let run_x = 2.0 * field.step_lng() * meters_per_degree_lat * lat.to_radians().cos();
    let run_y = 2.0 * field.step_lat() * meters_per_degree_lat;
    let slope_x = f64::from(east - west) / run_x;
    let slope_y = f64::from(north - south) / run_y;
    // The normal against a (-1, 1, 1)/sqrt(3) light, compressed so dark faces keep their tint.
    let light = (slope_x - slope_y + 1.0)
        / (slope_x * slope_x + slope_y * slope_y + 1.0).sqrt()
        / 3.0_f64.sqrt();
    (0.65 + 0.5 * light.clamp(-1.0, 1.0)) as f32
}

/// Sub-samples per axis when deciding how much of a pixel is ground.
const COVERAGE_SAMPLES: usize = 4;

/// A [0, 1] field as the byte the tile stores it in.
fn byte(fraction: f32) -> u8 {
    (fraction * 255.0).round() as u8
}

/// How much of one tile pixel stands on ground, 0 to 1.
fn pixel_coverage(field: &Field, lng: f64, lat: f64, zoom: u32) -> f32 {
    // The pixel's span from the tile grid, which differs from the field's step past its resolution.
    let span_lng = 360.0 / (f64::from(1u32 << zoom) * TILE_SIZE as f64);
    let span_lat = span_lng * lat.to_radians().cos();
    let mut total = 0.0;
    for row in 0..COVERAGE_SAMPLES {
        let offset_lat = (row as f64 + 0.5) / COVERAGE_SAMPLES as f64 - 0.5;
        for column in 0..COVERAGE_SAMPLES {
            let offset_lng = (column as f64 + 0.5) / COVERAGE_SAMPLES as f64 - 0.5;
            total += field.coverage(lng + offset_lng * span_lng, lat + offset_lat * span_lat);
        }
    }
    total / (COVERAGE_SAMPLES * COVERAGE_SAMPLES) as f32
}

const METERS_PER_DEGREE_LAT: f64 = 111_320.0;

/// The largest `hillshade` value; sync with `reliefScale` in src/theme/palette.ts.
const HILLSHADE_MAX: f32 = 1.15;

// Ground past the land polygons (piers): within a pier's reach, above the ~1.8 m MHHW water.
const SHORE_REACH_METERS: f64 = 300.0;
const DECK_METERS: f32 = 2.5;

/// A city's box pushed out by a distance on every side.
fn widen(bounds: &Bounds, meters: f64) -> Bounds {
    let lat = (bounds.north - bounds.south) / 2.0 + bounds.south;
    let north_south = meters / METERS_PER_DEGREE_LAT;
    let east_west = north_south / lat.to_radians().cos();
    Bounds {
        south: bounds.south - north_south,
        west: bounds.west - east_west,
        north: bounds.north + north_south,
        east: bounds.east + east_west,
    }
}

fn render(field: &Field, directory: &std::path::Path, tile: &Tile) -> Fallible<u64> {
    let mut pixels = vec![0u8; TILE_SIZE * TILE_SIZE * 4];
    let mut painted = false;
    let range = (field.high() - field.low()).max(1.0);
    for row in 0..TILE_SIZE {
        let lat = pixel_y_to_lat(
            (tile.y as f64 * TILE_SIZE as f64) + row as f64 + 0.5,
            tile.zoom,
        );
        for column in 0..TILE_SIZE {
            let lng = pixel_x_to_lng(
                (tile.x as f64 * TILE_SIZE as f64) + column as f64 + 0.5,
                tile.zoom,
            );
            let value = field.sample(lng, lat);
            if !value.is_finite() {
                continue;
            }
            // Averaged across the pixel so the shore gets a fractional edge, not a staircase.
            let coverage = pixel_coverage(field, lng, lat, tile.zoom);
            if coverage <= 0.0 {
                continue;
            }
            let shade = hillshade(field, lng, lat, METERS_PER_DEGREE_LAT);
            let pixel = (row * TILE_SIZE + column) * 4;
            // Height across the city's range, relief shade, and ground share; blue is unused.
            pixels[pixel] = byte(((value - field.low()) / range).clamp(0.0, 1.0));
            pixels[pixel + 1] = byte((shade / HILLSHADE_MAX).clamp(0.0, 1.0));
            pixels[pixel + 3] = byte(coverage);
            painted = true;
        }
    }
    // A tile with no ground is not written; the client reads the 404 as transparent.
    if !painted {
        return Ok(0);
    }
    // Lossless: lossy WebP keeps chroma at quarter resolution, and R and G carry data.
    let bytes = encode_webp_lossless(&pixels);
    fs::write(
        directory
            .join(tile.zoom.to_string())
            .join(tile.x.to_string())
            .join(format!("{}.webp", tile.y)),
        &bytes,
    )?;
    Ok(bytes.len() as u64)
}

/// `dem` is borrowed because the graph pass resamples the same mosaic for its relief byte.
pub fn run(args: &Args, dem: &mut Dem) -> Fallible<()> {
    let started = Instant::now();
    let mut manifest: Manifest = serde_json::from_slice(&fs::read(&args.manifest)?)?;
    manifest.cities.retain(|city| city.id == args.city);
    if manifest.cities.is_empty() {
        return Err(format!("no city {} in the manifest", args.city).into());
    }
    eprintln!("{}: {} DEM tiles", args.city, dem.tiles());
    // Widened by the mask's reach, since the city's bounds end where the shoreline polygons do.
    manifest.cities[0].bounds = widen(&manifest.cities[0].bounds, SHORE_REACH_METERS);
    let mut field = resample(&manifest.cities[0].bounds, ELEVATION_MAX_ZOOM, dem)?;
    // The decoded tile is a city of float32 at one meter; nothing below reads the mosaic again.
    dem.release();

    // Water dropped so the hillshade never differences shore against sea.
    let land = binfmt::read_polygons(&args.land, "LAND", LAND_FORMAT)?;
    let mut on_land = PolygonIndex::new(&land);
    let wet = field.retain(SHORE_REACH_METERS, DECK_METERS, |lng, lat| {
        on_land.contains(lng, lat)
    });
    eprintln!(
        "{}: {wet} field cells dropped as water, ground now {:.0} m to {:.0} m",
        args.city,
        field.low(),
        field.high()
    );

    let root = args.tiles.join("elevation").join(&args.city);
    let plan = plan_tiles(&manifest.cities, ELEVATION_MAX_ZOOM);
    for tile in &plan {
        fs::create_dir_all(root.join(tile.zoom.to_string()).join(tile.x.to_string()))?;
    }
    // The tint is stretched over the city's range, so the range travels with the tiles.
    fs::write(
        root.join("range.json"),
        serde_json::to_vec(&serde_json::json!({
            "lowMeters": field.low(),
            "highMeters": field.high(),
        }))?,
    )?;
    let bytes: u64 = plan
        .par_iter()
        .map(|tile| render(&field, &root, tile))
        .try_reduce(|| 0, |left, right| Ok(left + right))?;

    eprintln!(
        "{}: wrote {} elevation tiles (z{MIN_ZOOM}-z{ELEVATION_MAX_ZOOM}, {:.1} MiB) in {:.1}s",
        args.city,
        plan.len(),
        bytes as f64 / 1024.0 / 1024.0,
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

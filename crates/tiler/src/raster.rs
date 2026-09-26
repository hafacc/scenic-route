//! Web-mercator projection, tile plan, shoreline land mask and tile encoders.

use std::collections::HashMap;

use crate::Fallible;
use crate::binfmt::Polygon;
use crate::geometry::{self, Projection};
use crate::manifest::{Bounds, City};

pub(crate) const TILE_SIZE: usize = 256;
pub(crate) const MIN_ZOOM: u32 = 9;
pub(crate) const MAX_ZOOM: u32 = 15; // past this the field has no detail left to show; Leaflet upscales
pub(crate) const MIN_ALPHA: u8 = 2; // below this the fill is invisible, and the pixel costs more than it says
pub(crate) const EQUATOR_METERS_PER_PIXEL: f64 = 156_543.033_92; // web mercator, at the equator, at z0
pub(crate) const MIN_FEATHER_PIXELS: f64 = 0.5; // below this the blur has nothing to say and is skipped
const WEBP_QUALITY: f32 = 80.0; // lossy tile color; alpha and the density blobs are untouched
// The shoreline clip, rasterized once; clipping per tile instead costs a quarter of the build.
const LAND_METERS: f64 = 20.0;

/// The land, on a regular LAND_METERS grid in the local meter space.
pub(crate) struct LandMask {
    cells: Vec<u8>,
    cols: usize,
    rows: usize,
    min_x: f64,
    min_y: f64,
}

impl LandMask {
    /// The land column a projected meter x falls in, or None outside the grid.
    pub(crate) fn column(&self, x_meters: f64) -> Option<usize> {
        let col = ((x_meters - self.min_x) / LAND_METERS).floor();
        (col >= 0.0 && col < self.cols as f64).then_some(col as usize)
    }

    /// The row's base offset into `cells` for a projected meter y, or None outside the grid.
    pub(crate) fn row_base(&self, y_meters: f64) -> Option<usize> {
        let row = ((y_meters - self.min_y) / LAND_METERS).floor();
        (row >= 0.0 && row < self.rows as f64).then_some(row as usize * self.cols)
    }

    /// Whether the cell at a row base and column is land.
    pub(crate) fn is_land(&self, row_base: usize, column: usize) -> bool {
        self.cells[row_base + column] != 0
    }
}

/// One tile of the plan: which cities reach it, and where it goes.
pub(crate) struct Tile {
    pub(crate) zoom: u32,
    pub(crate) x: u32,
    pub(crate) y: u32,
    pub(crate) members: Vec<usize>,
}

fn world_size(zoom: u32) -> f64 {
    (TILE_SIZE << zoom) as f64
}

pub(crate) fn lng_to_pixel_x(lng: f64, zoom: u32) -> f64 {
    (lng + 180.0) / 360.0 * world_size(zoom)
}

pub(crate) fn lat_to_pixel_y(lat: f64, zoom: u32) -> f64 {
    let sin = (lat * std::f64::consts::PI / 180.0).sin();
    (0.5 - ((1.0 + sin) / (1.0 - sin)).ln() / (4.0 * std::f64::consts::PI)) * world_size(zoom)
}

pub(crate) fn pixel_x_to_lng(pixel_x: f64, zoom: u32) -> f64 {
    pixel_x / world_size(zoom) * 360.0 - 180.0
}

pub(crate) fn pixel_y_to_lat(pixel_y: f64, zoom: u32) -> f64 {
    let mercator = std::f64::consts::PI * (1.0 - 2.0 * pixel_y / world_size(zoom));
    mercator.sinh().atan() * 180.0 / std::f64::consts::PI
}

pub(crate) fn tile_index(pixel: f64, zoom: u32) -> u32 {
    (pixel / TILE_SIZE as f64)
        .floor()
        .clamp(0.0, f64::from((1u32 << zoom) - 1)) as u32
}

pub(crate) fn rasterize_land(
    land: &[Polygon],
    bounds: &Bounds,
    projection: &Projection,
) -> LandMask {
    let min_x = projection.x(bounds.west);
    let min_y = projection.y(bounds.south);
    let cols = ((projection.x(bounds.east) - min_x) / LAND_METERS).ceil() as usize;
    let rows = ((projection.y(bounds.north) - min_y) / LAND_METERS).ceil() as usize;
    let mut cells = vec![0u8; cols * rows];
    geometry::fill_polygons(
        &mut cells,
        cols,
        rows,
        &geometry::flatten(land),
        bounds,
        |lng, lat| {
            (
                (projection.x(lng) - min_x) / LAND_METERS,
                (projection.y(lat) - min_y) / LAND_METERS,
            )
        },
    );
    LandMask {
        cells,
        cols,
        rows,
        min_x,
        min_y,
    }
}

// Lossy is fine: these tiles are cosmetic, and the densities routing reads live in the .bin blobs.
pub(crate) fn encode_webp(pixels: &[u8]) -> Fallible<Vec<u8>> {
    let encoder = webp::Encoder::from_rgba(pixels, TILE_SIZE as u32, TILE_SIZE as u32);
    Ok(encoder.encode(WEBP_QUALITY).to_vec())
}

/// Lossless WebP for tiles whose channels carry data (genus densities, shade alpha).
pub(crate) fn encode_webp_lossless(pixels: &[u8]) -> Vec<u8> {
    let encoder = webp::Encoder::from_rgba(pixels, TILE_SIZE as u32, TILE_SIZE as u32);
    encoder.encode_lossless().to_vec()
}

/// Tiles are keyed globally so cities sharing one at low zoom paint into the same buffer.
pub(crate) fn plan_tiles(cities: &[City], max_zoom: u32) -> Vec<Tile> {
    let bounds: Vec<Bounds> = cities.iter().map(|city| city.bounds).collect();
    plan_bounds(&bounds, max_zoom)
}

/// `plan_tiles` over each member's bounds, member `index` being `bounds[index]`.
pub(crate) fn plan_bounds(bounds: &[Bounds], max_zoom: u32) -> Vec<Tile> {
    let mut plan: Vec<Tile> = Vec::new();
    let mut seen: HashMap<(u32, u32, u32), usize> = HashMap::new();
    for (index, city) in bounds.iter().enumerate() {
        let Bounds {
            south,
            west,
            north,
            east,
        } = *city;
        for zoom in MIN_ZOOM..=max_zoom {
            let min_x = tile_index(lng_to_pixel_x(west, zoom), zoom);
            let max_x = tile_index(lng_to_pixel_x(east, zoom), zoom);
            let min_y = tile_index(lat_to_pixel_y(north, zoom), zoom);
            let max_y = tile_index(lat_to_pixel_y(south, zoom), zoom);
            for x in min_x..=max_x {
                for y in min_y..=max_y {
                    match seen.get(&(zoom, x, y)) {
                        Some(slot) => plan[*slot].members.push(index),
                        None => {
                            seen.insert((zoom, x, y), plan.len());
                            plan.push(Tile {
                                zoom,
                                x,
                                y,
                                members: vec![index],
                            });
                        }
                    }
                }
            }
        }
    }
    plan
}

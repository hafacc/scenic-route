//! The ground surface: a mosaic of GeoTIFF tiles resampled onto a regular longitude/latitude grid.

use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use tiff::decoder::{Decoder, DecodingResult, Limits};
use tiff::tags::Tag;

use crate::Fallible;
use crate::heights::Tmerc;
use crate::manifest::Bounds;
use crate::raster::{lat_to_pixel_y, lng_to_pixel_x};

/// At or below this is nodata: 3DEP writes -9999 and the canopy models a larger sentinel.
const NODATA_BELOW: f32 = -9000.0;

const METERS_PER_DEGREE_LAT: f64 = 111_320.0;

/// One tile's georeferencing and pixel extent, read from its own tags.
pub struct TileGrid {
    pub path: PathBuf,
    pub width: usize,
    pub height: usize,
    /// Ground coordinate of the upper-left *corner* of pixel (0, 0), in the mosaic's projection.
    pub origin_x: f64,
    pub origin_y: f64,
    pub cell: f64,
    pub bands: usize,
    /// Index into the `Dem`'s mosaics, which gives this tile's projection and band.
    pub mosaic: usize,
}

impl TileGrid {
    pub fn min_x(&self) -> f64 {
        self.origin_x
    }
    pub fn max_x(&self) -> f64 {
        self.origin_x + self.width as f64 * self.cell
    }
    pub fn max_y(&self) -> f64 {
        self.origin_y
    }
    pub fn min_y(&self) -> f64 {
        self.origin_y - self.height as f64 * self.cell
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.min_x() && x < self.max_x() && y > self.min_y() && y <= self.max_y()
    }
}

pub fn read_tile_grid(path: &Path) -> Fallible<TileGrid> {
    let mut decoder = Decoder::new(BufReader::new(File::open(path)?))?;
    let (width, height) = decoder.dimensions()?;
    let scale = decoder.get_tag_f64_vec(Tag::ModelPixelScaleTag)?;
    let tie = decoder.get_tag_f64_vec(Tag::ModelTiepointTag)?;
    if scale.len() < 2 || tie.len() < 6 || tie[..3] != [0.0, 0.0, 0.0] || scale[0] != scale[1] {
        return Err(format!(
            "{}: not an axis-aligned raster tied at its origin (scale {scale:?}, tie {tie:?})",
            path.display()
        )
        .into());
    }
    let bands = decoder
        .get_tag_u32_vec(Tag::SamplesPerPixel)
        .map_or(1, |values| values.first().copied().unwrap_or(1) as usize);
    Ok(TileGrid {
        path: path.to_path_buf(),
        width: width as usize,
        height: height as usize,
        origin_x: tie[3],
        origin_y: tie[4],
        cell: scale[0],
        bands,
        mosaic: 0,
    })
}

/// One survey's tiles, their projection, and the band that carries the surface.
pub struct MosaicTiles {
    pub projection: Tmerc,
    pub band: usize,
    pub paths: Vec<PathBuf>,
}

/// An open mosaic; its tiles live in the `Dem`'s shared list.
struct Mosaic {
    projection: Tmerc,
    band: usize,
    /// Coarse tile index in projected meters; one per mosaic, as meters on two projections don't compare.
    index: HashMap<(i64, i64), Vec<usize>>,
    index_cell: f64,
}

/// A ground surface of one or more mosaics, sampled by longitude and latitude.
pub struct Dem {
    mosaics: Vec<Mosaic>,
    /// Every mosaic's tiles in one list, so a tile position means the same thing everywhere.
    tiles: Vec<TileGrid>,
    /// The one decoded tile; holding a city of float32 would be gigabytes.
    loaded: Option<(usize, Vec<f32>)>,
    pub decoded: usize,
}

impl Dem {
    /// A `Dem` of a single mosaic.
    pub fn open(paths: &[PathBuf], projection: Tmerc, band: usize) -> Fallible<Dem> {
        Dem::open_mosaics(&[MosaicTiles {
            projection,
            band,
            paths: paths.to_vec(),
        }])
    }

    /// Reads and indexes every tile's georeferencing; no pixels are decoded until a resample.
    pub fn open_mosaics(mosaics: &[MosaicTiles]) -> Fallible<Dem> {
        if mosaics.is_empty() {
            return Err("an elevation source with no mosaics".into());
        }
        let mut tiles: Vec<TileGrid> = Vec::new();
        let mut opened: Vec<Mosaic> = Vec::new();
        for (position, mosaic) in mosaics.iter().enumerate() {
            let first = tiles.len();
            for path in &mosaic.paths {
                let mut tile = read_tile_grid(path)?;
                if mosaic.band >= tile.bands {
                    return Err(format!(
                        "{}: band {} asked for, {} in the file",
                        tile.path.display(),
                        mosaic.band,
                        tile.bands
                    )
                    .into());
                }
                tile.mosaic = position;
                tiles.push(tile);
            }
            let own = &tiles[first..];
            if own.is_empty() {
                return Err("an elevation mosaic with no tiles".into());
            }
            // One index cell per largest tile, so no tile spans more cells than it has to.
            let index_cell = own
                .iter()
                .map(|tile| (tile.max_x() - tile.min_x()).max(tile.max_y() - tile.min_y()))
                .fold(1.0_f64, f64::max);
            let mut index: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
            for (offset, tile) in own.iter().enumerate() {
                let x0 = (tile.min_x() / index_cell).floor() as i64;
                let x1 = (tile.max_x() / index_cell).floor() as i64;
                let y0 = (tile.min_y() / index_cell).floor() as i64;
                let y1 = (tile.max_y() / index_cell).floor() as i64;
                for x in x0..=x1 {
                    for y in y0..=y1 {
                        index.entry((x, y)).or_default().push(first + offset);
                    }
                }
            }
            opened.push(Mosaic {
                projection: mosaic.projection,
                band: mosaic.band,
                index,
                index_cell,
            });
        }
        Ok(Dem {
            mosaics: opened,
            tiles,
            loaded: None,
            decoded: 0,
        })
    }

    /// The tile covering a point, without decoding; where surveys overlap, the first mosaic wins.
    pub fn tile_of(&mut self, lng: f64, lat: f64) -> Option<usize> {
        for mosaic in &self.mosaics {
            let (x, y) = mosaic.projection.forward(lng, lat);
            let key = (
                (x / mosaic.index_cell).floor() as i64,
                (y / mosaic.index_cell).floor() as i64,
            );
            let found = mosaic.index.get(&key).and_then(|nearby| {
                nearby
                    .iter()
                    .copied()
                    .find(|&position| self.tiles[position].contains(x, y))
            });
            if found.is_some() {
                return found;
            }
        }
        None
    }

    /// The reading at a point known to fall in `position`, decoding that tile if it isn't held.
    pub fn sample_in(&mut self, position: usize, lng: f64, lat: f64) -> Fallible<Option<f32>> {
        self.load(position)?;
        let (x, y) = self.mosaics[self.tiles[position].mosaic]
            .projection
            .forward(lng, lat);
        Ok(self.read(position, x, y))
    }

    /// Readings over a row-major grid in the one mosaic's projected meters, NaN where uncovered.
    pub fn sample_grid(
        &mut self,
        origin_x: f64,
        origin_y: f64,
        cell: f64,
        width: usize,
        height: usize,
    ) -> Fallible<Vec<f32>> {
        if self.mosaics.len() > 1 {
            return Err(format!(
                "a grid in projected meters sampled from a DEM of {} mosaics, which are on {} \
                 different projections",
                self.mosaics.len(),
                self.mosaics.len()
            )
            .into());
        }
        let east = origin_x + width as f64 * cell;
        let south = origin_y - height as f64 * cell;
        let reaching: Vec<usize> = (0..self.tiles.len())
            .filter(|&position| {
                let tile = &self.tiles[position];
                tile.min_x() < east
                    && tile.max_x() > origin_x
                    && tile.min_y() < origin_y
                    && tile.max_y() > south
            })
            .collect();
        let mut values = vec![f32::NAN; width * height];
        for position in reaching {
            self.load(position)?;
            let tile = &self.tiles[position];
            let span = |from: f64, to: f64, limit: usize| {
                (from.floor().clamp(0.0, limit as f64) as usize)
                    ..(to.ceil().clamp(0.0, limit as f64) as usize)
            };
            let columns = span(
                (tile.min_x() - origin_x) / cell,
                (tile.max_x() - origin_x) / cell,
                width,
            );
            let rows = span(
                (origin_y - tile.max_y()) / cell,
                (origin_y - tile.min_y()) / cell,
                height,
            );
            for row in rows {
                let y = origin_y - (row as f64 + 0.5) * cell;
                for column in columns.clone() {
                    let x = origin_x + (column as f64 + 0.5) * cell;
                    // Tiles overlap by a few pixels; keep whichever carried a reading, not the last visited.
                    if let Some(value) = self.read(position, x, y) {
                        values[row * width + column] = value;
                    }
                }
            }
        }
        Ok(values)
    }

    /// The cell at a projected point in an already-decoded tile.
    fn read(&self, position: usize, x: f64, y: f64) -> Option<f32> {
        let tile = &self.tiles[position];
        let column = ((x - tile.origin_x) / tile.cell).floor() as isize;
        let row = ((tile.origin_y - y) / tile.cell).floor() as isize;
        if column < 0 || row < 0 || column as usize >= tile.width || row as usize >= tile.height {
            return None;
        }
        let (_, values) = self.loaded.as_ref()?;
        let band = self.mosaics[tile.mosaic].band;
        let index = (row as usize * tile.width + column as usize) * tile.bands + band;
        let value = values.get(index).copied().unwrap_or(f32::NAN);
        if value.is_finite() && value > NODATA_BELOW {
            Some(value)
        } else {
            None
        }
    }

    fn load(&mut self, position: usize) -> Fallible<()> {
        if self
            .loaded
            .as_ref()
            .is_some_and(|(held, _)| *held == position)
        {
            return Ok(());
        }
        // Dropped before the decode, so two tiles are never held at once.
        self.loaded = None;
        let tile = &self.tiles[position];
        // The default decode limit rejects the staged 1 m DEM's 401 MB tiles.
        let mut decoder =
            Decoder::new(BufReader::new(File::open(&tile.path)?))?.with_limits(Limits::unlimited());
        let values = match decoder.read_image()? {
            DecodingResult::F32(values) => values,
            DecodingResult::U16(values) => values.iter().map(|&v| f32::from(v)).collect(),
            DecodingResult::I16(values) => values.iter().map(|&v| f32::from(v)).collect(),
            _ => {
                return Err(format!(
                    "{}: unsupported sample type in an elevation tile",
                    tile.path.display()
                )
                .into());
            }
        };
        self.loaded = Some((position, values));
        self.decoded += 1;
        Ok(())
    }

    pub fn tiles(&self) -> usize {
        self.tiles.len()
    }

    /// Drops the decoded tile, for a caller holding the `Dem` for a later pass.
    pub fn release(&mut self) {
        self.loaded = None;
    }
}

/// The resampled ground surface on a regular longitude/latitude grid over the city's bounds.
pub struct Field {
    west: f64,
    north: f64,
    step_lng: f64,
    step_lat: f64,
    width: usize,
    height: usize,
    /// NaN where the DEM had nothing, which is most of the water and the odd gap.
    meters: Vec<f32>,
    low: f32,
    high: f32,
}

impl Field {
    pub fn low(&self) -> f32 {
        self.low
    }

    pub fn high(&self) -> f32 {
        self.high
    }

    pub fn step_lng(&self) -> f64 {
        self.step_lng
    }

    pub fn step_lat(&self) -> f64 {
        self.step_lat
    }

    pub fn at(&self, column: usize, row: usize) -> f32 {
        self.meters[row * self.width + column]
    }

    /// NaNs cells outside `keep` unless within `reach_meters` of it and `deck_meters` up (a pier).
    /// Recomputes `low..high` so sea-level water doesn't anchor the tint; returns the count dropped.
    pub fn retain(
        &mut self,
        reach_meters: f64,
        deck_meters: f32,
        mut keep: impl FnMut(f64, f64) -> bool,
    ) -> usize {
        let mut flags = vec![0u8; self.width * self.height];
        for row in 0..self.height {
            let lat = self.north - (row as f64 + 0.5) * self.step_lat;
            for column in 0..self.width {
                let lng = self.west + (column as f64 + 0.5) * self.step_lng;
                if keep(lng, lat) {
                    flags[row * self.width + column] = INSIDE;
                }
            }
        }
        let cell_meters = self.step_lat * METERS_PER_DEGREE_LAT;
        let radius = (reach_meters / cell_meters.max(0.01)).round() as usize;
        dilate(&mut flags, self.width, self.height, radius);

        let mut dropped = 0;
        for (meters, flag) in self.meters.iter_mut().zip(&flags) {
            if !meters.is_finite() {
                continue;
            }
            // Inside the mask height isn't asked: beaches and tidal flats sit below any deck.
            let keep_cell = flag & INSIDE != 0 || (flag & REACHED != 0 && *meters >= deck_meters);
            if !keep_cell {
                *meters = f32::NAN;
                dropped += 1;
            }
        }
        self.low = f32::INFINITY;
        self.high = f32::NEG_INFINITY;
        for value in &self.meters {
            if value.is_finite() {
                self.low = self.low.min(*value);
                self.high = self.high.max(*value);
            }
        }
        dropped
    }

    /// Fraction of the four cells `sample` blends that hold ground, so the coastline can fade.
    pub fn coverage(&self, lng: f64, lat: f64) -> f32 {
        let x = (lng - self.west) / self.step_lng - 0.5;
        let y = (self.north - lat) / self.step_lat - 0.5;
        let at = |column: f64, row: f64| -> f32 {
            if column < 0.0 || row < 0.0 {
                return 0.0;
            }
            let (column, row) = (column as usize, row as usize);
            if column >= self.width || row >= self.height {
                0.0
            } else if self.at(column, row).is_finite() {
                1.0
            } else {
                0.0
            }
        };
        let column = x.floor();
        let row = y.floor();
        let fx = (x - column) as f32;
        let fy = (y - row) as f32;
        let top = at(column, row) + (at(column + 1.0, row) - at(column, row)) * fx;
        let bottom =
            at(column, row + 1.0) + (at(column + 1.0, row + 1.0) - at(column, row + 1.0)) * fx;
        top + (bottom - top) * fy
    }

    /// Bilinear value at a point, NaN outside; nearest-cell would charge a short edge a cell's climb.
    pub fn sample(&self, lng: f64, lat: f64) -> f32 {
        // Cell centers sit at half-steps, so a point at a center returns that cell's own value.
        let x = (lng - self.west) / self.step_lng - 0.5;
        let y = (self.north - lat) / self.step_lat - 0.5;
        let at = |column: f64, row: f64| -> f32 {
            if column < 0.0 || row < 0.0 {
                return f32::NAN;
            }
            let (column, row) = (column as usize, row as usize);
            if column >= self.width || row >= self.height {
                f32::NAN
            } else {
                self.at(column, row)
            }
        };
        let column = x.floor();
        let row = y.floor();
        let top_left = at(column, row);
        let top_right = at(column + 1.0, row);
        let bottom_left = at(column, row + 1.0);
        let bottom_right = at(column + 1.0, row + 1.0);
        // At a shoreline a missing corner falls back to the point's own cell, so land isn't smeared.
        if !top_left.is_finite()
            || !top_right.is_finite()
            || !bottom_left.is_finite()
            || !bottom_right.is_finite()
        {
            return at(x.round(), y.round());
        }
        let fx = (x - column) as f32;
        let fy = (y - row) as f32;
        let top = top_left + (top_right - top_left) * fx;
        let bottom = bottom_left + (bottom_right - bottom_left) * fx;
        top + (bottom - top) * fy
    }
}

/// The fill's reach in meters, not rings (which shrink as the field gets finer); bounded by the bay.
const FILL_REACH_METERS: f64 = 40.0;

/// Caps the rings the reach converts to on a very fine field.
const MAX_FILL_RINGS: usize = 24;

// Bits of `retain`'s one byte per cell: the kept mask, its row-wise spread, and its full reach.
const INSIDE: u8 = 1;
const SPREAD: u8 = 2;
const REACHED: u8 = 4;

/// Flags REACHED on every cell within `radius` cells of an INSIDE one, a square in two passes.
fn dilate(flags: &mut [u8], width: usize, height: usize, radius: usize) {
    let has = |flag: u8, bit: u8| usize::from(flag & bit != 0);
    if radius == 0 {
        for flag in flags.iter_mut() {
            *flag |= if *flag & INSIDE != 0 { REACHED } else { 0 };
        }
        return;
    }
    for row in 0..height {
        let mut count = 0usize;
        for column in 0..(radius + 1).min(width) {
            count += has(flags[row * width + column], INSIDE);
        }
        for column in 0..width {
            if count > 0 {
                flags[row * width + column] |= SPREAD;
            }
            if let Some(leaving) = column.checked_sub(radius) {
                count -= has(flags[row * width + leaving], INSIDE);
            }
            let entering = column + radius + 1;
            if entering < width {
                count += has(flags[row * width + entering], INSIDE);
            }
        }
    }
    for column in 0..width {
        let mut count = 0usize;
        for row in 0..(radius + 1).min(height) {
            count += has(flags[row * width + column], SPREAD);
        }
        for row in 0..height {
            if count > 0 {
                flags[row * width + column] |= REACHED;
            }
            if let Some(leaving) = row.checked_sub(radius) {
                count -= has(flags[leaving * width + column], SPREAD);
            }
            let entering = row + radius + 1;
            if entering < height {
                count += has(flags[entering * width + column], SPREAD);
            }
        }
    }
}

/// Fills gaps ring by ring from the mean of valid 8-neighbors; returns how many cells it filled.
fn close_holes(meters: &mut [f32], width: usize, height: usize, cell_meters: f64) -> usize {
    let rings =
        ((FILL_REACH_METERS / cell_meters.max(0.01)).round() as usize).clamp(1, MAX_FILL_RINGS);
    let mut patched = 0;
    for _ in 0..rings {
        let mut filled: Vec<(usize, f32)> = Vec::new();
        for row in 0..height {
            for column in 0..width {
                let cell = row * width + column;
                if meters[cell].is_finite() {
                    continue;
                }
                let mut total = 0.0f32;
                let mut count = 0u32;
                for delta_row in -1i64..=1 {
                    for delta_column in -1i64..=1 {
                        let neighbor_row = row as i64 + delta_row;
                        let neighbor_column = column as i64 + delta_column;
                        if neighbor_row < 0
                            || neighbor_column < 0
                            || neighbor_row >= height as i64
                            || neighbor_column >= width as i64
                        {
                            continue;
                        }
                        let value =
                            meters[neighbor_row as usize * width + neighbor_column as usize];
                        if value.is_finite() {
                            total += value;
                            count += 1;
                        }
                    }
                }
                // At least three neighbors, so a fill interpolates rather than copies one cell.
                if count >= 3 {
                    filled.push((cell, total / count as f32));
                }
            }
        }
        if filled.is_empty() {
            break;
        }
        for (cell, value) in filled {
            meters[cell] = value;
            patched += 1;
        }
    }
    patched
}

// Field rows resampled per band; a tile spanning a band edge decodes once per band it reaches.
const RESAMPLE_BAND_ROWS: usize = 1024;

/// Resamples the mosaic onto a longitude/latitude grid at `zoom`'s pixel size.
pub fn resample(bounds: &Bounds, zoom: u32, dem: &mut Dem) -> Fallible<Field> {
    // Cells the size of a pixel at `zoom`, in degrees, so the field lines up with the tiles.
    let west = bounds.west;
    let east = bounds.east;
    let south = bounds.south;
    let north = bounds.north;
    let pixels_x = lng_to_pixel_x(east, zoom) - lng_to_pixel_x(west, zoom);
    let pixels_y = lat_to_pixel_y(south, zoom) - lat_to_pixel_y(north, zoom);
    let width = pixels_x.ceil().max(1.0) as usize;
    let height = pixels_y.ceil().max(1.0) as usize;
    let step_lng = (east - west) / width as f64;
    let step_lat = (north - south) / height as f64;

    let mut meters = vec![f32::NAN; width * height];
    let mut low = f32::INFINITY;
    let mut high = f32::NEG_INFINITY;
    let mut filled = 0usize;

    // Bucketed by tile, since a row-major sweep re-decodes every tile on every row.
    // A band at a time, so the buckets hold a band's cell indices, not the whole field's.
    for band in (0..height).step_by(RESAMPLE_BAND_ROWS) {
        let mut by_tile: HashMap<usize, Vec<u32>> = HashMap::new();
        for row in band..(band + RESAMPLE_BAND_ROWS).min(height) {
            let lat = north - (row as f64 + 0.5) * step_lat;
            for column in 0..width {
                let lng = west + (column as f64 + 0.5) * step_lng;
                if let Some(position) = dem.tile_of(lng, lat) {
                    by_tile
                        .entry(position)
                        .or_default()
                        .push(((row - band) * width + column) as u32);
                }
            }
        }
        let mut positions: Vec<usize> = by_tile.keys().copied().collect();
        positions.sort_unstable();
        for position in positions {
            for &offset in &by_tile[&position] {
                let cell = band * width + offset as usize;
                let row = cell / width;
                let column = cell % width;
                let lat = north - (row as f64 + 0.5) * step_lat;
                let lng = west + (column as f64 + 0.5) * step_lng;
                if let Some(value) = dem.sample_in(position, lng, lat)? {
                    meters[cell] = value;
                    low = low.min(value);
                    high = high.max(value);
                    filled += 1;
                }
            }
        }
    }
    if filled == 0 {
        return Err("the DEM covered none of the city".into());
    }
    // The cell size in meters, so the fill's reach doesn't depend on zoom.
    let cell_meters = step_lat * METERS_PER_DEGREE_LAT;
    let patched = close_holes(&mut meters, width, height, cell_meters);
    eprintln!(
        "  field {width} x {height}, {filled} cells with ground ({:.0} m to {:.0} m), {patched} holes closed, {} tiles decoded",
        low, high, dem.decoded
    );
    Ok(Field {
        west,
        north,
        step_lng,
        step_lat,
        width,
        height,
        meters,
        low,
        high,
    })
}

#[cfg(test)]
impl Field {
    /// A field built straight from row-major values, NaN where there is no ground.
    pub fn from_grid(
        west: f64,
        north: f64,
        step_lng: f64,
        step_lat: f64,
        width: usize,
        height: usize,
        meters: Vec<f32>,
    ) -> Field {
        let mut low = f32::INFINITY;
        let mut high = f32::NEG_INFINITY;
        for value in &meters {
            if value.is_finite() {
                low = low.min(*value);
                high = high.max(*value);
            }
        }
        Field {
            west,
            north,
            step_lng,
            step_lat,
            width,
            height,
            meters,
            low,
            high,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{FILL_REACH_METERS, INSIDE, REACHED, close_holes, dilate};

    /// `dilate` over a plain mask, read back as one.
    fn reach(set: &[bool], width: usize, height: usize, radius: usize) -> Vec<bool> {
        let mut flags: Vec<u8> = set
            .iter()
            .map(|&hit| if hit { INSIDE } else { 0 })
            .collect();
        dilate(&mut flags, width, height, radius);
        flags.iter().map(|flag| flag & REACHED != 0).collect()
    }

    /// A cell size that makes the reach exactly four rings.
    const FOUR_RINGS: f64 = FILL_REACH_METERS / 4.0;
    const MAX_FILL_RINGS: usize = 4;

    const NAN: f32 = f32::NAN;

    #[test]
    fn a_single_missing_cell_takes_the_mean_of_its_neighbors() {
        let mut field = vec![
            10.0, 10.0, 10.0, //
            10.0, NAN, 10.0, //
            10.0, 10.0, 10.0,
        ];
        assert_eq!(close_holes(&mut field, 3, 3, FOUR_RINGS), 1);
        assert_eq!(field[4], 10.0);
    }

    #[test]
    fn a_hole_fills_from_the_ground_around_it_not_across_it() {
        // A 0 m to 100 m step with a hole on the seam: the fill must land between.
        let mut field = vec![
            0.0, 0.0, 100.0, 100.0, //
            0.0, 0.0, NAN, 100.0, //
            0.0, 0.0, 100.0, 100.0,
        ];
        close_holes(&mut field, 4, 3, FOUR_RINGS);
        assert!(field[6] > 0.0 && field[6] < 100.0, "got {}", field[6]);
    }

    #[test]
    fn the_fill_reaches_open_water_by_no_more_than_its_ring_bound() {
        // Ground down the left column, sea to the right: the fill creeps seaward only its rings.
        let width = 12;
        let height = 5;
        let mut field = vec![NAN; width * height];
        for row in 0..height {
            field[row * width] = 5.0;
        }
        close_holes(&mut field, width, height, FOUR_RINGS);
        for row in 0..height {
            for column in 0..width {
                if column > MAX_FILL_RINGS {
                    assert!(
                        field[row * width + column].is_nan(),
                        "invented ground {column} cells out to sea at row {row}"
                    );
                }
            }
        }
        assert!(field[(height / 2) * width + 1].is_finite());
    }

    #[test]
    fn a_hole_wider_than_the_fill_can_reach_keeps_a_missing_core() {
        // Ground round a 20-cell void: the fill stops short, so the bound isn't convergence.
        let width = 24;
        let height = 24;
        let mut field = vec![NAN; width * height];
        for row in 0..height {
            for column in 0..width {
                let edge = row < 2 || column < 2 || row >= height - 2 || column >= width - 2;
                if edge {
                    field[row * width + column] = 7.0;
                }
            }
        }
        close_holes(&mut field, width, height, FOUR_RINGS);
        assert!(field[(height / 2) * width + width / 2].is_nan());
    }
    // The reach that lets a pier survive the mask: square, symmetric, and bounded.
    #[test]
    fn the_reach_spreads_one_cell_by_its_radius_and_stops() {
        let width = 11;
        let height = 11;
        let mut set = vec![false; width * height];
        set[5 * width + 5] = true;
        let reached = reach(&set, width, height, 2);
        assert!(reached[5 * width + 7]);
        assert!(reached[3 * width + 3]); // the corner of the square, two out on each axis
        assert!(!reached[5 * width + 8]);
        assert_eq!(reached.iter().filter(|&&hit| hit).count(), 25);
    }

    #[test]
    fn a_zero_reach_leaves_the_mask_exactly_as_it_was() {
        let set = vec![false, true, false, false];
        assert_eq!(reach(&set, 2, 2, 0), set);
    }
}

#[cfg(test)]
mod mosaic_tests {
    use std::fs::{self, File};
    use std::io::BufWriter;
    use std::path::{Path, PathBuf};

    use tiff::encoder::{TiffEncoder, colortype};
    use tiff::tags::Tag;

    use super::{Dem, MosaicTiles};
    use crate::heights::{SF_CS13, UTM_10N};

    /// A point in each survey's own ground: the CS13 origin under Twin Peaks, and downtown Oakland.
    const IN_SAN_FRANCISCO: (f64, f64) = (-122.45, 37.75);
    const IN_THE_EAST_BAY: (f64, f64) = (-122.27, 37.80);

    const SIDE: usize = 40;

    /// A tile file per test, so parallel tests don't truncate each other's tiles.
    fn scratch(test: &str, name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("tiler-dem-test-{}", std::process::id()))
            .join(test);
        fs::create_dir_all(&dir).expect("a scratch directory");
        dir.join(name)
    }

    fn georeference<Color: colortype::ColorType, Writer: std::io::Write + std::io::Seek>(
        image: &mut tiff::encoder::ImageEncoder<'_, Writer, Color, tiff::encoder::TiffKindStandard>,
        origin_x: f64,
        origin_y: f64,
    ) {
        image
            .encoder()
            .write_tag(Tag::ModelPixelScaleTag, &[1.0, 1.0, 0.0][..])
            .expect("the pixel scale");
        image
            .encoder()
            .write_tag(
                Tag::ModelTiepointTag,
                &[0.0, 0.0, 0.0, origin_x, origin_y, 0.0][..],
            )
            .expect("the tiepoint");
    }

    /// One meter cells, `SIDE` of them a side, every cell reading `value`.
    fn write_flat(path: &Path, origin_x: f64, origin_y: f64, value: f32) {
        let mut encoder =
            TiffEncoder::new(BufWriter::new(File::create(path).expect("a tile"))).expect("a tiff");
        let mut image = encoder
            .new_image::<colortype::Gray32Float>(SIDE as u32, SIDE as u32)
            .expect("an image");
        georeference(&mut image, origin_x, origin_y);
        image
            .write_data(&vec![value; SIDE * SIDE])
            .expect("the samples");
    }

    /// Three bands a pixel, like the 3DEP product whose ground is one band of five.
    fn write_three_band(path: &Path, origin_x: f64, origin_y: f64, bands: [f32; 3]) {
        let mut encoder =
            TiffEncoder::new(BufWriter::new(File::create(path).expect("a tile"))).expect("a tiff");
        let mut image = encoder
            .new_image::<colortype::RGB32Float>(SIDE as u32, SIDE as u32)
            .expect("an image");
        georeference(&mut image, origin_x, origin_y);
        let samples: Vec<f32> = std::iter::repeat_n(bands, SIDE * SIDE).flatten().collect();
        image.write_data(&samples).expect("the samples");
    }

    /// San Francisco on CS13 band 0 and the East Bay on UTM 10N band 2.
    fn two_surveys(test: &str) -> Dem {
        let (sf_x, sf_y) = SF_CS13.forward(IN_SAN_FRANCISCO.0, IN_SAN_FRANCISCO.1);
        let (east_x, east_y) = UTM_10N.forward(IN_THE_EAST_BAY.0, IN_THE_EAST_BAY.1);
        let west = scratch(test, "cs13.tif");
        let east = scratch(test, "utm10n.tif");
        write_flat(&west, sf_x - 20.0, sf_y + 20.0, 110.0);
        write_three_band(&east, east_x - 20.0, east_y + 20.0, [1.0, 2.0, 33.0]);
        Dem::open_mosaics(&[
            MosaicTiles {
                projection: SF_CS13,
                band: 0,
                paths: vec![west],
            },
            MosaicTiles {
                projection: UTM_10N,
                band: 2,
                paths: vec![east],
            },
        ])
        .expect("a two-mosaic dem")
    }

    #[test]
    fn a_point_is_read_through_its_own_survey_s_projection_and_band() {
        let mut dem = two_surveys("own-projection-and-band");
        let west = dem
            .tile_of(IN_SAN_FRANCISCO.0, IN_SAN_FRANCISCO.1)
            .expect("san francisco's tile");
        let east = dem
            .tile_of(IN_THE_EAST_BAY.0, IN_THE_EAST_BAY.1)
            .expect("the east bay's tile");
        assert_ne!(west, east);
        // One projection for both would find neither tile.
        assert_eq!(
            dem.sample_in(west, IN_SAN_FRANCISCO.0, IN_SAN_FRANCISCO.1)
                .expect("a reading"),
            Some(110.0)
        );
        assert_eq!(
            dem.sample_in(east, IN_THE_EAST_BAY.0, IN_THE_EAST_BAY.1)
                .expect("a reading"),
            Some(33.0)
        );
    }

    #[test]
    fn a_grid_in_projected_meters_is_refused_when_the_mosaics_disagree_on_the_meter() {
        let test = "mosaics-disagree";
        let (east_x, east_y) = UTM_10N.forward(IN_THE_EAST_BAY.0, IN_THE_EAST_BAY.1);
        let error = two_surveys(test)
            .sample_grid(east_x - 20.0, east_y + 20.0, 1.0, SIDE, SIDE)
            .expect_err("a refusal");
        assert!(error.to_string().contains("mosaics"), "{error}");

        // The same grid off the same tile, opened as the one mosaic it belongs to, is answered.
        let east = scratch(test, "utm10n.tif");
        let mut alone = Dem::open(&[east], UTM_10N, 2).expect("the east bay's mosaic on its own");
        let values = alone
            .sample_grid(east_x - 20.0, east_y + 20.0, 1.0, SIDE, SIDE)
            .expect("a grid");
        assert!(values.iter().all(|&value| value == 33.0));
    }
}

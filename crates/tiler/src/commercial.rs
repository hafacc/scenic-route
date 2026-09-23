//! The commercial pass: per-segment signals, snapped here and aligned by index to STCK chunks.
//! The client applies the thresholds, so the gate is retunable without a rebuild.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::Fallible;
use crate::binfmt::{self, COMMERCIAL_FORMAT, Coord, write_varint, zigzag};
use crate::geometry::{METERS_PER_DEGREE_LAT, round_half_up};
use crate::manifest::{Bounds, Manifest};
use crate::raster::{lat_to_pixel_y, lng_to_pixel_x, tile_index};

const CHUNK_ZOOM: u32 = 12;

const SIGNAL_MAGIC: &[u8; 4] = b"CMRC";
const SIGNAL_FORMAT: u16 = 1;
const SIGNAL_HEADER_BYTES: usize = 12; // magic(4) + version(2) + headerSize(2) + count(4)
const SIGNAL_BYTES: usize = 3; // commercial fraction, median roof height, flags
// The qualifying-block centerlines for the routing bake, one CMLN file per city in the LAND layout.
const LINE_MAGIC: &[u8; 4] = b"CMLN";
const LINE_HEADER_BYTES: usize = 40;
const LINE_COORD_SCALE: f64 = 1e-6; // degrees per quantized unit, ~0.1 m

// A point fronts a segment when its foot lands within the span, which keeps corner lots out.
const FRONTAGE_METERS: f64 = 35.0;
const BUILDING_FRONTAGE_METERS: f64 = 40.0;
const FLAG_FRONTAGE_METERS: f64 = 30.0;
// Fewer fronting lots than this writes a fraction of 0, which can't pass the client gate.
const MIN_LOTS: u32 = 4;

// The land-use digit split: 4/5 commercial, 1..3 residential.
const COMMERCIAL_CLASS: u8 = 4; // this class and above (4 mixed-res/commercial, 5 commercial/office)

// The default client thresholds, mirrored here to pick the segments the routing bake rewards.
const GATE_COMMERCIAL_FRACTION: f64 = 0.5;
const GATE_LOW_RISE_METERS: u8 = 25;

const NO_BUILDINGS: u8 = 255; // the median-height byte of a segment nothing snapped to
const OPEN_STREET_FLAG: u8 = 1;
const SEATING_FLAG: u8 = 2;

// Segments register in every ~330 m cell their box overlaps; a point scans its radius.
const SEGMENT_CELL_DEG: f64 = 0.003;

pub struct Args {
    pub manifest: PathBuf,
    /// The committed sources the signals are snapped from: data/{landuse,buildings,openstreets,dining}.
    pub data: PathBuf,
    /// public/commercial, the per-chunk signal files.
    pub signals: PathBuf,
    /// public/commercial-lines, the per-city qualifying-block lines.
    pub lines: PathBuf,
}

/// Where each city's qualifying-block centerlines landed, for the graph pass's commercial bake.
/// Where each city's qualifying-block centerlines landed; a city with no segment has no entry.
#[derive(Default)]
pub struct Lines {
    by_city: HashMap<String, PathBuf>,
}

impl Lines {
    pub fn get(&self, city: &str) -> Option<&Path> {
        self.by_city.get(city).map(PathBuf::as_path)
    }

    /// What this pass left in `dir` last time, read off disk so a skipped run matches a real one.
    pub fn written(dir: &Path, manifest: &Manifest) -> Lines {
        let mut lines = Lines::default();
        for city in &manifest.cities {
            let file = dir.join(format!("{}.bin", city.id));
            if file.is_file() {
                lines.by_city.insert(city.id.clone(), file);
            }
        }
        lines
    }
}

type Segment = Vec<Coord>;

/// One served STCK chunk: its tile, and where its segments start in the flat city array.
struct Chunk {
    tile_x: u32,
    tile_y: u32,
    start: usize,
    count: usize,
}

struct Signals {
    commercial_frac: Vec<u8>,
    median_height: Vec<u8>,
    flags: Vec<u8>,
}

/// The z12 tile range a lat/lng box covers; north maps to the smaller tile y.
fn tile_range(bounds: &Bounds) -> (u32, u32, u32, u32) {
    (
        tile_index(lng_to_pixel_x(bounds.west, CHUNK_ZOOM), CHUNK_ZOOM),
        tile_index(lng_to_pixel_x(bounds.east, CHUNK_ZOOM), CHUNK_ZOOM),
        tile_index(lat_to_pixel_y(bounds.north, CHUNK_ZOOM), CHUNK_ZOOM),
        tile_index(lat_to_pixel_y(bounds.south, CHUNK_ZOOM), CHUNK_ZOOM),
    )
}

// Sorted, so the flat segment index doesn't depend on the filesystem's directory order.
fn sorted_names(dir: &Path) -> Fallible<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(dir)? {
        names.push(entry?.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    Ok(names)
}

/// Every served STCK chunk in the city's z12 range, decoded, with each chunk's start index.
fn load_city_chunks(bounds: &Bounds, chunk_dir: &Path) -> Fallible<(Vec<Chunk>, Vec<Segment>)> {
    let (min_x, max_x, min_y, max_y) = tile_range(bounds);
    let mut chunks = Vec::new();
    let mut segments: Vec<Segment> = Vec::new();
    if !chunk_dir.is_dir() {
        return Ok((chunks, segments));
    }
    for row in sorted_names(chunk_dir)? {
        let tile_x = match row.parse::<u32>() {
            Ok(tile_x) if (min_x..=max_x).contains(&tile_x) => tile_x,
            _ => continue,
        };
        for file in sorted_names(&chunk_dir.join(&row))? {
            let tile_y = match file.strip_suffix(".bin").unwrap_or(&file).parse::<u32>() {
                Ok(tile_y) if (min_y..=max_y).contains(&tile_y) => tile_y,
                _ => continue,
            };
            let decoded = binfmt::read_chunk(&chunk_dir.join(&row).join(&file))?;
            chunks.push(Chunk {
                tile_x,
                tile_y,
                start: segments.len(),
                count: decoded.len(),
            });
            segments.extend(decoded);
        }
    }
    Ok((chunks, segments))
}

/// A grid of segment bounding boxes, each registered in every ~330 m cell its box overlaps.
fn build_segment_index(segments: &[Segment]) -> HashMap<(i64, i64), Vec<u32>> {
    let mut buckets: HashMap<(i64, i64), Vec<u32>> = HashMap::new();
    for (index, segment) in segments.iter().enumerate() {
        let mut min = Coord {
            lng: f64::INFINITY,
            lat: f64::INFINITY,
        };
        let mut max = Coord {
            lng: f64::NEG_INFINITY,
            lat: f64::NEG_INFINITY,
        };
        for vertex in segment {
            min.lng = min.lng.min(vertex.lng);
            max.lng = max.lng.max(vertex.lng);
            min.lat = min.lat.min(vertex.lat);
            max.lat = max.lat.max(vertex.lat);
        }
        for cell_x in cell(min.lng)..=cell(max.lng) {
            for cell_y in cell(min.lat)..=cell(max.lat) {
                buckets
                    .entry((cell_x, cell_y))
                    .or_default()
                    .push(index as u32);
            }
        }
    }
    buckets
}

fn cell(degrees: f64) -> i64 {
    (degrees / SEGMENT_CELL_DEG).floor() as i64
}

/// Squared perpendicular distance to a piece in meters, or infinity when the foot falls outside it.
fn perpendicular_in_span_squared(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = bx - ax;
    let dy = by - ay;
    let length_squared = dx * dx + dy * dy;
    if length_squared == 0.0 {
        return f64::INFINITY;
    }
    let along = -(ax * dx + ay * dy) / length_squared;
    if !(0.0..=1.0).contains(&along) {
        return f64::INFINITY;
    }
    let closest_x = ax + along * dx;
    let closest_y = ay + along * dy;
    closest_x * closest_x + closest_y * closest_y
}

/// The segment a point fronts, or None; `seen` and `generation` dedup without allocating.
struct Attributor<'a> {
    segments: &'a [Segment],
    buckets: HashMap<(i64, i64), Vec<u32>>,
    seen: Vec<u32>,
    generation: u32,
}

impl<'a> Attributor<'a> {
    fn new(segments: &'a [Segment]) -> Self {
        Self {
            segments,
            buckets: build_segment_index(segments),
            seen: vec![0; segments.len()],
            generation: 0,
        }
    }

    fn frontage(&mut self, point: Coord, reach_meters: f64) -> Option<usize> {
        self.generation += 1;
        let meters_per_degree_lng =
            METERS_PER_DEGREE_LAT * (point.lat * std::f64::consts::PI / 180.0).cos();
        let reach_deg_lat = reach_meters / METERS_PER_DEGREE_LAT;
        let reach_deg_lng = reach_meters / meters_per_degree_lng;

        let mut best = f64::INFINITY;
        let mut best_segment = None;
        for cell_x in cell(point.lng - reach_deg_lng)..=cell(point.lng + reach_deg_lng) {
            for cell_y in cell(point.lat - reach_deg_lat)..=cell(point.lat + reach_deg_lat) {
                let Some(bucket) = self.buckets.get(&(cell_x, cell_y)) else {
                    continue;
                };
                for index in bucket {
                    let index = *index as usize;
                    if self.seen[index] == self.generation {
                        continue;
                    }
                    self.seen[index] = self.generation;
                    // The in-span distance to this segment's closest fronted piece, or infinity.
                    let mut nearest = f64::INFINITY;
                    let segment = &self.segments[index];
                    let Some(first) = segment.first() else {
                        continue;
                    };
                    let mut previous = (
                        (first.lng - point.lng) * meters_per_degree_lng,
                        (first.lat - point.lat) * METERS_PER_DEGREE_LAT,
                    );
                    for vertex in &segment[1..] {
                        let current = (
                            (vertex.lng - point.lng) * meters_per_degree_lng,
                            (vertex.lat - point.lat) * METERS_PER_DEGREE_LAT,
                        );
                        nearest = nearest.min(perpendicular_in_span_squared(
                            previous.0, previous.1, current.0, current.1,
                        ));
                        previous = current;
                    }
                    if nearest < best {
                        best = nearest;
                        best_segment = Some(index);
                    }
                }
            }
        }
        if best <= reach_meters * reach_meters {
            best_segment
        } else {
            None
        }
    }
}

fn source(data: &Path, kind: &str, city_id: &str) -> Option<PathBuf> {
    let path = data.join(kind).join(format!("{city_id}.bin"));
    path.is_file().then_some(path)
}

/// The commercial share of a block's fronting lots, as the signal byte; too few lots reads 0.
fn commercial_fraction(commercial: u32, total: u32) -> u8 {
    if total >= MIN_LOTS {
        round_half_up(255.0 * f64::from(commercial) / f64::from(total)) as u8
    } else {
        0
    }
}

/// Attribute every source to the segment it fronts, reduced to three signal bytes per segment.
fn compute_signals(data: &Path, city_id: &str, segments: &[Segment]) -> Fallible<Signals> {
    let mut attributor = Attributor::new(segments);
    let count = segments.len();
    let mut signals = Signals {
        commercial_frac: vec![0; count],
        median_height: vec![NO_BUILDINGS; count],
        flags: vec![0; count],
    };

    if let Some(path) = source(data, "landuse", city_id) {
        let (lots, classes) =
            binfmt::read_classified_points(&path, "PLUT", binfmt::LANDUSE_FORMAT)?;
        let mut commercial = vec![0u32; count];
        let mut total = vec![0u32; count];
        for (lot, class) in lots.iter().zip(&classes) {
            if let Some(segment) = attributor.frontage(*lot, FRONTAGE_METERS) {
                total[segment] += 1;
                if *class >= COMMERCIAL_CLASS {
                    commercial[segment] += 1;
                }
            }
        }
        for index in 0..count {
            signals.commercial_frac[index] = commercial_fraction(commercial[index], total[index]);
        }
    }

    if let Some(path) = source(data, "buildings", city_id) {
        let (footprints, heights) = binfmt::read_buildings(&path)?;
        let mut per_segment: Vec<Vec<f64>> = vec![Vec::new(); count];
        for (footprint, height) in footprints.iter().zip(&heights) {
            // The centroid is the mean of the outer ring's vertices; holes are skipped.
            let Some(outer) = footprint.first().filter(|ring| !ring.is_empty()) else {
                continue;
            };
            let centroid = Coord {
                lng: outer.iter().map(|vertex| vertex.lng).sum::<f64>() / outer.len() as f64,
                lat: outer.iter().map(|vertex| vertex.lat).sum::<f64>() / outer.len() as f64,
            };
            if let Some(segment) = attributor.frontage(centroid, BUILDING_FRONTAGE_METERS) {
                per_segment[segment].push(*height);
            }
        }
        for (index, mut fronting) in per_segment.into_iter().enumerate() {
            if !fronting.is_empty() {
                fronting.sort_by(f64::total_cmp);
                let median = fronting[fronting.len() >> 1];
                signals.median_height[index] =
                    round_half_up(median).clamp(0.0, f64::from(NO_BUILDINGS)) as u8;
            }
        }
    }

    for (kind, magic, format, flag) in [
        (
            "openstreets",
            "OSTR",
            binfmt::OPENSTREET_FORMAT,
            OPEN_STREET_FLAG,
        ),
        ("dining", "DINE", binfmt::DINING_FORMAT, SEATING_FLAG),
    ] {
        if let Some(path) = source(data, kind, city_id) {
            for point in binfmt::read_points(&path, magic, format)? {
                if let Some(segment) = attributor.frontage(point, FLAG_FRONTAGE_METERS) {
                    signals.flags[segment] |= flag;
                }
            }
        }
    }

    Ok(signals)
}

/// One chunk's signals as a CMRC file: the 12-byte header, then 3 bytes per segment.
fn encode_signals(chunk: &Chunk, signals: &Signals) -> Vec<u8> {
    let mut bytes = vec![0u8; SIGNAL_HEADER_BYTES + chunk.count * SIGNAL_BYTES];
    bytes[0..4].copy_from_slice(SIGNAL_MAGIC);
    bytes[4..6].copy_from_slice(&SIGNAL_FORMAT.to_le_bytes());
    bytes[6..8].copy_from_slice(&(SIGNAL_HEADER_BYTES as u16).to_le_bytes());
    bytes[8..12].copy_from_slice(&(chunk.count as u32).to_le_bytes());
    for local in 0..chunk.count {
        let segment = chunk.start + local;
        let at = SIGNAL_HEADER_BYTES + local * SIGNAL_BYTES;
        bytes[at] = signals.commercial_frac[segment];
        bytes[at + 1] = signals.median_height[segment];
        bytes[at + 2] = signals.flags[segment];
    }
    bytes
}

/// The overlay's default gate: over-half commercial, low-rise, and an open street or seating.
fn qualifies(signals: &Signals, index: usize) -> bool {
    f64::from(signals.commercial_frac[index]) / 255.0 >= GATE_COMMERCIAL_FRACTION
        && signals.median_height[index] <= GATE_LOW_RISE_METERS
        && signals.flags[index] & (OPEN_STREET_FLAG | SEATING_FLAG) != 0
}

/// The qualifying polylines as CMLN single-ring LAND polygons; an empty city's origin is infinity.
fn encode_qualifying_lines(segments: &[Segment], signals: &Signals) -> (Vec<u8>, usize) {
    let lines: Vec<&Segment> = segments
        .iter()
        .enumerate()
        .filter(|(index, _)| qualifies(signals, *index))
        .map(|(_, segment)| segment)
        .collect();
    let mut origin = Coord {
        lng: f64::INFINITY,
        lat: f64::INFINITY,
    };
    for line in &lines {
        for vertex in line.iter() {
            origin.lng = origin.lng.min(vertex.lng);
            origin.lat = origin.lat.min(vertex.lat);
        }
    }

    let mut bytes = vec![0u8; LINE_HEADER_BYTES];
    for line in &lines {
        bytes.extend_from_slice(&1u16.to_le_bytes()); // one ring, the centerline itself
        bytes.extend_from_slice(&(line.len() as u32).to_le_bytes());
        let mut previous = (0i64, 0i64);
        for vertex in line.iter() {
            let x = round_half_up((vertex.lng - origin.lng) / LINE_COORD_SCALE) as i64;
            let y = round_half_up((vertex.lat - origin.lat) / LINE_COORD_SCALE) as i64;
            write_varint(&mut bytes, zigzag(x - previous.0));
            write_varint(&mut bytes, zigzag(y - previous.1));
            previous = (x, y);
        }
    }
    bytes[0..4].copy_from_slice(LINE_MAGIC);
    bytes[4..6].copy_from_slice(&COMMERCIAL_FORMAT.to_le_bytes());
    bytes[6..8].copy_from_slice(&(LINE_HEADER_BYTES as u16).to_le_bytes());
    bytes[8..12].copy_from_slice(&(lines.len() as u32).to_le_bytes());
    bytes[16..24].copy_from_slice(&origin.lng.to_le_bytes());
    bytes[24..32].copy_from_slice(&origin.lat.to_le_bytes());
    bytes[32..40].copy_from_slice(&LINE_COORD_SCALE.to_le_bytes());
    (bytes, lines.len())
}

pub fn run(args: &Args, chunks: &crate::chunks::Chunks) -> Fallible<Lines> {
    let manifest: Manifest = serde_json::from_slice(&fs::read(&args.manifest)?)?;
    for directory in [&args.signals, &args.lines] {
        if directory.exists() {
            fs::remove_dir_all(directory)?;
        }
        fs::create_dir_all(directory)?;
    }

    let mut written = Lines::default();
    for city in &manifest.cities {
        let started = Instant::now();
        let (chunks, segments) = load_city_chunks(&city.bounds, &chunks.dir)?;
        if segments.is_empty() {
            eprintln!("{}: no served street chunks, skipped", city.id);
            continue;
        }
        let signals = compute_signals(&args.data, &city.id, &segments)?;

        for chunk in &chunks {
            let row = args.signals.join(chunk.tile_x.to_string());
            fs::create_dir_all(&row)?;
            fs::write(
                row.join(format!("{}.bin", chunk.tile_y)),
                encode_signals(chunk, &signals),
            )?;
        }

        let (lines, passing) = encode_qualifying_lines(&segments, &signals);
        let line_file = args.lines.join(format!("{}.bin", city.id));
        fs::write(&line_file, lines)?;
        written.by_city.insert(city.id.clone(), line_file);

        eprintln!(
            "{}: {} segments in {} chunks, {passing} pass the default gate (>={GATE_COMMERCIAL_FRACTION} commercial, <={GATE_LOW_RISE_METERS} m, open-street|seating), {:.1}s",
            city.id,
            segments.len(),
            chunks.len(),
            started.elapsed().as_secs_f64()
        );
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CELL_METERS: f64 = SEGMENT_CELL_DEG * METERS_PER_DEGREE_LAT;

    /// A point in meters from a reference in New York, so tests exercise the real cos(lat) scaling.
    fn at(east_meters: f64, north_meters: f64) -> Coord {
        const LAT: f64 = 40.7;
        Coord {
            lng: -74.0
                + east_meters
                    / (METERS_PER_DEGREE_LAT * (LAT * std::f64::consts::PI / 180.0).cos()),
            lat: LAT + north_meters / METERS_PER_DEGREE_LAT,
        }
    }

    /// A 100 m east-west block, and a second one 60 m north of it.
    fn two_blocks() -> Vec<Segment> {
        vec![
            vec![at(0.0, 0.0), at(100.0, 0.0)],
            vec![at(0.0, 60.0), at(100.0, 60.0)],
        ]
    }

    fn signals(commercial_frac: u8, median_height: u8, flags: u8) -> Signals {
        Signals {
            commercial_frac: vec![commercial_frac],
            median_height: vec![median_height],
            flags: vec![flags],
        }
    }

    #[test]
    fn a_lot_beside_a_block_fronts_it() {
        let segments = two_blocks();
        let mut attributor = Attributor::new(&segments);

        assert_eq!(
            attributor.frontage(at(50.0, 20.0), FRONTAGE_METERS),
            Some(0)
        );
    }

    #[test]
    fn a_lot_past_the_end_of_a_block_fronts_nothing() {
        let segments = two_blocks();
        let mut attributor = Attributor::new(&segments);

        // Ten meters off the block's line but past its end: the corner case of the in-span test.
        assert_eq!(attributor.frontage(at(110.0, 10.0), FRONTAGE_METERS), None);
    }

    #[test]
    fn a_lot_out_of_reach_fronts_nothing() {
        let segments = vec![vec![at(0.0, 0.0), at(100.0, 0.0)]];
        let mut attributor = Attributor::new(&segments);

        assert_eq!(attributor.frontage(at(50.0, 36.0), FRONTAGE_METERS), None);
        assert_eq!(
            attributor.frontage(at(50.0, 34.0), FRONTAGE_METERS),
            Some(0)
        );
    }

    #[test]
    fn a_lot_between_two_blocks_fronts_the_nearer() {
        let segments = two_blocks();
        let mut attributor = Attributor::new(&segments);

        assert_eq!(
            attributor.frontage(at(50.0, 25.0), FRONTAGE_METERS),
            Some(0)
        );
        assert_eq!(
            attributor.frontage(at(50.0, 35.0), FRONTAGE_METERS),
            Some(1)
        );
    }

    /// A segment spanning a cell boundary, found from both cells, keeps its first sighting.
    #[test]
    fn a_block_spanning_two_index_cells_is_found_once_from_either_side() {
        let segments = vec![vec![at(-CELL_METERS, 0.0), at(CELL_METERS, 0.0)]];
        let mut attributor = Attributor::new(&segments);

        assert_eq!(
            attributor.frontage(at(-1.0, 10.0), FRONTAGE_METERS),
            Some(0)
        );
        assert_eq!(attributor.frontage(at(1.0, 10.0), FRONTAGE_METERS), Some(0));
    }

    /// Perpendicular distance decides frontage, not which side of the street the point sits on.
    #[test]
    fn a_lot_across_the_street_still_fronts_the_block() {
        let segments = vec![vec![at(0.0, 0.0), at(100.0, 0.0)]];
        let mut attributor = Attributor::new(&segments);

        assert_eq!(
            attributor.frontage(at(50.0, -20.0), FRONTAGE_METERS),
            Some(0)
        );
    }

    #[test]
    fn a_block_qualifies_only_when_commercial_low_rise_and_cute() {
        assert!(qualifies(&signals(200, 12, OPEN_STREET_FLAG), 0));
        assert!(qualifies(&signals(200, 12, SEATING_FLAG), 0));
        // Half of 255 is 127.5, so 127 is under the gate and 128 is over it.
        assert!(!qualifies(&signals(127, 12, SEATING_FLAG), 0));
        assert!(qualifies(&signals(128, 12, SEATING_FLAG), 0));
        assert!(!qualifies(&signals(200, 26, SEATING_FLAG), 0));
        assert!(!qualifies(&signals(200, 12, 0), 0));
        // The block nothing snapped to: 255 reads as not low-rise rather than as flat ground.
        assert!(!qualifies(&signals(200, NO_BUILDINGS, SEATING_FLAG), 0));
    }

    /// Too few fronting lots reads 0, separating a commercial strip from a corner shop.
    #[test]
    fn a_block_with_too_few_lots_reports_no_commercial_fraction() {
        assert_eq!(commercial_fraction(3, 3), 0);
        assert_eq!(commercial_fraction(4, 4), 255);
        assert_eq!(commercial_fraction(2, 4), 128); // 127.5 rounds half up, as Math.round does
    }
}

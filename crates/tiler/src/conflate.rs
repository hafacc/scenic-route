//! Conflation: the OSM walking network merged into the CSCL streets before `graph.rs` nodes it.
//! Coordinates are quantized i32 in the streets frame; `meters_per_unit` converts per axis.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::ops::ControlFlow;

use crate::geometry::round_half_up;
use crate::graph::{DECIMETERS_PER_METER, KIND_CROSSING, KIND_SIDEWALK};

// Drops on-street bike lanes (~5 m off the centerline) while off-street greenways (>10 m) survive.
const DEDUP_METERS: f64 = 6.0;
// Mod 180°: a parallel duplicate is within 25°, an oblique crossing is not.
const DEDUP_BEARING_DEGREES: f64 = 25.0;
// A way ≥80% covered is a duplicate; partial overlaps (25–75%) are distinct walks kept whole.
const DEDUP_FRACTION: f64 = 0.8;
// Greenways sit >10 m from their centerline; only a named standalone way is tested at this band.
const ORPHAN_DEDUP_METERS: f64 = 10.0;
// Fine enough not to step over the 6 m band, coarse enough to stay cheap.
const DEDUP_SAMPLE_METERS: f64 = 10.0;
// Exceeds the 6 m dedup band and 4 m weld radius, so a 3×3 scan covers them.
const GRID_CELL_METERS: f64 = 16.0;
// OSM crossing nodes sit on the road centerline; structure flags suppress false welds.
const WELD_METERS: f64 = 4.0;
// Of Central Park's 318 dangling ends, 210 lie within 25 m of a walkable segment, mostly 3–15 m.
const ENTRANCE_METERS: f64 = 20.0;
// A fence-parallel path's connector runs ~90° across its exit and is rejected.
const CONTINUATION_DEGREES: f64 = 75.0;
// NYC's 60 ft right-of-way puts the property line ~9 m out; within 8 m the guard is skipped.
const CONTINUATION_FREE_METERS: f64 = 8.0;
// The right-of-way half-width: within it the two nodes are the same piece of street.
const DANGLING_MERGE_METERS: f64 = 8.0;
const DANGLING_DETOUR_METERS: f64 = 60.0;
// Merges a split within 2 m of another split or vertex, so no sliver edge is shed.
pub const SPLIT_MERGE_METERS: f64 = 2.0;
// A coincidence tolerance: 437 components lie within 1 m of the network, then a trough until 4 m.
const ISLAND_TOUCH_METERS: f64 = 1.0;
// A coincidence tolerance: alley mouths lie within 0.25 m of a centerline, the next one 5 m away.
const CSCL_TOUCH_METERS: f64 = 1.0;

pub const SIDEWALK_LEFT: u8 = 1 << 0;
pub const SIDEWALK_RIGHT: u8 = 1 << 1;

/// The same mask read against the opposite direction of travel.
pub fn swap_sidewalks(sidewalks: u8) -> u8 {
    ((sidewalks & SIDEWALK_LEFT) << 1) | ((sidewalks & SIDEWALK_RIGHT) >> 1)
}

// Mirrors graph.rs's GRPH_STRUCTURE; a deck never welds to the road beneath it.
const STRUCTURE_FLAG: u8 = 1 << 0;

/// One edge before `graph.rs` nodes it; `source_id` passes unchanged to every piece of a cut.
#[derive(Clone)]
pub struct ProtoEdge {
    pub poly_x: Vec<i32>,
    pub poly_y: Vec<i32>,
    pub length: f32,
    pub cover_left: u8,
    pub cover_right: u8,
    pub offset: u8,
    pub flags: u8,
    pub name_id: u16,
    pub osm: bool,
    pub source_id: u32,
    // GRPH kind: a CSCL street is KIND_SIDEWALK/SIDE_NONE, expanded per side; OSM arrives labeled.
    pub kind: u8,
    pub side: u8,
    // Sides getting a derived sidewalk; zero on a path, a walkable street or an OSM-mapped side.
    pub sidewalks: u8,
    // Which sides have pavement at all, derived or OSM's; despite the name, existence, not surface.
    pub paved: u8,
    // Snapped onto a derived sidewalk, so `graph.rs` binds it to the corner, not the roadway.
    pub curb_a: bool,
    pub curb_b: bool,
}

impl ProtoEdge {
    /// An OSM sidewalk or crossing way, which the park-path passes must leave alone.
    fn sidewalk_network(&self) -> bool {
        self.osm && (self.kind == KIND_SIDEWALK || self.kind == KIND_CROSSING)
    }
}

pub struct ConflateStats {
    pub deduped_ways: usize, // whole OSM ways dropped as CSCL duplicates
    pub deduped_km: f64,
    pub deduped_orphan_ways: usize, // ways dropped by the wider orphan band (step 2b)
    pub deduped_orphan_km: f64,
    pub osm_t_splits: usize, // OSM ways cut at a shared interior vertex (T-junctions)
    pub cscl_t_splits: usize, // CSCL segments cut where another CSCL end stands on their interior
    pub welded_vertices: usize, // OSM vertices moved onto a CSCL segment at an at-grade crossing
    pub entrance_snaps: usize, // dangling OSM endpoints snapped to a walking line, guard accepted
    pub entrance_snaps_curb: usize, // of those, onto a street's derived sidewalk rather than a line
    pub short_entrance_snaps: usize, // of those, accepted only because the connector was under 8 m
    pub dangling_ends: usize, // degree-1 OSM endpoints left unconnected after every step
    pub merged_dangling_ends: usize, // dangling ends pulled onto a node a block away by network
    pub island_touch_cuts: usize, // unanchored components noded onto the network they stand on
    pub cscl_splits: usize,  // interior cuts applied to CSCL segments (weld + entrance)
    pub osm_ways: usize,     // OSM ways read (before dedup)
    pub osm_km: f64,
}

pub type Point = (i32, i32);

pub fn meters_between(from: Point, to: Point, meters_per_unit: (f64, f64)) -> f64 {
    let delta_x = f64::from(to.0 - from.0) * meters_per_unit.0;
    let delta_y = f64::from(to.1 - from.1) * meters_per_unit.1;
    delta_x.hypot(delta_y)
}

/// The geodesic length of a quantized polyline, which a cut's stored length is prorated against.
pub fn polyline_meters(poly_x: &[i32], poly_y: &[i32], meters_per_unit: (f64, f64)) -> f64 {
    let mut total = 0.0;
    for vertex in 1..poly_x.len() {
        total += meters_between(
            (poly_x[vertex - 1], poly_y[vertex - 1]),
            (poly_x[vertex], poly_y[vertex]),
            meters_per_unit,
        );
    }
    total
}

pub fn bearing_degrees(from: Point, to: Point, meters_per_unit: (f64, f64)) -> f64 {
    let east = f64::from(to.0 - from.0) * meters_per_unit.0;
    let north = f64::from(to.1 - from.1) * meters_per_unit.1;
    north.atan2(east).to_degrees()
}

/// The acute angle between two undirected lines, in [0, 90].
pub fn line_angle(first_degrees: f64, second_degrees: f64) -> f64 {
    let wrapped = (first_degrees - second_degrees).rem_euclid(180.0);
    wrapped.min(180.0 - wrapped)
}

/// The angle between two directed bearings, in [0, 180].
fn directed_angle(first_degrees: f64, second_degrees: f64) -> f64 {
    let wrapped = (first_degrees - second_degrees).rem_euclid(360.0);
    wrapped.min(360.0 - wrapped)
}

/// Projects a point onto a segment: distance in meters, clamped parameter, quantized point.
pub fn project(
    point: Point,
    from: Point,
    to: Point,
    meters_per_unit: (f64, f64),
) -> (f64, f64, Point) {
    let edge_x = f64::from(to.0 - from.0) * meters_per_unit.0;
    let edge_y = f64::from(to.1 - from.1) * meters_per_unit.1;
    let point_x = f64::from(point.0 - from.0) * meters_per_unit.0;
    let point_y = f64::from(point.1 - from.1) * meters_per_unit.1;
    let length2 = edge_x * edge_x + edge_y * edge_y;
    let param = if length2 > 0.0 {
        ((point_x * edge_x + point_y * edge_y) / length2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let projected_x = f64::from(from.0) + param * f64::from(to.0 - from.0);
    let projected_y = f64::from(from.1) + param * f64::from(to.1 - from.1);
    let residual_x = (f64::from(point.0) - projected_x) * meters_per_unit.0;
    let residual_y = (f64::from(point.1) - projected_y) * meters_per_unit.1;
    let distance = residual_x.hypot(residual_y);
    (
        distance,
        param,
        (
            round_half_up(projected_x) as i32,
            round_half_up(projected_y) as i32,
        ),
    )
}

/// A 16 m grid over each polyline sub-segment `(line, vertex)`, keyed by bounding box.
pub struct SegmentGrid {
    cell_units_x: i32,
    cell_units_y: i32,
    cells: HashMap<Point, Vec<(u32, u32)>>,
}

impl SegmentGrid {
    pub fn new<'a>(
        lines: impl IntoIterator<Item = (&'a [i32], &'a [i32])>,
        meters_per_unit: (f64, f64),
    ) -> Self {
        let cell_units_x = (GRID_CELL_METERS / meters_per_unit.0).floor().max(1.0) as i32;
        let cell_units_y = (GRID_CELL_METERS / meters_per_unit.1).floor().max(1.0) as i32;
        let mut cells: HashMap<Point, Vec<(u32, u32)>> = HashMap::new();
        for (line_index, (poly_x, poly_y)) in lines.into_iter().enumerate() {
            for vertex in 0..poly_x.len() - 1 {
                let (min_x, max_x) = (
                    poly_x[vertex].min(poly_x[vertex + 1]),
                    poly_x[vertex].max(poly_x[vertex + 1]),
                );
                let (min_y, max_y) = (
                    poly_y[vertex].min(poly_y[vertex + 1]),
                    poly_y[vertex].max(poly_y[vertex + 1]),
                );
                for cell_x in min_x.div_euclid(cell_units_x)..=max_x.div_euclid(cell_units_x) {
                    for cell_y in min_y.div_euclid(cell_units_y)..=max_y.div_euclid(cell_units_y) {
                        cells
                            .entry((cell_x, cell_y))
                            .or_default()
                            .push((line_index as u32, vertex as u32));
                    }
                }
            }
        }
        Self {
            cell_units_x,
            cell_units_y,
            cells,
        }
    }

    /// Sub-segments within `radius` meters of the point, possibly duplicated.
    pub fn nearby(
        &self,
        point: Point,
        radius: f64,
        meters_per_unit: (f64, f64),
    ) -> Vec<(u32, u32)> {
        let ring_x = (radius / (f64::from(self.cell_units_x) * meters_per_unit.0)).ceil() as i32;
        let ring_y = (radius / (f64::from(self.cell_units_y) * meters_per_unit.1)).ceil() as i32;
        let center_x = point.0.div_euclid(self.cell_units_x);
        let center_y = point.1.div_euclid(self.cell_units_y);
        let mut found = Vec::new();
        for cell_x in center_x - ring_x..=center_x + ring_x {
            for cell_y in center_y - ring_y..=center_y + ring_y {
                if let Some(bucket) = self.cells.get(&(cell_x, cell_y)) {
                    found.extend_from_slice(bucket);
                }
            }
        }
        found
    }
}

/// The nearest non-structure street sub-segment within `radius`; `exclude` skips one proto.
fn nearest_street(
    grid: &SegmentGrid,
    streets: &[ProtoEdge],
    point: Point,
    radius: f64,
    exclude_structure: bool,
    exclude: Option<usize>,
    meters_per_unit: (f64, f64),
) -> Option<(usize, usize, f64, Point, f64)> {
    let mut best: Option<(usize, usize, f64, Point, f64)> = None;
    for (proto_index, vertex) in grid.nearby(point, radius, meters_per_unit) {
        let proto = &streets[proto_index as usize];
        if exclude_structure && proto.flags & STRUCTURE_FLAG != 0 {
            continue;
        }
        if exclude == Some(proto_index as usize) {
            continue;
        }
        let from = (proto.poly_x[vertex as usize], proto.poly_y[vertex as usize]);
        let to = (
            proto.poly_x[vertex as usize + 1],
            proto.poly_y[vertex as usize + 1],
        );
        let (distance, param, projected) = project(point, from, to, meters_per_unit);
        if distance <= radius && best.is_none_or(|(_, _, _, _, incumbent)| distance < incumbent) {
            best = Some((
                proto_index as usize,
                vertex as usize,
                param,
                projected,
                distance,
            ));
        }
    }
    best
}

/// A snap target for a dangling OSM end: a derived sidewalk, or a walkable centerline.
struct WalkLine {
    poly_x: Vec<i32>,
    poly_y: Vec<i32>,
    street: usize,
    /// A derived sidewalk, offset vertex for vertex, so its projection maps back to the centerline.
    curb: bool,
}

/// A derived sidewalk line, offset vertex for vertex; it overruns the corner node slightly.
fn offset_line(
    poly_x: &[i32],
    poly_y: &[i32],
    half_offset_m: f64,
    sign: f64,
    meters_per_unit: (f64, f64),
) -> (Vec<i32>, Vec<i32>) {
    let (meters_per_unit_lng, meters_per_unit_lat) = meters_per_unit;
    let count = poly_x.len();
    let same =
        |left: usize, right: usize| poly_x[left] == poly_x[right] && poly_y[left] == poly_y[right];
    let mut out_x = Vec::with_capacity(count);
    let mut out_y = Vec::with_capacity(count);
    for vertex in 0..count {
        let mut back = vertex;
        while back > 0 && same(back, vertex) {
            back -= 1;
        }
        let mut ahead = vertex;
        while ahead + 1 < count && same(ahead, vertex) {
            ahead += 1;
        }
        let tangent_east = f64::from(poly_x[ahead] - poly_x[back]) * meters_per_unit_lng;
        let tangent_north = f64::from(poly_y[ahead] - poly_y[back]) * meters_per_unit_lat;
        let length = tangent_east.hypot(tangent_north);
        let (normal_east, normal_north) = if length > 0.0 {
            (-tangent_north / length, tangent_east / length)
        } else {
            (0.0, 0.0)
        };
        let east = sign * half_offset_m * normal_east;
        let north = sign * half_offset_m * normal_north;
        out_x.push(poly_x[vertex] + round_half_up(east / meters_per_unit_lng) as i32);
        out_y.push(poly_y[vertex] + round_half_up(north / meters_per_unit_lat) as i32);
    }
    (out_x, out_y)
}

/// Every snap target: each paved side of a non-structure street, or its walkable centerline.
fn walk_lines(streets: &[ProtoEdge], meters_per_unit: (f64, f64)) -> Vec<WalkLine> {
    let mut lines = Vec::with_capacity(2 * streets.len());
    for (street, proto) in streets.iter().enumerate() {
        if proto.flags & STRUCTURE_FLAG != 0 {
            continue;
        }
        if proto.offset == 0 {
            lines.push(WalkLine {
                poly_x: proto.poly_x.clone(),
                poly_y: proto.poly_y.clone(),
                street,
                curb: false,
            });
        } else {
            let half_offset_m = f64::from(proto.offset) / DECIMETERS_PER_METER;
            for (sign, side) in [(1.0, SIDEWALK_LEFT), (-1.0, SIDEWALK_RIGHT)] {
                // `paved`: `trim_derived` zeroes `sidewalks` on OSM-mapped sides, which still count.
                if proto.paved & side == 0 {
                    continue;
                }
                let (poly_x, poly_y) = offset_line(
                    &proto.poly_x,
                    &proto.poly_y,
                    half_offset_m,
                    sign,
                    meters_per_unit,
                );
                lines.push(WalkLine {
                    poly_x,
                    poly_y,
                    street,
                    curb: true,
                });
            }
        }
    }
    lines
}

/// The nearest walking line within `radius`: line, sub-segment, parameter, point, distance.
fn nearest_walk_line(
    grid: &SegmentGrid,
    lines: &[WalkLine],
    point: Point,
    radius: f64,
    meters_per_unit: (f64, f64),
) -> Option<(usize, usize, f64, Point, f64)> {
    let mut best: Option<(usize, usize, f64, Point, f64)> = None;
    for (line_index, vertex) in grid.nearby(point, radius, meters_per_unit) {
        let line = &lines[line_index as usize];
        let from = (line.poly_x[vertex as usize], line.poly_y[vertex as usize]);
        let to = (
            line.poly_x[vertex as usize + 1],
            line.poly_y[vertex as usize + 1],
        );
        let (distance, param, projected) = project(point, from, to, meters_per_unit);
        if distance <= radius && best.is_none_or(|(_, _, _, _, incumbent)| distance < incumbent) {
            best = Some((
                line_index as usize,
                vertex as usize,
                param,
                projected,
                distance,
            ));
        }
    }
    best
}

/// Evenly spaced samples ~`DEDUP_SAMPLE_METERS` apart, each with its segment's bearing.
fn dedup_samples(poly_x: &[i32], poly_y: &[i32], meters_per_unit: (f64, f64)) -> Vec<(Point, f64)> {
    let mut prefix = vec![0.0f64];
    for vertex in 1..poly_x.len() {
        let step = meters_between(
            (poly_x[vertex - 1], poly_y[vertex - 1]),
            (poly_x[vertex], poly_y[vertex]),
            meters_per_unit,
        );
        prefix.push(prefix[vertex - 1] + step);
    }
    let total = *prefix.last().expect("a non-empty prefix");
    let count = (total / DEDUP_SAMPLE_METERS).round().max(1.0) as usize;
    let mut samples = Vec::with_capacity(count + 1);
    let mut segment = 0usize;
    for step in 0..=count {
        let target = total * step as f64 / count as f64;
        while segment + 2 < poly_x.len() && prefix[segment + 1] < target {
            segment += 1;
        }
        let span = prefix[segment + 1] - prefix[segment];
        let param = if span > 0.0 {
            (target - prefix[segment]) / span
        } else {
            0.0
        };
        let sample_x =
            f64::from(poly_x[segment]) + param * f64::from(poly_x[segment + 1] - poly_x[segment]);
        let sample_y =
            f64::from(poly_y[segment]) + param * f64::from(poly_y[segment + 1] - poly_y[segment]);
        let bearing = bearing_degrees(
            (poly_x[segment], poly_y[segment]),
            (poly_x[segment + 1], poly_y[segment + 1]),
            meters_per_unit,
        );
        samples.push((
            (
                round_half_up(sample_x) as i32,
                round_half_up(sample_y) as i32,
            ),
            bearing,
        ));
    }
    samples
}

/// The share of samples within `band` of an aligned CSCL sub-segment, optionally of the same name.
fn aligned_fraction(
    way: &ProtoEdge,
    grid: &SegmentGrid,
    streets: &[ProtoEdge],
    band: f64,
    same_name_as: Option<&str>,
    names: &[String],
    meters_per_unit: (f64, f64),
) -> f64 {
    let samples = dedup_samples(&way.poly_x, &way.poly_y, meters_per_unit);
    let mut matched = 0usize;
    for (sample, bearing) in &samples {
        let is_duplicate =
            grid.nearby(*sample, band, meters_per_unit)
                .into_iter()
                .any(|(proto_index, vertex)| {
                    let proto = &streets[proto_index as usize];
                    if same_name_as.is_some()
                        && street_key(proto.name_id, names).as_deref() != same_name_as
                    {
                        return false;
                    }
                    let from = (proto.poly_x[vertex as usize], proto.poly_y[vertex as usize]);
                    let to = (
                        proto.poly_x[vertex as usize + 1],
                        proto.poly_y[vertex as usize + 1],
                    );
                    let (distance, _, _) = project(*sample, from, to, meters_per_unit);
                    distance <= band
                        && line_angle(*bearing, bearing_degrees(from, to, meters_per_unit))
                            <= DEDUP_BEARING_DEGREES
                });
        if is_duplicate {
            matched += 1;
        }
    }
    matched as f64 / samples.len() as f64
}

/// A comparison key with CSCL suffixes expanded, except a leading word (ST NICHOLAS AVE).
fn street_key(name_id: u16, names: &[String]) -> Option<String> {
    let name = names.get(name_id as usize)?;
    let words: Vec<String> = name
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_uppercase)
        .collect();
    if words.is_empty() {
        return None;
    }
    let expanded: Vec<&str> = words
        .iter()
        .enumerate()
        .map(|(index, word)| {
            if index == 0 {
                return word.as_str();
            }
            match word.as_str() {
                "ST" => "STREET",
                "AVE" | "AV" => "AVENUE",
                "ALY" => "ALLEY",
                "BLVD" => "BOULEVARD",
                "PKWY" | "PKY" => "PARKWAY",
                "DR" => "DRIVE",
                "RD" => "ROAD",
                "LN" => "LANE",
                "CT" => "COURT",
                "PL" => "PLACE",
                "TER" | "TERR" => "TERRACE",
                "SQ" => "SQUARE",
                "PLZ" => "PLAZA",
                "CIR" => "CIRCLE",
                "TPKE" => "TURNPIKE",
                "EXPY" => "EXPRESSWAY",
                "HWY" => "HIGHWAY",
                "BRG" => "BRIDGE",
                other => other,
            }
        })
        .collect();
    Some(expanded.join(" "))
}

/// Cuts a proto at interior vertices, prorating length; only the outermost pieces keep curb ends.
fn split_at_vertices(
    parent: &ProtoEdge,
    cuts: &[usize],
    meters_per_unit: (f64, f64),
) -> Vec<ProtoEdge> {
    let full = polyline_meters(&parent.poly_x, &parent.poly_y, meters_per_unit);
    let mut boundaries: Vec<usize> = cuts.to_vec();
    boundaries.push(parent.poly_x.len() - 1);
    let last_piece = boundaries.len() - 1;
    let mut pieces = Vec::with_capacity(boundaries.len());
    let mut start = 0usize;
    for (piece_index, &end) in boundaries.iter().enumerate() {
        let poly_x = parent.poly_x[start..=end].to_vec();
        let poly_y = parent.poly_y[start..=end].to_vec();
        let piece = polyline_meters(&poly_x, &poly_y, meters_per_unit);
        let length = if full > 0.0 {
            (f64::from(parent.length) * piece / full) as f32
        } else {
            parent.length
        };
        pieces.push(ProtoEdge {
            poly_x,
            poly_y,
            length,
            cover_left: parent.cover_left,
            cover_right: parent.cover_right,
            offset: parent.offset,
            flags: parent.flags,
            name_id: parent.name_id,
            osm: parent.osm,
            source_id: parent.source_id,
            kind: parent.kind,
            side: parent.side,
            sidewalks: parent.sidewalks,
            paved: parent.paved,
            curb_a: parent.curb_a && piece_index == 0,
            curb_b: parent.curb_b && piece_index == last_piece,
        });
        start = end;
    }
    pieces
}

struct Split {
    along: f64,
    point: Point,
}

/// Merges each split onto a vertex or cut within 2 m, cuts there, and records the moved points.
fn apply_splits(
    proto: ProtoEdge,
    splits: &mut [Split],
    relocate: &mut HashMap<Point, Point>,
    meters_per_unit: (f64, f64),
) -> (Vec<ProtoEdge>, usize) {
    splits.sort_by(|left, right| left.along.total_cmp(&right.along));
    let vertex_along = vertex_prefix(&proto.poly_x, &proto.poly_y, meters_per_unit);
    let last = proto.poly_x.len() - 1;

    let mut existing_cuts: HashSet<usize> = HashSet::new();
    let mut inserted: Vec<(f64, Point)> = Vec::new();
    for split in splits.iter() {
        // By along-distance, a proxy for meters on the polyline.
        let mut nearest_vertex = 0usize;
        let mut nearest_gap = f64::INFINITY;
        for (vertex, &along) in vertex_along.iter().enumerate() {
            let gap = (along - split.along).abs();
            if gap < nearest_gap {
                nearest_gap = gap;
                nearest_vertex = vertex;
            }
        }
        if nearest_gap <= SPLIT_MERGE_METERS {
            let target = (proto.poly_x[nearest_vertex], proto.poly_y[nearest_vertex]);
            if split.point != target {
                relocate.insert(split.point, target);
            }
            if nearest_vertex != 0 && nearest_vertex != last {
                existing_cuts.insert(nearest_vertex);
            }
            continue;
        }
        if let Some((_, target)) = inserted
            .iter()
            .find(|(along, _)| (along - split.along).abs() <= SPLIT_MERGE_METERS)
            .copied()
        {
            if split.point != target {
                relocate.insert(split.point, target);
            }
        } else {
            inserted.push((split.along, split.point));
        }
    }

    if existing_cuts.is_empty() && inserted.is_empty() {
        return (vec![proto], 0);
    }

    let mut vertices: Vec<(f64, Point, bool)> = Vec::with_capacity(last + 1 + inserted.len());
    for (vertex, &along) in vertex_along.iter().enumerate() {
        vertices.push((
            along,
            (proto.poly_x[vertex], proto.poly_y[vertex]),
            existing_cuts.contains(&vertex),
        ));
    }
    for (along, point) in inserted {
        vertices.push((along, point, true));
    }
    vertices.sort_by(|left, right| left.0.total_cmp(&right.0));

    let mut woven = ProtoEdge {
        poly_x: vertices.iter().map(|entry| entry.1.0).collect(),
        poly_y: vertices.iter().map(|entry| entry.1.1).collect(),
        ..proto
    };
    let woven_last = woven.poly_x.len() - 1;
    let cuts: Vec<usize> = (1..woven_last)
        .filter(|&vertex| vertices[vertex].2)
        .collect();
    // All splits snapped to an endpoint, so the edge stays whole.
    if cuts.is_empty() {
        woven.poly_x = proto.poly_x;
        woven.poly_y = proto.poly_y;
        (vec![woven], 0)
    } else {
        let count = cuts.len();
        (split_at_vertices(&woven, &cuts, meters_per_unit), count)
    }
}

/// Step 0: a street endpoint on another street's interior cuts it there and moves onto the cut.
fn node_streets(streets: Vec<ProtoEdge>, meters_per_unit: (f64, f64)) -> (Vec<ProtoEdge>, usize) {
    let grid = SegmentGrid::new(
        streets
            .iter()
            .map(|proto| (&proto.poly_x[..], &proto.poly_y[..])),
        meters_per_unit,
    );
    let mut splits_by_proto: HashMap<usize, Vec<Split>> = HashMap::new();
    let mut touched: HashMap<Point, Point> = HashMap::new(); // the end, and the cut it moves onto
    for (proto_index, proto) in streets.iter().enumerate() {
        let last = proto.poly_x.len() - 1;
        for endpoint in [
            (proto.poly_x[0], proto.poly_y[0]),
            (proto.poly_x[last], proto.poly_y[last]),
        ] {
            if touched.contains_key(&endpoint) {
                continue; // two alleys sharing one mouth cut the street once
            }
            let Some((target, seg, param, projected, _)) = nearest_street(
                &grid,
                &streets,
                endpoint,
                CSCL_TOUCH_METERS,
                true,
                Some(proto_index),
                meters_per_unit,
            ) else {
                continue;
            };
            let target_last = streets[target].poly_x.len() - 1;
            let ends_of_target = [
                (streets[target].poly_x[0], streets[target].poly_y[0]),
                (
                    streets[target].poly_x[target_last],
                    streets[target].poly_y[target_last],
                ),
            ];
            if ends_of_target
                .iter()
                .any(|&end| meters_between(projected, end, meters_per_unit) <= SPLIT_MERGE_METERS)
            {
                continue;
            }
            splits_by_proto.entry(target).or_default().push(Split {
                along: along_at(
                    &streets[target].poly_x,
                    &streets[target].poly_y,
                    seg,
                    param,
                    meters_per_unit,
                ),
                point: projected,
            });
            touched.insert(endpoint, projected);
        }
    }

    let mut relocate: HashMap<Point, Point> = HashMap::new();
    let mut cscl_t_splits = 0usize;
    let mut noded: Vec<ProtoEdge> = Vec::with_capacity(streets.len());
    for (proto_index, proto) in streets.into_iter().enumerate() {
        match splits_by_proto.remove(&proto_index) {
            Some(mut splits) => {
                let (pieces, cuts) =
                    apply_splits(proto, &mut splits, &mut relocate, meters_per_unit);
                cscl_t_splits += cuts;
                noded.extend(pieces);
            }
            None => noded.push(proto),
        }
    }
    // Applied last so an end whose cut merged onto a vertex follows it there.
    for proto in &mut noded {
        for vertex in [0, proto.poly_x.len() - 1] {
            let Some(&cut) = touched.get(&(proto.poly_x[vertex], proto.poly_y[vertex])) else {
                continue;
            };
            let cut = relocate.get(&cut).copied().unwrap_or(cut);
            proto.poly_x[vertex] = cut.0;
            proto.poly_y[vertex] = cut.1;
        }
    }
    (noded, cscl_t_splits)
}

/// Steps 1–6 over the noded CSCL network; returns the combined list `graph.rs` nodes.
pub fn conflate(
    streets: Vec<ProtoEdge>,
    paths: Vec<ProtoEdge>,
    names: &[String],
    meters_per_unit: (f64, f64),
) -> (Vec<ProtoEdge>, ConflateStats) {
    let osm_ways = paths.len();
    let osm_km = paths.iter().map(|way| f64::from(way.length)).sum::<f64>() / 1000.0;

    let (streets, cscl_t_splits) = node_streets(streets, meters_per_unit);
    let grid = SegmentGrid::new(
        streets
            .iter()
            .map(|proto| (&proto.poly_x[..], &proto.poly_y[..])),
        meters_per_unit,
    );

    let mut deduped_ways = 0usize;
    let mut deduped_km = 0.0;
    let mut ways: Vec<ProtoEdge> = Vec::with_capacity(paths.len());
    for way in paths {
        if !way.sidewalk_network()
            && aligned_fraction(
                &way,
                &grid,
                &streets,
                DEDUP_METERS,
                None,
                names,
                meters_per_unit,
            ) >= DEDUP_FRACTION
        {
            deduped_ways += 1;
            deduped_km += f64::from(way.length) / 1000.0;
        } else {
            ways.push(way);
        }
    }

    // Step 2: T-split OSM ways at an interior vertex that is another way's endpoint.
    let mut endpoints: HashSet<Point> = HashSet::new();
    for way in &ways {
        endpoints.insert((way.poly_x[0], way.poly_y[0]));
        endpoints.insert((
            *way.poly_x.last().expect("a vertex"),
            *way.poly_y.last().expect("a vertex"),
        ));
    }
    let mut osm_t_splits = 0usize;
    let mut noded: Vec<ProtoEdge> = Vec::with_capacity(ways.len());
    for way in ways {
        let last = way.poly_x.len() - 1;
        let cuts: Vec<usize> = (1..last)
            .filter(|&vertex| endpoints.contains(&(way.poly_x[vertex], way.poly_y[vertex])))
            .collect();
        if cuts.is_empty() {
            noded.push(way);
        } else {
            osm_t_splits += cuts.len();
            noded.extend(split_at_vertices(&way, &cuts, meters_per_unit));
        }
    }
    let ways = noded;

    // Step 2b: the wider dedup, requiring the same name as the CSCL segment and no shared OSM node.
    let mut way_ends: HashMap<Point, usize> = HashMap::new();
    for way in &ways {
        let last = way.poly_x.len() - 1;
        *way_ends.entry((way.poly_x[0], way.poly_y[0])).or_default() += 1;
        *way_ends
            .entry((way.poly_x[last], way.poly_y[last]))
            .or_default() += 1;
    }
    let mut deduped_orphan_ways = 0usize;
    let mut deduped_orphan_km = 0.0;
    let mut kept: Vec<ProtoEdge> = Vec::with_capacity(ways.len());
    for way in ways {
        let last = way.poly_x.len() - 1;
        let standalone = way.flags & STRUCTURE_FLAG == 0
            && !way.sidewalk_network()
            && way_ends[&(way.poly_x[0], way.poly_y[0])] == 1
            && way_ends[&(way.poly_x[last], way.poly_y[last])] == 1;
        let way_name = street_key(way.name_id, names);
        if standalone
            && way_name.is_some()
            && aligned_fraction(
                &way,
                &grid,
                &streets,
                ORPHAN_DEDUP_METERS,
                way_name.as_deref(),
                names,
                meters_per_unit,
            ) >= DEDUP_FRACTION
        {
            deduped_orphan_ways += 1;
            deduped_orphan_km += f64::from(way.length) / 1000.0;
        } else {
            kept.push(way);
        }
    }
    let ways = kept;

    // Step 3: weld OSM vertices to CSCL within 4 m, except sidewalk ways and lone way ends.
    let mut way_end_count: HashMap<Point, usize> = HashMap::new();
    for way in &ways {
        let last = way.poly_x.len() - 1;
        *way_end_count
            .entry((way.poly_x[0], way.poly_y[0]))
            .or_default() += 1;
        *way_end_count
            .entry((way.poly_x[last], way.poly_y[last]))
            .or_default() += 1;
    }
    let mut cscl_splits_by_proto: HashMap<usize, Vec<Split>> = HashMap::new();
    let mut welded_coords: HashSet<Point> = HashSet::new();
    let mut welded_vertices = 0usize;
    let mut welded: Vec<ProtoEdge> = Vec::with_capacity(ways.len());
    for mut way in ways {
        if way.flags & STRUCTURE_FLAG != 0 || way.sidewalk_network() {
            welded.push(way);
            continue;
        }
        let last = way.poly_x.len() - 1;
        let mut interior_cuts: Vec<usize> = Vec::new();
        for vertex in 0..=last {
            let point = (way.poly_x[vertex], way.poly_y[vertex]);
            if (vertex == 0 || vertex == last) && way_end_count[&point] == 1 {
                continue;
            }
            let Some((proto_index, seg, param, projected, _)) = nearest_street(
                &grid,
                &streets,
                point,
                WELD_METERS,
                true,
                None,
                meters_per_unit,
            ) else {
                continue;
            };
            way.poly_x[vertex] = projected.0;
            way.poly_y[vertex] = projected.1;
            welded_coords.insert(projected);
            welded_vertices += 1;
            let along = along_at(
                &streets[proto_index].poly_x,
                &streets[proto_index].poly_y,
                seg,
                param,
                meters_per_unit,
            );
            cscl_splits_by_proto
                .entry(proto_index)
                .or_default()
                .push(Split {
                    along,
                    point: projected,
                });
            if vertex != 0 && vertex != last {
                interior_cuts.push(vertex);
            }
        }
        if interior_cuts.is_empty() {
            welded.push(way);
        } else {
            welded.extend(split_at_vertices(&way, &interior_cuts, meters_per_unit));
        }
    }
    let mut ways = welded;

    // Step 4: snap dangling OSM ends to a walking line within 20 m, against unedited geometry.
    let lines = walk_lines(&streets, meters_per_unit);
    let walk_grid = SegmentGrid::new(
        lines
            .iter()
            .map(|line| (&line.poly_x[..], &line.poly_y[..])),
        meters_per_unit,
    );
    let mut endpoint_degree: HashMap<Point, usize> = HashMap::new();
    for way in &ways {
        *endpoint_degree
            .entry((way.poly_x[0], way.poly_y[0]))
            .or_default() += 1;
        *endpoint_degree
            .entry((
                *way.poly_x.last().expect("a vertex"),
                *way.poly_y.last().expect("a vertex"),
            ))
            .or_default() += 1;
    }
    let mut entrance_snaps = 0usize;
    let mut entrance_snaps_curb = 0usize;
    let mut short_entrance_snaps = 0usize;
    let mut dangling_ends = 0usize;
    for way in &mut ways {
        for at_start in [true, false] {
            let last = way.poly_x.len() - 1;
            let endpoint = if at_start {
                (way.poly_x[0], way.poly_y[0])
            } else {
                (way.poly_x[last], way.poly_y[last])
            };
            let connected = endpoint_degree.get(&endpoint).copied().unwrap_or(0) >= 2
                || welded_coords.contains(&endpoint);
            if connected {
                continue;
            }
            let Some((line_index, seg, param, projected, _)) = nearest_walk_line(
                &walk_grid,
                &lines,
                endpoint,
                ENTRANCE_METERS,
                meters_per_unit,
            ) else {
                dangling_ends += 1;
                continue;
            };
            // The connector must continue the way's exit bearing, not run across it.
            let interior = if at_start {
                first_distinct(&way.poly_x, &way.poly_y, 0, 1)
            } else {
                first_distinct(&way.poly_x, &way.poly_y, last, -1)
            };
            let Some(interior_vertex) = interior else {
                dangling_ends += 1;
                continue;
            };
            let exit = bearing_degrees(
                (way.poly_x[interior_vertex], way.poly_y[interior_vertex]),
                endpoint,
                meters_per_unit,
            );
            // Split on the centerline, which the guard and its waiver are still measured to.
            let line = &lines[line_index];
            let join = point_on_segment(
                &streets[line.street].poly_x,
                &streets[line.street].poly_y,
                seg,
                param,
            );
            let connector = bearing_degrees(endpoint, join, meters_per_unit);
            let turned = directed_angle(exit, connector) > CONTINUATION_DEGREES;
            if turned && meters_between(endpoint, join, meters_per_unit) > CONTINUATION_FREE_METERS
            {
                dangling_ends += 1;
                continue;
            }
            if turned {
                short_entrance_snaps += 1;
            }
            let along = along_at(
                &streets[line.street].poly_x,
                &streets[line.street].poly_y,
                seg,
                param,
                meters_per_unit,
            );
            cscl_splits_by_proto
                .entry(line.street)
                .or_default()
                .push(Split { along, point: join });
            if line.curb {
                entrance_snaps_curb += 1;
            }
            // The connector costs the walk to the pavement, not to the middle of the road.
            let connector_meters = meters_between(endpoint, projected, meters_per_unit) as f32;
            if at_start {
                way.poly_x.insert(0, join.0);
                way.poly_y.insert(0, join.1);
                way.curb_a = line.curb;
            } else {
                way.poly_x.push(join.0);
                way.poly_y.push(join.1);
                way.curb_b = line.curb;
            }
            way.length += connector_meters;
            entrance_snaps += 1;
        }
    }

    // Step 5: apply the CSCL splits.
    let mut streets = streets;
    let mut relocate: HashMap<Point, Point> = HashMap::new();
    let mut cscl_splits = 0usize;
    let mut split_streets: Vec<ProtoEdge> = Vec::with_capacity(streets.len());
    let mut per_street: Vec<Option<Vec<Split>>> = (0..streets.len()).map(|_| None).collect();
    for (proto_index, splits) in cscl_splits_by_proto {
        per_street[proto_index] = Some(splits);
    }
    for (proto_index, proto) in streets.drain(..).enumerate() {
        match per_street[proto_index].take() {
            Some(mut splits) => {
                let (pieces, cuts) =
                    apply_splits(proto, &mut splits, &mut relocate, meters_per_unit);
                cscl_splits += cuts;
                split_streets.extend(pieces);
            }
            None => split_streets.push(proto),
        }
    }

    // Move OSM vertices whose splits merged onto a vertex or earlier cut to its exact coordinate.
    if !relocate.is_empty() {
        for way in &mut ways {
            for vertex in 0..way.poly_x.len() {
                if let Some(&target) = relocate.get(&(way.poly_x[vertex], way.poly_y[vertex])) {
                    way.poly_x[vertex] = target.0;
                    way.poly_y[vertex] = target.1;
                }
            }
        }
    }

    let mut combined = split_streets;
    combined.extend(ways);

    // Step 6 runs on the finished list so it sees every weld, snap and split.
    let merged_dangling_ends = merge_dangling_ends(&mut combined, meters_per_unit);

    // Step 7: node unanchored walking components onto the network they stand on.
    let (combined, island_touch_cuts) = cut_island_touches(combined, meters_per_unit);

    let stats = ConflateStats {
        island_touch_cuts,
        deduped_ways,
        deduped_km,
        deduped_orphan_ways,
        deduped_orphan_km,
        osm_t_splits,
        cscl_t_splits,
        welded_vertices,
        entrance_snaps,
        entrance_snaps_curb,
        short_entrance_snaps,
        dangling_ends,
        merged_dangling_ends,
        cscl_splits,
        osm_ways,
        osm_km,
    };
    (combined, stats)
}

/// Step 6: pulls a dangling OSM end onto a node within reach by distance but far by network.
fn merge_dangling_ends(protos: &mut [ProtoEdge], meters_per_unit: (f64, f64)) -> usize {
    let mut node_of: HashMap<Point, u32> = HashMap::new();
    let mut node_point: Vec<Point> = Vec::new();
    let mut ends: Vec<(u32, u32)> = Vec::with_capacity(protos.len());
    for proto in protos.iter() {
        let last = proto.poly_x.len() - 1;
        let mut intern = |point: Point| -> u32 {
            let next = node_point.len() as u32;
            *node_of.entry(point).or_insert_with(|| {
                node_point.push(point);
                next
            })
        };
        let node_a = intern((proto.poly_x[0], proto.poly_y[0]));
        let node_b = intern((proto.poly_x[last], proto.poly_y[last]));
        ends.push((node_a, node_b));
    }
    let node_count = node_point.len();

    // Adjacency, plus whether a node is a structure deck and its one proto when dangling.
    let mut adjacency: Vec<Vec<(u32, f64)>> = vec![Vec::new(); node_count];
    let mut structure: Vec<bool> = vec![false; node_count];
    let mut sole_proto: Vec<u32> = vec![u32::MAX; node_count];
    for (proto_index, &(node_a, node_b)) in ends.iter().enumerate() {
        let proto = &protos[proto_index];
        let length = f64::from(proto.length).max(0.0);
        adjacency[node_a as usize].push((node_b, length));
        adjacency[node_b as usize].push((node_a, length));
        for node in [node_a, node_b] {
            structure[node as usize] |= proto.flags & STRUCTURE_FLAG != 0;
            sole_proto[node as usize] = proto_index as u32;
        }
    }

    let cell_units_x = (GRID_CELL_METERS / meters_per_unit.0).floor().max(1.0) as i32;
    let cell_units_y = (GRID_CELL_METERS / meters_per_unit.1).floor().max(1.0) as i32;
    let mut cells: HashMap<Point, Vec<u32>> = HashMap::new();
    for (node, point) in node_point.iter().enumerate() {
        cells
            .entry((
                point.0.div_euclid(cell_units_x),
                point.1.div_euclid(cell_units_y),
            ))
            .or_default()
            .push(node as u32);
    }

    let mut parent: Vec<u32> = (0..node_count as u32).collect();
    let mut merged = 0usize;
    for node in 0..node_count {
        if adjacency[node].len() != 1 || structure[node] {
            continue;
        }
        let proto_index = sole_proto[node] as usize;
        if !protos[proto_index].osm {
            continue;
        }
        let point = node_point[node];
        let cell = (
            point.0.div_euclid(cell_units_x),
            point.1.div_euclid(cell_units_y),
        );
        let mut candidates: Vec<(f64, u32)> = Vec::new();
        for cell_x in cell.0 - 1..=cell.0 + 1 {
            for cell_y in cell.1 - 1..=cell.1 + 1 {
                for &other in cells.get(&(cell_x, cell_y)).into_iter().flatten() {
                    if other as usize == node || structure[other as usize] {
                        continue;
                    }
                    let gap = meters_between(point, node_point[other as usize], meters_per_unit);
                    if gap <= DANGLING_MERGE_METERS {
                        candidates.push((gap, other));
                    }
                }
            }
        }
        if candidates.is_empty() {
            continue;
        }
        candidates.sort_by(|left, right| left.0.total_cmp(&right.0).then(left.1.cmp(&right.1)));
        let reached = reachable_within(
            &adjacency,
            node as u32,
            DANGLING_DETOUR_METERS,
            &candidates.iter().map(|&(_, other)| other).collect(),
        );
        // Merging onto the proto's own far end would fold it into a degenerate loop.
        let own_far_end = if ends[proto_index].0 == node as u32 {
            ends[proto_index].1
        } else {
            ends[proto_index].0
        };
        for &(_, other) in &candidates {
            if reached.contains(&other) {
                continue;
            }
            let (from_root, to_root) = (find(&mut parent, node as u32), find(&mut parent, other));
            if from_root == to_root || to_root == find(&mut parent, own_far_end) {
                continue;
            }
            parent[from_root as usize] = to_root;
            merged += 1;
            break;
        }
    }
    if merged == 0 {
        return 0;
    }

    for (proto_index, proto) in protos.iter_mut().enumerate() {
        let last = proto.poly_x.len() - 1;
        for (vertex, node) in [(0, ends[proto_index].0), (last, ends[proto_index].1)] {
            let target = node_point[find(&mut parent, node) as usize];
            proto.poly_x[vertex] = target.0;
            proto.poly_y[vertex] = target.1;
        }
    }
    merged
}

/// Step 7: cuts an anchored line where an island vertex stands on it; neither may be a structure.
fn cut_island_touches(
    protos: Vec<ProtoEdge>,
    meters_per_unit: (f64, f64),
) -> (Vec<ProtoEdge>, usize) {
    let mut protos = protos;
    let mut cuts = 0usize;
    // Runs to a fixed point, since one join can bring another island within reach.
    loop {
        let round = cut_island_touch_round(&mut protos, meters_per_unit);
        cuts += round;
        if round == 0 {
            return (protos, cuts);
        }
    }
}

/// One round of step 7: every currently unanchored component takes at most one join.
fn cut_island_touch_round(protos: &mut Vec<ProtoEdge>, meters_per_unit: (f64, f64)) -> usize {
    let (component, anchored) = walking_components(protos);
    let anchored_protos: Vec<usize> = (0..protos.len())
        .filter(|&proto| anchored.contains(&component[proto]))
        .collect();
    if anchored_protos.len() == protos.len() {
        return 0;
    }
    let grid = SegmentGrid::new(
        anchored_protos
            .iter()
            .map(|&proto| (&protos[proto].poly_x[..], &protos[proto].poly_y[..])),
        meters_per_unit,
    );

    struct Touch {
        distance: f64,
        island: usize,
        vertex: usize,
        target: usize,
        along: f64,
        point: Point,
    }
    let mut best: HashMap<u32, Touch> = HashMap::new();
    for (island, proto) in protos.iter().enumerate() {
        let root = component[island];
        if anchored.contains(&root) || proto.flags & STRUCTURE_FLAG != 0 {
            continue;
        }
        for vertex in 0..proto.poly_x.len() {
            let point = (proto.poly_x[vertex], proto.poly_y[vertex]);
            for (line, sub) in grid.nearby(point, ISLAND_TOUCH_METERS, meters_per_unit) {
                let target = anchored_protos[line as usize];
                let candidate = &protos[target];
                if candidate.flags & STRUCTURE_FLAG != 0 {
                    continue;
                }
                let (sub, last) = (sub as usize, candidate.poly_x.len() - 1);
                let (distance, param, projected) = project(
                    point,
                    (candidate.poly_x[sub], candidate.poly_y[sub]),
                    (candidate.poly_x[sub + 1], candidate.poly_y[sub + 1]),
                    meters_per_unit,
                );
                if distance > ISLAND_TOUCH_METERS
                    || best
                        .get(&root)
                        .is_some_and(|incumbent| incumbent.distance <= distance)
                {
                    continue;
                }
                let ends = [
                    (candidate.poly_x[0], candidate.poly_y[0]),
                    (candidate.poly_x[last], candidate.poly_y[last]),
                ];
                if ends.iter().any(|&end| {
                    meters_between(projected, end, meters_per_unit) <= SPLIT_MERGE_METERS
                }) {
                    continue;
                }
                best.insert(
                    root,
                    Touch {
                        distance,
                        island,
                        vertex,
                        target,
                        along: along_at(
                            &candidate.poly_x,
                            &candidate.poly_y,
                            sub,
                            param,
                            meters_per_unit,
                        ),
                        point: projected,
                    },
                );
            }
        }
    }
    if best.is_empty() {
        return 0;
    }

    let mut target_splits: HashMap<usize, Vec<Split>> = HashMap::new();
    let mut island_cuts: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut moved: HashMap<Point, Point> = HashMap::new();
    let mut touches: Vec<&Touch> = best.values().collect();
    touches.sort_by_key(|touch| (touch.island, touch.vertex));
    for touch in &touches {
        let proto = &protos[touch.island];
        let point = (proto.poly_x[touch.vertex], proto.poly_y[touch.vertex]);
        if moved.contains_key(&point) {
            continue; // two islands already sharing this coordinate cut the line once
        }
        target_splits.entry(touch.target).or_default().push(Split {
            along: touch.along,
            point: touch.point,
        });
        if touch.vertex != 0 && touch.vertex != proto.poly_x.len() - 1 {
            island_cuts
                .entry(touch.island)
                .or_default()
                .push(touch.vertex);
        }
        moved.insert(point, touch.point);
    }
    let joined = moved.len();

    let mut relocate: HashMap<Point, Point> = HashMap::new();
    let mut rebuilt: Vec<ProtoEdge> = Vec::with_capacity(protos.len() + 2 * joined);
    for (index, proto) in protos.drain(..).enumerate() {
        match (target_splits.remove(&index), island_cuts.remove(&index)) {
            (Some(mut splits), _) => {
                let (pieces, _) = apply_splits(proto, &mut splits, &mut relocate, meters_per_unit);
                rebuilt.extend(pieces);
            }
            (None, Some(mut vertices)) => {
                vertices.sort_unstable();
                rebuilt.extend(split_at_vertices(&proto, &vertices, meters_per_unit));
            }
            (None, None) => rebuilt.push(proto),
        }
    }
    // Only the island moves; CSCL geometry and OSM pavement stay where they were drawn.
    let (component, anchored) = walking_components(&rebuilt);
    for (index, proto) in rebuilt.iter_mut().enumerate() {
        if anchored.contains(&component[index]) {
            continue;
        }
        for vertex in 0..proto.poly_x.len() {
            let Some(&cut) = moved.get(&(proto.poly_x[vertex], proto.poly_y[vertex])) else {
                continue;
            };
            let cut = relocate.get(&cut).copied().unwrap_or(cut);
            proto.poly_x[vertex] = cut.0;
            proto.poly_y[vertex] = cut.1;
        }
    }
    *protos = rebuilt;
    joined
}

/// Connected components by root, and which roots the island drop keeps; must match the drop's test.
fn walking_components(protos: &[ProtoEdge]) -> (Vec<u32>, HashSet<u32>) {
    let mut node_of: HashMap<Point, u32> = HashMap::new();
    let mut ends: Vec<(u32, u32)> = Vec::with_capacity(protos.len());
    for proto in protos {
        let last = proto.poly_x.len() - 1;
        let mut intern = |point: Point| -> u32 {
            let next = node_of.len() as u32;
            *node_of.entry(point).or_insert(next)
        };
        ends.push((
            intern((proto.poly_x[0], proto.poly_y[0])),
            intern((proto.poly_x[last], proto.poly_y[last])),
        ));
    }
    let mut parent: Vec<u32> = (0..node_of.len() as u32).collect();
    for &(node_a, node_b) in &ends {
        let (root_a, root_b) = (find(&mut parent, node_a), find(&mut parent, node_b));
        parent[root_a as usize] = root_b;
    }
    let component: Vec<u32> = ends
        .iter()
        .map(|&(node_a, _)| find(&mut parent, node_a))
        .collect();
    let mut anchored: HashSet<u32> = HashSet::new();
    for (proto, &root) in protos.iter().zip(&component) {
        if !proto.osm || proto.kind == KIND_SIDEWALK {
            anchored.insert(root);
        }
    }
    (component, anchored)
}

/// A node's neighbors with lengths in meters.
pub trait Adjacency {
    fn neighbors(&self, node: u32) -> &[(u32, f64)];
}

impl Adjacency for [Vec<(u32, f64)>] {
    fn neighbors(&self, node: u32) -> &[(u32, f64)] {
        &self[node as usize]
    }
}

/// Dijkstra capped at `cap` meters; `settle` sees each node once and can stop the walk.
pub fn walk_within<A: Adjacency + ?Sized>(
    adjacency: &A,
    source: u32,
    cap: f64,
    mut settle: impl FnMut(u32) -> ControlFlow<()>,
) {
    let mut best: HashMap<u32, f64> = HashMap::from([(source, 0.0)]);
    // Centimeters, so the queue orders on an integer key.
    let mut queue: BinaryHeap<Reverse<(u64, u32)>> = BinaryHeap::from([Reverse((0, source))]);
    while let Some(Reverse((centimeters, node))) = queue.pop() {
        let distance = centimeters as f64 / 100.0;
        if best
            .get(&node)
            .is_some_and(|&incumbent| distance > incumbent + 0.01)
        {
            continue;
        }
        if settle(node).is_break() {
            return;
        }
        for &(next, length) in adjacency.neighbors(node) {
            let step = distance + length;
            if step > cap {
                continue;
            }
            if best.get(&next).is_none_or(|&incumbent| step < incumbent) {
                best.insert(next, step);
                queue.push(Reverse(((step * 100.0) as u64, next)));
            }
        }
    }
}

fn reachable_within(
    adjacency: &[Vec<(u32, f64)>],
    source: u32,
    cap: f64,
    targets: &HashSet<u32>,
) -> HashSet<u32> {
    let mut reached: HashSet<u32> = HashSet::new();
    walk_within(adjacency, source, cap, |node| {
        if targets.contains(&node) {
            reached.insert(node);
            if reached.len() == targets.len() {
                return ControlFlow::Break(());
            }
        }
        ControlFlow::Continue(())
    });
    reached
}

/// Union-find; the root's coordinate is where every end in the group lands.
fn find(parent: &mut [u32], node: u32) -> u32 {
    let mut root = node;
    while parent[root as usize] != root {
        root = parent[root as usize];
    }
    let mut walk = node;
    while parent[walk as usize] != root {
        let next = parent[walk as usize];
        parent[walk as usize] = root;
        walk = next;
    }
    root
}

/// The along-distance in meters to parameter `param` on sub-segment `seg`.
pub fn along_at(
    poly_x: &[i32],
    poly_y: &[i32],
    seg: usize,
    param: f64,
    meters_per_unit: (f64, f64),
) -> f64 {
    let mut prefix = 0.0;
    for vertex in 1..=seg {
        prefix += meters_between(
            (poly_x[vertex - 1], poly_y[vertex - 1]),
            (poly_x[vertex], poly_y[vertex]),
            meters_per_unit,
        );
    }
    let span = meters_between(
        (poly_x[seg], poly_y[seg]),
        (poly_x[seg + 1], poly_y[seg + 1]),
        meters_per_unit,
    );
    prefix + param * span
}

/// The quantized point at `param` along sub-segment `seg`.
fn point_on_segment(poly_x: &[i32], poly_y: &[i32], seg: usize, param: f64) -> Point {
    let x = f64::from(poly_x[seg]) + param * f64::from(poly_x[seg + 1] - poly_x[seg]);
    let y = f64::from(poly_y[seg]) + param * f64::from(poly_y[seg + 1] - poly_y[seg]);
    (round_half_up(x) as i32, round_half_up(y) as i32)
}

fn vertex_prefix(poly_x: &[i32], poly_y: &[i32], meters_per_unit: (f64, f64)) -> Vec<f64> {
    let mut prefix = Vec::with_capacity(poly_x.len());
    prefix.push(0.0);
    for vertex in 1..poly_x.len() {
        let step = meters_between(
            (poly_x[vertex - 1], poly_y[vertex - 1]),
            (poly_x[vertex], poly_y[vertex]),
            meters_per_unit,
        );
        prefix.push(prefix[vertex - 1] + step);
    }
    prefix
}

/// The first vertex distinct from `origin`, stepping by `step`, for the exit bearing.
fn first_distinct(poly_x: &[i32], poly_y: &[i32], origin: usize, step: isize) -> Option<usize> {
    let mut vertex = origin as isize + step;
    while vertex >= 0 && (vertex as usize) < poly_x.len() {
        let index = vertex as usize;
        if poly_x[index] != poly_x[origin] || poly_y[index] != poly_y[origin] {
            return Some(index);
        }
        vertex += step;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{KIND_PATH, SIDE_NONE};

    // Quantized units are meters.
    const MPU: (f64, f64) = (1.0, 1.0);

    fn street(poly: &[(i32, i32)]) -> ProtoEdge {
        line(poly, false, 0)
    }

    fn path(poly: &[(i32, i32)]) -> ProtoEdge {
        line(poly, true, 4) // GRPH_PATHLIKE, as an OSM proto carries
    }

    fn line(poly: &[(i32, i32)], osm: bool, flags: u8) -> ProtoEdge {
        let poly_x: Vec<i32> = poly.iter().map(|point| point.0).collect();
        let poly_y: Vec<i32> = poly.iter().map(|point| point.1).collect();
        let length = polyline_meters(&poly_x, &poly_y, MPU) as f32;
        ProtoEdge {
            poly_x,
            poly_y,
            length,
            cover_left: 0,
            cover_right: 0,
            offset: if osm { 0 } else { 40 },
            flags,
            name_id: 0xFFFF,
            osm,
            source_id: 0,
            kind: if osm { KIND_PATH } else { KIND_SIDEWALK },
            side: SIDE_NONE,
            sidewalks: if osm {
                0
            } else {
                SIDEWALK_LEFT | SIDEWALK_RIGHT
            },
            paved: if osm {
                0
            } else {
                SIDEWALK_LEFT | SIDEWALK_RIGHT
            },
            curb_a: false,
            curb_b: false,
        }
    }

    // Offset 0, so its own centerline is the walking line.
    fn walkway(poly: &[(i32, i32)]) -> ProtoEdge {
        let mut edge = line(poly, false, 4); // GRPH_PATHLIKE
        edge.offset = 0;
        edge
    }

    fn with_source_id(mut edge: ProtoEdge, source_id: u32) -> ProtoEdge {
        edge.source_id = source_id;
        edge
    }

    // OSM's own pavement, which anchors a component without CSCL dedup or weld.
    fn mapped_sidewalk(poly: &[(i32, i32)]) -> ProtoEdge {
        let mut edge = path(poly);
        edge.kind = KIND_SIDEWALK;
        edge
    }

    // Components in the list, and how many the island drop would keep.
    fn components(protos: &[ProtoEdge]) -> (usize, usize) {
        let (component, anchored) = walking_components(protos);
        let roots: HashSet<u32> = component.iter().copied().collect();
        (roots.len(), anchored.len())
    }

    #[test]
    fn a_component_nothing_anchors_is_noded_onto_the_line_it_stands_on() {
        // The trail ends on the pavement's interior with no shared vertex; only step 7 joins them.
        let pavement = mapped_sidewalk(&[(0, 0), (100, 0)]);
        let trail = path(&[(50, 0), (50, 40), (90, 40)]);
        let (combined, stats) = conflate(vec![], vec![pavement, trail], &[], MPU);
        assert_eq!(stats.island_touch_cuts, 1);
        assert_eq!(
            combined
                .iter()
                .filter(|edge| edge.kind == KIND_SIDEWALK)
                .count(),
            2,
            "the pavement was cut at the touch"
        );
        assert_eq!(
            components(&combined),
            (1, 1),
            "and nothing is left stranded"
        );
    }

    #[test]
    fn a_component_standing_clear_of_the_network_is_left_for_the_island_drop() {
        // A 3 m gap is a gap in what OSM drew, not a missing node.
        let pavement = mapped_sidewalk(&[(0, 0), (100, 0)]);
        let trail = path(&[(50, 3), (50, 40), (90, 40)]);
        let (combined, stats) = conflate(vec![], vec![pavement, trail], &[], MPU);
        assert_eq!(stats.island_touch_cuts, 0);
        assert_eq!(
            components(&combined),
            (2, 1),
            "the trail is still an island"
        );
    }

    #[test]
    fn a_deck_over_the_network_is_not_noded_to_what_runs_beneath_it() {
        // A footbridge a story up; only the structure flag tells it from the trail above.
        let pavement = mapped_sidewalk(&[(0, 0), (100, 0)]);
        let mut deck = path(&[(50, 0), (50, 40), (90, 40)]);
        deck.flags |= STRUCTURE_FLAG;
        let (combined, stats) = conflate(vec![], vec![pavement, deck], &[], MPU);
        assert_eq!(stats.island_touch_cuts, 0);
        assert_eq!(components(&combined), (2, 1));
    }

    #[test]
    fn a_component_that_touches_twice_is_joined_once() {
        // Both loop ends touch the pavement; one join suffices and a second would be invented.
        let pavement = mapped_sidewalk(&[(0, 0), (100, 0)]);
        let loop_way = path(&[(30, 0), (30, 40), (70, 40), (70, 0)]);
        let (combined, stats) = conflate(vec![], vec![pavement, loop_way], &[], MPU);
        assert_eq!(stats.island_touch_cuts, 1);
        assert_eq!(
            combined
                .iter()
                .filter(|edge| edge.kind == KIND_SIDEWALK)
                .count(),
            2,
            "the pavement was cut once"
        );
        assert_eq!(components(&combined), (1, 1));
    }

    #[test]
    fn an_island_the_first_join_brings_within_reach_is_joined_too() {
        // The spur only anchors once the trail does, so a single sweep would strand it.
        let pavement = mapped_sidewalk(&[(0, 0), (100, 0)]);
        let trail = path(&[(50, 0), (50, 50)]);
        let spur = path(&[(20, 25), (50, 25)]);
        let (combined, stats) = conflate(vec![], vec![pavement, trail, spur], &[], MPU);
        assert_eq!(stats.island_touch_cuts, 2);
        assert_eq!(components(&combined), (1, 1));
    }

    #[test]
    fn duplicate_way_beside_a_street_is_dropped() {
        let streets = vec![street(&[(0, 0), (100, 0)])];
        let paths = vec![path(&[(0, 3), (100, 3)])]; // parallel, 3 m off, aligned bearing
        let (combined, stats) = conflate(streets, paths, &[], MPU);
        assert_eq!(stats.deduped_ways, 1);
        assert!(
            combined.iter().all(|edge| !edge.osm),
            "the duplicate is gone"
        );
    }

    #[test]
    fn oblique_crossing_is_not_deduped() {
        let streets = vec![street(&[(0, 0), (100, 0)])];
        // Crosses at a right angle, never bearing-aligned, so it survives.
        let paths = vec![path(&[(50, -40), (50, 40)])];
        let (combined, stats) = conflate(streets, paths, &[], MPU);
        assert_eq!(stats.deduped_ways, 0);
        assert!(combined.iter().any(|edge| edge.osm));
    }

    #[test]
    fn shared_vertex_splits_the_through_way() {
        let through = path(&[(0, 0), (50, 0), (100, 0)]);
        let stem = path(&[(50, 0), (50, 50)]);
        let (combined, stats) = conflate(vec![], vec![through, stem], &[], MPU);
        assert_eq!(stats.osm_t_splits, 1);
        assert_eq!(combined.iter().filter(|edge| edge.osm).count(), 3);
    }

    #[test]
    fn greenway_crossing_two_streets_welds_and_splits_both() {
        let streets = vec![
            street(&[(0, -50), (0, 50)]),
            street(&[(100, -50), (100, 50)]),
        ];
        let greenway = path(&[(-20, 0), (0, 0), (100, 0), (120, 0)]);
        let (combined, stats) = conflate(streets, vec![greenway], &[], MPU);
        assert_eq!(stats.welded_vertices, 2);
        assert_eq!(stats.cscl_splits, 2);
        assert_eq!(combined.iter().filter(|edge| !edge.osm).count(), 4);
        assert_eq!(combined.iter().filter(|edge| edge.osm).count(), 3);
    }

    #[test]
    fn every_piece_of_a_cut_edge_keeps_its_source_id() {
        let streets = vec![with_source_id(street(&[(0, -50), (0, 50)]), 11)];
        let greenway = with_source_id(path(&[(-20, 0), (0, 0), (20, 0)]), 22);
        let stem = with_source_id(path(&[(20, 0), (20, 40)]), 33);
        let (combined, _) = conflate(streets, vec![greenway, stem], &[], MPU);
        assert_eq!(
            combined.iter().filter(|edge| edge.source_id == 11).count(),
            2,
            "the street was cut in two"
        );
        assert_eq!(
            combined.iter().filter(|edge| edge.source_id == 22).count(),
            2,
            "the greenway was cut at the crossing"
        );
        assert_eq!(
            combined.iter().filter(|edge| edge.source_id == 33).count(),
            1
        );
    }

    #[test]
    fn entrance_snap_accepts_a_continuation_and_rejects_a_fence_parallel() {
        let streets = vec![street(&[(-50, 0), (50, 0)])];
        let entering = path(&[(0, 20), (0, 5)]);
        // 15 m off, too far to dedup; its connector would cross at ~90°, rejected.
        let fence = path(&[(-30, 15), (30, 15)]);
        let (combined, stats) = conflate(streets, vec![entering, fence], &[], MPU);
        assert_eq!(stats.entrance_snaps, 1);
        let reaches = combined
            .iter()
            .filter(|edge| edge.osm)
            .any(|edge| edge.poly_y.contains(&0));
        assert!(reaches, "the accepted entrance reaches the street");
        assert_eq!(stats.cscl_splits, 1);
    }

    #[test]
    fn an_entrance_snaps_to_the_curb_of_a_sidewalked_street() {
        // The 40 dm offset puts the sidewalks 4 m either side; the path stops 2 m short of one.
        let streets = vec![street(&[(-50, 0), (50, 0)])];
        let entering = path(&[(0, 20), (0, 6)]);
        let (combined, stats) = conflate(streets, vec![entering], &[], MPU);
        assert_eq!(stats.entrance_snaps, 1);
        assert_eq!(stats.entrance_snaps_curb, 1);
        let snapped = combined.iter().find(|edge| edge.osm).expect("the entrance");
        // The vertex is the centerline cut; the curb bit sends graph.rs to that cut's corner.
        let end = (
            *snapped.poly_x.last().expect("a vertex"),
            *snapped.poly_y.last().expect("a vertex"),
        );
        assert_eq!(end, (0, 0));
        assert!(snapped.curb_b && !snapped.curb_a);
        assert!((snapped.length - 16.0).abs() < 0.5, "{}", snapped.length);
        assert_eq!(stats.cscl_splits, 1, "the street was cut at the join");
    }

    #[test]
    fn a_bare_side_is_not_a_snap_target_but_one_osm_maps_still_is() {
        // Sidewalk lines 24 m either side; the path stops 2 m short of the near one.
        let mut wide = street(&[(-50, 0), (50, 0)]);
        wide.offset = 240;
        let entering = path(&[(0, 60), (0, 26)]);
        let (_, stats) = conflate(vec![wide.clone()], vec![entering.clone()], &[], MPU);
        assert_eq!(stats.entrance_snaps, 1);

        // With that side gated away, a dead end beats a join across 48 m of roadway.
        let mut bare = wide.clone();
        bare.paved = SIDEWALK_RIGHT;
        bare.sidewalks = SIDEWALK_RIGHT;
        let (_, stats) = conflate(vec![bare], vec![entering.clone()], &[], MPU);
        assert_eq!(stats.entrance_snaps, 0);
        assert_eq!(stats.dangling_ends, 2);

        // A side OSM maps itself derives no edge but is still pavement to reach for.
        wide.sidewalks = SIDEWALK_RIGHT;
        let (_, stats) = conflate(vec![wide], vec![entering], &[], MPU);
        assert_eq!(stats.entrance_snaps, 1);
    }

    #[test]
    fn a_street_that_is_the_walking_surface_keeps_its_centerline_join() {
        // Offset 0: the centerline is where people walk, so the join is not a curb.
        let entering = path(&[(0, 20), (0, 6)]);
        let (combined, stats) = conflate(
            vec![walkway(&[(-50, 0), (50, 0)])],
            vec![entering],
            &[],
            MPU,
        );
        assert_eq!(stats.entrance_snaps, 1);
        assert_eq!(stats.entrance_snaps_curb, 0);
        let snapped = combined.iter().find(|edge| edge.osm).expect("the entrance");
        assert!(!snapped.curb_a && !snapped.curb_b);
    }

    #[test]
    fn the_snap_radius_is_measured_to_the_pavement() {
        // 23 m from the centerline, but 19 m from the sidewalk it joins.
        let mut wide = street(&[(-50, 0), (50, 0)]);
        wide.offset = 40;
        let entering = path(&[(0, 60), (0, 23)]);
        let (_, stats) = conflate(vec![wide], vec![entering], &[], MPU);
        assert_eq!(stats.entrance_snaps, 1);
        assert_eq!(stats.entrance_snaps_curb, 1);
    }

    #[test]
    fn splits_at_a_segment_end_merge_onto_the_endpoint() {
        let streets = vec![street(&[(0, 0), (100, 0)])];
        // Within 2 m of the street's start and beyond the 4 m weld radius, so both snap to it.
        let first = path(&[(1, 10), (1, 5)]);
        let second = path(&[(2, 12), (2, 5)]);
        let (combined, stats) = conflate(streets, vec![first, second], &[], MPU);
        assert_eq!(stats.entrance_snaps, 2);
        assert_eq!(stats.cscl_splits, 0, "endpoint snaps add no interior cut");
        assert_eq!(
            combined.iter().filter(|edge| !edge.osm).count(),
            1,
            "the street stays one edge"
        );
        let on_origin = combined
            .iter()
            .filter(|edge| edge.osm)
            .filter(|edge| {
                (edge.poly_x[0] == 0 && edge.poly_y[0] == 0)
                    || (*edge.poly_x.last().unwrap() == 0 && *edge.poly_y.last().unwrap() == 0)
            })
            .count();
        assert_eq!(on_origin, 2);
    }

    #[test]
    fn an_alley_mouth_cuts_the_street_it_stands_on() {
        // An alley ending mid-block on the street's centerline with no node there.
        let streets = vec![
            street(&[(0, 0), (100, 0)]),
            walkway(&[(40, 0), (40, -30), (70, -30)]),
        ];
        let (combined, stats) = conflate(streets, vec![], &[], MPU);
        assert_eq!(stats.cscl_t_splits, 1);
        let pieces: Vec<&ProtoEdge> = combined.iter().filter(|edge| edge.offset > 0).collect();
        assert_eq!(pieces.len(), 2, "the street is two blocks now");
        assert!(
            pieces
                .iter()
                .all(|piece| piece.poly_x.contains(&40) && piece.poly_y.contains(&0)),
            "both meet the mouth"
        );
    }

    #[test]
    fn a_street_end_already_at_a_node_is_left_whole() {
        // CSCL already splits at the corner, and a mouth 3 m off is a gap, not a coincidence.
        let streets = vec![
            street(&[(0, 0), (100, 0)]),
            walkway(&[(0, 0), (0, -30)]),
            walkway(&[(60, -3), (60, -30)]),
        ];
        let (combined, stats) = conflate(streets, vec![], &[], MPU);
        assert_eq!(stats.cscl_t_splits, 0);
        assert_eq!(combined.iter().filter(|edge| edge.offset > 0).count(), 1);
    }

    #[test]
    fn a_short_connector_snaps_whatever_direction_it_turns() {
        let streets = vec![street(&[(-50, 0), (50, 0)])];
        // 7 m from the curb: past the dedup band, inside the half-width where the guard is waived.
        let inside = path(&[(-20, 7), (20, 7)]);
        let (_, stats) = conflate(streets.clone(), vec![inside], &[], MPU);
        assert_eq!(stats.entrance_snaps, 2, "both ends reach the curb");
        assert_eq!(
            stats.short_entrance_snaps, 2,
            "both only because of the waiver"
        );
        let outside = path(&[(-20, 12), (20, 12)]);
        let (_, stats) = conflate(streets, vec![outside], &[], MPU);
        assert_eq!(stats.entrance_snaps, 0);
    }

    #[test]
    fn a_named_orphan_lying_on_its_own_street_is_dropped() {
        let names = vec!["COENTIES ALY".to_string(), "COENTIES ALLEY".to_string()];
        let mut alley = street(&[(0, 0), (100, 0)]);
        alley.name_id = 0;
        // 8 m off and standalone, so only the orphan band sees it.
        let mut remapped = path(&[(0, 8), (100, 8)]);
        remapped.name_id = 1;
        let (combined, stats) = conflate(vec![alley.clone()], vec![remapped.clone()], &names, MPU);
        assert_eq!(stats.deduped_ways, 0, "the 6 m band does not reach it");
        assert_eq!(stats.deduped_orphan_ways, 1);
        assert!(combined.iter().all(|edge| !edge.osm));

        let mut greenway = remapped.clone();
        greenway.name_id = UNNAMED_FIXTURE;
        let (_, stats) = conflate(vec![alley.clone()], vec![greenway], &names, MPU);
        assert_eq!(stats.deduped_orphan_ways, 0);

        let joined = path(&[(100, 8), (140, 40)]);
        let (_, stats) = conflate(vec![alley], vec![remapped, joined], &names, MPU);
        assert_eq!(stats.deduped_orphan_ways, 0);
    }

    const UNNAMED_FIXTURE: u16 = 0xFFFF;

    #[test]
    fn a_dangling_end_merges_onto_a_node_a_block_away_through_the_network() {
        // A U: the two free ends are 2 m apart, 140 m apart through the network.
        let left = path(&[(0, 0), (0, 50)]);
        let base = path(&[(0, 0), (40, 0)]);
        let right = path(&[(40, 0), (40, 50), (2, 50)]);
        let (combined, stats) = conflate(vec![], vec![left, base, right], &[], MPU);
        assert_eq!(stats.merged_dangling_ends, 1);
        let free_ends: HashSet<Point> = combined
            .iter()
            .map(|edge| {
                let last = edge.poly_x.len() - 1;
                (edge.poly_x[last], edge.poly_y[last])
            })
            .collect();
        assert_eq!(free_ends.len(), 2, "the two free ends became one node");
        assert!(free_ends.contains(&(40, 0)));
    }

    #[test]
    fn a_dangling_end_beside_its_own_junction_is_left_alone() {
        // The same 2 m gap, only 38 m apart through the network: a stub, not a seam.
        let spine = path(&[(0, 0), (0, 10)]);
        let arm = path(&[(0, 10), (10, 10), (10, 2), (0, 2)]);
        let (combined, stats) = conflate(vec![], vec![spine, arm], &[], MPU);
        assert_eq!(stats.merged_dangling_ends, 0);
        assert!(
            combined
                .iter()
                .any(|edge| *edge.poly_x.last().expect("a vertex") == 0
                    && *edge.poly_y.last().expect("a vertex") == 2),
            "the arm still ends where it did"
        );
    }
}

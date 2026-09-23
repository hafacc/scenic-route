//! The graph pass: contracts STRT into the pedestrian routing graph and writes it as GRPH.

use std::collections::{HashMap, HashSet};
use std::f64::consts::TAU;
use std::fs;
use std::ops::ControlFlow;
use std::path::PathBuf;

use serde::Deserialize;

use crate::Fallible;
use crate::association;
use crate::binfmt::{self, SIDES, write_varint, zigzag};
use crate::bridge;
use crate::conflate::{self, ProtoEdge, SIDEWALK_LEFT, SIDEWALK_RIGHT, swap_sidewalks};
use crate::corners::{self, EdgeEnd};
use crate::direct_canopy;
use crate::geometry::{METERS_PER_DEGREE_LAT, round_half_up};
use crate::graph_cache;
use crate::historic;
use crate::industrial;
use crate::invariants;
use crate::relief;
use crate::scenic;
use crate::shade;
use crate::sidewalks::{self, FLAG_NON_VEHICULAR};

// STRT record flags (byte 23); FLAG_NON_VEHICULAR lives in sidewalks.rs.
pub const FLAG_VEHICULAR_ONLY: u8 = 1 << 0;
pub const FLAG_STRUCTURE: u8 = 1 << 2;
// PATH and SWLK only: tunnel or covered; STRT spends this bit on FLAG_OSM_LEFT and uses rw_type 4.
pub const FLAG_TUNNEL: u8 = 1 << 3;
// Per-side STRT bits: OSM maps a sidewalk way there, and a survey says there is pavement there.
const FLAG_OSM_LEFT: u8 = 1 << 3;
const FLAG_OSM_RIGHT: u8 = 1 << 4;
const FLAG_SURVEYED_LEFT: u8 = 1 << 5;
const FLAG_SURVEYED_RIGHT: u8 = 1 << 6;

// Gate guards: a big drop means unstamped side bits; few demoted alleys, a flipped rule.
const MIN_DEMOTED_ALLEY_FRACTION: f64 = 0.95;
const ALLEY: u8 = 10;
// SWLK byte 20; a traffic island becomes a crossing edge, being the middle of its crossing.
const SWLK_SIDEWALK: u8 = 20;

/// Per-region existence-gate ceilings: share of derived km dropped, and p90 unpaved share per cell.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExistenceCeilings {
    pub dropped_sidewalk_fraction: f64,
    pub cell_demoted_share: f64,
}

/// Ceilings for a region with a municipal sidewalk survey, and the default.
pub const SURVEYED_CEILINGS: ExistenceCeilings = ExistenceCeilings {
    dropped_sidewalk_fraction: 0.30,
    cell_demoted_share: 0.30,
};

// GRPH edge flags; contraction requires equal flags, so they never mix within one edge.
const GRPH_STRUCTURE: u8 = 1 << 0; // on a bridge or tunnel deck
const GRPH_STEPS: u8 = 1 << 1; // a step street (rw_type 7)
// A line taken as drawn, not offset; a matched OSM sidewalk keeps it but borrows a half-offset.
const GRPH_PATHLIKE: u8 = 1 << 2;
// An OSM-sourced walking edge (flags bit 3); it rides in `Edge::osm` until the write.
const GRPH_OSM: u8 = 1 << 3;
// Under the deck rather than on it (flags bit 4); the structure bit cannot tell the two apart.
const GRPH_TUNNEL: u8 = 1 << 4;
// Internal, masked at write: buildings lie geometry-right, written as FLAG_GEOMETRY_RIGHT.
const GRPH_BUILDING_RIGHT: u8 = 1 << 5;

// Edge kinds (byte 22 bits 0-2) and sides (bits 3-5); a ferry reuses bytes 20-21 as a u16 duration.
pub const KIND_SIDEWALK: u8 = 0;
pub const KIND_CROSSING: u8 = 1;
pub const KIND_LINK: u8 = 2;
pub const KIND_PATH: u8 = 3;
const KIND_FERRY: u8 = 4;
// Transit kinds; a board edge bakes no duration since the timetable answers its wait at route time.
const KIND_ACCESS: u8 = 5;
const KIND_BOARD: u8 = 6;
const KIND_RIDE: u8 = 7;
const KIND_MASK: u8 = 0x7;
const SIDE_SHIFT: u8 = 3;
pub const SIDE_NONE: u8 = 0;
pub const SIDE_NORTH: u8 = 1;
pub const SIDE_EAST: u8 = 2;
pub const SIDE_SOUTH: u8 = 3;
const SIDE_WEST: u8 = 4;
const FLAG_GEOMETRY_RIGHT: u8 = 1 << 2; // this sidewalk lies right of its stored geometry direction

// v12 lays the graph out by column so the client views each column in place.
const GRAPH_FORMAT: u16 = 12;
// The relief field's zoom: about 5 m pixels at San Francisco's latitude.
const RELIEF_FIELD_ZOOM: u32 = 15;
// 64 header bytes plus a 48-entry section directory; a reader zero-fills an absent column.
const GRAPH_HEADER_BYTES: usize = 640;
const GRAPH_DIRECTORY_AT: usize = 64;
const GRAPH_DIRECTORY_ENTRY: usize = 12;
const GRAPH_DIRECTORY_MAX: usize = 48;
const GRAPH_SECTIONS: usize = 35;
// Every section starts aligned here, so any Float64/Float32/Uint32 view over it is legal.
const SECTION_ALIGN: usize = 8;
// (source id, side, ordinal) is an edge key that survives a rebuild, unlike the positional id.
const NO_SOURCE_ID: u32 = 0xFFFF_FFFF; // no durable identity: a crossing, a link or a ferry
// NYC's worst OSM way reaches 103 edges under one source id and side, so the ordinal needs a byte.
const ORDINALS: usize = 256;
const NO_GEOMETRY: u32 = 0xFFFF_FFFF; // edge record byte 12 sentinel: straight a->b, no blob entry
const UNNAMED: u16 = 0xFFFF;
pub const DECIMETERS_PER_METER: f64 = 10.0; // the half-offset byte's unit, as the chunk uses
const STEP_STREET: u8 = 7;
const TUNNEL_STREET: u8 = 4; // CSCL rw_type 4, as against 3 for a bridge
// Below this chord length the N/S/E/W label falls back to the first segment's bearing.
const SHORT_CHORD_METERS: f64 = 10.0;
const LENGTH_SLACK_METERS: f32 = 0.5; // f32 length vs great-circle node distance rounding
const EARTH_RADIUS_METERS: f64 = 6_371_000.0; // matches the client's haversineMeters
// Mirrors the manifest's sidewalkInsetMeters, which this pass never sees.
const SIDEWALK_INSET_METERS: f64 = 2.0;

const MERGE_RADIUS_METERS: f64 = 1.0; // CSCL digitization slivers, mopped up after exact noding
const GRID_METERS: f64 = 3.0; // near-miss bucket size; a 3x3 scan then covers the merge radius
const PRUNE_DEVIATION_UNITS: f64 = 1.5; // ~0.15 m; the ingest's 25 m densification is pure lerp
const MAX_EDGE_VERTICES: usize = u16::MAX as usize; // a guard on the merged polyline, never a limit
// A pier sits off the street grid, so its snap is looser than the node merge.
const FERRY_SNAP_RADIUS_METERS: f64 = 250.0;
// A station point is the middle of a mezzanine, not a street door, so it reaches as far as a pier.
const TRANSIT_SNAP_RADIUS_METERS: f64 = 250.0;
// A station gets a door on every edge this near, since a lone nearest door can be across an avenue.
const TRANSIT_ENTRANCE_RADIUS_METERS: f64 = 40.0;
// Enough doors for both sides of an avenue, few enough not to fan a complex into dozens of edges.
const TRANSIT_ENTRANCES_MAX: usize = 6;
// Mirrors WALK_METERS_PER_SECOND in src/routing/walk-speed.ts.
const ACCESS_WALK_METERS_PER_SECOND: f64 = 1.3;
// Baked station entry costs; every alight edge takes the surface figure, since exits don't queue.
const UNDERGROUND_ACCESS_SECONDS: u16 = 90;
const SURFACE_ACCESS_SECONDS: u16 = 30;
const ALIGHT_SECONDS: u16 = SURFACE_ACCESS_SECONDS;
// No dataset measures this; it must not undercut the stair beside it.
const ELEVATOR_ACCESS_SECONDS: u16 = 150;
// ACCESS-only flag bits; bit 5 is shared with GRPH_BUILDING_RIGHT, which is masked out at write.
const ACCESS_EXIT_ONLY: u8 = 1 << 5;
const ACCESS_ENTRY_ONLY: u8 = 1 << 6;
// An escalator, ramp, station house or passage all read as a stair.
const ACCESS_ELEVATOR: u8 = 1 << 7;
// RIDE only: the free step from a stop's arrival node onto its boarding node (staying aboard).
const RIDE_STAY_ABOARD: u8 = 1 << 6;
// How far OSM's corner may stand from where a fan corner would go and still be that corner.
const SEAM_RADIUS_METERS: f64 = 12.0;
// How far an invented corner reaches to join an OSM node with a link edge.
const SEAM_LINK_METERS: f64 = 20.0;
// A corner cuts OSM pavement only within the seam radius and when the way's nearest node is farther.
const CURB_CUT_METERS: f64 = SEAM_RADIUS_METERS;
const CURB_CUT_DETOUR_METERS: f64 = SEAM_LINK_METERS;
// Cuts within 2 m of each other or of a vertex merge, so no sliver edge is shed.
const SPLIT_MERGE_METERS: f64 = 2.0;
// An OSM crossing may be this much longer than the straight curb line and still serve the pair.
const SUPPRESSION_SLACK: f64 = 1.5;
// How far the seam repair looks for the other half of a gap before reporting it.
const SEAM_REPAIR_METERS: f64 = 60.0;
// The measured seam-gap count; the ceiling is derived from it with sixfold headroom.
const MEASURED_SEAM_GAPS: usize = 80;
const MAX_SEAM_GAPS: usize = 6 * MEASURED_SEAM_GAPS;
// Pavement-coverage cells, and the street length a cell needs before it is scored.
const PAVEMENT_CELL_METERS: f64 = 500.0;
const PAVEMENT_CELL_KM: f64 = 2.0;
// Whole-city bounds, each set between the finished city and a build without its fix.
const MAX_STRANDED_ALLEY_FRACTION: f64 = 0.01;
// Alley mouths: median walk to pavement, p90 walk, and the count that reach none.
const MAX_ALLEY_MOUTH_MEDIAN_METERS: f64 = 10.0;
const MAX_ALLEY_MOUTH_P90_METERS: f64 = 120.0;
const MAX_STRANDED_ALLEY_MOUTHS: usize = 10;
// Loop streets label their own far wind, so a residue of opposing-wind pavement is expected.
const MAX_PHANTOM_SIDEWALKS: usize = 200;
// Every link is a seam repair or entrance snap, so all are bounded by SEAM_REPAIR_METERS.
const MAX_LINK_P99_METERS: f64 = 50.0;
// Floors so each bound above can't pass on an empty population; alley ones run on alley cities only.
const MIN_ALLEY_KM: f64 = 50.0; // nyc 303.1; alley-classifying cities only
const MIN_ALLEY_MOUTHS: usize = 600; // nyc 3_813; alley-classifying cities only
const MIN_ONE_SIDED_KEYS: usize = 500; // nyc 14_961, sf 1_127
const MIN_PAVEMENT_CELLS: usize = 200; // nyc 2_877, sf 484
const MIN_LINK_EDGES: usize = 2_500; // nyc 15_539, sf 3_320
// The same floors on the existence gate's own denominators.
const MIN_DERIVED_SIDEWALK_KM: f64 = 400.0; // nyc 2_342, sf 3_466

pub const STRANDED_FORMAT: u16 = 1;
pub const STRANDED_HEADER_BYTES: usize = 12;

pub struct Args {
    pub streets: PathBuf,
    pub paths: Option<PathBuf>,
    // OSM's sidewalk network (SWLK), which the PATH extract excludes.
    pub sidewalks: Option<PathBuf>,
    pub ferries: Option<PathBuf>,
    /// The city's rail topology (TRNS); none builds a graph with no transit edge.
    pub transit: Option<PathBuf>,
    pub landmarks: Option<PathBuf>,
    pub art: Option<PathBuf>,
    pub highways: Option<PathBuf>,
    pub commercial: Option<PathBuf>,
    // Industrial tax lots (INDL); none bakes zeros, which hides the slider.
    pub industrial: Option<PathBuf>,
    // Designated historic districts (HDST); absent for a city that has none.
    pub historic: Option<PathBuf>,
    // The land mask (LAND) for the bridge over-water share; absent only for a fixture.
    pub land: Option<PathBuf>,
    pub out: PathBuf,
    /// Where to write this city's dropped ways as STRD; nothing reads it back.
    pub stranded_out: Option<PathBuf>,
    // The optional SHDE bake: footprints, sun grid and output directory, all three or none.
    pub buildings: Option<PathBuf>,
    pub shade_params: Option<shade::Params>,
    pub shade_dir: Option<PathBuf>,
    /// The DEM resample bounds; present means the city has terrain and the relief column is baked.
    pub elevation_bounds: Option<crate::manifest::Bounds>,
    /// Whether this city's centerline classifies alleys.
    pub alleys: bool,
    /// The existence gate's two ceilings for this region.
    pub existence_ceilings: ExistenceCeilings,
    // The measured canopy, for the direct-canopy byte and the shade bake's crowns.
    pub canopy: Option<PathBuf>,
    /// Cache locations and keys, or none for a run that must not write cache entries.
    pub cache: Option<graph_cache::Keys>,
    // `tiler key-probe`: build a fixture's key space and skip the whole-city bounds.
    pub probe: bool,
    // Where to write the stats line instead of stdout.
    pub report: Option<PathBuf>,
}

/// One edge; length is the sum of the source records' f32 lengths, never recomputed from geometry.
struct Edge {
    a: u32,
    b: u32,
    poly_x: Vec<i32>,
    poly_y: Vec<i32>,
    length: f32,
    cover_left: u8,
    cover_right: u8,
    offset: u8,
    flags: u8,
    name_id: u16,
    osm: bool, // OSM-sourced (a conflated path); keeps contraction and island-drop from blending provenance
    source_id: u32, // the CSCL physicalid or OSM way id this came from; the minimum over a contracted chain
    kind: u8,       // the GRPH record kind this becomes
    side: u8,       // and its N/E/S/W label, where the source already knows it
    sidewalks: u8,  // which sides get a *derived* sidewalk, in this edge's stored direction
    // Which sides have pavement at all (existence, not surface), so corners and crossings are placed.
    paved: u8,
    // This end snapped onto a derived sidewalk, so it binds to the split's corner node.
    curb_a: bool,
    curb_b: bool,
}

/// Whether the given end of an edge is a curb-bound entrance snap.
fn curb_end(edge: &Edge, node: u32) -> bool {
    (edge.a == node && edge.curb_a) || (edge.b == node && edge.curb_b)
}

/// A traffic island is a crossing; read as anything else, a divided street's crossing dead-ends.
fn swlk_kind(road_type: u8) -> u8 {
    if road_type == SWLK_SIDEWALK {
        KIND_SIDEWALK
    } else {
        KIND_CROSSING
    }
}

/// The existence gate: which sides of an offsetted street have pavement at all.
fn gated_sidewalks(record_flags: u8) -> u8 {
    let mut sidewalks = 0u8;
    if record_flags & (FLAG_OSM_LEFT | FLAG_SURVEYED_LEFT) != 0 {
        sidewalks |= SIDEWALK_LEFT;
    }
    if record_flags & (FLAG_OSM_RIGHT | FLAG_SURVEYED_RIGHT) != 0 {
        sidewalks |= SIDEWALK_RIGHT;
    }
    sidewalks
}

/// Cut a street into stretches sharing one derived-sidewalk mask, so offsets skip OSM pavement.
fn trim_derived(
    street: ProtoEdge,
    covered: &[Vec<(f64, f64)>; 2],
    meters_per_unit: (f64, f64),
) -> Vec<ProtoEdge> {
    if street.offset == 0 || covered.iter().all(Vec::is_empty) {
        return vec![street];
    }
    let ruler = association::cumulative_meters(&street.poly_x, &street.poly_y, meters_per_unit);
    let whole = ruler.last().copied().unwrap_or(0.0);
    let stretches = association::derived_stretches(covered, street.sidewalks, whole);
    if let [(_, mask)] = stretches[..] {
        return vec![ProtoEdge {
            sidewalks: mask,
            ..street
        }];
    }

    let mut pieces: Vec<ProtoEdge> = Vec::with_capacity(stretches.len());
    let mut poly_x: Vec<i32> = vec![street.poly_x[0]];
    let mut poly_y: Vec<i32> = vec![street.poly_y[0]];
    let mut vertex = 1usize;
    for (index, &(end, mask)) in stretches.iter().enumerate() {
        let last = index + 1 == stretches.len();
        while vertex < ruler.len() && (last || ruler[vertex] < end) {
            poly_x.push(street.poly_x[vertex]);
            poly_y.push(street.poly_y[vertex]);
            vertex += 1;
        }
        if !last {
            // Quantization can land the cut on a neighboring vertex, which the dedup folds away.
            let span = ruler[vertex] - ruler[vertex - 1];
            let param = if span > 0.0 {
                (end - ruler[vertex - 1]) / span
            } else {
                0.0
            };
            let lerp = |from: i32, to: i32| {
                round_half_up(f64::from(from) + param * f64::from(to - from)) as i32
            };
            poly_x.push(lerp(street.poly_x[vertex - 1], street.poly_x[vertex]));
            poly_y.push(lerp(street.poly_y[vertex - 1], street.poly_y[vertex]));
        }
        let mut piece_x = vec![poly_x[0]];
        let mut piece_y = vec![poly_y[0]];
        for point in 1..poly_x.len() {
            if (poly_x[point], poly_y[point]) != (poly_x[point - 1], poly_y[point - 1]) {
                piece_x.push(poly_x[point]);
                piece_y.push(poly_y[point]);
            }
        }
        poly_x = vec![*poly_x.last().expect("a cut vertex")];
        poly_y = vec![*poly_y.last().expect("a cut vertex")];
        if piece_x.len() < 2 {
            continue; // the whole stretch quantized onto one point
        }
        let piece_meters = conflate::polyline_meters(&piece_x, &piece_y, meters_per_unit);
        let length = if whole > 0.0 {
            (f64::from(street.length) * piece_meters / whole) as f32
        } else {
            street.length
        };
        pieces.push(ProtoEdge {
            poly_x: piece_x,
            poly_y: piece_y,
            length,
            sidewalks: mask,
            ..street.clone()
        });
    }
    pieces
}

/// A crossing spends half its length under each side, so its cover is their mean.
fn crossing_cover_bytes(left: u8, right: u8) -> u8 {
    round_half_up((f64::from(left) + f64::from(right)) / 2.0) as u8
}

/// The ends leaving one base node (streets in CCW bearing order, then paths) and their corner fan.
struct NodeFan {
    ends: Vec<EdgeEnd>,
    street_count: usize,
    degree: usize,
    fan: corners::CornerFan,
}

fn node_fan(
    base: usize,
    incidence2: &[Vec<(u32, bool)>],
    final_edges: &[Edge],
    merged_x: &[i32],
    merged_y: &[i32],
    meters_per_unit_lng: f64,
    meters_per_unit_lat: f64,
) -> NodeFan {
    let mut street_ends: Vec<(EdgeEnd, f64)> = Vec::new();
    let mut path_ends: Vec<EdgeEnd> = Vec::new();
    for &(edge_id, at_a) in &incidence2[base] {
        let edge = &final_edges[edge_id as usize];
        let bearing = departure_bearing(
            &edge.poly_x,
            &edge.poly_y,
            at_a,
            meters_per_unit_lng,
            meters_per_unit_lat,
        );
        let end = EdgeEnd {
            edge: edge_id,
            at_a,
            bearing,
            pathlike: edge.flags & GRPH_PATHLIKE != 0,
        };
        if end.pathlike {
            path_ends.push(end);
        } else {
            street_ends.push((end, f64::from(edge.offset) / DECIMETERS_PER_METER));
        }
    }
    street_ends.sort_by(|left, right| {
        left.0
            .bearing
            .total_cmp(&right.0.bearing)
            .then(left.0.edge.cmp(&right.0.edge))
            .then(left.0.at_a.cmp(&right.0.at_a))
    });
    path_ends.sort_by(|left, right| left.edge.cmp(&right.edge).then(left.at_a.cmp(&right.at_a)));

    let street_count = street_ends.len();
    let degree = incidence2[base].len();
    let mut ends: Vec<EdgeEnd> = Vec::with_capacity(degree);
    let mut half_offsets: Vec<f64> = Vec::with_capacity(degree);
    for &(ref end, offset) in &street_ends {
        ends.push(EdgeEnd {
            edge: end.edge,
            at_a: end.at_a,
            bearing: end.bearing,
            pathlike: false,
        });
        half_offsets.push(offset);
    }
    for end in path_ends {
        ends.push(end);
        half_offsets.push(0.0);
    }

    let fan = corners::build_fan(
        merged_x[base],
        merged_y[base],
        &ends,
        &half_offsets,
        meters_per_unit_lng,
        meters_per_unit_lat,
    );
    NodeFan {
        ends,
        street_count,
        degree,
        fan,
    }
}

/// A per-side mask as seen leaving an end: mirrored at `b`.
fn mask_leaving(mask: u8, at_a: bool) -> u8 {
    if at_a { mask } else { swap_sidewalks(mask) }
}

/// An edge's derived sidewalk sides as seen leaving one of its ends.
fn sidewalks_leaving(edge: &Edge, node: u32) -> u8 {
    mask_leaving(edge.sidewalks, edge.a == node)
}

/// The sides with pavement at all, a superset of derived sides.
fn paved_leaving(edge: &Edge, node: u32) -> u8 {
    mask_leaving(edge.paved, edge.a == node)
}

/// Only `GRPH_BUILDING_RIGHT` is direction-dependent, so only it flips.
fn flags_leaving(edge: &Edge, node: u32) -> u8 {
    if edge.a == node || !edge.osm || edge.kind != KIND_SIDEWALK {
        edge.flags
    } else {
        edge.flags ^ GRPH_BUILDING_RIGHT
    }
}

/// A cut position along a polyline, with its own point where the caller has one.
struct CutAt {
    along: f64,
    point: Option<(i32, i32)>,
}

/// A polyline with cuts woven in, merged within `SPLIT_MERGE_METERS` like `conflate::apply_splits`.
struct WovenCuts {
    x: Vec<i32>,
    y: Vec<i32>,
    /// Distance along the parent at each woven vertex.
    along: Vec<f64>,
    /// Per cut, the woven vertex it became or joined; an end vertex means no cut.
    vertex_of_cut: Vec<usize>,
    /// Interior woven vertices where pieces split, ascending.
    boundaries: Vec<usize>,
}

fn weave_cuts(
    poly_x: &[i32],
    poly_y: &[i32],
    cuts: &[CutAt],
    meters_per_unit: (f64, f64),
) -> WovenCuts {
    let along = association::cumulative_meters(poly_x, poly_y, meters_per_unit);
    let mut woven: Vec<(f64, i32, i32, bool)> = (0..poly_x.len())
        .map(|vertex| (along[vertex], poly_x[vertex], poly_y[vertex], false))
        .collect();
    let mut vertex_of_cut: Vec<usize> = vec![0; cuts.len()];
    for (index, cut) in cuts.iter().enumerate() {
        let nearest = (0..woven.len())
            .min_by(|&left, &right| {
                (woven[left].0 - cut.along)
                    .abs()
                    .total_cmp(&(woven[right].0 - cut.along).abs())
            })
            .expect("a non-empty polyline");
        if (woven[nearest].0 - cut.along).abs() <= SPLIT_MERGE_METERS {
            // Never at an end: that node exists and a cut there sheds an empty piece.
            if nearest != 0 && nearest != woven.len() - 1 {
                woven[nearest].3 = true;
            }
            vertex_of_cut[index] = nearest;
            continue;
        }
        let after = woven
            .iter()
            .position(|entry| entry.0 > cut.along)
            .expect("a cut inside the polyline");
        let point = cut.point.unwrap_or_else(|| {
            let span = woven[after].0 - woven[after - 1].0;
            let param = if span > 0.0 {
                (cut.along - woven[after - 1].0) / span
            } else {
                0.0
            };
            let lerp = |from: i32, to: i32| {
                round_half_up(f64::from(from) + param * f64::from(to - from)) as i32
            };
            (
                lerp(woven[after - 1].1, woven[after].1),
                lerp(woven[after - 1].2, woven[after].2),
            )
        });
        woven.insert(after, (cut.along, point.0, point.1, true));
        // The insertion shifted later vertices, which earlier cuts hold indices of.
        for held in &mut vertex_of_cut[..index] {
            if *held >= after {
                *held += 1;
            }
        }
        vertex_of_cut[index] = after;
    }
    WovenCuts {
        boundaries: (1..woven.len().saturating_sub(1))
            .filter(|&vertex| woven[vertex].3)
            .collect(),
        x: woven.iter().map(|entry| entry.1).collect(),
        y: woven.iter().map(|entry| entry.2).collect(),
        along: woven.iter().map(|entry| entry.0).collect(),
        vertex_of_cut,
    }
}

/// Cut one contracted edge at interior positions, splitting its length by geodesic share.
fn cut_edge_at(
    edge: &Edge,
    cuts: &[f64],
    merged_x: &mut Vec<i32>,
    merged_y: &mut Vec<i32>,
    meters_per_unit: (f64, f64),
) -> Vec<Edge> {
    let woven = weave_cuts(
        &edge.poly_x,
        &edge.poly_y,
        &cuts
            .iter()
            .map(|&along| CutAt { along, point: None })
            .collect::<Vec<CutAt>>(),
        meters_per_unit,
    );
    if woven.boundaries.is_empty() {
        return vec![Edge { ..clone_edge(edge) }];
    }
    let full = woven.along.last().copied().unwrap_or(0.0);
    let last = woven.x.len() - 1;

    let mut pieces: Vec<Edge> = Vec::new();
    let mut start = 0usize;
    let mut start_node = edge.a;
    for &boundary in woven.boundaries.iter().chain(std::iter::once(&last)) {
        let poly_x: Vec<i32> = woven.x[start..=boundary].to_vec();
        let poly_y: Vec<i32> = woven.y[start..=boundary].to_vec();
        let span = conflate::polyline_meters(&poly_x, &poly_y, meters_per_unit);
        let length = if full > 0.0 {
            (f64::from(edge.length) * span / full) as f32
        } else {
            edge.length
        };
        let end_node = if boundary == last {
            edge.b
        } else {
            merged_x.push(woven.x[boundary]);
            merged_y.push(woven.y[boundary]);
            (merged_x.len() - 1) as u32
        };
        pieces.push(Edge {
            a: start_node,
            b: end_node,
            poly_x,
            poly_y,
            length,
            curb_a: edge.curb_a && start == 0,
            curb_b: edge.curb_b && boundary == last,
            ..clone_edge(edge)
        });
        start = boundary;
        start_node = end_node;
    }
    pieces
}

/// `Edge` is deliberately not `Clone`, so everything a cut piece inherits is listed here.
fn clone_edge(edge: &Edge) -> Edge {
    Edge {
        a: edge.a,
        b: edge.b,
        poly_x: edge.poly_x.clone(),
        poly_y: edge.poly_y.clone(),
        length: edge.length,
        cover_left: edge.cover_left,
        cover_right: edge.cover_right,
        offset: edge.offset,
        flags: edge.flags,
        name_id: edge.name_id,
        osm: edge.osm,
        source_id: edge.source_id,
        kind: edge.kind,
        side: edge.side,
        sidewalks: edge.sidewalks,
        paved: edge.paved,
        curb_a: edge.curb_a,
        curb_b: edge.curb_b,
    }
}

/// Cut OSM sidewalk ways at corners inside the corner's wedge, off-deck, where the detour is long.
fn cut_sidewalks_at_corners(
    final_edges: &mut Vec<Edge>,
    merged_x: &mut Vec<i32>,
    merged_y: &mut Vec<i32>,
    meters_per_unit_lng: f64,
    meters_per_unit_lat: f64,
) -> usize {
    let meters_per_unit = (meters_per_unit_lng, meters_per_unit_lat);
    let mut incidence: Vec<Vec<(u32, bool)>> = vec![Vec::new(); merged_x.len()];
    for (edge_id, edge) in final_edges.iter().enumerate() {
        incidence[edge.a as usize].push((edge_id as u32, true));
        incidence[edge.b as usize].push((edge_id as u32, false));
    }

    // OSM sidewalk edges at grade; derived sidewalks don't exist yet, crossings end in nodes.
    let pavement: Vec<u32> = (0..final_edges.len() as u32)
        .filter(|&edge_id| {
            let edge = &final_edges[edge_id as usize];
            edge.osm && edge.kind == KIND_SIDEWALK && edge.flags & GRPH_STRUCTURE == 0
        })
        .collect();
    let grid = conflate::SegmentGrid::new(
        pavement.iter().map(|&edge_id| {
            let edge = &final_edges[edge_id as usize];
            (&edge.poly_x[..], &edge.poly_y[..])
        }),
        meters_per_unit,
    );
    let along_of: Vec<Vec<f64>> = pavement
        .iter()
        .map(|&edge_id| {
            let edge = &final_edges[edge_id as usize];
            association::cumulative_meters(&edge.poly_x, &edge.poly_y, meters_per_unit)
        })
        .collect();

    let mut cuts_by_edge: HashMap<u32, Vec<f64>> = HashMap::new();
    for base in 0..incidence.len() {
        if incidence[base].is_empty() {
            continue;
        }
        // A deck above or below grade shares no ground with what passes under or over it.
        if incidence[base]
            .iter()
            .any(|&(edge_id, _)| final_edges[edge_id as usize].flags & GRPH_STRUCTURE != 0)
        {
            continue;
        }
        let NodeFan {
            ends,
            street_count,
            degree,
            fan,
        } = node_fan(
            base,
            &incidence,
            final_edges,
            merged_x,
            merged_y,
            meters_per_unit_lng,
            meters_per_unit_lat,
        );
        // A lone street-end's 360-degree gap is no wedge; a cul-de-sac tip would cut anything.
        if street_count < 2 {
            continue;
        }
        // A corner nothing binds to is never materialized, so cutting for it would add a stray node.
        let mut needed = vec![false; street_count];
        for slot in 0..street_count {
            let end = &ends[slot];
            let leaving = mask_leaving(final_edges[end.edge as usize].paved, end.at_a);
            if leaving & SIDEWALK_LEFT != 0 {
                needed[fan.corner_left[slot] as usize] = true;
            }
            if leaving & SIDEWALK_RIGHT != 0 {
                needed[fan.corner_right[slot] as usize] = true;
            }
        }
        for path_slot in 0..degree - street_count {
            needed[fan.path_corner[path_slot] as usize] = true;
        }

        for slot in 0..street_count {
            if !needed[slot] {
                continue;
            }
            let corner = (fan.corner_x[slot], fan.corner_y[slot]);
            // The gap as `corners::build_fan` measures it: CCW from this street-end to the next.
            let start = ends[slot].bearing;
            let raw = ends[(slot + 1) % street_count].bearing - start;
            let gap = if street_count == 1 || raw <= 0.0 {
                raw + TAU
            } else {
                raw
            };
            for candidate in pavement_within(
                &grid,
                final_edges,
                &pavement,
                corner,
                CURB_CUT_METERS,
                meters_per_unit,
            ) {
                // Pavement across a roadway lies beyond a bounding street-end, never inside.
                let toward = (f64::from(candidate.point.1 - merged_y[base]) * meters_per_unit_lat)
                    .atan2(f64::from(candidate.point.0 - merged_x[base]) * meters_per_unit_lng);
                if (toward - start).rem_euclid(TAU) >= gap {
                    continue;
                }
                // Walks enter the way at an end, so this lower-bounds the walk the cut saves.
                let along = &along_of[candidate.entry];
                let (from, to) = (along[candidate.vertex], along[candidate.vertex + 1]);
                let cut = from + candidate.param * (to - from);
                let whole = along.last().copied().unwrap_or(0.0);
                if cut.min(whole - cut) <= CURB_CUT_DETOUR_METERS {
                    continue;
                }
                cuts_by_edge
                    .entry(pavement[candidate.entry])
                    .or_default()
                    .push(cut);
                break;
            }
        }
    }

    let mut cut_count = 0usize;
    let mut cut_edges: Vec<Edge> = Vec::with_capacity(final_edges.len());
    for (edge_id, edge) in final_edges.iter().enumerate() {
        match cuts_by_edge.get(&(edge_id as u32)) {
            Some(cuts) => {
                let mut sorted = cuts.clone();
                sorted.sort_by(f64::total_cmp);
                let pieces = cut_edge_at(edge, &sorted, merged_x, merged_y, meters_per_unit);
                cut_count += pieces.len() - 1;
                cut_edges.extend(pieces);
            }
            None => cut_edges.push(clone_edge(edge)),
        }
    }
    *final_edges = cut_edges;
    cut_count
}

/// One projection of a corner onto a candidate stretch of pavement.
struct Projection {
    entry: usize,  // which entry of the `pavement` list
    vertex: usize, // its sub-segment, by that sub-segment's first vertex
    param: f64,    // how far along the sub-segment the projection falls
    point: (i32, i32),
    meters: f64,
}

/// Sub-segments of `pavement` within `radius`, nearest first; the nearest isn't always the one.
fn pavement_within(
    grid: &conflate::SegmentGrid,
    final_edges: &[Edge],
    pavement: &[u32],
    point: (i32, i32),
    radius: f64,
    meters_per_unit: (f64, f64),
) -> Vec<Projection> {
    let mut found: Vec<Projection> = Vec::new();
    for (entry, vertex) in grid.nearby(point, radius, meters_per_unit) {
        let edge = &final_edges[pavement[entry as usize] as usize];
        let from = (edge.poly_x[vertex as usize], edge.poly_y[vertex as usize]);
        let to = (
            edge.poly_x[vertex as usize + 1],
            edge.poly_y[vertex as usize + 1],
        );
        let (meters, param, projected) = conflate::project(point, from, to, meters_per_unit);
        if meters <= radius {
            found.push(Projection {
                entry: entry as usize,
                vertex: vertex as usize,
                param,
                point: projected,
                meters,
            });
        }
    }
    found.sort_by(|left, right| {
        left.meters
            .total_cmp(&right.meters)
            .then(left.entry.cmp(&right.entry))
            .then(left.vertex.cmp(&right.vertex))
    });
    found
}

/// One finished v2 edge; `name_id` is still the STRT id here and is remapped at write.
#[derive(Clone)]
#[cfg_attr(test, derive(PartialEq, Debug))]
struct V2Edge {
    a: u32,
    b: u32,
    length: f32,
    geom: u32,
    cover: u8,
    half_offset: u8,
    name_id: u16,
    kind: u8,
    side: u8,
    flags: u8,
    source_id: u32,
}

/// `atan2(north, east)` to the first vertex distinct from the node; a collapsed segment gives 0.
fn departure_bearing(
    poly_x: &[i32],
    poly_y: &[i32],
    at_a: bool,
    meters_per_unit_lng: f64,
    meters_per_unit_lat: f64,
) -> f64 {
    let count = poly_x.len();
    let bearing_to = |origin_x: i32, origin_y: i32, other_x: i32, other_y: i32| {
        let east = f64::from(other_x - origin_x) * meters_per_unit_lng;
        let north = f64::from(other_y - origin_y) * meters_per_unit_lat;
        north.atan2(east)
    };
    if at_a {
        let (origin_x, origin_y) = (poly_x[0], poly_y[0]);
        for vertex in 1..count {
            if poly_x[vertex] != origin_x || poly_y[vertex] != origin_y {
                return bearing_to(origin_x, origin_y, poly_x[vertex], poly_y[vertex]);
            }
        }
    } else {
        let (origin_x, origin_y) = (poly_x[count - 1], poly_y[count - 1]);
        for vertex in (0..count - 1).rev() {
            if poly_x[vertex] != origin_x || poly_y[vertex] != origin_y {
                return bearing_to(origin_x, origin_y, poly_x[vertex], poly_y[vertex]);
            }
        }
    }
    0.0
}

/// The N/S/E/W wind a normal points into; exact diagonals resolve to N/S.
fn side_label(normal_x: f64, normal_y: f64) -> u8 {
    if normal_y >= normal_x.abs() {
        SIDE_NORTH
    } else if normal_y <= -normal_x.abs() {
        SIDE_SOUTH
    } else if normal_x > 0.0 {
        SIDE_EAST
    } else {
        SIDE_WEST
    }
}

/// Side labels of a street's two sidewalks, geometry-left then geometry-right.
fn side_labels(
    poly_x: &[i32],
    poly_y: &[i32],
    meters_per_unit_lng: f64,
    meters_per_unit_lat: f64,
) -> (u8, u8) {
    let last = poly_x.len() - 1;
    let mut chord_x = f64::from(poly_x[last] - poly_x[0]) * meters_per_unit_lng;
    let mut chord_y = f64::from(poly_y[last] - poly_y[0]) * meters_per_unit_lat;
    if chord_x.hypot(chord_y) < SHORT_CHORD_METERS {
        let bearing = departure_bearing(
            poly_x,
            poly_y,
            true,
            meters_per_unit_lng,
            meters_per_unit_lat,
        );
        chord_x = bearing.cos();
        chord_y = bearing.sin();
    }
    // The geometry-left normal is the travel direction turned 90 degrees counter-clockwise.
    let left = side_label(-chord_y, chord_x);
    let right = side_label(chord_y, -chord_x);
    (left, right)
}

/// Great-circle meters matching the client's `haversineMeters`, so A* stays admissible.
fn great_circle(
    from_x: i32,
    from_y: i32,
    to_x: i32,
    to_y: i32,
    origin_lng: f64,
    origin_lat: f64,
    scale: f64,
) -> f64 {
    let lng_from = (origin_lng + f64::from(from_x) * scale).to_radians();
    let lng_to = (origin_lng + f64::from(to_x) * scale).to_radians();
    let lat_from = (origin_lat + f64::from(from_y) * scale).to_radians();
    let lat_to = (origin_lat + f64::from(to_y) * scale).to_radians();
    let sin_lat = ((lat_to - lat_from) / 2.0).sin();
    let sin_lng = ((lng_to - lng_from) / 2.0).sin();
    let inner = sin_lat * sin_lat + lat_from.cos() * lat_to.cos() * sin_lng * sin_lng;
    2.0 * EARTH_RADIUS_METERS * inner.sqrt().min(1.0).asin()
}

fn node_distance(
    node_x: &[i32],
    node_y: &[i32],
    left: u32,
    right: u32,
    origin_lng: f64,
    origin_lat: f64,
    scale: f64,
) -> f64 {
    great_circle(
        node_x[left as usize],
        node_y[left as usize],
        node_x[right as usize],
        node_y[right as usize],
        origin_lng,
        origin_lat,
        scale,
    )
}

/// Geodesic length with the same earth radius as `node_distance`, so both use one metric.
fn polyline_length(
    poly_x: &[i32],
    poly_y: &[i32],
    origin_lng: f64,
    origin_lat: f64,
    scale: f64,
) -> f64 {
    let mut total = 0.0;
    for vertex in 1..poly_x.len() {
        total += great_circle(
            poly_x[vertex - 1],
            poly_y[vertex - 1],
            poly_x[vertex],
            poly_y[vertex],
            origin_lng,
            origin_lat,
            scale,
        );
    }
    total
}

/// A sidewalk's geometry: the centerline offset to one side, ends replaced by its corner nodes.
fn offset_polyline(
    poly_x: &[i32],
    poly_y: &[i32],
    half_offset_m: f64,
    sign: f64,
    corner_a: (i32, i32),
    corner_b: (i32, i32),
    meters_per_unit: (f64, f64),
) -> (Vec<i32>, Vec<i32>) {
    let (meters_per_unit_lng, meters_per_unit_lat) = meters_per_unit;
    let count = poly_x.len();
    let mut out_x = Vec::with_capacity(count);
    let mut out_y = Vec::with_capacity(count);
    out_x.push(corner_a.0);
    out_y.push(corner_a.1);
    let same =
        |left: usize, right: usize| poly_x[left] == poly_x[right] && poly_y[left] == poly_y[right];
    for vertex in 1..count - 1 {
        // Span distinct neighbors, so a coincident vertex doesn't zero the normal.
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
        // The geometry-left normal is the tangent turned 90 degrees counter-clockwise.
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
    out_x.push(corner_b.0);
    out_y.push(corner_b.1);
    (out_x, out_y)
}

impl conflate::Adjacency for HashMap<u32, Vec<(u32, f64)>> {
    fn neighbors(&self, node: u32) -> &[(u32, f64)] {
        self.get(&node).map_or(&[], Vec::as_slice)
    }
}

/// Whether mapped OSM crossings alone join two termini within `cap` meters.
fn crossing_joins(adjacency: &HashMap<u32, Vec<(u32, f64)>>, from: u32, to: u32, cap: f64) -> bool {
    let mut joined = false;
    conflate::walk_within(adjacency, from, cap, |node| {
        if node == to {
            joined = true;
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    });
    joined
}

fn find(parent: &mut [u32], start: u32) -> u32 {
    let mut node = start;
    while parent[node as usize] != node {
        parent[node as usize] = parent[parent[node as usize] as usize];
        node = parent[node as usize];
    }
    node
}

// The smaller id becomes the root, so a merged near-node keeps the lower id's coordinates.
fn union(parent: &mut [u32], left: u32, right: u32) -> bool {
    let root_left = find(parent, left);
    let root_right = find(parent, right);
    if root_left == root_right {
        false
    } else {
        let (low, high) = (root_left.min(root_right), root_left.max(root_right));
        parent[high as usize] = low;
        true
    }
}

/// Length-weighted trapezoid of the vertex cover bytes per side, computed before any merging.
fn segment_cover(
    densities: &[u8],
    quantized_x: &[i32],
    quantized_y: &[i32],
    from: usize,
    to: usize,
    meters_per_unit_lng: f64,
    meters_per_unit_lat: f64,
) -> (u8, u8) {
    let mut total = 0.0;
    let mut left = 0.0;
    let mut right = 0.0;
    for vertex in from..to - 1 {
        let delta_x =
            f64::from(quantized_x[vertex + 1] - quantized_x[vertex]) * meters_per_unit_lng;
        let delta_y =
            f64::from(quantized_y[vertex + 1] - quantized_y[vertex]) * meters_per_unit_lat;
        let length = delta_x.hypot(delta_y);
        let left_pair =
            f64::from(densities[SIDES * vertex]) + f64::from(densities[SIDES * (vertex + 1)]);
        let right_pair = f64::from(densities[SIDES * vertex + 1])
            + f64::from(densities[SIDES * (vertex + 1) + 1]);
        left += length * left_pair / 2.0;
        right += length * right_pair / 2.0;
        total += length;
    }
    if total > 0.0 {
        (
            round_half_up(left / total) as u8,
            round_half_up(right / total) as u8,
        )
    } else {
        (densities[SIDES * from], densities[SIDES * from + 1])
    }
}

// A shape joint: two half-edges agreeing on half-offset, flags and name (a name change is kept).
fn contractible(edges: &[Edge], incidence: &[Vec<u32>], node: u32) -> bool {
    let incident = &incidence[node as usize];
    incident.len() == 2
        && incident[0] != incident[1]
        && edges[incident[0] as usize].offset == edges[incident[1] as usize].offset
        && edges[incident[0] as usize].flags == edges[incident[1] as usize].flags
        && edges[incident[0] as usize].name_id == edges[incident[1] as usize].name_id
        && edges[incident[0] as usize].osm == edges[incident[1] as usize].osm
        // Pieces merge only as the same kind on the same side of the same street.
        && edges[incident[0] as usize].kind == edges[incident[1] as usize].kind
        && edges[incident[0] as usize].side == edges[incident[1] as usize].side
        // The two halves leave in opposite directions, so matching masks mirror each other.
        && sidewalks_leaving(&edges[incident[0] as usize], node)
            == swap_sidewalks(sidewalks_leaving(&edges[incident[1] as usize], node))
        // The paved mask differs from the derived one where OSM owns a side, and decides crossings.
        && paved_leaving(&edges[incident[0] as usize], node)
            == swap_sidewalks(paved_leaving(&edges[incident[1] as usize], node))
        // A curb end binds to a corner that exists only while this node does.
        && !curb_end(&edges[incident[0] as usize], node)
        && !curb_end(&edges[incident[1] as usize], node)
}

/// Merge a degree-2 chain from `start` into one edge; its source id is the parts' minimum.
fn trace_chain(
    edges: &[Edge],
    incidence: &[Vec<u32>],
    visited: &mut [bool],
    start: u32,
    first_edge: u32,
) -> Edge {
    let offset = edges[first_edge as usize].offset;
    let flags = flags_leaving(&edges[first_edge as usize], start);
    let name_id = edges[first_edge as usize].name_id;
    let osm = edges[first_edge as usize].osm;
    let kind = edges[first_edge as usize].kind;
    let side = edges[first_edge as usize].side;
    let mut source_id = edges[first_edge as usize].source_id;
    // Every part of a contractible chain agrees on both masks once oriented.
    let sidewalks = sidewalks_leaving(&edges[first_edge as usize], start);
    let paved = paved_leaving(&edges[first_edge as usize], start);
    let curb_a = curb_end(&edges[first_edge as usize], start);
    // Assigned on every pass before any break, so it ends as the chain's far end.
    let mut curb_b;
    let mut poly_x: Vec<i32> = Vec::new();
    let mut poly_y: Vec<i32> = Vec::new();
    let mut length = 0.0f32;
    let mut total_weight = 0.0f64;
    let mut left_weighted = 0.0f64;
    let mut right_weighted = 0.0f64;
    let mut current = start;
    let mut edge_id = first_edge;
    loop {
        let edge = &edges[edge_id as usize];
        visited[edge_id as usize] = true;
        let (part_x, part_y, far, left, right) = if edge.a == current {
            (
                edge.poly_x.clone(),
                edge.poly_y.clone(),
                edge.b,
                edge.cover_left,
                edge.cover_right,
            )
        } else {
            let mut reversed_x = edge.poly_x.clone();
            let mut reversed_y = edge.poly_y.clone();
            reversed_x.reverse();
            reversed_y.reverse();
            (
                reversed_x,
                reversed_y,
                edge.a,
                edge.cover_right,
                edge.cover_left,
            )
        };
        if poly_x.is_empty() {
            poly_x.extend_from_slice(&part_x);
            poly_y.extend_from_slice(&part_y);
        } else {
            poly_x.extend_from_slice(&part_x[1..]);
            poly_y.extend_from_slice(&part_y[1..]);
        }
        length += edge.length;
        source_id = source_id.min(edge.source_id);
        total_weight += f64::from(edge.length);
        left_weighted += f64::from(edge.length) * f64::from(left);
        right_weighted += f64::from(edge.length) * f64::from(right);
        current = far;
        curb_b = curb_end(edge, current);

        if !contractible(edges, incidence, current) {
            break;
        }
        let incident = &incidence[current as usize];
        let next = if incident[0] == edge_id {
            incident[1]
        } else {
            incident[0]
        };
        // A chain closing on itself is a degree-2 cycle, emitted as a self-loop.
        if visited[next as usize] {
            break;
        }
        // Unreachable today (longest ~84 vertices), but the format caps vertex counts at u16.
        if poly_x.len() + edges[next as usize].poly_x.len() - 1 > MAX_EDGE_VERTICES {
            break;
        }
        edge_id = next;
    }
    let (cover_left, cover_right) = if total_weight > 0.0 {
        (
            round_half_up(left_weighted / total_weight) as u8,
            round_half_up(right_weighted / total_weight) as u8,
        )
    } else {
        (0, 0)
    };
    Edge {
        a: start,
        b: current,
        poly_x,
        poly_y,
        length,
        cover_left,
        cover_right,
        offset,
        flags,
        name_id,
        osm,
        source_id,
        kind,
        side,
        sidewalks,
        paved,
        curb_a,
        curb_b,
    }
}

/// Drop interior vertices deviating under ~0.15 m from the chord; drawing-only, cover is already set.
fn prune_collinear(xs: &[i32], ys: &[i32]) -> (Vec<i32>, Vec<i32>) {
    let count = xs.len();
    if count <= 2 {
        return (xs.to_vec(), ys.to_vec());
    }
    let mut keep = vec![0usize];
    for vertex in 1..count - 1 {
        let anchor = *keep.last().expect("a kept vertex");
        let chord_x = f64::from(xs[vertex + 1] - xs[anchor]);
        let chord_y = f64::from(ys[vertex + 1] - ys[anchor]);
        let point_x = f64::from(xs[vertex] - xs[anchor]);
        let point_y = f64::from(ys[vertex] - ys[anchor]);
        let cross = (chord_x * point_y - chord_y * point_x).abs();
        let chord = chord_x.hypot(chord_y);
        let deviation = if chord > 0.0 {
            cross / chord
        } else {
            point_x.hypot(point_y)
        };
        if deviation > PRUNE_DEVIATION_UNITS {
            keep.push(vertex);
        }
    }
    keep.push(count - 1);
    (
        keep.iter().map(|&index| xs[index]).collect(),
        keep.iter().map(|&index| ys[index]).collect(),
    )
}

/// A mapped crossing beats a synthesized one, then the shorter wins, then the incumbent.
fn crossing_supersedes(candidate: &V2Edge, incumbent: &V2Edge) -> bool {
    let candidate_mapped = candidate.flags & GRPH_OSM != 0;
    let incumbent_mapped = incumbent.flags & GRPH_OSM != 0;
    if candidate_mapped == incumbent_mapped {
        candidate.length < incumbent.length
    } else {
        candidate_mapped
    }
}

/// Drop and return self-loop edges; no search takes one, so dropping cannot disconnect anything.
fn drop_self_loops(edges: &mut Vec<V2Edge>) -> Vec<V2Edge> {
    let mut dropped: Vec<V2Edge> = Vec::new();
    edges.retain(|edge| {
        if edge.a == edge.b {
            dropped.push(edge.clone());
            false
        } else {
            true
        }
    });
    dropped
}

/// OSM way ids every edge of which the island drop removed, so the overlay can skip them.
fn stranded_osm_paths(
    edges: &[Edge],
    final_edges: &[Edge],
    keep_edge: &[bool],
    node_count: usize,
) -> Vec<u32> {
    let mut parent: Vec<u32> = (0..node_count as u32).collect();
    for edge in final_edges.iter().chain(edges) {
        union(&mut parent, edge.a, edge.b);
    }
    let mut dropped_roots: HashSet<u32> = HashSet::new();
    for (edge, keep) in final_edges.iter().zip(keep_edge) {
        if !keep {
            let root = find(&mut parent, edge.a);
            dropped_roots.insert(root);
        }
    }
    let mut kept: HashSet<u32> = HashSet::new();
    let mut lost: HashSet<u32> = HashSet::new();
    for edge in edges {
        if edge.osm && edge.kind == KIND_PATH {
            let root = find(&mut parent, edge.a);
            if dropped_roots.contains(&root) {
                lost.insert(edge.source_id);
            } else {
                kept.insert(edge.source_id);
            }
        }
    }
    let mut ways: Vec<u32> = lost.difference(&kept).copied().collect();
    ways.sort_unstable();
    ways
}

/// Keep one crossing per node pair, returning how many were dropped.
fn collapse_parallel_crossings(edges: &mut Vec<V2Edge>) -> usize {
    let mut kept: HashMap<(u32, u32), usize> = HashMap::new();
    let mut dropped = vec![false; edges.len()];
    for edge_id in 0..edges.len() {
        let edge = &edges[edge_id];
        if edge.kind != KIND_CROSSING {
            continue;
        }
        let pair = (edge.a.min(edge.b), edge.a.max(edge.b));
        match kept.get(&pair).copied() {
            None => {
                kept.insert(pair, edge_id);
            }
            Some(incumbent) => {
                let (winner, loser) = if crossing_supersedes(edge, &edges[incumbent]) {
                    (edge_id, incumbent)
                } else {
                    (incumbent, edge_id)
                };
                dropped[loser] = true;
                kept.insert(pair, winner);
            }
        }
    }
    let collapsed = dropped.iter().filter(|&&drop| drop).count();
    if collapsed > 0 {
        let mut survivors: Vec<V2Edge> = Vec::with_capacity(edges.len() - collapsed);
        for (edge, drop) in edges.drain(..).zip(&dropped) {
            if !drop {
                survivors.push(edge);
            }
        }
        *edges = survivors;
    }
    collapsed
}

/// Per edge, how many earlier edges share its `(source id, side)`; a 257th is an error.
fn assign_ordinals(edges: &[V2Edge]) -> Fallible<Vec<u8>> {
    let mut seen: HashMap<(u32, u8), usize> = HashMap::new();
    let mut ordinals = vec![0u8; edges.len()];
    for (edge_id, edge) in edges.iter().enumerate() {
        if edge.source_id == NO_SOURCE_ID {
            continue;
        }
        let count = seen.entry((edge.source_id, edge.side)).or_insert(0);
        if *count >= ORDINALS {
            return Err(format!(
                "source id {} side {} carries more than {ORDINALS} edges: the durable key's ordinal overflows",
                edge.source_id, edge.side
            )
            .into());
        }
        ordinals[edge_id] = *count as u8;
        *count += 1;
    }
    Ok(ordinals)
}

fn put_u16(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_f64(bytes: &mut [u8], offset: usize, value: f64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

/// Kinds whose bytes 20-21 are a u16 of seconds; they carry no polyline or scenic attribute.
fn timed_kind(kind: u8) -> bool {
    matches!(kind, KIND_FERRY | KIND_ACCESS | KIND_BOARD | KIND_RIDE)
}

/// One transit edge; its length is the straight node-to-node distance.
#[allow(clippy::too_many_arguments)]
fn transit_edge(
    node_x: &[i32],
    node_y: &[i32],
    from: u32,
    to: u32,
    kind: u8,
    seconds: u16,
    name_id: u16,
    flags: u8,
    origin_lng: f64,
    origin_lat: f64,
    scale: f64,
) -> V2Edge {
    V2Edge {
        a: from,
        b: to,
        length: node_distance(node_x, node_y, from, to, origin_lng, origin_lat, scale) as f32,
        geom: NO_GEOMETRY,
        cover: (seconds & 0x00FF) as u8,
        half_offset: (seconds >> 8) as u8,
        name_id,
        kind,
        side: SIDE_NONE,
        flags,
        source_id: NO_SOURCE_ID,
    }
}

/// One station node's worth of the topology; the node stands at its members' centroid.
struct StationGroup {
    lng: f64,
    lat: f64,
    name: String,
    surface: bool,
    member_points: Vec<(f64, f64)>,
    /// Two sides where the agency publishes no free crossover, with no edge between them.
    sides: usize,
    /// The published ways in, indexed into the topology's entrance table.
    entrances: Vec<usize>,
}

/// One group per transfer complex or lone station, so a transfer is an alight and a board.
fn station_groups(
    stations: &[binfmt::TransitStation],
    entrances: &[binfmt::TransitEntrance],
) -> (Vec<StationGroup>, Vec<usize>) {
    let mut group_of_complex: HashMap<u16, usize> = HashMap::new();
    let mut members: Vec<Vec<usize>> = Vec::new();
    let mut group_of_station: Vec<usize> = Vec::with_capacity(stations.len());
    for (index, station) in stations.iter().enumerate() {
        let group = if station.complex == 0 {
            members.push(Vec::new());
            members.len() - 1
        } else {
            *group_of_complex.entry(station.complex).or_insert_with(|| {
                members.push(Vec::new());
                members.len() - 1
            })
        };
        members[group].push(index);
        group_of_station.push(group);
    }
    let mut entrances_of_group: Vec<Vec<usize>> = vec![Vec::new(); members.len()];
    for (index, entrance) in entrances.iter().enumerate() {
        entrances_of_group[group_of_station[usize::from(entrance.station)]].push(index);
    }

    let groups = members
        .iter()
        .zip(entrances_of_group)
        .map(|(member, entrances)| {
            let mut counts: HashMap<&str, usize> = HashMap::new();
            for &station in member {
                *counts.entry(stations[station].name.as_str()).or_insert(0) += 1;
            }
            let mut commonest = ("", 0usize);
            for &station in member {
                let name = stations[station].name.as_str();
                if counts[name] > commonest.1 {
                    commonest = (name, counts[name]);
                }
            }
            let count = member.len() as f64;
            StationGroup {
                lng: member.iter().map(|&one| stations[one].lng).sum::<f64>() / count,
                lat: member.iter().map(|&one| stations[one].lat).sum::<f64>() / count,
                name: commonest.0.to_string(),
                surface: member.iter().all(|&one| stations[one].surface),
                member_points: member
                    .iter()
                    .map(|&one| (stations[one].lng, stations[one].lat))
                    .collect(),
                // A complex keeps one node, since a transfer inside it is free.
                sides: if member.len() == 1 && stations[member[0]].split {
                    2
                } else {
                    1
                },
                entrances,
            }
        })
        .collect();
    (groups, group_of_station)
}

/// Where one member station meets the pavement.
struct PavementFoot {
    edge: u32,
    along: f64,
    point: (i32, i32),
}

/// Edges whose foot is within the entrance radius, else the nearest within the snap radius.
#[allow(clippy::too_many_arguments)]
fn pavement_feet(
    point: (i32, i32),
    nearest_only: bool,
    grid: &conflate::SegmentGrid,
    candidates: &[u32],
    v2_edges: &[V2Edge],
    geometry_polys: &[(Vec<i32>, Vec<i32>)],
    origin_lng: f64,
    origin_lat: f64,
    scale: f64,
    meters_per_unit: (f64, f64),
) -> Vec<(f64, PavementFoot)> {
    let polyline_of = |edge: u32| -> &(Vec<i32>, Vec<i32>) {
        &geometry_polys[v2_edges[edge as usize].geom as usize]
    };
    // One projection: how far off it is, the edge, and where on that edge it landed.
    #[derive(Clone, Copy)]
    struct Nearest {
        meters: f64,
        edge: u32,
        vertex: usize,
        param: f64,
        point: (i32, i32),
    }
    let nearer = |left: &Nearest, right: &Nearest| -> bool {
        // The edge id breaks ties, since pieces meeting at a corner can be equidistant.
        left.meters < right.meters || (left.meters == right.meters && left.edge < right.edge)
    };
    let mut doors: HashMap<u32, Nearest> = HashMap::new();
    let mut nearest: Option<Nearest> = None;
    for (candidate, vertex) in grid.nearby(point, TRANSIT_SNAP_RADIUS_METERS, meters_per_unit) {
        let edge = candidates[candidate as usize];
        let (poly_x, poly_y) = polyline_of(edge);
        let vertex = vertex as usize;
        let (meters, param, projected) = conflate::project(
            point,
            (poly_x[vertex], poly_y[vertex]),
            (poly_x[vertex + 1], poly_y[vertex + 1]),
            meters_per_unit,
        );
        if meters > TRANSIT_SNAP_RADIUS_METERS {
            continue;
        }
        let standing = Nearest {
            meters,
            edge,
            vertex,
            param,
            point: projected,
        };
        let beats_all = nearest.is_none_or(|incumbent| nearer(&standing, &incumbent));
        let beats_its_edge = !nearest_only
            && doors
                .get(&edge)
                .is_none_or(|incumbent| nearer(&standing, incumbent));
        if !beats_all && !beats_its_edge {
            continue;
        }
        let reach = great_circle(
            point.0,
            point.1,
            projected.0,
            projected.1,
            origin_lng,
            origin_lat,
            scale,
        );
        if reach > TRANSIT_SNAP_RADIUS_METERS {
            continue;
        }
        if beats_all {
            nearest = Some(standing);
        }
        if beats_its_edge && reach <= TRANSIT_ENTRANCE_RADIUS_METERS {
            doors.insert(edge, standing);
        }
    }

    let mut kept: Vec<Nearest> = if doors.is_empty() {
        nearest.into_iter().collect()
    } else {
        doors.into_values().collect()
    };
    kept.sort_by(|left, right| {
        left.meters
            .total_cmp(&right.meters)
            .then(left.edge.cmp(&right.edge))
    });
    kept.into_iter()
        .map(|door| {
            let (poly_x, poly_y) = polyline_of(door.edge);
            (
                door.meters,
                PavementFoot {
                    edge: door.edge,
                    along: conflate::along_at(
                        poly_x,
                        poly_y,
                        door.vertex,
                        door.param,
                        meters_per_unit,
                    ),
                    point: door.point,
                },
            )
        })
        .collect()
}

/// One way into a station group before the pavement is cut.
struct DoorRequest {
    foot: usize,
    sides: u8,
    base: u16,
    flags: u8,
    street: (u16, u8),
}

/// Doors of one side on the same node, kind and directions, collapsed into one.
struct JoinedDoor {
    node: u32,
    base: u16,
    kind: u8,
    entry: bool,
    exit: bool,
    street: (u16, u8),
}

/// The entry and exit nodes of one platform side.
struct StationSide {
    entry: u32,
    exit: u32,
}

/// The name and side of the edge a door's foot landed on, read before the cut.
fn door_street(v2_edges: &[V2Edge], foot: &PavementFoot) -> (u16, u8) {
    let edge = &v2_edges[foot.edge as usize];
    (edge.name_id, edge.side)
}

/// What the descent costs before the walk out to the door; a curbside stop is one step.
fn entrance_base(surface: bool, kind: binfmt::EntranceKind) -> u16 {
    if surface {
        SURFACE_ACCESS_SECONDS
    } else if kind == binfmt::EntranceKind::Elevator {
        ELEVATOR_ACCESS_SECONDS
    } else {
        UNDERGROUND_ACCESS_SECONDS
    }
}

fn entrance_flags(entrance: &binfmt::TransitEntrance) -> u8 {
    let mut flags = 0u8;
    if !entrance.entry {
        flags |= ACCESS_EXIT_ONLY;
    }
    if !entrance.exit {
        flags |= ACCESS_ENTRY_ONLY;
    }
    if entrance.kind == binfmt::EntranceKind::Elevator {
        flags |= ACCESS_ELEVATOR;
    }
    flags
}

/// Cut every walking edge a station foot landed on, returning each foot's node and the cut count.
#[allow(clippy::too_many_arguments)]
fn cut_pavement_at_feet(
    feet: &[PavementFoot],
    node_lng: &mut Vec<i32>,
    node_lat: &mut Vec<i32>,
    v2_edges: &mut Vec<V2Edge>,
    geometry_polys: &mut Vec<(Vec<i32>, Vec<i32>)>,
    origin_lng: f64,
    origin_lat: f64,
    scale: f64,
    meters_per_unit: (f64, f64),
) -> (Vec<u32>, usize) {
    let mut feet_of_edge: HashMap<u32, Vec<usize>> = HashMap::new();
    for (index, foot) in feet.iter().enumerate() {
        feet_of_edge.entry(foot.edge).or_default().push(index);
    }
    let mut node_of_foot: Vec<u32> = vec![u32::MAX; feet.len()];
    let mut cuts_made = 0usize;
    // In edge order, since hash map order is seeded per process.
    let mut cut_edges: Vec<u32> = feet_of_edge.keys().copied().collect();
    cut_edges.sort_unstable();
    for edge_id in cut_edges {
        let mut indices = feet_of_edge.remove(&edge_id).expect("the edge's own feet");
        indices.sort_by(|&left, &right| feet[left].along.total_cmp(&feet[right].along));
        let parent = v2_edges[edge_id as usize].clone();
        let (poly_x, poly_y) = geometry_polys[parent.geom as usize].clone();
        let woven = weave_cuts(
            &poly_x,
            &poly_y,
            &indices
                .iter()
                .map(|&index| CutAt {
                    along: feet[index].along,
                    point: Some(feet[index].point),
                })
                .collect::<Vec<CutAt>>(),
            meters_per_unit,
        );
        let last = woven.x.len() - 1;

        // A node per cut; a foot on an end joins the existing node.
        let mut node_of_vertex: HashMap<usize, u32> =
            HashMap::with_capacity(woven.boundaries.len());
        for &boundary in &woven.boundaries {
            node_of_vertex.insert(boundary, node_lng.len() as u32);
            node_lng.push(woven.x[boundary]);
            node_lat.push(woven.y[boundary]);
        }
        for (&index, &vertex) in indices.iter().zip(&woven.vertex_of_cut) {
            node_of_foot[index] = if vertex == 0 {
                parent.a
            } else if vertex == last {
                parent.b
            } else {
                node_of_vertex[&vertex]
            };
        }
        if woven.boundaries.is_empty() {
            continue;
        }

        let full = conflate::polyline_meters(&woven.x, &woven.y, meters_per_unit);
        let mut start = 0usize;
        for (piece, &end) in woven
            .boundaries
            .iter()
            .chain(std::iter::once(&last))
            .enumerate()
        {
            let piece_x = woven.x[start..=end].to_vec();
            let piece_y = woven.y[start..=end].to_vec();
            let node_a = match node_of_vertex.get(&start) {
                Some(&node) => node,
                None => parent.a,
            };
            let node_b = match node_of_vertex.get(&end) {
                Some(&node) => node,
                None => parent.b,
            };
            let share = if full > 0.0 {
                (f64::from(parent.length)
                    * conflate::polyline_meters(&piece_x, &piece_y, meters_per_unit)
                    / full) as f32
            } else {
                parent.length
            };
            let straight = node_distance(
                node_lng, node_lat, node_a, node_b, origin_lng, origin_lat, scale,
            ) as f32;
            let length = share.max(straight);
            if piece == 0 {
                geometry_polys[parent.geom as usize] = (piece_x, piece_y);
                let edge = &mut v2_edges[edge_id as usize];
                edge.b = node_b;
                edge.length = length;
            } else {
                let geom = geometry_polys.len() as u32;
                geometry_polys.push((piece_x, piece_y));
                v2_edges.push(V2Edge {
                    a: node_a,
                    b: node_b,
                    length,
                    geom,
                    ..parent.clone()
                });
            }
            start = end;
        }
        cuts_made += woven.boundaries.len();
    }
    (node_of_foot, cuts_made)
}

/// What the transit pass appended, for the log and the transit side tables.
#[derive(Default)]
struct TransitBuild {
    /// Station nodes: two per platform side (in and out).
    stations: usize,
    unsnapped: usize,
    /// The groups that got a pair of nodes per platform side.
    split_stations: usize,
    /// The published entrances that found pavement and became doors.
    entrances: usize,
    /// Groups with no enterable published entrance, which took the station point's own doors.
    fallback_stations: usize,
    /// Groups with a side lacking a way in, which stand on one node after all.
    collapsed_stations: usize,
    /// Access edges joining station nodes to the pavement: one per direction per door per side.
    street_doors: usize,
    /// The exit-to-entry edges a change of train crosses.
    transfer_edges: usize,
    /// The mid-block nodes those joins cut into the walking network.
    pavement_cuts: usize,
    /// Platform nodes: two per stop of every pattern (board and alight).
    platform_nodes: usize,
    access_edges: usize,
    board_edges: usize,
    ride_edges: usize,
    /// The arrival-to-boarding edges a rider staying on the train crosses.
    stay_aboard_edges: usize,
    dropped_patterns: usize,
    routes: Vec<TransitRouteRecord>,
    /// Per board edge its lane, route and stop index; per ride edge its route, in edge-id order.
    board_table: Vec<(u32, u32, u16, u16)>,
    ride_table: Vec<(u32, u16)>,
    /// Per door the street and side it stands on, which the maneuver names it by.
    door_table: Vec<(u32, u16, u8)>,
}

/// Transit: entry/exit node pairs per side and board/arrival pairs per stop, so no free underpass.
#[allow(clippy::too_many_arguments)]
fn append_transit(
    transit: &binfmt::Transit,
    node_lng: &mut Vec<i32>,
    node_lat: &mut Vec<i32>,
    v2_edges: &mut Vec<V2Edge>,
    geometry_polys: &mut Vec<(Vec<i32>, Vec<i32>)>,
    all_names: &mut Vec<String>,
    origin_lng: f64,
    origin_lat: f64,
    scale: f64,
    meters_per_unit: (f64, f64),
) -> TransitBuild {
    let quantize_x = |lng: f64| ((lng - origin_lng) / scale).round() as i32;
    let quantize_y = |lat: f64| ((lat - origin_lat) / scale).round() as i32;
    let mut built = TransitBuild::default();
    let mut interned: HashMap<String, u16> = HashMap::new();
    for route in &transit.routes {
        built.routes.push(TransitRouteRecord {
            color: route.color,
            text_color: route.text_color,
            short_name: intern_name(all_names, &mut interned, &route.short_name),
            long_name: intern_name(all_names, &mut interned, &route.long_name),
            id_name: intern_name(all_names, &mut interned, &route.id),
        });
    }

    // Each published entrance projects onto the edge under it; none falls back to the station point.
    let (groups, group_of_station) = station_groups(&transit.stations, &transit.entrances);
    let candidates: Vec<u32> = v2_edges
        .iter()
        .enumerate()
        .filter(|(_, edge)| {
            matches!(edge.kind, KIND_SIDEWALK | KIND_PATH) && edge.geom != NO_GEOMETRY
        })
        .map(|(edge_id, _)| edge_id as u32)
        .collect();
    let grid = conflate::SegmentGrid::new(
        candidates.iter().map(|&edge_id| {
            let (poly_x, poly_y) = &geometry_polys[v2_edges[edge_id as usize].geom as usize];
            (&poly_x[..], &poly_y[..])
        }),
        meters_per_unit,
    );
    let mut feet: Vec<PavementFoot> = Vec::new();
    let mut doors_of_group: Vec<Vec<DoorRequest>> = Vec::with_capacity(groups.len());
    for group in &groups {
        let both_sides: u8 = if group.sides == 2 { 0b11 } else { 0b01 };
        let mut doors: Vec<DoorRequest> = Vec::new();
        // An exit-only stair is no way in (145 St northbound publishes only outward doors).
        let mut served: u8 = 0;
        for &entrance_index in &group.entrances {
            let entrance = &transit.entrances[entrance_index];
            // A one-node station takes every door, whatever side it names.
            let sides = if group.sides == 2 {
                entrance.sides & both_sides
            } else {
                both_sides
            };
            if sides == 0 {
                continue;
            }
            let point = (quantize_x(entrance.lng), quantize_y(entrance.lat));
            let landed = pavement_feet(
                point,
                true,
                &grid,
                &candidates,
                v2_edges,
                geometry_polys,
                origin_lng,
                origin_lat,
                scale,
                meters_per_unit,
            );
            let Some((_, foot)) = landed.into_iter().next() else {
                continue;
            };
            let flags = entrance_flags(entrance);
            let street = door_street(v2_edges, &foot);
            feet.push(foot);
            doors.push(DoorRequest {
                foot: feet.len() - 1,
                sides,
                base: entrance_base(group.surface, entrance.kind),
                flags,
                street,
            });
            if flags & ACCESS_EXIT_ONLY == 0 {
                served |= sides;
            }
            built.entrances += 1;
        }

        // A split group with one side served stands on that node rather than inventing doors.
        let missing = if served == 0 { both_sides } else { 0 };
        if missing != 0 {
            let mut found: Vec<(f64, PavementFoot)> = Vec::new();
            for &(member_lng, member_lat) in &group.member_points {
                let point = (quantize_x(member_lng), quantize_y(member_lat));
                found.extend(pavement_feet(
                    point,
                    false,
                    &grid,
                    &candidates,
                    v2_edges,
                    geometry_polys,
                    origin_lng,
                    origin_lat,
                    scale,
                    meters_per_unit,
                ));
            }
            // Nearest first across the whole group, so a complex spends its doors on the nearest.
            found.sort_by(|left, right| {
                left.0
                    .total_cmp(&right.0)
                    .then(left.1.edge.cmp(&right.1.edge))
            });
            found.truncate(TRANSIT_ENTRANCES_MAX);
            if !found.is_empty() {
                built.fallback_stations += 1;
            }
            let base = entrance_base(group.surface, binfmt::EntranceKind::Stair);
            for (_, foot) in found {
                let street = door_street(v2_edges, &foot);
                feet.push(foot);
                doors.push(DoorRequest {
                    foot: feet.len() - 1,
                    sides: missing,
                    base,
                    flags: 0,
                    street,
                });
            }
        }
        doors_of_group.push(doors);
    }
    let (node_of_foot, pavement_cuts) = cut_pavement_at_feet(
        &feet,
        node_lng,
        node_lat,
        v2_edges,
        geometry_polys,
        origin_lng,
        origin_lat,
        scale,
        meters_per_unit,
    );
    built.pavement_cuts = pavement_cuts;

    let mut group_nodes: Vec<Vec<StationSide>> = Vec::with_capacity(groups.len());
    for (group, doors) in groups.iter().zip(&doors_of_group) {
        if doors.is_empty() {
            built.unsnapped += 1;
            eprintln!(
                "tiler graph: transit station \"{}\" ({:.6}, {:.6}) has no walking edge within {TRANSIT_SNAP_RADIUS_METERS:.0} m; dropping it",
                group.name, group.lng, group.lat
            );
            group_nodes.push(Vec::new());
        } else {
            // A side with no way in would be unboardable, so the group stays on one node.
            let enterable = |side: usize| {
                doors
                    .iter()
                    .any(|door| door.sides & (1 << side) != 0 && door.flags & ACCESS_EXIT_ONLY == 0)
            };
            let sides = if group.sides == 2 && (0..2).all(enterable) {
                2
            } else {
                1
            };
            if sides == 2 {
                built.split_stations += 1;
            } else if group.sides == 2 {
                built.collapsed_stations += 1;
            }
            let name_id = intern_name(all_names, &mut interned, &group.name);
            let first_node = node_lng.len() as u32;
            for _ in 0..2 * sides {
                node_lng.push(quantize_x(group.lng));
                node_lat.push(quantize_y(group.lat));
            }
            let places: Vec<StationSide> = (0..sides as u32)
                .map(|side| StationSide {
                    entry: first_node + 2 * side,
                    exit: first_node + 2 * side + 1,
                })
                .collect();
            for (side, place) in places.iter().enumerate() {
                // Entrances on one node with equal directions and kind merge, at the cheaper base.
                let mut joined: Vec<JoinedDoor> = Vec::new();
                for door in doors {
                    if sides == 2 && door.sides & (1 << side) == 0 {
                        continue;
                    }
                    let walking_node = node_of_foot[door.foot];
                    let entry = door.flags & ACCESS_EXIT_ONLY == 0;
                    let exit = door.flags & ACCESS_ENTRY_ONLY == 0;
                    let kind = door.flags & ACCESS_ELEVATOR;
                    match joined.iter_mut().find(|held| {
                        held.node == walking_node
                            && held.kind == kind
                            && held.entry == entry
                            && held.exit == exit
                    }) {
                        Some(held) => {
                            if door.base < held.base {
                                held.base = door.base;
                                held.street = door.street;
                            }
                        }
                        None => joined.push(JoinedDoor {
                            node: walking_node,
                            base: door.base,
                            kind,
                            entry,
                            exit,
                            street: door.street,
                        }),
                    }
                }
                joined.sort_unstable_by_key(|door| {
                    (door.node, door.kind, door.entry, door.exit, door.base)
                });
                for door in joined {
                    // Measured from the station node so it's the edge's own length.
                    let meters = node_distance(
                        node_lng,
                        node_lat,
                        place.entry,
                        door.node,
                        origin_lng,
                        origin_lat,
                        scale,
                    );
                    let walk = (meters / ACCESS_WALK_METERS_PER_SECOND).round();
                    let seconds = (f64::from(door.base) + walk).min(f64::from(u16::MAX)) as u16;
                    // A two-way door is two edges, since in and out land on different nodes.
                    for (station_id, flag) in [
                        (place.entry, ACCESS_ENTRY_ONLY),
                        (place.exit, ACCESS_EXIT_ONLY),
                    ] {
                        if (flag == ACCESS_ENTRY_ONLY && !door.entry)
                            || (flag == ACCESS_EXIT_ONLY && !door.exit)
                        {
                            continue;
                        }
                        let edge_id = v2_edges.len() as u32;
                        v2_edges.push(transit_edge(
                            node_lng,
                            node_lat,
                            station_id,
                            door.node,
                            KIND_ACCESS,
                            seconds,
                            name_id,
                            door.kind | flag,
                            origin_lng,
                            origin_lat,
                            scale,
                        ));
                        let (street_name, street_side) = door.street;
                        if street_name != UNNAMED {
                            built.door_table.push((edge_id, street_name, street_side));
                        }
                        built.access_edges += 1;
                        built.street_doors += 1;
                    }
                }
                // Free and one-way, so no walk reaches a door through it; the board prices the wait.
                v2_edges.push(transit_edge(
                    node_lng,
                    node_lat,
                    place.exit,
                    place.entry,
                    KIND_ACCESS,
                    0,
                    name_id,
                    ACCESS_EXIT_ONLY,
                    origin_lng,
                    origin_lat,
                    scale,
                ));
                built.access_edges += 1;
                built.transfer_edges += 1;
                built.stations += 2;
            }
            group_nodes.push(places);
        }
    }

    for pattern in &transit.patterns {
        // Skip dropped stations; the kept stop index is the feed's, so departures stay aligned.
        let kept: Vec<(&StationSide, (i32, i32), u32, u16)> = pattern
            .stops
            .iter()
            .zip(&pattern.offsets)
            .enumerate()
            .filter_map(|(index, (&stop, &offset))| {
                let station = &transit.stations[stop as usize];
                let point = (quantize_x(station.lng), quantize_y(station.lat));
                // A split station boards from the nodes of its own direction.
                let places = &group_nodes[group_of_station[stop as usize]];
                places
                    .get(usize::from(pattern.direction) % places.len().max(1))
                    .map(|place| (place, point, offset, index as u16))
            })
            .collect();
        if kept.len() < 2 {
            built.dropped_patterns += 1;
            continue;
        }
        let route = &transit.routes[usize::from(pattern.route_index)];
        let route_name = intern_name(all_names, &mut interned, &route.short_name);
        let mut previous: Option<(u32, u32)> = None; // the last boarding node and its offset
        for &(place, (platform_x, platform_y), offset, stop_index) in &kept {
            // Board and arrival nodes at the feed's stop, so a board can't cross the block.
            let boarding = node_lng.len() as u32;
            node_lng.push(platform_x);
            node_lat.push(platform_y);
            let arrival = node_lng.len() as u32;
            node_lng.push(platform_x);
            node_lat.push(platform_y);
            built.platform_nodes += 2;
            let board = v2_edges.len() as u32;
            v2_edges.push(transit_edge(
                node_lng,
                node_lat,
                place.entry,
                boarding,
                KIND_BOARD,
                0,
                route_name,
                0,
                origin_lng,
                origin_lat,
                scale,
            ));
            built
                .board_table
                .push((board, pattern.lane_id, pattern.route_index, stop_index));
            built.board_edges += 1;
            // The way out: a fixed walk to the station's exit node, of the access kind.
            v2_edges.push(transit_edge(
                node_lng,
                node_lat,
                arrival,
                place.exit,
                KIND_ACCESS,
                ALIGHT_SECONDS,
                UNNAMED,
                0,
                origin_lng,
                origin_lat,
                scale,
            ));
            built.access_edges += 1;
            v2_edges.push(transit_edge(
                node_lng,
                node_lat,
                arrival,
                boarding,
                KIND_RIDE,
                0,
                UNNAMED,
                RIDE_STAY_ABOARD,
                origin_lng,
                origin_lat,
                scale,
            ));
            built.stay_aboard_edges += 1;
            if let Some((from_boarding, from_offset)) = previous {
                let seconds = offset.saturating_sub(from_offset).min(u32::from(u16::MAX));
                let ride = v2_edges.len() as u32;
                v2_edges.push(transit_edge(
                    node_lng,
                    node_lat,
                    from_boarding,
                    arrival,
                    KIND_RIDE,
                    seconds as u16,
                    route_name,
                    0,
                    origin_lng,
                    origin_lat,
                    scale,
                ));
                built.ride_table.push((ride, pattern.route_index));
                built.ride_edges += 1;
            }
            previous = Some((boarding, offset));
        }
    }
    built
}

fn intern_name(
    all_names: &mut Vec<String>,
    interned: &mut HashMap<String, u16>,
    name: &str,
) -> u16 {
    if let Some(&id) = interned.get(name) {
        id
    } else {
        let id = all_names.len() as u16;
        all_names.push(name.to_string());
        interned.insert(name.to_string(), id);
        id
    }
}

// SHDE: `bins.json` plus one file per bin (12-byte "SHDB" header, then building and tree rows).
fn write_shade(
    dir: &std::path::Path,
    edge_count: usize,
    positions: &[shade::BinPosition],
    rows: &[(Vec<u8>, Vec<u8>)],
) -> Fallible<()> {
    match fs::remove_dir_all(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    fs::create_dir_all(dir)?;

    let bins: Vec<serde_json::Value> = positions
        .iter()
        .enumerate()
        .map(|(index, position)| {
            serde_json::json!({
                "index": index,
                "season": position.season,
                "hourAngle": position.hour_angle,
                "elevation": position.elevation,
                "azimuth": position.azimuth,
            })
        })
        .collect();
    let manifest = serde_json::json!({ "edgeCount": edge_count, "bins": bins });
    fs::write(dir.join("bins.json"), serde_json::to_vec(&manifest)?)?;

    const HEADER_BYTES: usize = 12;
    for (index, (buildings, trees)) in rows.iter().enumerate() {
        let mut bytes = Vec::with_capacity(HEADER_BYTES + 2 * edge_count);
        bytes.extend_from_slice(b"SHDB");
        bytes.extend_from_slice(&2u16.to_le_bytes()); // version
        bytes.extend_from_slice(&0u16.to_le_bytes()); // pad
        bytes.extend_from_slice(&(edge_count as u32).to_le_bytes());
        bytes.extend_from_slice(buildings);
        bytes.extend_from_slice(trees);
        fs::write(dir.join(format!("{index}.bin")), &bytes)?;
    }
    Ok(())
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// FNV-1a 64 over the sorted durable keys, integer-only so it's identical across platforms.
fn key_space_hash(edges: &[V2Edge], ordinals: &[u8]) -> u64 {
    let mut keys: Vec<u64> = edges
        .iter()
        .zip(ordinals)
        .filter(|(edge, _)| edge.source_id != NO_SOURCE_ID)
        .map(|(edge, &ordinal)| {
            u64::from(edge.source_id) << 11 | u64::from(edge.side) << 8 | u64::from(ordinal)
        })
        .collect();
    // Ascending, so a reordering with the same key set doesn't change the hash.
    keys.sort_unstable();
    let mut bytes = Vec::with_capacity(8 * (keys.len() + 1));
    bytes.extend_from_slice(&(keys.len() as u64).to_le_bytes());
    for key in keys {
        bytes.extend_from_slice(&key.to_le_bytes());
    }
    fnv1a64(&bytes)
}

// `version.json`: FNV-1a 64 over the graph bytes (detects a rebuild), plus the narrower `keyHash`.
fn write_version(
    out: &std::path::Path,
    bytes: &[u8],
    edge_count: usize,
    key_hash: u64,
) -> Fallible<()> {
    let hash = fnv1a64(bytes);
    let generated = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    let version = serde_json::json!({
        "graph": out.file_name().map(|name| name.to_string_lossy()),
        "hash": format!("{hash:016x}"),
        "keyHash": format!("{key_hash:016x}"),
        "edges": edge_count,
        "bytes": bytes.len(),
        "generatedUnixSeconds": generated,
    });
    // Named per graph since two cities share the directory; the wrong hash blanks the shed layer.
    fs::write(
        out.with_extension("version.json"),
        serde_json::to_vec(&version)?,
    )?;
    Ok(())
}

/// STRD: magic, format, header size, count, then sorted u32 OSM way ids.
fn write_stranded(out: &std::path::Path, ways: &[u32]) -> Fallible<()> {
    let mut bytes = Vec::with_capacity(STRANDED_HEADER_BYTES + 4 * ways.len());
    bytes.extend_from_slice(b"STRD");
    bytes.extend_from_slice(&STRANDED_FORMAT.to_le_bytes());
    bytes.extend_from_slice(&(STRANDED_HEADER_BYTES as u16).to_le_bytes());
    bytes.extend_from_slice(&(ways.len() as u32).to_le_bytes());
    for way in ways {
        bytes.extend_from_slice(&way.to_le_bytes());
    }
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(out, &bytes)?;
    Ok(())
}

/// Read the STRD ids back for a build whose graph was already fresh.
pub fn read_stranded(path: &std::path::Path) -> Fallible<Vec<u32>> {
    let bytes = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if bytes.len() < STRANDED_HEADER_BYTES || &bytes[0..4] != b"STRD" {
        return Err(format!("{} is not a STRD file", path.display()).into());
    }
    let format = u16::from_le_bytes([bytes[4], bytes[5]]);
    if format != STRANDED_FORMAT {
        return Err(format!("{} is STRD format {format}", path.display()).into());
    }
    let header = usize::from(u16::from_le_bytes([bytes[6], bytes[7]]));
    let count = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    if bytes.len() != header + 4 * count {
        return Err(format!(
            "{} is {} bytes, not the {} its header claims",
            path.display(),
            bytes.len(),
            header + 4 * count
        )
        .into());
    }
    Ok(bytes[header..]
        .as_chunks::<4>()
        .0
        .iter()
        .copied()
        .map(u32::from_le_bytes)
        .collect())
}

/// One transit route: the feed's colors and three name ids.
#[derive(Clone, Copy)]
#[cfg_attr(test, derive(PartialEq, Debug))]
struct TransitRouteRecord {
    color: [u8; 3],
    text_color: [u8; 3],
    short_name: u16,
    long_name: u16,
    id_name: u16,
}

/// One city's finished walking network, which every attribute column is a byte per edge of.
#[cfg_attr(test, derive(PartialEq, Debug))]
struct Base {
    origin_lng: f64,
    origin_lat: f64,
    scale: f64,
    node_lng: Vec<i32>,
    node_lat: Vec<i32>,
    node_component: Vec<u16>,
    component_count: usize,
    edges: Vec<V2Edge>,
    /// The ordinal half of the durable key, per edge, over this exact order.
    ordinals: Vec<u8>,
    key_hash: u64,
    geometry_polys: Vec<(Vec<i32>, Vec<i32>)>,
    /// The compact name table every edge's `name_id` indexes.
    names: Vec<String>,
    ferry_side_table: Vec<(u32, u16, u16)>,
    /// Routes, then per board edge its lane id, route and stop index, and per ride edge its route.
    transit_routes: Vec<TransitRouteRecord>,
    transit_board_table: Vec<(u32, u32, u16, u16)>,
    transit_ride_table: Vec<(u32, u16)>,
    /// Per street-door access edge, the street name id and side it opens onto.
    transit_door_table: Vec<(u32, u16, u8)>,
    stranded_ways: Vec<u32>,
    /// The pass's stats bar the two figures the write measures.
    stats: serde_json::Value,
    /// Derived from the edges rather than stored, so a decoded base cannot disagree with them.
    csr: Vec<u32>,
    adjacency: Vec<u32>,
}

/// CSR adjacency of edge ids: node n owns [csr[n], csr[n + 1]); a self-loop lists its edge twice.
fn adjacency_of(node_count: usize, edges: &[V2Edge]) -> (Vec<u32>, Vec<u32>) {
    let mut degree = vec![0u32; node_count];
    for edge in edges {
        degree[edge.a as usize] += 1;
        degree[edge.b as usize] += 1;
    }
    let mut csr = vec![0u32; node_count + 1];
    for node in 0..node_count {
        csr[node + 1] = csr[node] + degree[node];
    }
    let mut cursor = csr.clone();
    let mut adjacency = vec![0u32; 2 * edges.len()];
    for (edge_id, edge) in edges.iter().enumerate() {
        adjacency[cursor[edge.a as usize] as usize] = edge_id as u32;
        cursor[edge.a as usize] += 1;
        adjacency[cursor[edge.b as usize] as usize] = edge_id as u32;
        cursor[edge.b as usize] += 1;
    }
    (csr, adjacency)
}

impl Base {
    /// Little-endian fields in this order; no version since the cache key folds the tiler's code.
    fn encode(&self) -> Fallible<Vec<u8>> {
        let mut out = graph_cache::Writer::default();
        out.f64(self.origin_lng);
        out.f64(self.origin_lat);
        out.f64(self.scale);
        out.usize(self.component_count);
        out.u64(self.key_hash);
        out.usize(self.node_lng.len());
        for node in 0..self.node_lng.len() {
            out.i32(self.node_lng[node]);
            out.i32(self.node_lat[node]);
            out.u16(self.node_component[node]);
        }
        out.usize(self.edges.len());
        for (edge, ordinal) in self.edges.iter().zip(&self.ordinals) {
            out.u32(edge.a);
            out.u32(edge.b);
            out.f32(edge.length);
            out.u32(edge.geom);
            out.u32(edge.source_id);
            out.u16(edge.name_id);
            out.u8(edge.cover);
            out.u8(edge.half_offset);
            out.u8(edge.kind);
            out.u8(edge.side);
            out.u8(edge.flags);
            out.u8(*ordinal);
        }
        out.usize(self.geometry_polys.len());
        for (poly_x, poly_y) in &self.geometry_polys {
            out.usize(poly_x.len());
            for (x, y) in poly_x.iter().zip(poly_y) {
                out.i32(*x);
                out.i32(*y);
            }
        }
        out.usize(self.names.len());
        for name in &self.names {
            out.bytes(name.as_bytes());
        }
        out.usize(self.ferry_side_table.len());
        for &(edge_id, a_stop_name, b_stop_name) in &self.ferry_side_table {
            out.u32(edge_id);
            out.u16(a_stop_name);
            out.u16(b_stop_name);
        }
        out.usize(self.transit_routes.len());
        for route in &self.transit_routes {
            for channel in route.color.iter().chain(&route.text_color) {
                out.u8(*channel);
            }
            out.u16(route.short_name);
            out.u16(route.long_name);
            out.u16(route.id_name);
        }
        out.usize(self.transit_board_table.len());
        for &(edge_id, lane_id, route_index, stop_index) in &self.transit_board_table {
            out.u32(edge_id);
            out.u32(lane_id);
            out.u16(route_index);
            out.u16(stop_index);
        }
        out.usize(self.transit_ride_table.len());
        for &(edge_id, route_index) in &self.transit_ride_table {
            out.u32(edge_id);
            out.u16(route_index);
        }
        out.usize(self.transit_door_table.len());
        for &(edge_id, street_name, side) in &self.transit_door_table {
            out.u32(edge_id);
            out.u16(street_name);
            out.u8(side);
        }
        out.usize(self.stranded_ways.len());
        for way in &self.stranded_ways {
            out.u32(*way);
        }
        out.bytes(&serde_json::to_vec(&self.stats)?);
        Ok(out.bytes)
    }

    fn decode(bytes: &[u8]) -> Fallible<Base> {
        let mut input = graph_cache::Reader::new(bytes);
        let origin_lng = input.f64()?;
        let origin_lat = input.f64()?;
        let scale = input.f64()?;
        let component_count = input.usize()?;
        let key_hash = input.u64()?;
        let node_count = input.usize()?;
        let mut node_lng = Vec::with_capacity(node_count);
        let mut node_lat = Vec::with_capacity(node_count);
        let mut node_component = Vec::with_capacity(node_count);
        for _ in 0..node_count {
            node_lng.push(input.i32()?);
            node_lat.push(input.i32()?);
            node_component.push(input.u16()?);
        }
        let edge_count = input.usize()?;
        let mut edges = Vec::with_capacity(edge_count);
        let mut ordinals = Vec::with_capacity(edge_count);
        for _ in 0..edge_count {
            edges.push(V2Edge {
                a: input.u32()?,
                b: input.u32()?,
                length: input.f32()?,
                geom: input.u32()?,
                source_id: input.u32()?,
                name_id: input.u16()?,
                cover: input.u8()?,
                half_offset: input.u8()?,
                kind: input.u8()?,
                side: input.u8()?,
                flags: input.u8()?,
            });
            ordinals.push(input.u8()?);
        }
        let geometry_count = input.usize()?;
        let mut geometry_polys = Vec::with_capacity(geometry_count);
        for _ in 0..geometry_count {
            let vertices = input.usize()?;
            let mut poly_x = Vec::with_capacity(vertices);
            let mut poly_y = Vec::with_capacity(vertices);
            for _ in 0..vertices {
                poly_x.push(input.i32()?);
                poly_y.push(input.i32()?);
            }
            geometry_polys.push((poly_x, poly_y));
        }
        let name_count = input.usize()?;
        let mut names = Vec::with_capacity(name_count);
        for _ in 0..name_count {
            names.push(String::from_utf8(input.bytes()?.to_vec())?);
        }
        let ferry_count = input.usize()?;
        let mut ferry_side_table = Vec::with_capacity(ferry_count);
        for _ in 0..ferry_count {
            ferry_side_table.push((input.u32()?, input.u16()?, input.u16()?));
        }
        let transit_route_count = input.usize()?;
        let mut transit_routes = Vec::with_capacity(transit_route_count);
        for _ in 0..transit_route_count {
            let mut channels = [0u8; 6];
            for channel in &mut channels {
                *channel = input.u8()?;
            }
            transit_routes.push(TransitRouteRecord {
                color: [channels[0], channels[1], channels[2]],
                text_color: [channels[3], channels[4], channels[5]],
                short_name: input.u16()?,
                long_name: input.u16()?,
                id_name: input.u16()?,
            });
        }
        let board_count = input.usize()?;
        let mut transit_board_table = Vec::with_capacity(board_count);
        for _ in 0..board_count {
            transit_board_table.push((input.u32()?, input.u32()?, input.u16()?, input.u16()?));
        }
        let ride_count = input.usize()?;
        let mut transit_ride_table = Vec::with_capacity(ride_count);
        for _ in 0..ride_count {
            transit_ride_table.push((input.u32()?, input.u16()?));
        }
        let door_count = input.usize()?;
        let mut transit_door_table = Vec::with_capacity(door_count);
        for _ in 0..door_count {
            transit_door_table.push((input.u32()?, input.u16()?, input.u8()?));
        }
        let stranded_count = input.usize()?;
        let mut stranded_ways = Vec::with_capacity(stranded_count);
        for _ in 0..stranded_count {
            stranded_ways.push(input.u32()?);
        }
        let stats = serde_json::from_slice(input.bytes()?)?;
        input.finish()?;
        let (csr, adjacency) = adjacency_of(node_count, &edges);
        Ok(Base {
            origin_lng,
            origin_lat,
            scale,
            node_lng,
            node_lat,
            node_component,
            component_count,
            edges,
            ordinals,
            key_hash,
            geometry_polys,
            names,
            ferry_side_table,
            transit_routes,
            transit_board_table,
            transit_ride_table,
            transit_door_table,
            stranded_ways,
            stats,
            csr,
            adjacency,
        })
    }
}

/// Everything through name compaction; sequential, and independent of any attribute source.
fn topology(args: &Args) -> Fallible<Base> {
    let streets = binfmt::read_streets(&args.streets)?;
    let origin_lng = streets.origin_lng;
    let origin_lat = streets.origin_lat;
    let scale = streets.scale;
    // Equirectangular meters per quantized unit at the one origin latitude.
    let meters_per_unit_lat = METERS_PER_DEGREE_LAT * scale;
    let meters_per_unit_lng = METERS_PER_DEGREE_LAT * origin_lat.to_radians().cos() * scale;
    let meters_per_unit = (meters_per_unit_lng, meters_per_unit_lat);

    // Paths are re-quantized against the streets origin so both share one integer grid.
    let quantize_x = |lng: f64| ((lng - origin_lng) / scale).round() as i32;
    let quantize_y = |lat: f64| ((lat - origin_lat) / scale).round() as i32;
    let quantized_x: Vec<i32> = streets.lngs.iter().map(|lng| quantize_x(*lng)).collect();
    let quantized_y: Vec<i32> = streets.lats.iter().map(|lat| quantize_y(*lat)).collect();
    let densities = streets.densities();

    // Street protos: one per walkable CSCL segment, before endpoint pinning.
    let mut dropped_vehicular = 0usize;
    let mut street_protos: Vec<ProtoEdge> = Vec::new();
    let mut street_segment: Vec<usize> = Vec::new(); // per proto, the STRT record it came from
    for segment in 0..streets.segments() {
        if streets.flags[segment] & FLAG_VEHICULAR_ONLY != 0 {
            dropped_vehicular += 1;
            continue;
        }
        let from = streets.starts[segment] as usize;
        let to = streets.starts[segment + 1] as usize;
        let (cover_left, cover_right) = segment_cover(
            densities,
            &quantized_x,
            &quantized_y,
            from,
            to,
            meters_per_unit_lng,
            meters_per_unit_lat,
        );
        let offset_meters = sidewalks::half_offset_meters(
            streets.road_types[segment],
            streets.flags[segment],
            streets.width_feet[segment],
            SIDEWALK_INSET_METERS,
        );
        let mut flags = 0u8;
        if streets.flags[segment] & FLAG_STRUCTURE != 0 {
            flags |= GRPH_STRUCTURE;
        }
        if streets.road_types[segment] == TUNNEL_STREET {
            flags |= GRPH_TUNNEL;
        }
        if streets.road_types[segment] == STEP_STREET {
            flags |= GRPH_STEPS;
        }
        street_protos.push(ProtoEdge {
            poly_x: quantized_x[from..to].to_vec(),
            poly_y: quantized_y[from..to].to_vec(),
            length: streets.lengths_m[segment],
            cover_left,
            cover_right,
            offset: round_half_up(offset_meters * DECIMETERS_PER_METER) as u8,
            flags,
            name_id: streets.name_ids[segment],
            osm: false,
            source_id: streets.ids[segment],
            kind: KIND_SIDEWALK,
            side: SIDE_NONE,
            sidewalks: 0,
            paved: 0,
            curb_a: false,
            curb_b: false,
        });
        street_segment.push(segment);
    }
    // FLAG_NON_VEHICULAR is consumed inside half_offset_meters; this keeps the dependency visible.
    let _ = FLAG_NON_VEHICULAR;

    // Streets' names then paths' (ids offset past the street count).
    let mut all_names: Vec<String> = streets.names.clone();
    let street_name_count = all_names.len();
    let mut path_protos: Vec<ProtoEdge> = Vec::new();
    if let Some(paths_file) = &args.paths {
        let paths = binfmt::read_paths(paths_file)?;
        if street_name_count + paths.names.len() > UNNAMED as usize {
            return Err(format!(
                "{} street + path names overflow a u16 id",
                street_name_count + paths.names.len()
            )
            .into());
        }
        let path_x: Vec<i32> = paths.lngs.iter().map(|lng| quantize_x(*lng)).collect();
        let path_y: Vec<i32> = paths.lats.iter().map(|lat| quantize_y(*lat)).collect();
        let path_densities = paths.densities();
        for segment in 0..paths.segments() {
            let from = paths.starts[segment] as usize;
            let to = paths.starts[segment + 1] as usize;
            let (cover_left, cover_right) = segment_cover(
                path_densities,
                &path_x,
                &path_y,
                from,
                to,
                meters_per_unit_lng,
                meters_per_unit_lat,
            );
            let mut flags = GRPH_PATHLIKE;
            if paths.flags[segment] & FLAG_STRUCTURE != 0 {
                flags |= GRPH_STRUCTURE;
            }
            if paths.flags[segment] & FLAG_TUNNEL != 0 {
                flags |= GRPH_TUNNEL;
            }
            if paths.road_types[segment] == STEP_STREET {
                flags |= GRPH_STEPS;
            }
            let name_id = if paths.name_ids[segment] == UNNAMED {
                UNNAMED
            } else {
                paths.name_ids[segment] + street_name_count as u16
            };
            path_protos.push(ProtoEdge {
                poly_x: path_x[from..to].to_vec(),
                poly_y: path_y[from..to].to_vec(),
                length: paths.lengths_m[segment],
                cover_left,
                cover_right,
                offset: 0,
                flags,
                name_id,
                osm: true,
                source_id: paths.ids[segment],
                kind: KIND_PATH,
                side: SIDE_NONE,
                sidewalks: 0,
                paved: 0,
                curb_a: false,
                curb_b: false,
            });
        }
        all_names.extend(paths.names);
    }
    let path_name_count = all_names.len();

    // OSM's SWLK ways, one raw proto per way; the association below settles what they are.
    let osm_sidewalks = match &args.sidewalks {
        Some(file) => Some(binfmt::read_sidewalks(file)?),
        None => None,
    };
    let mut sidewalk_ways: Vec<ProtoEdge> = Vec::new();
    if let Some(ways) = &osm_sidewalks {
        if path_name_count + ways.names.len() > UNNAMED as usize {
            return Err(format!(
                "{} street + path + sidewalk names overflow a u16 id",
                path_name_count + ways.names.len()
            )
            .into());
        }
        let way_x: Vec<i32> = ways.lngs.iter().map(|lng| quantize_x(*lng)).collect();
        let way_y: Vec<i32> = ways.lats.iter().map(|lat| quantize_y(*lat)).collect();
        for segment in 0..ways.segments() {
            let from = ways.starts[segment] as usize;
            let to = ways.starts[segment + 1] as usize;
            let mut flags = GRPH_PATHLIKE;
            if ways.flags[segment] & FLAG_STRUCTURE != 0 {
                flags |= GRPH_STRUCTURE;
            }
            if ways.flags[segment] & FLAG_TUNNEL != 0 {
                flags |= GRPH_TUNNEL;
            }
            let name_id = if ways.name_ids[segment] == UNNAMED {
                UNNAMED
            } else {
                ways.name_ids[segment] + path_name_count as u16
            };
            sidewalk_ways.push(ProtoEdge {
                poly_x: way_x[from..to].to_vec(),
                poly_y: way_y[from..to].to_vec(),
                length: ways.lengths_m[segment],
                cover_left: 0,
                cover_right: 0,
                offset: 0,
                flags,
                name_id,
                osm: true,
                source_id: ways.ids[segment],
                kind: swlk_kind(ways.road_types[segment]),
                side: SIDE_NONE,
                sidewalks: 0,
                paved: 0,
                curb_a: false,
                curb_b: false,
            });
        }
        all_names.extend(ways.names.clone());
    }

    // Which CSCL street side each OSM sidewalk flanks: labels, keys and per-stretch exclusivity.
    let association = association::associate(&street_protos, &sidewalk_ways, meters_per_unit);
    let street_labels: Vec<(u8, u8)> = street_protos
        .iter()
        .map(|street| {
            side_labels(
                &street.poly_x,
                &street.poly_y,
                meters_per_unit_lng,
                meters_per_unit_lat,
            )
        })
        .collect();

    // A side exists if OSM maps any of it or the survey draws it; a street with neither is demoted.
    let mut demoted_streets = 0usize;
    let mut demoted_km = 0.0f64;
    let mut one_sided_streets = 0usize;
    let mut osm_covered_streets = 0usize;
    let mut derived_side_km = 0.0f64; // the two-a-street the unconditional derivation would give
    let mut kept_side_km = 0.0f64; // sides with pavement, however that pavement is drawn
    let mut osm_side_km = 0.0f64; // of those, the sides OSM maps for itself
    let mut alley_km = 0.0f64;
    let mut demoted_alley_km = 0.0f64;
    // Per-physicalid gate results the whole-city invariants read back off the finished edges.
    let mut alley_ids: HashSet<u32> = HashSet::new();
    let mut demoted_ids: HashSet<u32> = HashSet::new();
    let mut kept_sides: HashMap<u32, u32> = HashMap::new();
    for (proto_index, proto) in street_protos.iter_mut().enumerate() {
        if proto.offset == 0 {
            proto.flags |= GRPH_PATHLIKE;
            proto.kind = KIND_PATH;
            continue;
        }
        let segment = street_segment[proto_index];
        let km = f64::from(streets.lengths_m[segment]) / 1000.0;
        let covered = &association.covered[proto_index];
        let mut owned = 0u8;
        if !covered[0].is_empty() {
            owned |= SIDEWALK_LEFT;
        }
        if !covered[1].is_empty() {
            owned |= SIDEWALK_RIGHT;
        }
        let exists = gated_sidewalks(streets.flags[segment]) | owned;
        // `trim_derived` later cuts mapped stretches from `sidewalks`; `paved` stays whole.
        proto.sidewalks = exists;
        proto.paved = exists;
        derived_side_km += 2.0 * km;
        kept_side_km += f64::from(exists.count_ones()) * km;
        let owned_meters: f64 = covered
            .iter()
            .flatten()
            .map(|&(start, end)| end - start)
            .sum();
        osm_side_km += owned_meters / 1000.0;
        if streets.road_types[segment] == ALLEY {
            alley_km += km;
            alley_ids.insert(proto.source_id);
        }
        // CSCL splits a street across records, so keep the most pavement any record has.
        let sides = kept_sides.entry(proto.source_id).or_insert(0);
        *sides = (*sides).max(exists.count_ones());
        match exists.count_ones() {
            0 => {
                proto.offset = 0;
                proto.flags |= GRPH_PATHLIKE;
                proto.kind = KIND_PATH;
                demoted_streets += 1;
                demoted_km += km;
                demoted_ids.insert(proto.source_id);
                if streets.road_types[segment] == ALLEY {
                    demoted_alley_km += km;
                }
            }
            1 => one_sided_streets += 1,
            _ => {}
        }
        if proto.offset > 0 && exists & !owned == 0 {
            osm_covered_streets += 1;
        }
    }

    // OSM ids churn ~1.5-2%/yr, so a matched stretch takes its street's physicalid as its key.
    let mut streetless_sidewalk_km = 0.0f64;
    let mut sidewalk_protos: Vec<ProtoEdge> = Vec::new();
    for (way_index, way) in sidewalk_ways.iter().enumerate() {
        let whole = conflate::polyline_meters(&way.poly_x, &way.poly_y, meters_per_unit);
        for run in &association.runs[way_index] {
            let poly_x = way.poly_x[run.from..=run.to].to_vec();
            let poly_y = way.poly_y[run.from..=run.to].to_vec();
            let stretch = conflate::polyline_meters(&poly_x, &poly_y, meters_per_unit);
            let length = if whole > 0.0 {
                (f64::from(way.length) * stretch / whole) as f32
            } else {
                way.length
            };
            let mut piece = ProtoEdge {
                poly_x,
                poly_y,
                length,
                ..way.clone()
            };
            match run.matched {
                Some(matched) => {
                    let street = &street_protos[matched.street as usize];
                    let left = matched.sidewalk == SIDEWALK_LEFT;
                    let (left_label, right_label) = street_labels[matched.street as usize];
                    let cover = if left {
                        street.cover_left
                    } else {
                        street.cover_right
                    };
                    piece.cover_left = cover;
                    piece.cover_right = cover;
                    piece.offset = street.offset;
                    piece.name_id = street.name_id;
                    piece.source_id = street.source_id;
                    piece.side = if left { left_label } else { right_label };
                    // OSM rarely tags the pavement as a tunnel, so the bit comes from its roadway.
                    piece.flags |= street.flags & GRPH_TUNNEL;
                    if matched.street_left {
                        piece.flags |= GRPH_BUILDING_RIGHT;
                    }
                }
                None if way.kind == KIND_SIDEWALK => {
                    piece.kind = KIND_PATH;
                    streetless_sidewalk_km += f64::from(length) / 1000.0;
                }
                // No durable key, but it costs as its street like a synthesized crossing.
                None => {
                    piece.source_id = NO_SOURCE_ID;
                    if let Some(crossed) = association.crossed[way_index] {
                        let street = &street_protos[crossed as usize];
                        piece.cover_left =
                            crossing_cover_bytes(street.cover_left, street.cover_right);
                        piece.cover_right = piece.cover_left;
                        piece.name_id = street.name_id;
                        piece.flags |= street.flags & GRPH_TUNNEL;
                    }
                }
            }
            sidewalk_protos.push(piece);
        }
    }
    let sidewalk_edge_protos = sidewalk_protos.len();
    path_protos.extend(sidewalk_protos);

    // Cut OSM-mapped stretches out of the derived mask, after the loop indexing `street_protos`.
    let mut trimmed_streets = 0usize;
    let mut street_pieces: Vec<ProtoEdge> = Vec::with_capacity(street_protos.len());
    for (proto_index, proto) in street_protos.into_iter().enumerate() {
        let pieces = trim_derived(proto, &association.covered[proto_index], meters_per_unit);
        if pieces.len() > 1 {
            trimmed_streets += 1;
        }
        street_pieces.extend(pieces);
    }

    // Conflate the two sources into one segment list, then node it.
    let (protos, conflate_stats) =
        conflate::conflate(street_pieces, path_protos, &all_names, meters_per_unit);

    // Node the endpoints of every proto by exact quantized equality.
    let mut node_index: HashMap<(i32, i32), u32> = HashMap::new();
    let mut node_x: Vec<i32> = Vec::new();
    let mut node_y: Vec<i32> = Vec::new();
    let mut proto_ends: Vec<(u32, u32)> = Vec::with_capacity(protos.len()); // (node a, node b), raw ids
    for proto in &protos {
        let last = proto.poly_x.len() - 1;
        let mut intern = |key_x: i32, key_y: i32| {
            let next = node_x.len() as u32;
            *node_index.entry((key_x, key_y)).or_insert_with(|| {
                node_x.push(key_x);
                node_y.push(key_y);
                next
            })
        };
        let node_a = intern(proto.poly_x[0], proto.poly_y[0]);
        let node_b = intern(proto.poly_x[last], proto.poly_y[last]);
        proto_ends.push((node_a, node_b));
    }
    let raw_node_count = node_x.len();

    // Mop up near-misses: bucket the nodes into a ~3 m grid and union any pair within 1 m.
    let cell_units = (GRID_METERS / meters_per_unit_lng).floor().max(1.0) as i32;
    let mut grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
    for node in 0..raw_node_count {
        let cell = (
            node_x[node].div_euclid(cell_units),
            node_y[node].div_euclid(cell_units),
        );
        grid.entry(cell).or_default().push(node as u32);
    }
    let mut parent: Vec<u32> = (0..raw_node_count as u32).collect();
    let squared_radius = MERGE_RADIUS_METERS * MERGE_RADIUS_METERS;
    for node in 0..raw_node_count {
        let cell_x = node_x[node].div_euclid(cell_units);
        let cell_y = node_y[node].div_euclid(cell_units);
        for offset_x in -1..=1 {
            for offset_y in -1..=1 {
                let Some(bucket) = grid.get(&(cell_x + offset_x, cell_y + offset_y)) else {
                    continue;
                };
                for &other in bucket {
                    if other as usize <= node {
                        continue;
                    }
                    let delta_x =
                        f64::from(node_x[other as usize] - node_x[node]) * meters_per_unit_lng;
                    let delta_y =
                        f64::from(node_y[other as usize] - node_y[node]) * meters_per_unit_lat;
                    if delta_x * delta_x + delta_y * delta_y <= squared_radius {
                        union(&mut parent, node as u32, other);
                    }
                }
            }
        }
    }

    // Compact the merged nodes; the surviving id carries the smaller original id's coordinates.
    let mut merged_id = vec![u32::MAX; raw_node_count];
    let mut merged_x: Vec<i32> = Vec::new();
    let mut merged_y: Vec<i32> = Vec::new();
    for node in 0..raw_node_count {
        let root = find(&mut parent, node as u32) as usize;
        if merged_id[root] == u32::MAX {
            merged_id[root] = merged_x.len() as u32;
            merged_x.push(node_x[root]);
            merged_y.push(node_y[root]);
        }
        merged_id[node] = merged_id[root];
    }
    let merged_count = merged_x.len();
    let merged_near_nodes = raw_node_count - merged_count;

    // One edge per proto, endpoints pinned to the merged node coordinates.
    let mut edges: Vec<Edge> = Vec::with_capacity(protos.len());
    for (proto_index, &(raw_a, raw_b)) in proto_ends.iter().enumerate() {
        let proto = &protos[proto_index];
        let node_a = merged_id[raw_a as usize];
        let node_b = merged_id[raw_b as usize];
        let mut poly_x = proto.poly_x.clone();
        let mut poly_y = proto.poly_y.clone();
        let last = poly_x.len() - 1;
        poly_x[0] = merged_x[node_a as usize];
        poly_y[0] = merged_y[node_a as usize];
        poly_x[last] = merged_x[node_b as usize];
        poly_y[last] = merged_y[node_b as usize];
        edges.push(Edge {
            a: node_a,
            b: node_b,
            poly_x,
            poly_y,
            length: proto.length,
            cover_left: proto.cover_left,
            cover_right: proto.cover_right,
            offset: proto.offset,
            flags: proto.flags,
            name_id: proto.name_id,
            osm: proto.osm,
            source_id: proto.source_id,
            kind: proto.kind,
            side: proto.side,
            sidewalks: proto.sidewalks,
            paved: proto.paved,
            curb_a: proto.curb_a,
            curb_b: proto.curb_b,
        });
    }

    let mut incidence: Vec<Vec<u32>> = vec![Vec::new(); merged_count];
    for (edge_id, edge) in edges.iter().enumerate() {
        incidence[edge.a as usize].push(edge_id as u32);
        incidence[edge.b as usize].push(edge_id as u32);
    }

    // Name-break joints are the only shape joints contraction keeps.
    let mut name_break_joints = 0usize;
    for incident in &incidence {
        if incident.len() == 2
            && incident[0] != incident[1]
            && edges[incident[0] as usize].offset == edges[incident[1] as usize].offset
            && edges[incident[0] as usize].flags == edges[incident[1] as usize].flags
            && edges[incident[0] as usize].osm == edges[incident[1] as usize].osm
            && edges[incident[0] as usize].name_id != edges[incident[1] as usize].name_id
        {
            name_break_joints += 1;
        }
    }

    // Chains start at non-contractible nodes; leftover degree-2 cycles become self-loops.
    let mut visited = vec![false; edges.len()];
    let mut final_edges: Vec<Edge> = Vec::new();
    let mut kept_node = vec![false; merged_count];
    for node in 0..merged_count {
        if contractible(&edges, &incidence, node as u32) {
            continue;
        }
        kept_node[node] = true;
        for slot in 0..incidence[node].len() {
            let edge_id = incidence[node][slot];
            if visited[edge_id as usize] {
                continue;
            }
            let edge = trace_chain(&edges, &incidence, &mut visited, node as u32, edge_id);
            kept_node[edge.a as usize] = true;
            kept_node[edge.b as usize] = true;
            final_edges.push(edge);
        }
    }
    for edge_id in 0..edges.len() {
        if visited[edge_id] {
            continue;
        }
        let start = edges[edge_id].a;
        let edge = trace_chain(&edges, &incidence, &mut visited, start, edge_id as u32);
        kept_node[edge.a as usize] = true;
        kept_node[edge.b as usize] = true;
        final_edges.push(edge);
    }
    let contracted_nodes = merged_count - kept_node.iter().filter(|&&kept| kept).count();

    let mut pruned_vertices = 0usize;
    for edge in &mut final_edges {
        let before = edge.poly_x.len();
        let (pruned_x, pruned_y) = prune_collinear(&edge.poly_x, &edge.poly_y);
        pruned_vertices += before - pruned_x.len();
        edge.poly_x = pruned_x;
        edge.poly_y = pruned_y;
    }

    // Drop components with no CSCL edge or mapped sidewalk anchoring them.
    let mut island_parent: Vec<u32> = (0..merged_count as u32).collect();
    for edge in &final_edges {
        union(&mut island_parent, edge.a, edge.b);
    }
    let mut component_has_cscl: HashMap<u32, bool> = HashMap::new();
    for edge in &final_edges {
        let root = find(&mut island_parent, edge.a);
        let entry = component_has_cscl.entry(root).or_insert(false);
        *entry = *entry || !edge.osm || edge.kind == KIND_SIDEWALK;
    }
    let mut dropped_osm_island_roots: HashSet<u32> = HashSet::new();
    let mut dropped_osm_island_km = 0.0f64;
    let keep_edge: Vec<bool> = final_edges
        .iter()
        .map(|edge| {
            let root = find(&mut island_parent, edge.a);
            if component_has_cscl[&root] {
                true
            } else {
                dropped_osm_island_roots.insert(root);
                dropped_osm_island_km += f64::from(edge.length) / 1000.0;
                false
            }
        })
        .collect();
    let dropped_osm_islands = dropped_osm_island_roots.len();
    let stranded_ways = stranded_osm_paths(&edges, &final_edges, &keep_edge, merged_count);
    let mut kept_edges: Vec<Edge> = Vec::with_capacity(final_edges.len());
    for (edge, keep) in final_edges.into_iter().zip(keep_edge) {
        if keep {
            kept_edges.push(edge);
        }
    }
    let mut final_edges = kept_edges;

    // Where OSM draws a block as one way, the corner cuts it so the seam has a node to bind to.
    let curb_cuts = cut_sidewalks_at_corners(
        &mut final_edges,
        &mut merged_x,
        &mut merged_y,
        meters_per_unit_lng,
        meters_per_unit_lat,
    );
    let merged_count = merged_x.len();
    let final_edges = final_edges;

    // v1 components; a node counts only if a surviving edge touches it.
    let mut base_kept = vec![false; merged_count];
    for edge in &final_edges {
        base_kept[edge.a as usize] = true;
        base_kept[edge.b as usize] = true;
    }
    let mut component_parent: Vec<u32> = (0..merged_count as u32).collect();
    for edge in &final_edges {
        union(&mut component_parent, edge.a, edge.b);
    }
    let mut base_component: HashSet<u32> = HashSet::new();
    for (node, &kept) in base_kept.iter().enumerate() {
        if kept {
            base_component.insert(find(&mut component_parent, node as u32));
        }
    }
    let v1_component_count = base_component.len();

    // Incidence of (edge, is-a-end); a self-loop lists both ends on its one node.
    let mut incidence2: Vec<Vec<(u32, bool)>> = vec![Vec::new(); merged_count];
    for (edge_id, edge) in final_edges.iter().enumerate() {
        incidence2[edge.a as usize].push((edge_id as u32, true));
        incidence2[edge.b as usize].push((edge_id as u32, false));
    }

    // Fans are built for every base node first, since a sidewalk needs both ends' corners.
    let mut v2_x: Vec<i32> = Vec::new();
    let mut v2_y: Vec<i32> = Vec::new();
    let mut v2_base: Vec<u32> = Vec::new(); // the base node each v2 node was made for
    let mut v2_edges: Vec<V2Edge> = Vec::new();
    // Per base street edge, the four corner nodes its sidewalks attach to, filled by the fans.
    let mut left_at_a = vec![u32::MAX; final_edges.len()];
    let mut right_at_a = vec![u32::MAX; final_edges.len()];
    let mut left_at_b = vec![u32::MAX; final_edges.len()];
    let mut right_at_b = vec![u32::MAX; final_edges.len()];
    let mut path_node = vec![u32::MAX; merged_count];
    // Per base path edge end, the corner an entrance snap bound it to.
    let mut curb_node_at_a = vec![u32::MAX; final_edges.len()];
    let mut curb_node_at_b = vec![u32::MAX; final_edges.len()];
    let mut link_pairs: HashMap<(u32, u32), u8> = HashMap::new();
    // (corner a, corner b, crossed edge): a latent crossing the mop-up adds only if needed.
    let mut mopup_candidates: Vec<(u32, u32, u32)> = Vec::new();
    let mut corner_node_count = 0usize;
    let mut path_node_count = 0usize;
    let mut crossing_count = 0usize;
    let mut synthesized_crossings = 0usize;
    let mut seam_links = 0usize;

    // Base nodes where a mapped sidewalk ends and no CSCL street does.
    let mut osm_corner: Vec<u32> = Vec::new();
    for (base, incident) in incidence2.iter().enumerate() {
        let mut sidewalk = false;
        let mut street = false;
        for &(edge_id, _) in incident {
            let edge = &final_edges[edge_id as usize];
            if edge.flags & GRPH_PATHLIKE == 0 {
                street = true;
            } else if edge.osm && edge.kind == KIND_SIDEWALK {
                sidewalk = true;
            }
        }
        if sidewalk && !street {
            osm_corner.push(base as u32);
        }
    }
    // A seam radius wide in longitude, and so wider in latitude, so a 3x3 scan covers it.
    let seam_cell = (SEAM_RADIUS_METERS / meters_per_unit_lng).ceil().max(1.0) as i32;
    let mut seam_grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
    for &base in &osm_corner {
        let point = (merged_x[base as usize], merged_y[base as usize]);
        seam_grid
            .entry((point.0.div_euclid(seam_cell), point.1.div_euclid(seam_cell)))
            .or_default()
            .push(base);
    }

    // Fans are rebuilt later rather than kept, to avoid holding millions of small vectors.
    let mut corner_start: Vec<usize> = Vec::with_capacity(merged_count + 1);
    let mut corner_x: Vec<i32> = Vec::new();
    let mut corner_y: Vec<i32> = Vec::new();
    for base in 0..merged_count {
        corner_start.push(corner_x.len());
        if incidence2[base].is_empty() {
            continue;
        }
        let placed = node_fan(
            base,
            &incidence2,
            &final_edges,
            &merged_x,
            &merged_y,
            meters_per_unit_lng,
            meters_per_unit_lat,
        );
        corner_x.extend_from_slice(&placed.fan.corner_x);
        corner_y.extend_from_slice(&placed.fan.corner_y);
    }
    corner_start.push(corner_x.len());

    // Each OSM corner is claimed once, or two slots would collapse their crossing into a self-loop.
    let mut seam_candidates: Vec<(f64, u32, u32)> = Vec::new();
    for slot in 0..corner_x.len() {
        let cell_x = corner_x[slot].div_euclid(seam_cell);
        let cell_y = corner_y[slot].div_euclid(seam_cell);
        for offset_x in -1..=1 {
            for offset_y in -1..=1 {
                for &base in seam_grid
                    .get(&(cell_x + offset_x, cell_y + offset_y))
                    .into_iter()
                    .flatten()
                {
                    let delta_x =
                        f64::from(merged_x[base as usize] - corner_x[slot]) * meters_per_unit_lng;
                    let delta_y =
                        f64::from(merged_y[base as usize] - corner_y[slot]) * meters_per_unit_lat;
                    let meters = delta_x.hypot(delta_y);
                    if meters <= SEAM_LINK_METERS {
                        seam_candidates.push((meters, slot as u32, base));
                    }
                }
            }
        }
    }
    seam_candidates.sort_by(|left, right| {
        left.0
            .total_cmp(&right.0)
            .then(left.1.cmp(&right.1))
            .then(left.2.cmp(&right.2))
    });
    let mut corner_osm = vec![u32::MAX; corner_x.len()];
    let mut claimed_osm: HashSet<u32> = HashSet::new();
    for &(meters, slot, base) in &seam_candidates {
        if meters <= SEAM_RADIUS_METERS
            && corner_osm[slot as usize] == u32::MAX
            && claimed_osm.insert(base)
        {
            corner_osm[slot as usize] = base;
        }
    }
    let seam_corners = claimed_osm.len();
    // Same candidate order as above, so the two halves of the rule cannot claim the same node.
    let mut corner_link = vec![u32::MAX; corner_x.len()];
    for &(_, slot, base) in &seam_candidates {
        if corner_osm[slot as usize] == u32::MAX
            && corner_link[slot as usize] == u32::MAX
            && claimed_osm.insert(base)
        {
            corner_link[slot as usize] = base;
        }
    }
    for base in 0..merged_count {
        if claimed_osm.contains(&(base as u32)) {
            path_node[base] = v2_x.len() as u32;
            v2_x.push(merged_x[base]);
            v2_y.push(merged_y[base]);
            v2_base.push(base as u32);
            path_node_count += 1;
        }
    }

    let crossing_cover =
        |edge: &Edge| -> u8 { crossing_cover_bytes(edge.cover_left, edge.cover_right) };

    for base in 0..merged_count {
        if incidence2[base].is_empty() {
            continue;
        }
        let NodeFan {
            ends,
            street_count,
            degree,
            fan,
        } = node_fan(
            base,
            &incidence2,
            &final_edges,
            &merged_x,
            &merged_y,
            meters_per_unit_lng,
            meters_per_unit_lat,
        );

        // Unbound corners OSM doesn't stand at aren't made, or they'd form a ring joined to nothing.
        let mut needed = vec![false; street_count];
        for slot in 0..street_count {
            let end = &ends[slot];
            let edge = &final_edges[end.edge as usize];
            // A side OSM maps still needs a corner for the synthesized crossing to land on.
            let leaving = mask_leaving(edge.paved, end.at_a);
            if leaving & SIDEWALK_LEFT != 0 {
                needed[fan.corner_left[slot] as usize] = true;
            }
            if leaving & SIDEWALK_RIGHT != 0 {
                needed[fan.corner_right[slot] as usize] = true;
            }
        }
        for path_slot in 0..degree - street_count {
            if street_count > 0 {
                needed[fan.path_corner[path_slot] as usize] = true;
            }
        }

        // A slot whose corner OSM already stands at resolves to that node.
        let mut corner_ids: Vec<u32> = vec![u32::MAX; street_count];
        for slot in 0..street_count {
            let resolved = corner_osm[corner_start[base] + slot];
            if resolved != u32::MAX {
                corner_ids[slot] = path_node[resolved as usize];
            } else if needed[slot] {
                let corner = v2_x.len() as u32;
                corner_ids[slot] = corner;
                v2_x.push(fan.corner_x[slot]);
                v2_y.push(fan.corner_y[slot]);
                v2_base.push(base as u32);
                corner_node_count += 1;
                let reached = corner_link[corner_start[base] + slot];
                if reached != u32::MAX {
                    let cover = 0;
                    link_pairs
                        .entry((path_node[reached as usize], corner))
                        .or_insert(cover);
                    seam_links += 1;
                }
            }
        }

        for slot in 0..street_count {
            let end = &ends[slot];
            let left = corner_ids[fan.corner_left[slot] as usize];
            let right = corner_ids[fan.corner_right[slot] as usize];
            if end.at_a {
                left_at_a[end.edge as usize] = left;
                right_at_a[end.edge as usize] = right;
            } else {
                left_at_b[end.edge as usize] = left;
                right_at_b[end.edge as usize] = right;
            }
        }

        // One crossing per street at a real intersection; OSM-mapped ones replace them later.
        if street_count >= 2 && degree >= 3 {
            // Two ends of one street can name the same corner pair, so dedup or the crossing doubles.
            let mut crossed_pairs: Vec<(u32, u32)> = Vec::with_capacity(street_count);
            for slot in 0..street_count {
                let crossed = &final_edges[ends[slot].edge as usize];
                let corner_a = corner_ids[fan.corner_right[slot] as usize];
                let corner_b = corner_ids[fan.corner_left[slot] as usize];
                if corner_a == u32::MAX || corner_b == u32::MAX || corner_a == corner_b {
                    continue;
                }
                let pair = if corner_a <= corner_b {
                    (corner_a, corner_b)
                } else {
                    (corner_b, corner_a)
                };
                if crossed_pairs.contains(&pair) {
                    continue;
                }
                crossed_pairs.push(pair);
                let length = node_distance(
                    &v2_x, &v2_y, corner_a, corner_b, origin_lng, origin_lat, scale,
                );
                v2_edges.push(V2Edge {
                    a: corner_a,
                    b: corner_b,
                    length: length as f32,
                    geom: NO_GEOMETRY,
                    cover: crossing_cover(crossed),
                    half_offset: 0,
                    name_id: crossed.name_id,
                    kind: KIND_CROSSING,
                    side: SIDE_NONE,
                    flags: crossed.flags & (GRPH_STRUCTURE | GRPH_STEPS | GRPH_TUNNEL),
                    source_id: NO_SOURCE_ID,
                });
                crossing_count += 1;
                synthesized_crossings += 1;
            }
        } else if street_count == 2
            && degree == 2
            && corner_ids[0] != u32::MAX
            && corner_ids[1] != u32::MAX
            && corner_ids[0] != corner_ids[1]
        {
            // A ring of deg-2 joints would split its two sides, so remember the latent crossing.
            mopup_candidates.push((corner_ids[0], corner_ids[1], ends[0].edge));
        }

        // A snapped or sole path end binds to its curb corner, not the roadway centerline.
        let terminates = ends.len() == street_count + 1 && street_count > 0;
        let curbs: Vec<bool> = ends[street_count..]
            .iter()
            .enumerate()
            .map(|(path_slot, end)| {
                let edge = &final_edges[end.edge as usize];
                let curb = (if end.at_a { edge.curb_a } else { edge.curb_b }) || terminates;
                let corner = if street_count > 0 {
                    corner_ids[fan.path_corner[path_slot] as usize]
                } else {
                    u32::MAX
                };
                if curb && corner != u32::MAX {
                    if end.at_a {
                        curb_node_at_a[end.edge as usize] = corner;
                    } else {
                        curb_node_at_b[end.edge as usize] = corner;
                    }
                    true
                } else {
                    false
                }
            })
            .collect();
        if curbs.iter().any(|curb| !curb) {
            let node = match path_node[base] {
                u32::MAX => {
                    let node = v2_x.len() as u32;
                    v2_x.push(merged_x[base]);
                    v2_y.push(merged_y[base]);
                    v2_base.push(base as u32);
                    path_node[base] = node;
                    path_node_count += 1;
                    node
                }
                existing => existing,
            };
            for (path_slot, end) in ends[street_count..].iter().enumerate() {
                if street_count == 0 || curbs[path_slot] {
                    continue;
                }
                let corner = corner_ids[fan.path_corner[path_slot] as usize];
                if corner == u32::MAX {
                    continue;
                }
                let cover = final_edges[end.edge as usize]
                    .cover_left
                    .max(final_edges[end.edge as usize].cover_right);
                link_pairs.entry((node, corner)).or_insert(cover);
            }
        }
    }

    // Only the synthesized crossings and the links carry no geometry.
    let mut geometry_polys: Vec<(Vec<i32>, Vec<i32>)> = Vec::new();
    let mut sidewalk_count = 0usize;
    let mut path_edge_count = 0usize;
    let mut osm_path_edges = 0usize;
    let mut osm_path_km = 0.0f64;
    let mut osm_sidewalk_edges = 0usize;
    let mut osm_sidewalk_km = 0.0f64;
    let mut osm_crossing_edges = 0usize;
    let mut derived_sidewalk_km = 0.0f64;
    let mut length_clamped = 0usize;
    let clamp_length = |from: u32, to: u32, straight: f32, counter: &mut usize| -> f32 {
        let distance = node_distance(&v2_x, &v2_y, from, to, origin_lng, origin_lat, scale) as f32;
        if distance > straight {
            *counter += 1;
            distance
        } else {
            straight
        }
    };
    for (edge_id, edge) in final_edges.iter().enumerate() {
        let base_flags = edge.flags & (GRPH_STRUCTURE | GRPH_STEPS | GRPH_TUNNEL);
        if edge.flags & GRPH_PATHLIKE != 0 {
            // Endpoints are re-pinned onto the resolved nodes, moving the join onto the pavement.
            let node_a = match curb_node_at_a[edge_id] {
                u32::MAX => path_node[edge.a as usize],
                corner => corner,
            };
            let node_b = match curb_node_at_b[edge_id] {
                u32::MAX => path_node[edge.b as usize],
                corner => corner,
            };
            if node_a == u32::MAX || node_b == u32::MAX {
                return Err("a path edge is missing a path node".into());
            }
            let mut poly_x = edge.poly_x.clone();
            let mut poly_y = edge.poly_y.clone();
            let last = poly_x.len() - 1;
            poly_x[0] = v2_x[node_a as usize];
            poly_y[0] = v2_y[node_a as usize];
            poly_x[last] = v2_x[node_b as usize];
            poly_y[last] = v2_y[node_b as usize];
            let geom = geometry_polys.len() as u32;
            geometry_polys.push((poly_x, poly_y));
            // The 1 m node merge can leave a path short of its node distance, so clamp it up.
            let length = clamp_length(node_a, node_b, edge.length, &mut length_clamped);
            let mut path_flags = if edge.osm {
                base_flags | GRPH_OSM
            } else {
                base_flags
            };
            if edge.flags & GRPH_BUILDING_RIGHT != 0 {
                path_flags |= FLAG_GEOMETRY_RIGHT;
            }
            // Keeps its street's half-offset, which scaffolding depth infers the curb from.
            v2_edges.push(V2Edge {
                a: node_a,
                b: node_b,
                length,
                geom,
                cover: edge.cover_left.max(edge.cover_right),
                half_offset: edge.offset,
                name_id: edge.name_id,
                kind: edge.kind,
                side: edge.side,
                flags: path_flags,
                source_id: edge.source_id,
            });
            match edge.kind {
                KIND_SIDEWALK => {
                    sidewalk_count += 1;
                    osm_sidewalk_edges += 1;
                    osm_sidewalk_km += f64::from(length) / 1000.0;
                }
                KIND_CROSSING => {
                    crossing_count += 1;
                    osm_crossing_edges += 1;
                }
                _ => path_edge_count += 1,
            }
            if edge.osm && edge.kind == KIND_PATH {
                osm_path_edges += 1;
                osm_path_km += f64::from(length) / 1000.0;
            }
        } else {
            let left_a = left_at_a[edge_id];
            let right_a = right_at_a[edge_id];
            let left_b = left_at_b[edge_id];
            let right_b = right_at_b[edge_id];
            // Only corners a derived sidewalk reaches for must exist.
            if (edge.sidewalks & SIDEWALK_LEFT != 0 && (left_a == u32::MAX || right_b == u32::MAX))
                || (edge.sidewalks & SIDEWALK_RIGHT != 0
                    && (right_a == u32::MAX || left_b == u32::MAX))
            {
                return Err("a street edge is missing a corner assignment".into());
            }
            let (left_side, right_side) = side_labels(
                &edge.poly_x,
                &edge.poly_y,
                meters_per_unit_lng,
                meters_per_unit_lat,
            );
            let half_offset_m = f64::from(edge.offset) / DECIMETERS_PER_METER;
            let meters_per_unit = (meters_per_unit_lng, meters_per_unit_lat);
            // Left runs cornerLeft(a) -> cornerRight(b), right runs cornerRight(a) -> cornerLeft(b).
            if edge.sidewalks & SIDEWALK_LEFT != 0 {
                let left_geom = offset_polyline(
                    &edge.poly_x,
                    &edge.poly_y,
                    half_offset_m,
                    1.0,
                    (v2_x[left_a as usize], v2_y[left_a as usize]),
                    (v2_x[right_b as usize], v2_y[right_b as usize]),
                    meters_per_unit,
                );
                let left_baked =
                    polyline_length(&left_geom.0, &left_geom.1, origin_lng, origin_lat, scale)
                        as f32;
                let left_length = clamp_length(left_a, right_b, left_baked, &mut length_clamped);
                let left_geom_index = geometry_polys.len() as u32;
                geometry_polys.push(left_geom);
                v2_edges.push(V2Edge {
                    a: left_a,
                    b: right_b,
                    length: left_length,
                    geom: left_geom_index,
                    cover: edge.cover_left,
                    half_offset: edge.offset,
                    name_id: edge.name_id,
                    kind: KIND_SIDEWALK,
                    side: left_side,
                    flags: base_flags,
                    source_id: edge.source_id,
                });
                sidewalk_count += 1;
                derived_sidewalk_km += f64::from(left_length) / 1000.0;
            }
            if edge.sidewalks & SIDEWALK_RIGHT != 0 {
                let right_geom = offset_polyline(
                    &edge.poly_x,
                    &edge.poly_y,
                    half_offset_m,
                    -1.0,
                    (v2_x[right_a as usize], v2_y[right_a as usize]),
                    (v2_x[left_b as usize], v2_y[left_b as usize]),
                    meters_per_unit,
                );
                let right_baked =
                    polyline_length(&right_geom.0, &right_geom.1, origin_lng, origin_lat, scale)
                        as f32;
                let right_length = clamp_length(right_a, left_b, right_baked, &mut length_clamped);
                let right_geom_index = geometry_polys.len() as u32;
                geometry_polys.push(right_geom);
                v2_edges.push(V2Edge {
                    a: right_a,
                    b: left_b,
                    length: right_length,
                    geom: right_geom_index,
                    cover: edge.cover_right,
                    half_offset: edge.offset,
                    name_id: edge.name_id,
                    kind: KIND_SIDEWALK,
                    side: right_side,
                    flags: base_flags | FLAG_GEOMETRY_RIGHT,
                    source_id: edge.source_id,
                });
                sidewalk_count += 1;
                derived_sidewalk_km += f64::from(right_length) / 1000.0;
            }
        }
    }

    // In key order, since hash map order is seeded per process and would shuffle edge ids.
    let mut link_count = link_pairs.len();
    let mut link_list: Vec<((u32, u32), u8)> = link_pairs.into_iter().collect();
    link_list.sort_unstable();
    for ((node, corner), cover) in link_list {
        let length = node_distance(&v2_x, &v2_y, node, corner, origin_lng, origin_lat, scale);
        v2_edges.push(V2Edge {
            a: node,
            b: corner,
            length: length as f32,
            geom: NO_GEOMETRY,
            cover,
            half_offset: 0,
            name_id: UNNAMED,
            kind: KIND_LINK,
            side: SIDE_NONE,
            flags: 0,
            source_id: NO_SOURCE_ID,
        });
    }

    // Drop a synthesized crossing an OSM crossing already joins within 1.5x its length.
    let mut crossing_adjacency: HashMap<u32, Vec<(u32, f64)>> = HashMap::new();
    for edge in &v2_edges {
        if edge.kind == KIND_CROSSING && edge.flags & GRPH_OSM != 0 {
            let length = f64::from(edge.length);
            crossing_adjacency
                .entry(edge.a)
                .or_default()
                .push((edge.b, length));
            crossing_adjacency
                .entry(edge.b)
                .or_default()
                .push((edge.a, length));
        }
    }
    let mut suppressed_crossings = 0usize;
    let keep_crossing: Vec<bool> = v2_edges
        .iter()
        .map(|edge| {
            if edge.kind != KIND_CROSSING
                || edge.flags & GRPH_OSM != 0
                || !crossing_joins(
                    &crossing_adjacency,
                    edge.a,
                    edge.b,
                    SUPPRESSION_SLACK * f64::from(edge.length),
                )
            {
                true
            } else {
                suppressed_crossings += 1;
                false
            }
        })
        .collect();
    let mut kept_v2: Vec<V2Edge> = Vec::with_capacity(v2_edges.len() - suppressed_crossings);
    for (edge, keep) in v2_edges.into_iter().zip(keep_crossing) {
        if keep {
            kept_v2.push(edge);
        }
    }
    let mut v2_edges = kept_v2;
    crossing_count -= suppressed_crossings;

    // Backstop: one crossing per node pair, whatever drew them.
    let collapsed_crossings = collapse_parallel_crossings(&mut v2_edges);
    crossing_count -= collapsed_crossings;

    // Add latent crossings where sides are still separated until each v1 component is whole.
    let v2_node_count = v2_x.len();
    let mut v2_parent: Vec<u32> = (0..v2_node_count as u32).collect();
    for edge in &v2_edges {
        union(&mut v2_parent, edge.a, edge.b);
    }
    let mut mopup_crossings = 0usize;
    for &(corner_a, corner_b, crossed_edge) in &mopup_candidates {
        if find(&mut v2_parent, corner_a) != find(&mut v2_parent, corner_b) {
            let crossed = &final_edges[crossed_edge as usize];
            let length = node_distance(
                &v2_x, &v2_y, corner_a, corner_b, origin_lng, origin_lat, scale,
            );
            v2_edges.push(V2Edge {
                a: corner_a,
                b: corner_b,
                length: length as f32,
                geom: NO_GEOMETRY,
                cover: crossing_cover(crossed),
                half_offset: 0,
                name_id: crossed.name_id,
                kind: KIND_CROSSING,
                side: SIDE_NONE,
                flags: crossed.flags & (GRPH_STRUCTURE | GRPH_STEPS | GRPH_TUNNEL),
                source_id: NO_SOURCE_ID,
            });
            union(&mut v2_parent, corner_a, corner_b);
            mopup_crossings += 1;
        }
    }

    // Seam repair: rejoin gaps inside one v1 component where an OSM way stops short of the corner.
    let mut node_v1 = vec![0u32; v2_node_count];
    for (node, root) in node_v1.iter_mut().enumerate() {
        *root = find(&mut component_parent, v2_base[node]);
    }
    let mut piece_size: HashMap<u32, usize> = HashMap::new();
    for node in 0..v2_node_count {
        *piece_size
            .entry(find(&mut v2_parent, node as u32))
            .or_insert(0) += 1;
    }
    let mut split_v1: HashMap<u32, HashSet<u32>> = HashMap::new();
    for (node, &root) in node_v1.iter().enumerate() {
        split_v1
            .entry(root)
            .or_default()
            .insert(find(&mut v2_parent, node as u32));
    }
    let mut seam_repair_links = 0usize;
    let mut seam_repair_meters = 0.0f64;
    let mut seam_repair_longest = 0.0f64;
    let mut seam_gaps = 0usize;
    if split_v1.values().any(|pieces| pieces.len() > 1) {
        let repair_cell = (SEAM_REPAIR_METERS / meters_per_unit_lng).ceil().max(1.0) as i32;
        let mut repair_grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
        for node in 0..v2_node_count {
            repair_grid
                .entry((
                    v2_x[node].div_euclid(repair_cell),
                    v2_y[node].div_euclid(repair_cell),
                ))
                .or_default()
                .push(node as u32);
        }
        // Join non-largest pieces to their nearest peer, shortest first, until whole.
        let mut joins: Vec<(f64, u32, u32)> = Vec::new();
        for node in 0..v2_node_count {
            let piece = find(&mut v2_parent, node as u32);
            let Some(pieces) = split_v1.get(&node_v1[node]) else {
                continue;
            };
            if pieces.len() < 2
                || pieces
                    .iter()
                    .all(|other| piece_size[other] <= piece_size[&piece])
            {
                continue;
            }
            let cell_x = v2_x[node].div_euclid(repair_cell);
            let cell_y = v2_y[node].div_euclid(repair_cell);
            let mut best: Option<(f64, u32)> = None;
            for offset_x in -1..=1 {
                for offset_y in -1..=1 {
                    for &other in repair_grid
                        .get(&(cell_x + offset_x, cell_y + offset_y))
                        .into_iter()
                        .flatten()
                    {
                        if node_v1[other as usize] != node_v1[node]
                            || find(&mut v2_parent, other) == piece
                        {
                            continue;
                        }
                        let meters = node_distance(
                            &v2_x,
                            &v2_y,
                            node as u32,
                            other,
                            origin_lng,
                            origin_lat,
                            scale,
                        );
                        if meters <= SEAM_REPAIR_METERS
                            && best.is_none_or(|(held, at)| {
                                meters < held || (meters == held && other < at)
                            })
                        {
                            best = Some((meters, other));
                        }
                    }
                }
            }
            if let Some((meters, other)) = best {
                joins.push((meters, node as u32, other));
            }
        }
        joins.sort_by(|left, right| {
            left.0
                .total_cmp(&right.0)
                .then(left.1.cmp(&right.1))
                .then(left.2.cmp(&right.2))
        });
        for &(meters, node, other) in &joins {
            if find(&mut v2_parent, node) == find(&mut v2_parent, other) {
                continue;
            }
            v2_edges.push(V2Edge {
                a: node,
                b: other,
                length: meters as f32,
                geom: NO_GEOMETRY,
                cover: 0,
                half_offset: 0,
                name_id: UNNAMED,
                kind: KIND_LINK,
                side: SIDE_NONE,
                flags: 0,
                source_id: NO_SOURCE_ID,
            });
            union(&mut v2_parent, node, other);
            seam_repair_links += 1;
            seam_repair_meters += meters;
            seam_repair_longest = seam_repair_longest.max(meters);
        }
        for pieces in split_v1.values() {
            let mut whole: HashSet<u32> = HashSet::new();
            for &piece in pieces {
                whole.insert(find(&mut v2_parent, piece));
            }
            seam_gaps += whole.len() - 1;
        }
    }

    // Drop self-loops once every pass that places edges has run, correcting the kind counts.
    let self_loops = drop_self_loops(&mut v2_edges);
    for edge in &self_loops {
        let km = f64::from(edge.length) / 1000.0;
        let mapped = edge.flags & GRPH_OSM != 0;
        match edge.kind {
            KIND_SIDEWALK => {
                sidewalk_count -= 1;
                if mapped {
                    osm_sidewalk_edges -= 1;
                    osm_sidewalk_km -= km;
                } else {
                    derived_sidewalk_km -= km;
                }
            }
            KIND_CROSSING => {
                crossing_count -= 1;
                if mapped {
                    osm_crossing_edges -= 1;
                }
            }
            KIND_LINK => link_count -= 1,
            _ => {
                path_edge_count -= 1;
                if mapped {
                    osm_path_edges -= 1;
                    osm_path_km -= km;
                }
            }
        }
    }
    // Compact the geometry table, since dropped lines leave entries no edge names.
    let mut geometry_slot: Vec<u32> = vec![u32::MAX; geometry_polys.len()];
    for edge in &v2_edges {
        if edge.geom != NO_GEOMETRY {
            geometry_slot[edge.geom as usize] = 0;
        }
    }
    let mut kept_polys: Vec<(Vec<i32>, Vec<i32>)> = Vec::with_capacity(geometry_polys.len());
    for (index, slot) in geometry_slot.iter_mut().enumerate() {
        if *slot != u32::MAX {
            *slot = kept_polys.len() as u32;
            kept_polys.push(std::mem::take(&mut geometry_polys[index]));
        }
    }
    let mut geometry_polys = kept_polys;
    for edge in &mut v2_edges {
        if edge.geom != NO_GEOMETRY {
            edge.geom = geometry_slot[edge.geom as usize];
        }
    }

    // Components of the finished v2 graph, relabeled by size descending (0 = largest).
    let mut component_size: HashMap<u32, usize> = HashMap::new();
    let mut node_root = vec![0u32; v2_node_count];
    for (node, root_slot) in node_root.iter_mut().enumerate() {
        let root = find(&mut v2_parent, node as u32);
        *root_slot = root;
        *component_size.entry(root).or_insert(0) += 1;
    }
    let component_count = component_size.len();
    // The seam merges v1 components and leaves unrepaired gaps, so this is counted, not asserted.
    let seam_merged_components = v1_component_count.saturating_sub(component_count);
    if seam_gaps > MAX_SEAM_GAPS {
        return Err(format!(
            "the seam left {seam_gaps} v1 components split, over the {MAX_SEAM_GAPS} ceiling: the \
             mapped and derived networks are not meeting"
        )
        .into());
    }
    if component_count > u16::MAX as usize + 1 {
        return Err(format!("{component_count} components do not fit a u16 label").into());
    }
    let mut roots: Vec<(u32, usize)> = component_size.into_iter().collect();
    roots.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    let mut component_label: HashMap<u32, u16> = HashMap::with_capacity(component_count);
    for (label, &(root, _)) in roots.iter().enumerate() {
        component_label.insert(root, label as u16);
    }
    let node_component_of_v2: Vec<u16> =
        node_root.iter().map(|root| component_label[root]).collect();

    // Sort the nodes by (component, lat, lng), renumber, and remap the edges onto the new ids.
    let mut node_order: Vec<u32> = (0..v2_node_count as u32).collect();
    node_order.sort_by(|&left, &right| {
        node_component_of_v2[left as usize]
            .cmp(&node_component_of_v2[right as usize])
            .then(v2_y[left as usize].cmp(&v2_y[right as usize]))
            .then(v2_x[left as usize].cmp(&v2_x[right as usize]))
    });
    let node_count = node_order.len();
    let mut new_id = vec![u32::MAX; v2_node_count];
    for (index, &old) in node_order.iter().enumerate() {
        new_id[old as usize] = index as u32;
    }
    let mut node_lng: Vec<i32> = node_order.iter().map(|&old| v2_x[old as usize]).collect();
    let mut node_lat: Vec<i32> = node_order.iter().map(|&old| v2_y[old as usize]).collect();
    let node_component: Vec<u16> = node_order
        .iter()
        .map(|&old| node_component_of_v2[old as usize])
        .collect();
    for edge in &mut v2_edges {
        edge.a = new_id[edge.a as usize];
        edge.b = new_id[edge.b as usize];
    }
    v2_edges.sort_by(|left, right| {
        node_component[left.a as usize]
            .cmp(&node_component[right.a as usize])
            .then(left.a.min(left.b).cmp(&right.a.min(right.b)))
    });

    // Ferries go after the renumber; merged connectivity joins the islands to the main component.
    let mut ferry_edges = 0usize;
    let mut ferry_dropped_unsnapped = 0usize;
    let mut ferry_dropped_same_node = 0usize;
    let mut ferry_dropped_duplicate = 0usize;
    let mut ferry_stops_unsnapped = 0usize;
    // Per ferry edge the terminal name ids at its a and b ends; not name_ids, so remapped explicitly.
    let mut ferry_stop_names: Vec<(u32, u16, u16)> = Vec::new();
    let mut ferry_interned: HashMap<String, u16> = HashMap::new();
    if let Some(ferries_file) = &args.ferries {
        let ferries = binfmt::read_ferries(ferries_file)?;

        // Snap each stop to the nearest walking node in range; a stop with none drops its segments.
        let mut stop_node: Vec<Option<u32>> = Vec::with_capacity(ferries.stops.len());
        for stop in &ferries.stops {
            let stop_x = quantize_x(stop.lng);
            let stop_y = quantize_y(stop.lat);
            let mut nearest: Option<(u32, f64)> = None;
            for node in 0..node_count {
                let meters = great_circle(
                    stop_x,
                    stop_y,
                    node_lng[node],
                    node_lat[node],
                    origin_lng,
                    origin_lat,
                    scale,
                );
                if nearest.is_none_or(|(_, best)| meters < best) {
                    nearest = Some((node as u32, meters));
                }
            }
            match nearest {
                Some((node, meters)) if meters <= FERRY_SNAP_RADIUS_METERS => {
                    stop_node.push(Some(node));
                }
                _ => {
                    ferry_stops_unsnapped += 1;
                    eprintln!(
                        "tiler graph: ferry stop \"{}\" ({:.6}, {:.6}) has no walking node within {FERRY_SNAP_RADIUS_METERS:.0} m; dropping its segments",
                        stop.name, stop.lng, stop.lat
                    );
                    stop_node.push(None);
                }
            }
        }

        // Dedup segments that snap to the same unordered node pair, keeping the smaller raw time.
        let mut best_segment: HashMap<(u32, u32), usize> = HashMap::new();
        for (index, segment) in ferries.segments.iter().enumerate() {
            let (Some(node_a), Some(node_b)) = (
                stop_node[segment.stop_a as usize],
                stop_node[segment.stop_b as usize],
            ) else {
                ferry_dropped_unsnapped += 1;
                continue;
            };
            if node_a == node_b {
                ferry_dropped_same_node += 1;
                continue;
            }
            let key = (node_a.min(node_b), node_a.max(node_b));
            let replace = match best_segment.get(&key).copied() {
                Some(kept) => {
                    ferry_dropped_duplicate += 1;
                    segment.raw_time_seconds < ferries.segments[kept].raw_time_seconds
                }
                None => true,
            };
            if replace {
                best_segment.insert(key, index);
            }
        }

        // In node-pair order, since the appended ferry edges are numbered as emitted.
        let mut kept_segments: Vec<((u32, u32), usize)> = best_segment.into_iter().collect();
        kept_segments.sort_unstable();
        for (_, index) in kept_segments {
            let segment = &ferries.segments[index];
            let node_a = stop_node[segment.stop_a as usize].expect("a kept segment's stop snapped");
            let node_b = stop_node[segment.stop_b as usize].expect("a kept segment's stop snapped");
            // Crossing-plus-wait seconds as a u16, split across the cover/half-offset bytes at write.
            let duration = round_half_up(f64::from(segment.raw_time_seconds).max(0.0))
                .min(f64::from(u16::MAX)) as u16;
            let (geom, length) = match &segment.geometry {
                Some(shape) => {
                    // The shape's ends are unsnapped stops, so the nodes replace them.
                    let mut poly_x = vec![node_lng[node_a as usize]];
                    let mut poly_y = vec![node_lat[node_a as usize]];
                    for point in &shape[1..shape.len() - 1] {
                        poly_x.push(quantize_x(point.lng));
                        poly_y.push(quantize_y(point.lat));
                    }
                    poly_x.push(node_lng[node_b as usize]);
                    poly_y.push(node_lat[node_b as usize]);
                    let length =
                        polyline_length(&poly_x, &poly_y, origin_lng, origin_lat, scale) as f32;
                    let geom_index = geometry_polys.len() as u32;
                    geometry_polys.push((poly_x, poly_y));
                    (geom_index, length)
                }
                None => {
                    // A straight leg carries no geometry, so its length is the node distance.
                    let length = node_distance(
                        &node_lng, &node_lat, node_a, node_b, origin_lng, origin_lat, scale,
                    ) as f32;
                    (NO_GEOMETRY, length)
                }
            };
            // The route name becomes the edge's name; stop names go into the side table.
            let name_id = if segment.route_name.is_empty() {
                UNNAMED
            } else {
                intern_name(&mut all_names, &mut ferry_interned, &segment.route_name)
            };
            let a_stop_name = intern_name(
                &mut all_names,
                &mut ferry_interned,
                &ferries.stops[segment.stop_a as usize].name,
            );
            let b_stop_name = intern_name(
                &mut all_names,
                &mut ferry_interned,
                &ferries.stops[segment.stop_b as usize].name,
            );
            let edge_id = v2_edges.len() as u32;
            ferry_stop_names.push((edge_id, a_stop_name, b_stop_name));
            v2_edges.push(V2Edge {
                a: node_a,
                b: node_b,
                length,
                geom,
                cover: (duration & 0x00FF) as u8,
                half_offset: (duration >> 8) as u8,
                name_id,
                kind: KIND_FERRY,
                side: SIDE_NONE,
                flags: 0,
                source_id: NO_SOURCE_ID,
            });
            ferry_edges += 1;
        }
    }

    let TransitBuild {
        stations: transit_stations,
        unsnapped: transit_stations_unsnapped,
        split_stations: transit_split_stations,
        collapsed_stations: transit_collapsed_stations,
        entrances: transit_station_entrances,
        fallback_stations: transit_fallback_stations,
        transfer_edges: transit_transfer_edges,
        door_table: transit_door_names,
        street_doors: transit_street_doors,
        pavement_cuts: transit_pavement_cuts,
        platform_nodes: transit_platform_nodes,
        access_edges: transit_access_edges,
        board_edges: transit_board_edges,
        ride_edges: transit_ride_edges,
        stay_aboard_edges: transit_stay_aboard_edges,
        dropped_patterns: transit_dropped_patterns,
        routes: transit_routes,
        board_table: transit_board_names,
        ride_table: transit_ride_names,
    } = match &args.transit {
        Some(transit_file) => append_transit(
            &binfmt::read_transit(transit_file)?,
            &mut node_lng,
            &mut node_lat,
            &mut v2_edges,
            &mut geometry_polys,
            &mut all_names,
            origin_lng,
            origin_lat,
            scale,
            meters_per_unit,
        ),
        None => TransitBuild::default(),
    };
    let node_count = node_lng.len();

    // Relabel components over walking plus ferry edges, overwriting the walking-only ones.
    let mut merged_parent: Vec<u32> = (0..node_count as u32).collect();
    for edge in &v2_edges {
        union(&mut merged_parent, edge.a, edge.b);
    }
    let mut merged_size: HashMap<u32, usize> = HashMap::new();
    let mut merged_root = vec![0u32; node_count];
    for (node, slot) in merged_root.iter_mut().enumerate() {
        let root = find(&mut merged_parent, node as u32);
        *slot = root;
        *merged_size.entry(root).or_insert(0) += 1;
    }
    let component_count = merged_size.len();
    if component_count > u16::MAX as usize + 1 {
        return Err(format!("{component_count} merged components do not fit a u16 label").into());
    }
    let mut merged_roots: Vec<(u32, usize)> = merged_size.into_iter().collect();
    merged_roots.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    let largest_component = merged_roots.first().map_or(0, |&(_, size)| size);
    let mut merged_label: HashMap<u32, u16> = HashMap::with_capacity(component_count);
    for (label, &(root, _)) in merged_roots.iter().enumerate() {
        merged_label.insert(root, label as u16);
    }
    let node_component: Vec<u16> = merged_root.iter().map(|root| merged_label[root]).collect();

    let edge_count = v2_edges.len();

    // Only referenced names, sorted by original id; 0xFFFF stays unnamed.
    let mut used_names: Vec<u16> = v2_edges
        .iter()
        .map(|edge| edge.name_id)
        .filter(|&id| id != UNNAMED)
        .collect();
    // Ferry stop names are on no edge, so keep them or the compaction drops them.
    for &(_, a_stop_name, b_stop_name) in &ferry_stop_names {
        used_names.push(a_stop_name);
        used_names.push(b_stop_name);
    }
    // Route names are reached only through the side table, so they need the same rescue.
    for route in &transit_routes {
        used_names.push(route.short_name);
        used_names.push(route.long_name);
        used_names.push(route.id_name);
    }
    used_names.sort_unstable();
    used_names.dedup();
    if used_names.len() > UNNAMED as usize {
        return Err(format!("{} names do not fit a u16 id", used_names.len()).into());
    }
    let mut name_remap: HashMap<u16, u16> = HashMap::with_capacity(used_names.len());
    for (index, &original) in used_names.iter().enumerate() {
        name_remap.insert(original, index as u16);
    }
    // Remap the side-table stop-name ids through the same compaction the edge names use.
    let ferry_side_table: Vec<(u32, u16, u16)> = ferry_stop_names
        .iter()
        .map(|&(edge_id, a_stop_name, b_stop_name)| {
            (edge_id, name_remap[&a_stop_name], name_remap[&b_stop_name])
        })
        .collect();
    // A door's street name is some walking edge's own, so the compaction kept it; only the id moved.
    let transit_door_table: Vec<(u32, u16, u8)> = transit_door_names
        .iter()
        .map(|&(edge_id, street_name, side)| (edge_id, name_remap[&street_name], side))
        .collect();
    let transit_routes: Vec<TransitRouteRecord> = transit_routes
        .iter()
        .map(|route| TransitRouteRecord {
            short_name: name_remap[&route.short_name],
            long_name: name_remap[&route.long_name],
            id_name: name_remap[&route.id_name],
            ..*route
        })
        .collect();
    // Remapped here so the base already holds the table the blob ships.
    let names: Vec<String> = used_names
        .iter()
        .map(|&original| all_names[original as usize].clone())
        .collect();
    for edge in &mut v2_edges {
        if edge.name_id != UNNAMED {
            edge.name_id = name_remap[&edge.name_id];
        }
    }
    let (csr, adjacency) = adjacency_of(node_count, &v2_edges);

    // Geometry ends on its nodes, length >= node distance, no edge joins components, CSR total 2E.
    for edge in &v2_edges {
        if edge.geom != NO_GEOMETRY {
            let (poly_x, poly_y) = &geometry_polys[edge.geom as usize];
            let last = poly_x.len() - 1;
            if poly_x[0] != node_lng[edge.a as usize]
                || poly_y[0] != node_lat[edge.a as usize]
                || poly_x[last] != node_lng[edge.b as usize]
                || poly_y[last] != node_lat[edge.b as usize]
            {
                return Err("an edge geometry does not start and end on its nodes".into());
            }
        }
        let straight = node_distance(
            &node_lng, &node_lat, edge.a, edge.b, origin_lng, origin_lat, scale,
        ) as f32;
        if edge.length + LENGTH_SLACK_METERS < straight {
            return Err("an edge is shorter than its node distance".into());
        }
        if node_component[edge.a as usize] != node_component[edge.b as usize] {
            return Err("an edge joins two components".into());
        }
    }
    if csr[node_count] as usize != 2 * edge_count {
        return Err("the CSR half-edge count is not 2E".into());
    }

    // Transit is excluded since these bounds are about pavement; OSM and CSCL ids can collide.
    let invariant_edges: Vec<invariants::Edge> = v2_edges
        .iter()
        .filter(|edge| !matches!(edge.kind, KIND_ACCESS | KIND_BOARD | KIND_RIDE))
        .map(|edge| {
            let straight = [
                [node_lng[edge.a as usize], node_lng[edge.b as usize]],
                [node_lat[edge.a as usize], node_lat[edge.b as usize]],
            ];
            let (poly_x, poly_y) = match edge.geom {
                NO_GEOMETRY => (&straight[0][..], &straight[1][..]),
                geom => {
                    let (poly_x, poly_y) = &geometry_polys[geom as usize];
                    (&poly_x[..], &poly_y[..])
                }
            };
            let osm = edge.flags & GRPH_OSM != 0;
            let cscl = !osm || edge.kind == KIND_SIDEWALK;
            invariants::Edge {
                a: edge.a,
                b: edge.b,
                length: edge.length,
                kind: edge.kind,
                side: edge.side,
                source_id: edge.source_id,
                osm,
                alley: cscl && alley_ids.contains(&edge.source_id),
                demoted: cscl && demoted_ids.contains(&edge.source_id),
                bearing_a: departure_bearing(
                    poly_x,
                    poly_y,
                    true,
                    meters_per_unit_lng,
                    meters_per_unit_lat,
                ),
                bearing_b: departure_bearing(
                    poly_x,
                    poly_y,
                    false,
                    meters_per_unit_lng,
                    meters_per_unit_lat,
                ),
            }
        })
        .collect();
    let walk = invariants::Walk {
        node_count,
        node_x: &node_lng,
        node_y: &node_lat,
        meters_per_unit,
        edges: &invariant_edges,
    };
    let one_sided_ids: HashSet<u32> = kept_sides
        .iter()
        .filter(|&(_, &sides)| sides == 1)
        .map(|(&id, _)| id)
        .collect();
    let alley_reach = invariants::alley_reach(&walk);
    let mouth_walk = invariants::alley_mouth_walk(&walk);
    let crossings_to_nowhere = invariants::crossings_to_nowhere(&walk);
    let phantoms = invariants::phantom_sidewalks(&walk, &one_sided_ids);
    let link_lengths = invariants::link_lengths(&walk);
    let pavement_cells = invariants::pavement_cells(&walk, PAVEMENT_CELL_METERS, PAVEMENT_CELL_KM);
    let seam_hairpins = invariants::seam_hairpins(&walk);
    // Failures are collected before any is raised, so one build reports them all.
    let total_km: f64 = v2_edges
        .iter()
        .map(|edge| f64::from(edge.length))
        .sum::<f64>()
        / 1000.0;
    let mut broken: Vec<String> = Vec::new();
    // Only alley-classifying cities are asked; the floors still catch a classifier that stopped.
    if args.alleys {
        for (population, floor, what) in [
            (alley_reach.total_km, MIN_ALLEY_KM, "km of alley"),
            (
                mouth_walk.mouths as f64,
                MIN_ALLEY_MOUTHS as f64,
                "alley mouths",
            ),
        ] {
            if population < floor {
                broken.push(format!(
                    "the city has {population:.1} {what}, under the {floor:.0} floor: the bounds \
                     below are held over that population, so they would pass on it whatever the \
                     graph looks like"
                ));
            }
        }
    }
    // Populations first, so a bound passing on nothing says so.
    for (population, floor, what) in [
        (
            one_sided_ids.len() as f64,
            MIN_ONE_SIDED_KEYS as f64,
            "streets the gate left pavement on one side of",
        ),
        (
            pavement_cells.cells as f64,
            MIN_PAVEMENT_CELLS as f64,
            "scored half-kilometer cells",
        ),
        (
            link_lengths.links as f64,
            MIN_LINK_EDGES as f64,
            "link edges",
        ),
    ] {
        if population < floor {
            broken.push(format!(
                "the city has {population:.1} {what}, under the {floor:.0} floor: the bounds below \
                 are held over that population, so they would pass on it whatever the graph looks \
                 like"
            ));
        }
    }
    if args.alleys
        && alley_reach.off_component_km > MAX_STRANDED_ALLEY_FRACTION * alley_reach.total_km
    {
        broken.push(format!(
            "{:.1} of {:.1} km of alley hangs off the main walking component, over the {:.0}% \
             ceiling: an alley nothing reaches still routes internally, so a trip that ends on one \
             silently snaps to the street instead",
            alley_reach.off_component_km,
            alley_reach.total_km,
            100.0 * MAX_STRANDED_ALLEY_FRACTION
        ));
    }
    if args.alleys
        && (mouth_walk.median_meters > MAX_ALLEY_MOUTH_MEDIAN_METERS
            || mouth_walk.p90_meters > MAX_ALLEY_MOUTH_P90_METERS
            || mouth_walk.stranded > MAX_STRANDED_ALLEY_MOUTHS)
    {
        broken.push(format!(
            "an alley mouth walks {:.0} m to mapped pavement at the median and {:.0} m at the 90th \
             percentile, with {} of {} reaching none at all, over {MAX_ALLEY_MOUTH_MEDIAN_METERS:.0} \
             / {MAX_ALLEY_MOUTH_P90_METERS:.0} m and {MAX_STRANDED_ALLEY_MOUTHS}: the mouth is \
             meters from the pavement it faces and is going round the block to reach it",
            mouth_walk.median_meters, mouth_walk.p90_meters, mouth_walk.stranded, mouth_walk.mouths
        ));
    }
    if phantoms > MAX_PHANTOM_SIDEWALKS {
        broken.push(format!(
            "{phantoms} of the {} streets the gate left pavement on one side of carry it on both, \
             over the {MAX_PHANTOM_SIDEWALKS} ceiling: the graph is walking people down the side of \
             the street that has no sidewalk",
            one_sided_ids.len()
        ));
    }
    if link_lengths.p99_meters > MAX_LINK_P99_METERS
        || link_lengths.longest_meters > SEAM_REPAIR_METERS
    {
        broken.push(format!(
            "the link edges reach {:.0} m at the 99th percentile and {:.0} m at the longest, over \
             {MAX_LINK_P99_METERS:.0} and the {SEAM_REPAIR_METERS:.0} m the seam repair itself \
             reaches: a link is the stitch into a park or a plaza, and a long one is a walker sent \
             out to the roadway and back",
            link_lengths.p99_meters, link_lengths.longest_meters
        ));
    }
    let ceilings = args.existence_ceilings;
    if pavement_cells.p90_demoted_share > ceilings.cell_demoted_share {
        broken.push(format!(
            "a tenth of the city's {} half-kilometer cells are over {:.0}% streets with no \
             pavement, over the {:.0}% ceiling: a neighborhood has lost its sidewalks while the \
             citywide average hid it",
            pavement_cells.cells,
            100.0 * pavement_cells.p90_demoted_share,
            100.0 * ceilings.cell_demoted_share
        ));
    }
    let dropped_fraction = 1.0 - kept_side_km / derived_side_km;
    let demoted_alley_fraction = demoted_alley_km / alley_km;
    // Each guard catches the rule being wrong; with no denominator at all the build stops here.
    if !args.probe {
        if derived_side_km < MIN_DERIVED_SIDEWALK_KM || (args.alleys && alley_km < MIN_ALLEY_KM) {
            return Err(format!(
                "the gate was handed {derived_side_km:.1} km of derived sidewalk and {alley_km:.1} \
                 km of alley, under the {MIN_DERIVED_SIDEWALK_KM:.0} / {MIN_ALLEY_KM:.0} km \
                 floors: the two shares below are held over those, so an empty one passes them both"
            )
            .into());
        }
        if dropped_fraction > ceilings.dropped_sidewalk_fraction {
            broken.push(format!(
                "the existence gate dropped {:.1}% of derived sidewalk km, over the {:.0}% \
                 ceiling: the STRT per-side bits look unstamped, which reads as a city with no \
                 pavement",
                100.0 * dropped_fraction,
                100.0 * ceilings.dropped_sidewalk_fraction
            ));
        }
        if args.alleys && demoted_alley_fraction < MIN_DEMOTED_ALLEY_FRACTION {
            broken.push(format!(
                "only {:.1}% of alley km demoted to its centerline, under the {:.0}% floor: alleys \
                 have no sidewalks, so a build that keeps them has the gate the wrong way round",
                100.0 * demoted_alley_fraction,
                100.0 * MIN_DEMOTED_ALLEY_FRACTION
            ));
        }
    }
    // Whole-city bounds, so `key-probe` reports them and holds none.
    if !broken.is_empty() && !args.probe {
        return Err(broken.join("; and ").into());
    }

    // Over the exact written order, so an edge id here is the id the file ships.
    let edge_ordinals = assign_ordinals(&v2_edges)?;
    let durable_id_edges = v2_edges
        .iter()
        .filter(|edge| edge.source_id != NO_SOURCE_ID)
        .count();
    let max_ordinal = edge_ordinals.iter().copied().max().unwrap_or(0);
    let key_hash = key_space_hash(&v2_edges, &edge_ordinals);

    let largest_fraction = if node_count > 0 {
        largest_component as f64 / node_count as f64
    } else {
        0.0
    };
    let stats = serde_json::json!({
        "nodes": node_count,
        "edges": edge_count,
        "components": component_count,
        "largestComponentFraction": largest_fraction,
        "droppedVehicularOnly": dropped_vehicular,
        "mergedNearNodes": merged_near_nodes,
        "contractedNodes": contracted_nodes,
        "prunedVertices": pruned_vertices,
        "sidewalkEdges": sidewalk_count,
        "demotedStreets": demoted_streets,
        "demotedKm": demoted_km,
        "oneSidedStreets": one_sided_streets,
        "trimmedStreets": trimmed_streets,
        "droppedSidewalkFraction": dropped_fraction,
        "demotedAlleyFraction": demoted_alley_fraction,
        "crossingEdges": crossing_count,
        "linkEdges": link_count,
        "pathEdges": path_edge_count,
        "cornerNodes": corner_node_count,
        "pathNodes": path_node_count,
        "seamCorners": seam_corners,
        "seamLinks": seam_links,
        "osmCorners": osm_corner.len(),
        "synthesizedCrossings": synthesized_crossings,
        "nameBreakJoints": name_break_joints,
        "mopupCrossings": mopup_crossings,
        "seamRepairLinks": seam_repair_links,
        "seamRepairMeters": seam_repair_meters,
        "seamRepairLongest": seam_repair_longest,
        "seamGaps": seam_gaps,
        "suppressedCrossings": suppressed_crossings,
        "collapsedCrossings": collapsed_crossings,
        "selfLoopEdges": self_loops.len(),
        "seamMergedComponents": seam_merged_components,
        "v1Components": v1_component_count,
        "lengthClamped": length_clamped,
        "durableIdEdges": durable_id_edges,
        "maxOrdinal": max_ordinal,
        // The one figure a committed shed artifact is gated on.
        "keyHash": format!("{key_hash:016x}"),
        "dedupedWays": conflate_stats.deduped_ways,
        "dedupedKm": conflate_stats.deduped_km,
        "dedupedOrphanWays": conflate_stats.deduped_orphan_ways,
        "dedupedOrphanKm": conflate_stats.deduped_orphan_km,
        "osmTSplits": conflate_stats.osm_t_splits,
        "csclTSplits": conflate_stats.cscl_t_splits,
        "curbCuts": curb_cuts,
        "weldedVertices": conflate_stats.welded_vertices,
        "entranceSnaps": conflate_stats.entrance_snaps,
        "entranceSnapsCurb": conflate_stats.entrance_snaps_curb,
        "shortEntranceSnaps": conflate_stats.short_entrance_snaps,
        "danglingEnds": conflate_stats.dangling_ends,
        "mergedDanglingEnds": conflate_stats.merged_dangling_ends,
        "islandTouchCuts": conflate_stats.island_touch_cuts,
        "csclSplits": conflate_stats.cscl_splits,
        "osmWays": conflate_stats.osm_ways,
        "osmKm": conflate_stats.osm_km,
        "sidewalkWays": sidewalk_ways.len(),
        "sidewalkEdgeProtos": sidewalk_edge_protos,
        "streetlessSidewalkKm": streetless_sidewalk_km,
        "osmSideKm": osm_side_km,
        "osmCoveredStreets": osm_covered_streets,
        "droppedOsmIslands": dropped_osm_islands,
        "droppedOsmIslandKm": dropped_osm_island_km,
        "strandedPathWays": stranded_ways.len(),
        "osmPathEdges": osm_path_edges,
        "osmPathKm": osm_path_km,
        "osmSidewalkEdges": osm_sidewalk_edges,
        "osmSidewalkKm": osm_sidewalk_km,
        "osmCrossingEdges": osm_crossing_edges,
        "derivedSidewalkKm": derived_sidewalk_km,
        "ferryEdges": ferry_edges,
        "ferryStopsUnsnapped": ferry_stops_unsnapped,
        "ferryDroppedUnsnapped": ferry_dropped_unsnapped,
        "ferryDroppedSameNode": ferry_dropped_same_node,
        "ferryDroppedDuplicate": ferry_dropped_duplicate,
        "transitStations": transit_stations,
        "transitStationsUnsnapped": transit_stations_unsnapped,
        "transitSplitStations": transit_split_stations,
        "transitCollapsedStations": transit_collapsed_stations,
        "transitTransferEdges": transit_transfer_edges,
        "transitPlatformNodes": transit_platform_nodes,
        "transitStationEntrances": transit_station_entrances,
        "transitFallbackStations": transit_fallback_stations,
        "transitStreetDoors": transit_street_doors,
        "transitPavementCuts": transit_pavement_cuts,
        "transitAccessEdges": transit_access_edges,
        "transitBoardEdges": transit_board_edges,
        "transitRideEdges": transit_ride_edges,
        "transitStayAboardEdges": transit_stay_aboard_edges,
        "transitDroppedPatterns": transit_dropped_patterns,
        "transitRoutes": transit_routes.len(),
        "names": names.len(),
        "alleyKm": alley_reach.total_km,
        "alleyOffComponentKm": alley_reach.off_component_km,
        "alleyMouths": mouth_walk.mouths,
        "alleyMouthsStranded": mouth_walk.stranded,
        "alleyMouthWalkMedianM": mouth_walk.median_meters,
        "alleyMouthWalkP90M": mouth_walk.p90_meters,
        "crossingsToNowhere": crossings_to_nowhere,
        "oneSidedKeys": one_sided_ids.len(),
        "phantomSidewalks": phantoms,
        // After the seam repair; `linkEdges` counts before it.
        "linkEdgesScored": link_lengths.links,
        "linkP99M": link_lengths.p99_meters,
        "linkLongestM": link_lengths.longest_meters,
        "pavementCells": pavement_cells.cells,
        "pavementCellP90DemotedShare": pavement_cells.p90_demoted_share,
        "pavementCellP99DemotedShare": pavement_cells.p99_demoted_share,
        "pavementCellWorstDemotedShare": pavement_cells.worst_demoted_share,
        "seamHairpins": seam_hairpins,
        "totalKm": total_km,
    });

    Ok(Base {
        origin_lng,
        origin_lat,
        scale,
        node_lng,
        node_lat,
        node_component,
        component_count,
        edges: v2_edges,
        ordinals: edge_ordinals,
        key_hash,
        geometry_polys,
        names,
        ferry_side_table,
        transit_routes,
        transit_board_table: transit_board_names,
        transit_ride_table: transit_ride_names,
        transit_door_table,
        stranded_ways,
        stats,
        csr,
        adjacency,
    })
}

/// One byte per edge per attribute, plus a (buildings, trees) row pair per sun bin.
struct Columns {
    landmark: Vec<u8>,
    art: Vec<u8>,
    highway: Vec<u8>,
    commercial: Vec<u8>,
    ascent: Vec<u8>,
    descent: Vec<u8>,
    direct_canopy: Vec<u8>,
    industrial: Vec<u8>,
    historic: Vec<u8>,
    bridge: Vec<u8>,
    /// In schedule order, and empty for a city with no per-edge shade bake.
    shade: Vec<(Vec<u8>, Vec<u8>)>,
}

/// Every edge's polyline in degrees; a ferry has none, a geometry-less edge is its node-to-node line.
fn edge_polylines(base: &Base) -> Vec<Vec<binfmt::Coord>> {
    let to_coord = |quantized_x: i32, quantized_y: i32| binfmt::Coord {
        lng: base.origin_lng + f64::from(quantized_x) * base.scale,
        lat: base.origin_lat + f64::from(quantized_y) * base.scale,
    };
    base.edges
        .iter()
        .map(|edge| {
            if timed_kind(edge.kind) {
                Vec::new()
            } else if edge.geom == NO_GEOMETRY {
                vec![
                    to_coord(
                        base.node_lng[edge.a as usize],
                        base.node_lat[edge.a as usize],
                    ),
                    to_coord(
                        base.node_lng[edge.b as usize],
                        base.node_lat[edge.b as usize],
                    ),
                ]
            } else {
                let (poly_x, poly_y) = &base.geometry_polys[edge.geom as usize];
                poly_x
                    .iter()
                    .zip(poly_y)
                    .map(|(&quantized_x, &quantized_y)| to_coord(quantized_x, quantized_y))
                    .collect()
            }
        })
        .collect()
}

/// Built lazily: a couple hundred MB for New York, and unneeded when every column is cached.
struct Polylines<'a> {
    base: &'a Base,
    built: Option<Vec<Vec<binfmt::Coord>>>,
}

impl Polylines<'_> {
    fn get(&mut self) -> &[Vec<binfmt::Coord>] {
        self.built.get_or_insert_with(|| edge_polylines(self.base))
    }
}

/// One column: the cached entry under this key, or the bake stored under it.
fn column(
    mut cache: Option<&mut graph_cache::Cache>,
    name: &str,
    key: Option<&str>,
    expect: usize,
    bake: impl FnOnce() -> Fallible<Vec<u8>>,
) -> Fallible<Vec<u8>> {
    let held = match (cache.as_deref_mut(), key) {
        (Some(cache), Some(key)) => cache.load(name, key, expect)?,
        _ => None,
    };
    match held {
        Some(bytes) => Ok(bytes),
        None => {
            let bytes = bake()?;
            if let (Some(cache), Some(key)) = (cache, key) {
                cache.store(name, key, &bytes)?;
            }
            Ok(bytes)
        }
    }
}

/// Attribute columns, each cached under a key folding the base's, so one source rebakes one column.
fn bake(
    args: &Args,
    base: &Base,
    dem: Option<&mut crate::dem::Dem>,
    mut cache: Option<&mut graph_cache::Cache>,
) -> Fallible<Columns> {
    let keys = args.cache.as_ref();
    let edge_count = base.edges.len();
    let mut polylines = Polylines { base, built: None };

    // Scenic-factor bytes: a CSR fan-out over the finished graph; ferries zeroed at write.
    let edge_a: Vec<u32> = base.edges.iter().map(|edge| edge.a).collect();
    let edge_b: Vec<u32> = base.edges.iter().map(|edge| edge.b).collect();
    let edge_len_m: Vec<f64> = base
        .edges
        .iter()
        .map(|edge| f64::from(edge.length))
        .collect();
    // A ferry stays walkable here: no fan-out reaches across one, so this moves no bytes.
    let edge_walkable: Vec<bool> = base
        .edges
        .iter()
        .map(|edge| !matches!(edge.kind, KIND_ACCESS | KIND_BOARD | KIND_RIDE))
        .collect();
    let meters_per_unit_lat = METERS_PER_DEGREE_LAT * base.scale;
    let meters_per_unit_lng =
        METERS_PER_DEGREE_LAT * base.origin_lat.to_radians().cos() * base.scale;
    let network = scenic::Network {
        node_x: &base.node_lng,
        node_y: &base.node_lat,
        csr: &base.csr,
        adjacency: &base.adjacency,
        edge_a: &edge_a,
        edge_b: &edge_b,
        edge_len_m: &edge_len_m,
        edge_walkable: &edge_walkable,
        origin_lng: base.origin_lng,
        origin_lat: base.origin_lat,
        scale: base.scale,
        mpu_lng: meters_per_unit_lng,
        mpu_lat: meters_per_unit_lat,
    };

    let landmark = match &args.landmarks {
        Some(path) => column(
            cache.as_deref_mut(),
            graph_cache::LANDMARKS,
            keys.map(|keys| keys.landmarks.as_str()),
            edge_count,
            || {
                let pois = binfmt::read_points(path, "LMRK", binfmt::LANDMARK_FORMAT)?;
                let (bytes, stats) = scenic::poi_amenity(&network, &scenic::LANDMARK_PARAMS, &pois);
                eprintln!(
                    "landmarks: {} points, {} snapped, max amenity byte {}",
                    pois.len(),
                    stats.snapped,
                    stats.max_byte
                );
                Ok(bytes)
            },
        )?,
        None => vec![0u8; edge_count],
    };
    let art = match &args.art {
        Some(path) => column(
            cache.as_deref_mut(),
            graph_cache::ART,
            keys.map(|keys| keys.art.as_str()),
            edge_count,
            || {
                let pois = binfmt::read_points(path, "ARTW", binfmt::ART_FORMAT)?;
                let (bytes, stats) = scenic::poi_amenity(&network, &scenic::ART_PARAMS, &pois);
                eprintln!(
                    "art: {} points, {} snapped, max amenity byte {}",
                    pois.len(),
                    stats.snapped,
                    stats.max_byte
                );
                Ok(bytes)
            },
        )?,
        None => vec![0u8; edge_count],
    };
    let highway = match &args.highways {
        Some(path) => column(
            cache.as_deref_mut(),
            graph_cache::HIGHWAYS,
            keys.map(|keys| keys.highways.as_str()),
            edge_count,
            || {
                let lines = binfmt::read_polygons(path, "HWAY", binfmt::HIGHWAY_FORMAT)?;
                let (bytes, max_byte) = scenic::highway_penalty(&network, &lines);
                eprintln!(
                    "highways: {} nuisance lines, max penalty byte {}",
                    lines.len(),
                    max_byte
                );
                Ok(bytes)
            },
        )?,
        None => vec![0u8; edge_count],
    };
    let commercial = match &args.commercial {
        Some(path) => column(
            cache.as_deref_mut(),
            graph_cache::COMMERCIAL,
            keys.map(|keys| keys.commercial.as_str()),
            edge_count,
            || {
                let lines = binfmt::read_polygons(path, "CMLN", binfmt::COMMERCIAL_FORMAT)?;
                let (bytes, max_byte) = scenic::commercial_amenity(&network, &lines);
                eprintln!(
                    "commercial: {} qualifying lines, max amenity byte {}",
                    lines.len(),
                    max_byte
                );
                Ok(bytes)
            },
        )?,
        None => vec![0u8; edge_count],
    };

    // Ascent and descent along a->b, one cache entry since they share one DEM pass.
    let (ascent, descent) = match args.elevation_bounds {
        Some(bounds) => {
            let rows = column(
                cache.as_deref_mut(),
                graph_cache::RELIEF,
                keys.map(|keys| keys.relief.as_str()),
                2 * edge_count,
                || {
                    let dem = dem.ok_or(
                        "this city has a DEM and the driver opened none: its relief column was \
                         there when that was decided and is not now, so build again",
                    )?;
                    let field = crate::dem::resample(&bounds, RELIEF_FIELD_ZOOM, dem)?;
                    let lengths: Vec<f32> = base.edges.iter().map(|edge| edge.length).collect();
                    let baked = relief::relief(polylines.get(), &lengths, &field)?;
                    eprintln!(
                        "relief: {} edges measured, mean grade {:.1}%, steepest {:.1}%",
                        baked.measured,
                        100.0 * baked.mean_grade,
                        100.0 * baked.max_grade
                    );
                    Ok([baked.ascent, baked.descent].concat())
                },
            )?;
            let (ascent, descent) = rows.split_at(edge_count);
            (ascent.to_vec(), descent.to_vec())
        }
        None => (vec![0u8; edge_count], vec![0u8; edge_count]),
    };

    // The fraction of the edge under a crown, with no kernel (see direct_canopy.rs).
    let direct_canopy = match &args.canopy {
        Some(path) => column(
            cache.as_deref_mut(),
            graph_cache::CANOPY,
            keys.map(|keys| keys.canopy.as_str()),
            edge_count,
            || {
                let baked = direct_canopy::direct_canopy(polylines.get(), path, base.origin_lat)?;
                eprintln!(
                    "direct canopy: {} polygons, mean covered fraction {:.3}, max byte {}",
                    baked.polygons, baked.mean, baked.max_byte
                );
                Ok(baked.bytes)
            },
        )?,
        None => vec![0u8; edge_count],
    };

    // The structure flag is passed in since a deck over a yard fronts nothing.
    let industrial = match &args.industrial {
        Some(path) => column(
            cache.as_deref_mut(),
            graph_cache::INDUSTRIAL,
            keys.map(|keys| keys.industrial.as_str()),
            edge_count,
            || {
                let on_structure: Vec<bool> = base
                    .edges
                    .iter()
                    .map(|edge| edge.flags & GRPH_STRUCTURE != 0)
                    .collect();
                let baked =
                    industrial::industrial(polylines.get(), &on_structure, path, base.origin_lat)?;
                eprintln!(
                    "industrial: {} lots, {} edges fronting one, mean frontage {:.4}, max byte {}",
                    baked.polygons, baked.fronting, baked.mean, baked.max_byte
                );
                Ok(baked.bytes)
            },
        )?,
        None => vec![0u8; edge_count],
    };

    // Tested underfoot, not probed sideways; a deck through a district is still in it.
    let historic = match &args.historic {
        Some(path) => column(
            cache.as_deref_mut(),
            graph_cache::HISTORIC,
            keys.map(|keys| keys.historic.as_str()),
            edge_count,
            || {
                let baked = historic::historic(polylines.get(), path, base.origin_lat)?;
                eprintln!(
                    "historic: {} district parts, {} edges inside one, mean {:.4}, max byte {}",
                    baked.polygons, baked.inside, baked.mean, baked.max_byte
                );
                Ok(baked.bytes)
            },
        )?,
        None => vec![0u8; edge_count],
    };

    // The tunnel bit is excluded first, since a bore under a channel has no view.
    let bridge = match &args.land {
        Some(path) => column(
            cache.as_deref_mut(),
            graph_cache::BRIDGE,
            keys.map(|keys| keys.bridge.as_str()),
            edge_count,
            || {
                let on_bridge: Vec<bool> = base
                    .edges
                    .iter()
                    .map(|edge| edge.flags & GRPH_STRUCTURE != 0 && edge.flags & GRPH_TUNNEL == 0)
                    .collect();
                let lengths: Vec<f32> = base.edges.iter().map(|edge| edge.length).collect();
                let baked =
                    bridge::bridge(polylines.get(), &on_bridge, &lengths, path, base.origin_lat)?;
                eprintln!(
                    "bridge: {} land parts, {} edges over water, {:.0} m of deck over water, max \
                     byte {}",
                    baked.polygons, baked.decks, baked.over_water_meters, baked.max_byte
                );
                Ok(baked.bytes)
            },
        )?,
        None => vec![0u8; edge_count],
    };

    let shade = match (&args.buildings, &args.shade_params) {
        (Some(buildings), Some(params)) => {
            shade_columns(args, base, buildings, params, &mut polylines, cache)?
        }
        _ => Vec::new(),
    };

    Ok(Columns {
        landmark,
        art,
        highway,
        commercial,
        ascent,
        descent,
        direct_canopy,
        industrial,
        historic,
        bridge,
        shade,
    })
}

/// One cached column per sun bin; missing bins bake in one call, since it parallelizes across bins.
fn shade_columns(
    args: &Args,
    base: &Base,
    buildings: &std::path::Path,
    params: &shade::Params,
    polylines: &mut Polylines,
    mut cache: Option<&mut graph_cache::Cache>,
) -> Fallible<Vec<(Vec<u8>, Vec<u8>)>> {
    let keys = args.cache.as_ref();
    if let Some(keys) = keys
        && keys.shade.len() != params.buckets.len()
    {
        return Err("the driver keyed a different number of sun bins than the grid holds".into());
    }
    let edge_count = base.edges.len();
    let mut rows: Vec<Option<(Vec<u8>, Vec<u8>)>> = Vec::with_capacity(params.buckets.len());
    for bin in 0..params.buckets.len() {
        let held = match (cache.as_deref_mut(), keys) {
            (Some(cache), Some(keys)) => cache
                .load(graph_cache::SHADE, &keys.shade[bin], 2 * edge_count)?
                .map(|bytes| {
                    let (buildings, trees) = bytes.split_at(edge_count);
                    (buildings.to_vec(), trees.to_vec())
                }),
            _ => None,
        };
        rows.push(held);
    }

    let missing: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter(|(_, row)| row.is_none())
        .map(|(bin, _)| bin)
        .collect();
    if !missing.is_empty() {
        eprintln!(
            "shade: {} of {} bins to bake",
            missing.len(),
            params.buckets.len()
        );
        let casters = shade::edge_shade_casters(buildings, args.canopy.as_deref())?;
        let wanted: Vec<shade::Bucket> = missing
            .iter()
            .map(|bin| params.buckets[*bin].clone())
            .collect();
        let baked = shade::bake_edge_shade(
            &casters,
            &wanted,
            params.max_shadow_meters,
            params.max_zoom,
            polylines.get(),
        );
        for (bin, (buildings, trees)) in missing.iter().zip(baked) {
            if let (Some(cache), Some(keys)) = (cache.as_deref_mut(), keys) {
                let mut entry = Vec::with_capacity(2 * edge_count);
                entry.extend_from_slice(&buildings);
                entry.extend_from_slice(&trees);
                cache.store(graph_cache::SHADE, &keys.shade[*bin], &entry)?;
            }
            rows[*bin] = Some((buildings, trees));
        }
    }

    rows.into_iter()
        .map(|row| row.ok_or_else(|| "a sun bin nothing baked".into()))
        .collect()
}

/// FNV-1a 32 of the column name; readers find sections by position, so the tag catches swaps.
fn column_tag(name: &str) -> u32 {
    let mut hash = 0x811c_9dc5u32;
    for byte in name.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// One v12 section: 8-byte aligned, appended, and recorded as (offset, length, tag).
struct Layout {
    bytes: Vec<u8>,
    directory: Vec<(u32, u32, u32)>,
}

impl Layout {
    fn new() -> Self {
        Layout {
            bytes: vec![0u8; GRAPH_HEADER_BYTES],
            directory: Vec::with_capacity(GRAPH_SECTIONS),
        }
    }

    fn section(&mut self, name: &str, payload: &[u8]) {
        assert!(
            self.directory.len() < GRAPH_DIRECTORY_MAX,
            "the v12 directory holds {GRAPH_DIRECTORY_MAX} sections, and {name} would be the {}th",
            self.directory.len() + 1
        );
        while !self.bytes.len().is_multiple_of(SECTION_ALIGN) {
            self.bytes.push(0);
        }
        self.directory.push((
            self.bytes.len() as u32,
            payload.len() as u32,
            column_tag(name),
        ));
        self.bytes.extend_from_slice(payload);
    }

    fn finish(mut self) -> Vec<u8> {
        put_u32(&mut self.bytes, 44, self.directory.len() as u32);
        for (index, &(offset, length, tag)) in self.directory.iter().enumerate() {
            let entry = GRAPH_DIRECTORY_AT + GRAPH_DIRECTORY_ENTRY * index;
            put_u32(&mut self.bytes, entry, offset);
            put_u32(&mut self.bytes, entry + 4, length);
            put_u32(&mut self.bytes, entry + 8, tag);
        }
        self.bytes
    }
}

fn le_u16(values: &[u16]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

fn le_u32(values: &[u32]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

fn le_i32(values: &[i32]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

fn le_f32(values: &[f32]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

/// Nodes whose every walking edge is a crossing; mirrors src/routing/graph.ts's oracle.
fn mark_mid_roadway(
    node_count: usize,
    csr: &[u32],
    adjacency: &[u32],
    edge_kind_side: &[u8],
) -> Vec<u8> {
    let mut mid_roadway = vec![0u8; node_count];
    for node in 0..node_count {
        let mut walking = 0usize;
        let mut all_crossings = true;
        for slot in csr[node] as usize..csr[node + 1] as usize {
            let kind = edge_kind_side[adjacency[slot] as usize] & KIND_MASK;
            if matches!(kind, KIND_ACCESS | KIND_BOARD | KIND_RIDE) {
                continue;
            }
            walking += 1;
            all_crossings &= kind == KIND_CROSSING;
        }
        mid_roadway[node] = u8::from(all_crossings && walking > 0);
    }
    mid_roadway
}

/// Lay out the graph blob, version file, stranded list and SHDE bake; computes nothing new.
fn assemble(args: &Args, base: &Base, columns: &Columns) -> Fallible<()> {
    let Base {
        origin_lng,
        origin_lat,
        scale,
        node_lng,
        node_lat,
        node_component,
        component_count,
        edges: v2_edges,
        ordinals: edge_ordinals,
        key_hash,
        geometry_polys,
        names,
        ferry_side_table,
        transit_routes,
        transit_board_table,
        transit_ride_table,
        transit_door_table,
        stranded_ways,
        csr,
        adjacency,
        ..
    } = base;
    let (origin_lng, origin_lat, scale) = (*origin_lng, *origin_lat, *scale);
    let (component_count, key_hash) = (*component_count, *key_hash);
    let node_count = node_lng.len();
    let edge_count = v2_edges.len();

    // First vertex delta from the graph origin, the rest from the previous vertex.
    let mut geometry: Vec<u8> = Vec::new();
    let mut geometry_offsets: Vec<u32> = Vec::with_capacity(geometry_polys.len());
    for (poly_x, poly_y) in geometry_polys {
        geometry_offsets.push(geometry.len() as u32);
        let mut previous_x = 0i64;
        let mut previous_y = 0i64;
        for (&vertex_x, &vertex_y) in poly_x.iter().zip(poly_y) {
            write_varint(&mut geometry, zigzag(i64::from(vertex_x) - previous_x));
            write_varint(&mut geometry, zigzag(i64::from(vertex_y) - previous_y));
            previous_x = i64::from(vertex_x);
            previous_y = i64::from(vertex_y);
        }
    }

    // The name table: a u32 count, (count + 1) byte offsets, then the UTF-8 names back to back.
    let mut name_blob: Vec<u8> = Vec::new();
    let mut name_offsets: Vec<u32> = Vec::with_capacity(names.len() + 1);
    for name in names {
        name_offsets.push(name_blob.len() as u32);
        name_blob.extend_from_slice(name.as_bytes());
    }
    name_offsets.push(name_blob.len() as u32);
    let mut name_table: Vec<u8> = Vec::with_capacity(4 + 4 * name_offsets.len() + name_blob.len());
    name_table.extend_from_slice(&(names.len() as u32).to_le_bytes());
    name_table.extend_from_slice(&le_u32(&name_offsets));
    name_table.extend_from_slice(&name_blob);

    let mut edge_node_a: Vec<u32> = Vec::with_capacity(edge_count);
    let mut edge_node_b: Vec<u32> = Vec::with_capacity(edge_count);
    let mut edge_length: Vec<f32> = Vec::with_capacity(edge_count);
    let mut edge_geom_offset: Vec<u32> = Vec::with_capacity(edge_count);
    let mut edge_geom_count: Vec<u16> = Vec::with_capacity(edge_count);
    let mut edge_name_id: Vec<u16> = Vec::with_capacity(edge_count);
    let mut edge_duration: Vec<u16> = Vec::with_capacity(edge_count);
    let mut edge_kind_side: Vec<u8> = Vec::with_capacity(edge_count);
    let mut edge_flags: Vec<u8> = Vec::with_capacity(edge_count);
    let mut edge_cover: Vec<u8> = Vec::with_capacity(edge_count);
    let mut edge_source_id: Vec<u32> = Vec::with_capacity(edge_count);
    let mut ferry_edges: Vec<u32> = Vec::new();
    let mut transit_edges: Vec<u32> = Vec::new();
    let mut board_edges: Vec<u32> = Vec::new();
    let mut cover_clamped = 0usize;
    for (edge_id, edge) in v2_edges.iter().enumerate() {
        let (geom_offset, vertex_count) = if edge.geom == NO_GEOMETRY {
            (NO_GEOMETRY, 0u16)
        } else {
            (
                geometry_offsets[edge.geom as usize],
                geometry_polys[edge.geom as usize].0.len() as u16,
            )
        };
        edge_node_a.push(edge.a);
        edge_node_b.push(edge.b);
        edge_length.push(edge.length);
        edge_geom_offset.push(geom_offset);
        edge_geom_count.push(vertex_count);
        edge_name_id.push(edge.name_id);
        edge_kind_side.push((edge.kind & KIND_MASK) | (edge.side << SIDE_SHIFT));
        edge_flags.push(edge.flags);
        // A crossing, link or ferry carries the sentinel and a zero ordinal.
        edge_source_id.push(edge.source_id);
        // Cover clamps to 254: a 255 makes an edge free at w = 1, breaking cost.ts's heuristic.
        if timed_kind(edge.kind) {
            edge_duration.push(u16::from(edge.cover) | (u16::from(edge.half_offset) << 8));
            edge_cover.push(0);
        } else {
            edge_duration.push(0);
            edge_cover.push(if edge.cover > 254 {
                cover_clamped += 1;
                254
            } else {
                edge.cover
            });
        }
        match edge.kind {
            KIND_FERRY => ferry_edges.push(edge_id as u32),
            KIND_BOARD => {
                transit_edges.push(edge_id as u32);
                board_edges.push(edge_id as u32);
            }
            KIND_ACCESS | KIND_RIDE => transit_edges.push(edge_id as u32),
            _ => {}
        }
    }

    // Timed kinds read zero out of every attribute column.
    let walking_only = |values: &[u8]| -> Vec<u8> {
        v2_edges
            .iter()
            .enumerate()
            .map(|(edge_id, edge)| {
                if timed_kind(edge.kind) {
                    0
                } else {
                    values[edge_id]
                }
            })
            .collect()
    };
    let edge_landmark = walking_only(&columns.landmark);
    let edge_art = walking_only(&columns.art);
    let edge_highway = walking_only(&columns.highway);
    let edge_commercial = walking_only(&columns.commercial);
    let edge_direct_canopy = walking_only(&columns.direct_canopy);
    let edge_industrial = walking_only(&columns.industrial);
    let edge_historic = walking_only(&columns.historic);
    let edge_bridge = walking_only(&columns.bridge);
    let edge_ascent = walking_only(&columns.ascent);
    let edge_descent = walking_only(&columns.descent);

    let node_mid_roadway = mark_mid_roadway(node_count, csr, adjacency, &edge_kind_side);

    // A u32 count, then per ferry edge (u32 edge id, u16 a-stop name, u16 b-stop name).
    let mut ferry_table: Vec<u8> = Vec::with_capacity(4 + 8 * ferry_side_table.len());
    ferry_table.extend_from_slice(&(ferry_side_table.len() as u32).to_le_bytes());
    for &(edge_id, a_stop_name, b_stop_name) in ferry_side_table {
        ferry_table.extend_from_slice(&edge_id.to_le_bytes());
        ferry_table.extend_from_slice(&a_stop_name.to_le_bytes());
        ferry_table.extend_from_slice(&b_stop_name.to_le_bytes());
    }

    // Each is a u32 count plus fixed records; a reader missing the door table reads unnamed.
    let mut transit_table: Vec<u8> = Vec::new();
    transit_table.extend_from_slice(&(transit_routes.len() as u32).to_le_bytes());
    for route in transit_routes {
        transit_table.extend_from_slice(&route.color);
        transit_table.extend_from_slice(&route.text_color);
        transit_table.extend_from_slice(&route.short_name.to_le_bytes());
        transit_table.extend_from_slice(&route.long_name.to_le_bytes());
        transit_table.extend_from_slice(&route.id_name.to_le_bytes());
    }
    transit_table.extend_from_slice(&(transit_board_table.len() as u32).to_le_bytes());
    for &(edge_id, lane_id, route_index, stop_index) in transit_board_table {
        transit_table.extend_from_slice(&edge_id.to_le_bytes());
        transit_table.extend_from_slice(&lane_id.to_le_bytes());
        transit_table.extend_from_slice(&route_index.to_le_bytes());
        transit_table.extend_from_slice(&stop_index.to_le_bytes());
    }
    transit_table.extend_from_slice(&(transit_ride_table.len() as u32).to_le_bytes());
    for &(edge_id, route_index) in transit_ride_table {
        transit_table.extend_from_slice(&edge_id.to_le_bytes());
        transit_table.extend_from_slice(&route_index.to_le_bytes());
        transit_table.extend_from_slice(&0u16.to_le_bytes());
    }
    transit_table.extend_from_slice(&(transit_door_table.len() as u32).to_le_bytes());
    for &(edge_id, street_name, side) in transit_door_table {
        transit_table.extend_from_slice(&edge_id.to_le_bytes());
        transit_table.extend_from_slice(&street_name.to_le_bytes());
        transit_table.push(side);
        transit_table.push(0); // pad, to keep the record 8 bytes
    }

    let mut layout = Layout::new();
    layout.bytes[0..4].copy_from_slice(b"GRPH");
    put_u16(&mut layout.bytes, 4, GRAPH_FORMAT);
    put_u16(&mut layout.bytes, 6, GRAPH_HEADER_BYTES as u16);
    put_u32(&mut layout.bytes, 8, node_count as u32);
    put_u32(&mut layout.bytes, 12, edge_count as u32);
    put_f64(&mut layout.bytes, 16, origin_lng);
    put_f64(&mut layout.bytes, 24, origin_lat);
    put_f64(&mut layout.bytes, 32, scale);
    put_u32(&mut layout.bytes, 40, component_count as u32);
    // Baked so the client needn't scan 640k edges; in the order the client reads them.
    let greatest = |values: &[u8]| values.iter().copied().max().unwrap_or(0);
    for (index, column) in [
        &edge_cover,
        &edge_landmark,
        &edge_art,
        &edge_commercial,
        &edge_direct_canopy,
        &edge_industrial,
        &edge_historic,
        &edge_bridge,
    ]
    .iter()
    .enumerate()
    {
        layout.bytes[48 + index] = greatest(column);
    }
    let max_relief = edge_ascent
        .iter()
        .zip(&edge_descent)
        .map(|(&ascent, &descent)| u16::from(ascent) + u16::from(descent))
        .max()
        .unwrap_or(0);
    put_u16(&mut layout.bytes, 56, max_relief);
    layout.bytes[58] = u8::from(edge_flags.iter().any(|flags| flags & GRPH_TUNNEL != 0));

    layout.section("nodeQx", &le_i32(node_lng));
    layout.section("nodeQy", &le_i32(node_lat));
    layout.section("nodeComponent", &le_u16(node_component));
    layout.section("nodeMidRoadway", &node_mid_roadway);
    layout.section("csr", &le_u32(csr));
    layout.section("adjacency", &le_u32(adjacency));
    layout.section("edgeNodeA", &le_u32(&edge_node_a));
    layout.section("edgeNodeB", &le_u32(&edge_node_b));
    layout.section("edgeLength", &le_f32(&edge_length));
    layout.section("edgeGeomOffset", &le_u32(&edge_geom_offset));
    layout.section("edgeGeomCount", &le_u16(&edge_geom_count));
    layout.section("edgeNameId", &le_u16(&edge_name_id));
    layout.section("edgeDurationSeconds", &le_u16(&edge_duration));
    layout.section("edgeKindSide", &edge_kind_side);
    layout.section("edgeFlags", &edge_flags);
    layout.section("edgeCover", &edge_cover);
    layout.section("edgeLandmark", &edge_landmark);
    layout.section("edgeArt", &edge_art);
    layout.section("edgeHighway", &edge_highway);
    layout.section("edgeCommercial", &edge_commercial);
    layout.section("edgeDirectCanopy", &edge_direct_canopy);
    layout.section("edgeIndustrial", &edge_industrial);
    layout.section("edgeHistoric", &edge_historic);
    layout.section("edgeBridge", &edge_bridge);
    layout.section("edgeAscent", &edge_ascent);
    layout.section("edgeDescent", &edge_descent);
    layout.section("edgeSourceId", &le_u32(&edge_source_id));
    layout.section("edgeOrdinal", edge_ordinals);
    layout.section("ferryEdges", &le_u32(&ferry_edges));
    layout.section("transitEdges", &le_u32(&transit_edges));
    layout.section("boardEdges", &le_u32(&board_edges));
    layout.section("names", &name_table);
    layout.section("geometry", &geometry);
    layout.section("ferryEndpoints", &ferry_table);
    layout.section("transitTables", &transit_table);
    let bytes = layout.finish();

    if let Some(parent) = args.out.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&args.out, &bytes)?;
    write_version(&args.out, &bytes, edge_count, key_hash)?;
    if let Some(path) = &args.stranded_out {
        write_stranded(path, stranded_ways)?;
    }

    // Per-edge per-bin occlusion, in the finalized GRPH edge order.
    if let (Some(params), Some(shade_dir_path)) = (&args.shade_params, &args.shade_dir)
        && !columns.shade.is_empty()
    {
        let positions: Vec<shade::BinPosition> =
            params.buckets.iter().map(shade::bin_position).collect();
        write_shade(shade_dir_path, edge_count, &positions, &columns.shade)?;
        eprintln!(
            "shade: {} bins x {edge_count} edges baked to {}",
            positions.len(),
            shade_dir_path.display()
        );
    }

    let mut stats = base.stats.clone();
    stats["coverClamped"] = cover_clamped.into();
    stats["bytes"] = bytes.len().into();
    match &args.report {
        Some(path) => crate::write_report(path, &stats)?,
        None => println!("{}", serde_json::to_string(&stats)?),
    }
    Ok(())
}

/// Returns the OSM way ids the island drop stranded, sorted, for the second chunks pass.
pub fn run(args: &Args, dem: Option<&mut crate::dem::Dem>) -> Fallible<Vec<u32>> {
    let mut cache = args
        .cache
        .as_ref()
        .map(|keys| graph_cache::Cache::new(&keys.dir));
    let key = args.cache.as_ref().map(|keys| keys.base.as_str());
    let held = match (cache.as_mut(), key) {
        (Some(cache), Some(key)) => cache.load_base(key)?,
        _ => None,
    };
    // An undecodable entry is a miss, or the workflow would re-bank it under a fresh key forever.
    let base = match held.and_then(|bytes| match Base::decode(&bytes) {
        Ok(base) => Some(base),
        Err(error) => {
            eprintln!("topology: the cached base did not decode ({error}), rebuilding it");
            None
        }
    }) {
        Some(base) => {
            eprintln!(
                "topology: {} nodes, {} edges from the cache",
                base.node_lng.len(),
                base.edges.len()
            );
            base
        }
        None => {
            let base = topology(args)?;
            if let (Some(cache), Some(key)) = (cache.as_mut(), key) {
                cache.store(graph_cache::BASE, key, &base.encode()?)?;
            }
            base
        }
    };
    let columns = bake(args, &base, dem, cache.as_mut())?;
    assemble(args, &base, &columns)?;
    if let Some(cache) = &cache {
        cache.prune()?;
    }
    Ok(base.stranded_ways)
}

#[cfg(test)]
mod tests {
    use super::*;

    // An odd-length section, so the next must be padded to the 8-byte boundary typed arrays need.
    #[test]
    fn every_section_starts_on_an_eight_byte_boundary() {
        let mut layout = Layout::new();
        for length in [1usize, 7, 8, 9, 0, 33] {
            layout.section("edgeCover", &vec![0xABu8; length]);
        }
        let bytes = layout.finish();
        assert_eq!(
            get_u32(&bytes, 44),
            6,
            "the directory says how many it wrote"
        );
        for (index, &(offset, length, tag)) in layout_entries(&bytes, 6).iter().enumerate() {
            assert_eq!(offset % SECTION_ALIGN as u32, 0, "section {index}");
            assert!(
                offset as usize + length as usize <= bytes.len(),
                "section {index}"
            );
            assert_eq!(tag, column_tag("edgeCover"), "section {index}");
        }
    }

    // The directory is fixed-size and a 49th entry would overwrite node 0.
    #[test]
    #[should_panic(expected = "the v12 directory holds 48 sections")]
    fn the_directory_does_not_run_past_its_last_entry() {
        let mut layout = Layout::new();
        for _ in 0..=GRAPH_DIRECTORY_MAX {
            layout.section("edgeCover", &[0u8; 8]);
        }
    }

    // Must match what src/routing/graph.ts computes for the same name.
    #[test]
    fn the_column_tag_is_fnv_1a_32_of_the_name() {
        assert_eq!(column_tag("edgeCover"), 0x6365_59C7);
        assert_ne!(column_tag("edgeCover"), column_tag("edgeLandmark"));
    }

    // Two entries claiming one column would pass the client's check on a wrong file.
    #[test]
    fn no_two_sections_claim_the_same_column() {
        let names = [
            "nodeQx",
            "nodeQy",
            "nodeComponent",
            "nodeMidRoadway",
            "csr",
            "adjacency",
            "edgeNodeA",
            "edgeNodeB",
            "edgeLength",
            "edgeGeomOffset",
            "edgeGeomCount",
            "edgeNameId",
            "edgeDurationSeconds",
            "edgeKindSide",
            "edgeFlags",
            "edgeCover",
            "edgeLandmark",
            "edgeArt",
            "edgeHighway",
            "edgeCommercial",
            "edgeDirectCanopy",
            "edgeIndustrial",
            "edgeHistoric",
            "edgeBridge",
            "edgeAscent",
            "edgeDescent",
            "edgeSourceId",
            "edgeOrdinal",
            "ferryEdges",
            "transitEdges",
            "boardEdges",
            "names",
            "geometry",
            "ferryEndpoints",
            "transitTables",
        ];
        assert_eq!(names.len(), GRAPH_SECTIONS);
        let mut tags: Vec<u32> = names.iter().map(|name| column_tag(name)).collect();
        tags.sort_unstable();
        tags.dedup();
        assert_eq!(tags.len(), GRAPH_SECTIONS);
    }

    // An island mid-crossing (0-1-2) is mid-roadway; station node 3, with no walking edge, is not.
    #[test]
    fn a_station_on_a_traffic_island_does_not_pave_it() {
        let csr = [0u32, 1, 4, 5, 6];
        let adjacency = [0u32, 0, 1, 2, 1, 2];
        let kinds = [KIND_CROSSING, KIND_CROSSING, KIND_ACCESS];
        assert_eq!(
            mark_mid_roadway(4, &csr, &adjacency, &kinds),
            vec![1, 1, 1, 0]
        );
    }

    fn get_u32(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("4 bytes"))
    }

    fn layout_entries(bytes: &[u8], count: usize) -> Vec<(u32, u32, u32)> {
        (0..count)
            .map(|index| {
                let entry = GRAPH_DIRECTORY_AT + GRAPH_DIRECTORY_ENTRY * index;
                (
                    get_u32(bytes, entry),
                    get_u32(bytes, entry + 4),
                    get_u32(bytes, entry + 8),
                )
            })
            .collect()
    }

    // Late-stamped bits and door bits share the flags byte, so they must stand clear of each other.
    #[test]
    fn the_written_flag_bits_are_all_different() {
        let written = [
            GRPH_STRUCTURE,
            GRPH_STEPS,
            FLAG_GEOMETRY_RIGHT,
            GRPH_OSM,
            GRPH_TUNNEL,
            ACCESS_EXIT_ONLY,
            ACCESS_ENTRY_ONLY,
            ACCESS_ELEVATOR,
        ];
        for (index, bit) in written.iter().enumerate() {
            assert_eq!(bit.count_ones(), 1, "{bit:#04x} is not one bit");
            for other in &written[index + 1..] {
                assert_eq!(bit & other, 0, "{bit:#04x} and {other:#04x} share a bit");
            }
        }
        // Both are masked at write, so neither may sit on a bit the record spends.
        for internal in [GRPH_PATHLIKE, GRPH_BUILDING_RIGHT] {
            assert_eq!(internal & (GRPH_STRUCTURE | GRPH_STEPS | GRPH_TUNNEL), 0);
        }
        // Bit 5 is the one deliberate reuse, since GRPH_BUILDING_RIGHT never reaches a record.
        assert_eq!(ACCESS_EXIT_ONLY, GRPH_BUILDING_RIGHT);
        // A ride's flag borrows a door's bit; the kind tells them apart.
        assert_eq!(RIDE_STAY_ABOARD, ACCESS_ENTRY_ONLY);
    }

    // Two stations in one transfer complex, each on its own line, plus a terminus for each line.
    fn transfer_fixture() -> binfmt::Transit {
        let station = |lng_units: i32, lat_units: i32, name: &str, complex: u16, surface: bool| {
            binfmt::TransitStation {
                lng: -73.5 + f64::from(lng_units) * 1e-6,
                lat: 40.25 + f64::from(lat_units) * 1e-6,
                name: name.to_string(),
                complex,
                surface,
                split: false,
            }
        };
        let route = |short_name: &str| binfmt::TransitRoute {
            color: [0, 0, 0],
            text_color: [0xFF, 0xFF, 0xFF],
            short_name: short_name.to_string(),
            long_name: format!("{short_name} line"),
            id: format!("gtfs:{short_name}"),
        };
        binfmt::Transit {
            stations: vec![
                station(100, 100, "W 4 St-Wash Sq", 7, false),
                station(300, 100, "W 4 St-Wash Sq", 7, true),
                station(5_000, 100, "Broadway Junction", 0, false),
                station(5_100, 100, "Bay Ridge Av", 0, false),
            ],
            entrances: Vec::new(),
            routes: vec![route("A"), route("B")],
            patterns: vec![
                binfmt::TransitPattern {
                    lane_id: 1,
                    route_index: 0,
                    direction: 0,
                    stops: vec![2, 0],
                    offsets: vec![0, 600],
                },
                binfmt::TransitPattern {
                    lane_id: 2,
                    route_index: 1,
                    direction: 0,
                    stops: vec![1, 3],
                    offsets: vec![0, 600],
                },
            ],
        }
    }

    // Name 0, since `run_transit_on` seeds the table with it.
    const PAVEMENT_NAME: u16 = 0;
    const PAVEMENT_STREET: &str = "Flatbush Av";

    // One OSM sidewalk running 850 m east from node 0 to node 1.
    fn transfer_graph() -> PavementGraph {
        let sidewalk = V2Edge {
            a: 0,
            b: 1,
            length: 850.0,
            geom: 0,
            cover: 7,
            half_offset: 3,
            name_id: PAVEMENT_NAME,
            kind: KIND_SIDEWALK,
            side: SIDE_NORTH,
            flags: GRPH_OSM,
            source_id: 41,
        };
        (
            vec![0, 10_000],
            vec![0, 0],
            vec![sidewalk],
            vec![(vec![0, 10_000], vec![0, 0])],
        )
    }

    struct TransitRun {
        node_lng: Vec<i32>,
        node_lat: Vec<i32>,
        edges: Vec<V2Edge>,
        geometry_polys: Vec<(Vec<i32>, Vec<i32>)>,
        names: Vec<String>,
        built: TransitBuild,
    }

    // The same pavement repeated at each given row offset north of the origin.
    fn parallel_pavements(rows: &[i32]) -> PavementGraph {
        let (mut node_lng, mut node_lat) = (Vec::new(), Vec::new());
        let (mut edges, mut geometry_polys) = (Vec::new(), Vec::new());
        for &row in rows {
            let node_a = node_lng.len() as u32;
            node_lng.extend_from_slice(&[0, 10_000]);
            node_lat.extend_from_slice(&[row, row]);
            geometry_polys.push((vec![0, 10_000], vec![row, row]));
            edges.push(V2Edge {
                a: node_a,
                b: node_a + 1,
                geom: geometry_polys.len() as u32 - 1,
                ..transfer_graph().2[0].clone()
            });
        }
        (node_lng, node_lat, edges, geometry_polys)
    }

    type PavementGraph = (Vec<i32>, Vec<i32>, Vec<V2Edge>, Vec<(Vec<i32>, Vec<i32>)>);

    fn run_transit_on(graph: PavementGraph, transit: &binfmt::Transit) -> TransitRun {
        let (mut node_lng, mut node_lat, mut edges, mut geometry_polys) = graph;
        let mut names: Vec<String> = vec![PAVEMENT_STREET.to_string()];
        let built = append_transit(
            transit,
            &mut node_lng,
            &mut node_lat,
            &mut edges,
            &mut geometry_polys,
            &mut names,
            -73.5,
            40.25,
            1e-6,
            (0.0848, 0.11132),
        );
        TransitRun {
            node_lng,
            node_lat,
            edges,
            geometry_polys,
            names,
            built,
        }
    }

    fn run_transit(transit: &binfmt::Transit) -> TransitRun {
        run_transit_on(transfer_graph(), transit)
    }

    // One underground station standing north of the sidewalk, at the given offset from node 0.
    fn lone_station(lng_units: i32, lat_units: i32) -> binfmt::Transit {
        binfmt::Transit {
            stations: vec![binfmt::TransitStation {
                lng: -73.5 + f64::from(lng_units) * 1e-6,
                lat: 40.25 + f64::from(lat_units) * 1e-6,
                name: "Nevins St".to_string(),
                complex: 0,
                surface: false,
                split: false,
            }],
            entrances: Vec::new(),
            routes: Vec::new(),
            patterns: Vec::new(),
        }
    }

    fn access_edges_from(edges: &[V2Edge], station: u32) -> Vec<V2Edge> {
        edges
            .iter()
            .filter(|edge| edge.a == station && edge.kind == KIND_ACCESS)
            .cloned()
            .collect()
    }

    // A station node's doors: its access edges, less the one to the side's own entry node.
    fn doors_from(run: &TransitRun, station: u32, entry: u32) -> Vec<V2Edge> {
        access_edges_from(&run.edges, station)
            .into_iter()
            .filter(|edge| edge.b != entry)
            .collect()
    }

    fn baked_seconds(edge: &V2Edge) -> u16 {
        u16::from(edge.cover) | (u16::from(edge.half_offset) << 8)
    }

    #[test]
    fn a_station_cuts_the_pavement_at_the_foot_of_its_perpendicular() {
        let run = run_transit(&lone_station(4_000, 100));

        assert_eq!(run.built.pavement_cuts, 1);
        assert_eq!(
            run.built.street_doors, 2,
            "the one door, as a way in and a way out"
        );
        let foot = 2u32;
        assert_eq!(
            (run.node_lng[foot as usize], run.node_lat[foot as usize]),
            (4_000, 0),
            "the cut stands at the foot of the perpendicular, mid-block"
        );
        let (head, tail) = (&run.edges[0], &run.edges[1]);
        assert_eq!((head.a, head.b), (0, foot));
        assert_eq!((tail.a, tail.b), (foot, 1));
        for piece in [head, tail] {
            assert_eq!(
                (piece.kind, piece.side, piece.source_id, piece.cover),
                (KIND_SIDEWALK, SIDE_NORTH, 41, 7),
                "both halves are the sidewalk they were cut from"
            );
        }
        assert!(
            (head.length + tail.length - 850.0).abs() < 1.0,
            "the halves share out the parent's length: {} and {}",
            head.length,
            tail.length
        );
        assert_eq!(
            run.geometry_polys[head.geom as usize],
            (vec![0, 4_000], vec![0, 0])
        );
        assert_eq!(
            run.geometry_polys[tail.geom as usize],
            (vec![4_000, 10_000], vec![0, 0])
        );

        let (entry, exit) = station_sides(&run, "Nevins St")[0];
        let inward = doors_from(&run, entry, entry);
        assert_eq!(inward.len(), 1, "one way in, at the cut");
        assert_eq!(inward[0].b, foot);
        assert_eq!(inward[0].flags, ACCESS_ENTRY_ONLY);
        assert!(
            (inward[0].length - 11.1).abs() < 0.2,
            "the access edge is the perpendicular itself: {}",
            inward[0].length
        );
        assert_eq!(
            baked_seconds(&inward[0]),
            UNDERGROUND_ACCESS_SECONDS + 9,
            "the stair and the gate, plus the 11 m walk at 1.3 m/s"
        );
        let outward = doors_from(&run, exit, entry);
        assert_eq!(outward.len(), 1);
        assert_eq!((outward[0].b, outward[0].flags), (foot, ACCESS_EXIT_ONLY));
    }

    // With one node per station, down one stair and up another would be a free underpass.
    #[test]
    fn a_station_is_a_way_in_and_a_way_out_and_not_a_way_through() {
        let run = run_transit_on(parallel_pavements(&[0, 300]), &lone_station(4_000, 150));

        let (entry, exit) = station_sides(&run, "Nevins St")[0];
        assert_eq!(run.built.stations, 2, "a way in and a way out");
        for door in doors_from(&run, entry, entry) {
            assert_eq!(
                door.flags, ACCESS_ENTRY_ONLY,
                "every door of the entry is in"
            );
        }
        for door in doors_from(&run, exit, entry) {
            assert_eq!(
                door.flags, ACCESS_EXIT_ONLY,
                "and every door of the exit out"
            );
        }
        assert!(
            !run.edges
                .iter()
                .any(|edge| edge.a == entry && edge.b == exit),
            "nothing leaves the entry for the exit, so no walk passes through the station"
        );
        let transfer: Vec<&V2Edge> = run
            .edges
            .iter()
            .filter(|edge| edge.a == exit && edge.b == entry)
            .collect();
        assert_eq!(transfer.len(), 1, "one edge back, for a change of train");
        assert_eq!(
            (
                transfer[0].kind,
                baked_seconds(transfer[0]),
                transfer[0].flags
            ),
            (KIND_ACCESS, 0, ACCESS_EXIT_ONLY),
            "free, and walkable only out of the exit"
        );
    }

    #[test]
    fn a_station_between_two_pavements_gets_a_door_on_each() {
        // 150 lat units is ~17 m, inside the entrance radius of both pavements.
        let run = run_transit_on(parallel_pavements(&[0, 300]), &lone_station(4_000, 150));

        assert_eq!(
            run.built.street_doors, 4,
            "one door on each side, each in and out"
        );
        assert_eq!(run.built.pavement_cuts, 2);
        let (entry, _) = station_sides(&run, "Nevins St")[0];
        let doors = doors_from(&run, entry, entry);
        let rows: Vec<i32> = doors
            .iter()
            .map(|edge| run.node_lat[edge.b as usize])
            .collect();
        assert_eq!(rows, vec![0, 300], "one foot on each pavement");
        for edge in &doors {
            assert_eq!(run.node_lng[edge.b as usize], 4_000);
        }
    }

    // The maneuver names the street the door stands on, not the route's approach.
    #[test]
    fn every_door_records_the_street_it_opens_onto() {
        let run = run_transit_on(parallel_pavements(&[0, 300]), &lone_station(4_000, 150));

        let doors: Vec<u32> = run
            .edges
            .iter()
            .enumerate()
            .filter(|(_, edge)| edge.kind == KIND_ACCESS && edge.name_id != UNNAMED)
            .map(|(edge_id, _)| edge_id as u32)
            .collect();
        let streets: Vec<(u32, u16, u8)> = run.built.door_table.clone();
        assert_eq!(
            streets.len(),
            doors.len() - 1,
            "every door but the change of train, which stands on no street"
        );
        for &(edge_id, street, side) in &streets {
            assert_eq!(
                run.names[street as usize], PAVEMENT_STREET,
                "the name of the pavement the door was cut into"
            );
            assert_eq!(side, SIDE_NORTH, "and the side of it that pavement lies on");
            assert_eq!(run.edges[edge_id as usize].kind, KIND_ACCESS);
        }
    }

    #[test]
    fn a_station_takes_no_more_doors_than_the_cap() {
        let rows: Vec<i32> = (0..8).map(|row| row * 50).collect();
        let run = run_transit_on(parallel_pavements(&rows), &lone_station(4_000, 175));

        assert_eq!(run.built.street_doors, 2 * TRANSIT_ENTRANCES_MAX);
        assert_eq!(run.built.pavement_cuts, TRANSIT_ENTRANCES_MAX);
        let (entry, _) = station_sides(&run, "Nevins St")[0];
        let rows: Vec<i32> = doors_from(&run, entry, entry)
            .iter()
            .map(|edge| run.node_lat[edge.b as usize])
            .collect();
        assert_eq!(
            rows,
            vec![50, 100, 150, 200, 250, 300],
            "the six nearest pavements, and not the two farthest"
        );
    }

    #[test]
    fn a_foot_beside_a_corner_reuses_it() {
        let run = run_transit(&lone_station(0, 100));

        assert_eq!(run.built.pavement_cuts, 0, "a corner is already a node");
        let (entry, _) = station_sides(&run, "Nevins St")[0];
        let doors = doors_from(&run, entry, entry);
        assert_eq!(doors.len(), 1);
        assert_eq!(doors[0].b, 0, "the corner the foot landed on");
        assert_eq!(
            run.edges[0].b, 1,
            "and the sidewalk it stands on is left whole"
        );
    }

    #[test]
    fn a_station_out_of_reach_of_the_pavement_is_dropped() {
        let run = run_transit(&lone_station(4_000, 5_000));

        assert_eq!(run.built.stations, 0);
        assert_eq!(run.built.unsnapped, 1);
        assert_eq!(run.built.street_doors, 0);
        assert_eq!(run.edges.len(), 1, "the sidewalk, and nothing hung off it");
    }

    #[test]
    fn one_complex_takes_one_station_node_at_its_members_centroid() {
        let run = run_transit(&transfer_fixture());

        assert_eq!(
            run.built.stations, 6,
            "the complex is one pair of nodes, not two"
        );
        assert_eq!(
            run.built.pavement_cuts, 4,
            "one cut per member station of the four"
        );
        // The four cuts are numbered along the sidewalk, then the station nodes in feed order.
        let (entry, _) = station_sides(&run, "W 4 St-Wash Sq")[0];
        assert_eq!(entry, 6);
        assert_eq!(run.node_lng[entry as usize], 200);
        assert_eq!(run.node_lat[entry as usize], 100);
        let doors = doors_from(&run, entry, entry);
        assert_eq!(
            doors.len(),
            2,
            "each member of the complex brings its own way in"
        );
        let feet: Vec<i32> = doors
            .iter()
            .map(|edge| run.node_lng[edge.b as usize])
            .collect();
        assert_eq!(
            feet,
            vec![100, 300],
            "one under each member, not one corner for both"
        );
        for edge in &doors {
            assert!(
                baked_seconds(edge) > UNDERGROUND_ACCESS_SECONDS,
                "the walk out to the door is charged on top of the stair"
            );
            assert_eq!(
                run.names[edge.name_id as usize], "W 4 St-Wash Sq",
                "the name its members share"
            );
        }
    }

    fn entrance(
        lng_units: i32,
        lat_units: i32,
        station: u16,
        sides: u8,
        kind: binfmt::EntranceKind,
        entry: bool,
        exit: bool,
    ) -> binfmt::TransitEntrance {
        binfmt::TransitEntrance {
            lng: -73.5 + f64::from(lng_units) * 1e-6,
            lat: 40.25 + f64::from(lat_units) * 1e-6,
            station,
            sides,
            kind,
            entry,
            exit,
        }
    }

    // A split station between an avenue's two pavements, a stair onto each, and one line through it.
    fn split_fixture(entrances: Vec<binfmt::TransitEntrance>) -> binfmt::Transit {
        let station = |lng_units: i32, name: &str, split: bool| binfmt::TransitStation {
            lng: -73.5 + f64::from(lng_units) * 1e-6,
            lat: 40.25 + 150.0 * 1e-6,
            name: name.to_string(),
            complex: 0,
            surface: false,
            split,
        };
        binfmt::Transit {
            stations: vec![
                station(4_000, "Nevins St", true),
                station(8_000, "Atlantic Av", false),
            ],
            entrances,
            routes: vec![binfmt::TransitRoute {
                color: [0, 0, 0],
                text_color: [0xFF, 0xFF, 0xFF],
                short_name: "2".to_string(),
                long_name: "2 line".to_string(),
                id: "gtfs:2".to_string(),
            }],
            patterns: vec![
                binfmt::TransitPattern {
                    lane_id: 1,
                    route_index: 0,
                    direction: 0,
                    stops: vec![1, 0],
                    offsets: vec![0, 300],
                },
                binfmt::TransitPattern {
                    lane_id: 2,
                    route_index: 0,
                    direction: 1,
                    stops: vec![0, 1],
                    offsets: vec![0, 300],
                },
            ],
        }
    }

    // The station nodes one station's name hangs off, in the order they were made.
    fn named_station_nodes(run: &TransitRun, name: &str) -> Vec<u32> {
        let mut nodes: Vec<u32> = run
            .edges
            .iter()
            .filter(|edge| {
                edge.kind == KIND_ACCESS
                    && edge.name_id != UNNAMED
                    && run.names[edge.name_id as usize] == name
            })
            .map(|edge| edge.a)
            .collect();
        nodes.sort_unstable();
        nodes.dedup();
        nodes
    }

    // Those nodes as the (entry, exit) pair of each platform side, side 0 first.
    fn station_sides(run: &TransitRun, name: &str) -> Vec<(u32, u32)> {
        let nodes = named_station_nodes(run, name);
        assert_eq!(nodes.len() % 2, 0, "a station node is one of a pair");
        nodes.chunks(2).map(|pair| (pair[0], pair[1])).collect()
    }

    // The arrival node paired with a boarding node, via the stay-aboard edge.
    fn arrival_of(run: &TransitRun, boarding: u32) -> u32 {
        run.edges
            .iter()
            .find(|edge| {
                edge.b == boarding && edge.kind == KIND_RIDE && edge.flags & RIDE_STAY_ABOARD != 0
            })
            .expect("the platform's stay-aboard edge")
            .a
    }

    fn board_edge_of_lane(run: &TransitRun, lane: u32, stop: u16) -> &V2Edge {
        let (board, _, _, _) = *run
            .built
            .board_table
            .iter()
            .find(|&&(_, lane_id, _, stop_index)| lane_id == lane && stop_index == stop)
            .expect("the lane's board edge");
        &run.edges[board as usize]
    }

    #[test]
    fn a_split_station_boards_and_alights_on_the_side_of_its_own_direction() {
        let run = run_transit_on(
            parallel_pavements(&[0, 300]),
            &split_fixture(vec![
                entrance(4_000, 20, 0, 0b01, binfmt::EntranceKind::Stair, true, true),
                entrance(4_000, 280, 0, 0b10, binfmt::EntranceKind::Stair, true, true),
            ]),
        );

        assert_eq!(run.built.split_stations, 1);
        assert_eq!(run.built.collapsed_stations, 0);
        assert_eq!(
            run.built.entrances, 2,
            "both published stairs found pavement"
        );
        assert_eq!(run.built.fallback_stations, 1, "only the second station");
        let sides = station_sides(&run, "Nevins St");
        assert_eq!(sides.len(), 2, "one pair of nodes per platform side");
        let rows_of = |station: u32, entry: u32| -> Vec<i32> {
            let mut rows: Vec<i32> = doors_from(&run, station, entry)
                .iter()
                .map(|edge| run.node_lat[edge.b as usize])
                .collect();
            rows.sort_unstable();
            rows
        };
        assert_eq!(
            rows_of(sides[0].0, sides[0].0),
            vec![0],
            "side 0 opens onto the near curb"
        );
        assert_eq!(
            rows_of(sides[1].0, sides[1].0),
            vec![300],
            "and side 1 onto the far one, with no edge between the two"
        );

        // The northbound pattern calls at Nevins second and the southbound first.
        for (lane, stop, side) in [(1u32, 1u16, sides[0]), (2, 0, sides[1])] {
            let board = board_edge_of_lane(&run, lane, stop);
            assert_eq!(board.a, side.0, "lane {lane} boards from its side's entry");
            let alight = run
                .edges
                .iter()
                .find(|edge| edge.a == arrival_of(&run, board.b) && edge.kind == KIND_ACCESS)
                .expect("the way off the platform");
            assert_eq!(alight.b, side.1, "and lands on its side's exit");
        }
        let northbound = arrival_of(&run, board_edge_of_lane(&run, 1, 1).b);
        assert!(
            !run.edges.iter().any(|edge| edge.a == northbound
                && edge.kind == KIND_ACCESS
                && (edge.b == sides[1].0 || edge.b == sides[1].1)),
            "a rider off the northbound train cannot leave by the southbound stair"
        );
    }

    // 145 St: one platform's doors all open outwards, so the group stands on the served side.
    #[test]
    fn a_split_side_with_no_way_in_stands_on_the_side_that_has_one() {
        let run = run_transit_on(
            parallel_pavements(&[0, 300]),
            &split_fixture(vec![
                entrance(4_000, 20, 0, 0b01, binfmt::EntranceKind::Stair, true, true),
                entrance(
                    4_000,
                    280,
                    0,
                    0b10,
                    binfmt::EntranceKind::Stair,
                    false,
                    true,
                ),
            ]),
        );

        assert_eq!(run.built.split_stations, 0);
        assert_eq!(run.built.collapsed_stations, 1);
        assert_eq!(
            run.built.fallback_stations, 1,
            "the second station, and no invented doors here"
        );
        let sides = station_sides(&run, "Nevins St");
        assert_eq!(sides.len(), 1, "one pair of nodes, not two");
        let (entry, exit) = sides[0];
        let rows = |station: u32| -> Vec<i32> {
            let mut rows: Vec<i32> = doors_from(&run, station, entry)
                .iter()
                .map(|edge| run.node_lat[edge.b as usize])
                .collect();
            rows.sort_unstable();
            rows
        };
        assert_eq!(rows(entry), vec![0], "the one door that opens inwards");
        assert_eq!(
            rows(exit),
            vec![0, 300],
            "and both of them as ways out, the far platform's included"
        );
        for lane in [1u32, 2] {
            let stop = if lane == 1 { 1 } else { 0 };
            assert_eq!(
                board_edge_of_lane(&run, lane, stop).a,
                entry,
                "both directions board from the one node"
            );
        }
    }

    // With no side enterable, the station takes its own doors after all.
    #[test]
    fn a_station_whose_every_door_opens_outwards_takes_doors_it_can_be_entered_by() {
        let run = run_transit_on(
            parallel_pavements(&[0, 300]),
            &split_fixture(vec![
                entrance(4_000, 20, 0, 0b01, binfmt::EntranceKind::Stair, false, true),
                entrance(
                    4_000,
                    280,
                    0,
                    0b10,
                    binfmt::EntranceKind::Stair,
                    false,
                    true,
                ),
            ]),
        );

        assert_eq!(
            run.built.fallback_stations, 2,
            "this station and the one down the road"
        );
        assert_eq!(run.built.split_stations, 1, "and both sides are served");
        for (entry, _) in station_sides(&run, "Nevins St") {
            let inward = doors_from(&run, entry, entry);
            assert!(!inward.is_empty(), "a way in on every side");
            for door in inward {
                assert_eq!(door.flags, ACCESS_ENTRY_ONLY);
            }
        }
    }

    // A lift beside an exit-only stair must not merge into a two-way lift at the stair's base.
    #[test]
    fn an_exit_only_stair_beside_a_lift_stays_two_doors() {
        let mut transit = split_fixture(vec![
            entrance(4_000, 20, 0, 0b01, binfmt::EntranceKind::Stair, false, true),
            entrance(
                4_000,
                24,
                0,
                0b01,
                binfmt::EntranceKind::Elevator,
                true,
                true,
            ),
        ]);
        transit.stations[0].split = false;
        let run = run_transit_on(parallel_pavements(&[0, 300]), &transit);

        let (entry, exit) = station_sides(&run, "Nevins St")[0];
        let inward = doors_from(&run, entry, entry);
        assert_eq!(inward.len(), 1, "the lift is the only way in");
        assert_eq!(inward[0].flags, ACCESS_ELEVATOR | ACCESS_ENTRY_ONLY);
        let outward = doors_from(&run, exit, entry);
        assert_eq!(outward.len(), 2, "the stair and the lift, both ways out");
        assert_eq!(
            outward[0].b, outward[1].b,
            "on the one walking node between them"
        );
        let mut bases: Vec<u16> = outward
            .iter()
            .map(|edge| baked_seconds(edge) - (edge.length / 1.3).round() as u16)
            .collect();
        bases.sort_unstable();
        assert_eq!(
            bases,
            vec![UNDERGROUND_ACCESS_SECONDS, ELEVATOR_ACCESS_SECONDS],
            "each keeps its own base; the merge never lends the stair's to the lift"
        );
    }

    #[test]
    fn an_exit_only_door_is_one_way_and_an_elevator_costs_the_call() {
        let run = run_transit_on(
            parallel_pavements(&[0, 300]),
            &split_fixture(vec![
                entrance(4_000, 20, 0, 0b11, binfmt::EntranceKind::Stair, false, true),
                entrance(
                    4_000,
                    280,
                    0,
                    0b11,
                    binfmt::EntranceKind::Elevator,
                    true,
                    true,
                ),
            ]),
        );

        let sides = station_sides(&run, "Nevins St");
        assert_eq!(run.built.fallback_stations, 1, "both sides are served");
        for (entry, exit) in sides {
            let outward = doors_from(&run, exit, entry);
            let stair = outward
                .iter()
                .find(|edge| run.node_lat[edge.b as usize] == 0)
                .expect("the stair");
            assert_eq!(
                stair.flags, ACCESS_EXIT_ONLY,
                "a way out of the station and not a way in"
            );
            assert!(
                !doors_from(&run, entry, entry)
                    .iter()
                    .any(|edge| run.node_lat[edge.b as usize] == 0),
                "and it is on no way in"
            );
            let lift = outward
                .iter()
                .find(|edge| run.node_lat[edge.b as usize] == 300)
                .expect("the elevator");
            assert_eq!(lift.flags, ACCESS_ELEVATOR | ACCESS_EXIT_ONLY);
            assert_eq!(
                baked_seconds(lift),
                ELEVATOR_ACCESS_SECONDS + 13,
                "the call and the ride, plus the 17 m walk at 1.3 m/s"
            );
        }
    }

    #[test]
    fn a_complex_stays_one_node_whatever_its_members_say() {
        let mut transit = transfer_fixture();
        transit.stations[0].split = true;
        transit.stations[1].split = true;
        let run = run_transit_on(transfer_graph(), &transit);

        assert_eq!(run.built.split_stations, 0);
        assert_eq!(run.built.stations, 6, "the complex is still one pair");
        assert_eq!(station_sides(&run, "W 4 St-Wash Sq").len(), 1);
    }

    #[test]
    fn an_entrance_opens_onto_the_pavement_under_it_and_not_the_nearest_to_the_station() {
        // The door is cut where the published stair is, not at the station point.
        let mut transit = split_fixture(vec![entrance(
            4_000,
            10,
            0,
            0b11,
            binfmt::EntranceKind::Stair,
            true,
            true,
        )]);
        transit.stations[0].split = false;
        let run = run_transit_on(parallel_pavements(&[0, 300]), &transit);

        assert_eq!(run.built.entrances, 1);
        let (entry, _) = station_sides(&run, "Nevins St")[0];
        let inward = doors_from(&run, entry, entry);
        assert_eq!(
            inward.len(),
            1,
            "one published door, and no fallback beside it"
        );
        assert_eq!(run.node_lat[inward[0].b as usize], 0);
        assert_eq!(run.node_lng[inward[0].b as usize], 4_000);
        assert_eq!(
            inward[0].flags, ACCESS_ENTRY_ONLY,
            "a two-way stair, taken inwards"
        );
    }

    #[test]
    fn a_transfer_inside_a_complex_is_an_alight_and_a_board() {
        let run = run_transit(&transfer_fixture());
        let TransitRun {
            node_lng,
            edges,
            built,
            ..
        } = &run;

        // The A line's second stop and the B line's first: one rider's transfer.
        let platform_of = |lane: u32, stop: u16| -> u32 {
            let (board, _, _, _) = *built
                .board_table
                .iter()
                .find(|&&(_, lane_id, _, stop_index)| lane_id == lane && stop_index == stop)
                .expect("the pattern's board edge");
            edges[board as usize].b
        };
        let arrived = platform_of(1, 1);
        let departing = platform_of(2, 0);
        assert_ne!(arrived, departing);
        assert_eq!(
            (node_lng[arrived as usize], node_lng[departing as usize]),
            (100, 300),
            "each platform stands on the stop its own line calls at"
        );

        let alight = edges
            .iter()
            .find(|edge| edge.a == arrival_of(&run, arrived) && edge.kind == KIND_ACCESS)
            .expect("the way off the arriving platform");
        let board = edges
            .iter()
            .find(|edge| edge.b == departing && edge.kind == KIND_BOARD)
            .expect("the way onto the departing platform");
        let (entry, exit) = station_sides(&run, "W 4 St-Wash Sq")[0];
        assert_eq!(alight.b, exit, "the alight lands on the complex's exit");
        assert_eq!(board.a, entry, "and the next board leaves from its entry");
        assert!(
            edges
                .iter()
                .any(|edge| edge.a == exit && edge.b == entry && edge.kind == KIND_ACCESS),
            "with the change of train between them"
        );
        assert_eq!(
            baked_seconds(alight),
            ALIGHT_SECONDS,
            "and it costs a step off the train, not a walk to the street"
        );
    }

    // The shortest way across a platform must be a ride of at least one stop.
    #[test]
    fn a_platform_is_boarded_at_one_node_and_alighted_from_another() {
        let run = run_transit(&transfer_fixture());
        let boardings: HashSet<u32> = run
            .built
            .board_table
            .iter()
            .map(|&(board, _, _, _)| run.edges[board as usize].b)
            .collect();
        let arrivals: HashSet<u32> = boardings
            .iter()
            .map(|&boarding| arrival_of(&run, boarding))
            .collect();
        assert_eq!(boardings.len(), run.built.board_edges, "one node per board");
        assert_eq!(arrivals.len(), boardings.len(), "and one arrival for each");
        assert!(boardings.is_disjoint(&arrivals));
        assert_eq!(run.built.platform_nodes, boardings.len() + arrivals.len());
        assert_eq!(run.built.stay_aboard_edges, boardings.len());

        for &boarding in &boardings {
            let arrival = arrival_of(&run, boarding);
            assert_eq!(
                (
                    run.node_lng[arrival as usize],
                    run.node_lat[arrival as usize]
                ),
                (
                    run.node_lng[boarding as usize],
                    run.node_lat[boarding as usize]
                ),
                "both nodes stand on the stop the line calls at"
            );
            assert!(
                !run.edges
                    .iter()
                    .any(|edge| edge.kind == KIND_ACCESS && edge.a == boarding),
                "no way off the node a board lands on"
            );
            assert!(
                run.edges
                    .iter()
                    .any(|edge| edge.kind == KIND_ACCESS && edge.a == arrival),
                "and the alight leaves the one a ride lands on"
            );
        }

        for edge in run.edges.iter().filter(|edge| edge.kind == KIND_RIDE) {
            if edge.flags & RIDE_STAY_ABOARD == 0 {
                assert!(
                    boardings.contains(&edge.a) && arrivals.contains(&edge.b),
                    "a ride runs one stop's boarding node to the next stop's arrival node"
                );
            } else {
                assert!(
                    arrivals.contains(&edge.a) && boardings.contains(&edge.b),
                    "and staying aboard runs the arrival onto its own boarding, that way alone"
                );
            }
        }
    }

    fn keyed(source_id: u32, side: u8) -> V2Edge {
        V2Edge {
            a: 0,
            b: 0,
            length: 0.0,
            geom: NO_GEOMETRY,
            cover: 0,
            half_offset: 0,
            name_id: UNNAMED,
            kind: KIND_SIDEWALK,
            side,
            flags: 0,
            source_id,
        }
    }

    fn crossing(a: u32, b: u32, length: f32, mapped: bool) -> V2Edge {
        V2Edge {
            kind: KIND_CROSSING,
            a,
            b,
            length,
            flags: if mapped { GRPH_OSM } else { 0 },
            ..keyed(NO_SOURCE_ID, SIDE_NONE)
        }
    }

    // Three keyed sidewalks and one keyless crossing, with lengths that move any byte-level figure.
    fn key_space_fixture() -> (Vec<V2Edge>, Vec<u8>) {
        let edges = vec![
            V2Edge {
                length: 41.5,
                ..keyed(88, SIDE_NORTH)
            },
            V2Edge {
                length: 12.25,
                ..keyed(88, SIDE_NORTH)
            },
            crossing(0, 1, 9.0, false),
            V2Edge {
                length: 7.5,
                ..keyed(19, SIDE_WEST)
            },
        ];
        let ordinals = assign_ordinals(&edges).unwrap();
        (edges, ordinals)
    }

    #[test]
    fn the_key_space_hash_ignores_what_a_shed_does_not_resolve_through() {
        let (edges, ordinals) = key_space_fixture();
        let before = key_space_hash(&edges, &ordinals);
        // A ulp longer each, the whole macOS/Linux difference, plus a cover byte and a name.
        let moved: Vec<V2Edge> = edges
            .iter()
            .map(|edge| V2Edge {
                length: f32::from_bits(edge.length.to_bits() + 1),
                cover: 7,
                name_id: 3,
                ..*edge
            })
            .collect();
        assert_eq!(key_space_hash(&moved, &ordinals), before);
    }

    #[test]
    fn the_key_space_hash_ignores_the_order_the_keys_come_in() {
        let (edges, ordinals) = key_space_fixture();
        let mut reversed: Vec<V2Edge> = edges.iter().rev().cloned().collect();
        let mut flipped: Vec<u8> = ordinals.iter().rev().copied().collect();
        // The crossing's slot moves with it; the keys themselves are the same three.
        reversed.swap(0, 3);
        flipped.swap(0, 3);
        assert_eq!(
            key_space_hash(&reversed, &flipped),
            key_space_hash(&edges, &ordinals)
        );
    }

    #[test]
    fn the_key_space_hash_fires_when_a_source_splits_differently() {
        let (edges, ordinals) = key_space_fixture();
        // Source 88's north side cut in three instead of two, renaming ordinal 1's stretch.
        let mut split = edges.clone();
        split.push(V2Edge {
            length: 12.25,
            ..keyed(88, SIDE_NORTH)
        });
        let resplit = assign_ordinals(&split).unwrap();
        assert_ne!(
            key_space_hash(&split, &resplit),
            key_space_hash(&edges, &ordinals)
        );
    }

    #[test]
    fn the_key_space_hash_fires_when_an_ordinal_shifts() {
        let (edges, ordinals) = key_space_fixture();
        let mut shifted = ordinals.clone();
        shifted[1] = 2;
        assert_ne!(
            key_space_hash(&edges, &shifted),
            key_space_hash(&edges, &ordinals)
        );
    }

    #[test]
    fn a_mapped_crossing_takes_the_pair_from_a_synthesized_one_however_far_it_doglegs() {
        // Beyond the suppression slack: the mapped crossing is twice the synthesized line.
        let mut edges = vec![crossing(4, 9, 10.9, false), crossing(9, 4, 21.8, true)];
        assert_eq!(collapse_parallel_crossings(&mut edges), 1);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].length, 21.8);
    }

    #[test]
    fn two_mapped_crossings_over_one_pair_leave_the_shorter() {
        // An island drawn as a closed way, cut at two nodes: both ways round it join the same pair.
        let mut edges = vec![
            crossing(4, 9, 28.4, true),
            crossing(1, 2, 12.0, false),
            crossing(9, 4, 8.5, true),
        ];
        assert_eq!(collapse_parallel_crossings(&mut edges), 1);
        assert_eq!(
            edges.iter().map(|edge| edge.length).collect::<Vec<f32>>(),
            vec![12.0, 8.5]
        );
    }

    #[test]
    fn a_crossing_pair_nothing_else_joins_is_left_alone() {
        let mut edges = vec![
            crossing(4, 9, 10.9, false),
            crossing(9, 12, 10.9, false),
            V2Edge {
                a: 4,
                b: 9,
                ..keyed(3, SIDE_NORTH)
            },
        ];
        assert_eq!(collapse_parallel_crossings(&mut edges), 0);
        assert_eq!(edges.len(), 3);
    }

    #[test]
    fn an_edge_from_a_node_back_to_itself_is_no_edge_of_any_kind() {
        let mut edges = vec![
            crossing(9, 9, 0.62, true),
            V2Edge {
                a: 4,
                b: 4,
                length: 0.79,
                kind: KIND_PATH,
                flags: GRPH_OSM,
                ..keyed(NO_SOURCE_ID, SIDE_NONE)
            },
            crossing(4, 9, 10.9, false),
        ];
        let dropped = drop_self_loops(&mut edges);
        assert_eq!(
            dropped
                .iter()
                .map(|edge| (edge.kind, edge.a))
                .collect::<Vec<(u8, u32)>>(),
            vec![(KIND_CROSSING, 9), (KIND_PATH, 4)]
        );
        assert_eq!(edges.len(), 1);
        assert_eq!((edges[0].a, edges[0].b), (4, 9));
    }

    #[test]
    fn an_edge_between_two_nodes_is_left_alone() {
        let mut edges = vec![crossing(4, 9, 10.9, false), crossing(9, 4, 10.9, true)];
        assert!(drop_self_loops(&mut edges).is_empty());
        assert_eq!(edges.len(), 2);
    }

    // The STRT flags byte of an offsetted record, from the four per-side bits.
    fn record(osm_left: bool, osm_right: bool, surveyed_left: bool, surveyed_right: bool) -> u8 {
        u8::from(osm_left) * FLAG_OSM_LEFT
            | u8::from(osm_right) * FLAG_OSM_RIGHT
            | u8::from(surveyed_left) * FLAG_SURVEYED_LEFT
            | u8::from(surveyed_right) * FLAG_SURVEYED_RIGHT
    }

    #[test]
    fn the_gate_keeps_a_side_either_source_vouches_for() {
        // Both sources agree: an ordinary block, two sidewalks.
        assert_eq!(
            gated_sidewalks(record(true, true, true, true)),
            SIDEWALK_LEFT | SIDEWALK_RIGHT
        );
        // Unmapped in OSM but surveyed on both sides, so both survive.
        assert_eq!(
            gated_sidewalks(record(false, false, true, true)),
            SIDEWALK_LEFT | SIDEWALK_RIGHT
        );
        // Missed by the survey but mapped in OSM, so it survives too.
        assert_eq!(
            gated_sidewalks(record(true, false, false, false)),
            SIDEWALK_LEFT
        );
        // A genuinely one-sided street keeps the side it has and loses the side it has not.
        assert_eq!(
            gated_sidewalks(record(false, false, false, true)),
            SIDEWALK_RIGHT
        );
    }

    #[test]
    fn the_gate_leaves_an_alley_no_sidewalks_at_all() {
        // Most alley km: no evidence either side, so the alley is demoted to a centerline path.
        assert_eq!(gated_sidewalks(record(false, false, false, false)), 0);
        // The other flag bits share the byte and must not be read as sides.
        let alley = FLAG_VEHICULAR_ONLY | FLAG_STRUCTURE | (1 << 1);
        assert_eq!(gated_sidewalks(alley), 0);
    }

    #[test]
    fn a_traffic_island_is_part_of_the_crossing_it_chains_through() {
        // An island must read as a crossing, or a divided street's crossing ends mid-road.
        assert_eq!(swlk_kind(SWLK_SIDEWALK), KIND_SIDEWALK);
        assert_eq!(swlk_kind(21), KIND_CROSSING);
        assert_eq!(swlk_kind(22), KIND_CROSSING);
    }

    #[test]
    fn a_mask_read_backwards_swaps_its_sides() {
        assert_eq!(swap_sidewalks(SIDEWALK_LEFT), SIDEWALK_RIGHT);
        assert_eq!(swap_sidewalks(SIDEWALK_RIGHT), SIDEWALK_LEFT);
        assert_eq!(
            swap_sidewalks(SIDEWALK_LEFT | SIDEWALK_RIGHT),
            SIDEWALK_LEFT | SIDEWALK_RIGHT
        );
        assert_eq!(swap_sidewalks(0), 0);
    }

    #[test]
    fn a_chain_contracts_only_where_the_surviving_sides_line_up() {
        // The first arrives at node 1 and the second departs, so their masks read the same way round.
        let block = |a: u32, b: u32, sidewalks: u8, paved: u8| Edge {
            a,
            b,
            poly_x: vec![0, 1],
            poly_y: vec![0, 0],
            length: 1.0,
            cover_left: 0,
            cover_right: 0,
            offset: 40,
            flags: 0,
            name_id: 0,
            osm: false,
            source_id: 1,
            kind: KIND_SIDEWALK,
            side: SIDE_NONE,
            sidewalks,
            paved,
            curb_a: false,
            curb_b: false,
        };
        let north_only = |a: u32, b: u32, sidewalks: u8| block(a, b, sidewalks, sidewalks);
        let incidence = vec![vec![0u32], vec![0u32, 1u32], vec![1u32]];
        let agreeing = vec![
            north_only(0, 1, SIDEWALK_LEFT),
            north_only(1, 2, SIDEWALK_LEFT),
        ];
        assert!(contractible(&agreeing, &incidence, 1));
        // The next block has pavement on the other side only: a joint, not a shape joint.
        let differing = vec![
            north_only(0, 1, SIDEWALK_LEFT),
            north_only(1, 2, SIDEWALK_RIGHT),
        ];
        assert!(!contractible(&differing, &incidence, 1));
        // The second block digitized the other way round, so the masks must mirror.
        let mirrored = vec![
            north_only(0, 1, SIDEWALK_LEFT),
            north_only(2, 1, SIDEWALK_RIGHT),
        ];
        assert!(contractible(&mirrored, &incidence, 1));
        // Derived masks agree but paved ones don't; merging would place a crossing to nowhere.
        let paved_only = vec![block(0, 1, 0, SIDEWALK_LEFT), block(1, 2, 0, 0)];
        assert!(!contractible(&paved_only, &incidence, 1));
        // And it mirrors like the derived mask does.
        let paved_mirrored = vec![
            block(0, 1, 0, SIDEWALK_LEFT),
            block(2, 1, 0, SIDEWALK_RIGHT),
        ];
        assert!(contractible(&paved_mirrored, &incidence, 1));
    }

    #[test]
    fn a_street_is_cut_where_osm_takes_over_its_side() {
        // 100 m of street with OSM owning the first 40 m of the left side.
        let street = ProtoEdge {
            poly_x: vec![0, 100],
            poly_y: vec![0, 0],
            length: 100.0,
            cover_left: 3,
            cover_right: 4,
            offset: 40,
            flags: 0,
            name_id: 7,
            osm: false,
            source_id: 11,
            kind: KIND_SIDEWALK,
            side: SIDE_NONE,
            sidewalks: SIDEWALK_LEFT | SIDEWALK_RIGHT,
            paved: SIDEWALK_LEFT | SIDEWALK_RIGHT,
            curb_a: false,
            curb_b: false,
        };
        let covered = [vec![(0.0, 40.0)], Vec::new()];
        let pieces = trim_derived(street, &covered, (1.0, 1.0));
        let shape: Vec<(Vec<i32>, u8, u32)> = pieces
            .iter()
            .map(|piece| (piece.poly_x.clone(), piece.sidewalks, piece.source_id))
            .collect();
        assert_eq!(
            shape,
            vec![
                (vec![0, 40], SIDEWALK_RIGHT, 11),
                (vec![40, 100], SIDEWALK_LEFT | SIDEWALK_RIGHT, 11),
            ]
        );
        // Both keep the whole pavement mask, and their lengths still sum to it.
        assert!(
            pieces
                .iter()
                .all(|piece| piece.paved == SIDEWALK_LEFT | SIDEWALK_RIGHT)
        );
        assert_eq!(pieces.iter().map(|piece| piece.length).sum::<f32>(), 100.0);
    }

    #[test]
    fn a_street_osm_owns_outright_keeps_one_piece_and_no_offset() {
        let street = ProtoEdge {
            poly_x: vec![0, 50, 100],
            poly_y: vec![0, 0, 0],
            length: 100.0,
            cover_left: 0,
            cover_right: 0,
            offset: 40,
            flags: 0,
            name_id: 7,
            osm: false,
            source_id: 11,
            kind: KIND_SIDEWALK,
            side: SIDE_NONE,
            sidewalks: SIDEWALK_LEFT | SIDEWALK_RIGHT,
            paved: SIDEWALK_LEFT | SIDEWALK_RIGHT,
            curb_a: false,
            curb_b: false,
        };
        let covered = [vec![(0.0, 100.0)], vec![(0.0, 100.0)]];
        let pieces = trim_derived(street, &covered, (1.0, 1.0));
        assert_eq!(pieces.len(), 1);
        assert_eq!(pieces[0].sidewalks, 0);
        assert_eq!(pieces[0].poly_x, vec![0, 50, 100], "uncut");
    }

    #[test]
    fn ordinals_count_per_source_and_side() {
        let edges = vec![
            keyed(7, SIDE_NORTH),
            keyed(7, SIDE_SOUTH),
            keyed(NO_SOURCE_ID, SIDE_NONE),
            keyed(7, SIDE_NORTH),
            keyed(9, SIDE_NORTH),
        ];
        let ordinals = assign_ordinals(&edges).expect("ordinals");
        assert_eq!(ordinals, vec![0, 0, 0, 1, 0]);
    }

    #[test]
    fn an_ordinal_past_the_byte_is_an_error() {
        let edges: Vec<V2Edge> = (0..=ORDINALS).map(|_| keyed(7, SIDE_NORTH)).collect();
        let message = assign_ordinals(&edges).expect_err("overflow").to_string();
        assert!(message.contains("source id 7"), "{message}");
    }

    #[test]
    fn writes_per_bin_shade_files() {
        let dir = std::env::temp_dir().join(format!("tiler-shade-test-{}", std::process::id()));
        let positions = vec![
            shade::BinPosition {
                season: 0,
                hour_angle: -45.0,
                elevation: 10.0,
                azimuth: 100.0,
            },
            shade::BinPosition {
                season: 2,
                hour_angle: 15.0,
                elevation: 20.0,
                azimuth: 200.0,
            },
        ];
        let edge_count = 3;
        // One (buildings, trees) row pair per bin, three edges each.
        let rows = vec![
            (vec![1u8, 2, 3], vec![10u8, 20, 30]),
            (vec![4u8, 5, 6], vec![40u8, 50, 60]),
        ];
        write_shade(&dir, edge_count, &positions, &rows).expect("write");

        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join("bins.json")).expect("bins.json")).unwrap();
        assert_eq!(manifest["edgeCount"], 3);
        assert_eq!(manifest["bins"].as_array().unwrap().len(), 2);
        assert_eq!(manifest["bins"][1]["index"], 1);
        assert_eq!(manifest["bins"][1]["azimuth"], 200.0);
        assert_eq!(manifest["bins"][1]["season"], 2);
        assert_eq!(manifest["bins"][1]["hourAngle"], 15.0);

        let bin1 = fs::read(dir.join("1.bin")).expect("1.bin");
        assert_eq!(&bin1[0..4], b"SHDB");
        assert_eq!(u16::from_le_bytes([bin1[4], bin1[5]]), 2);
        assert_eq!(
            u32::from_le_bytes([bin1[8], bin1[9], bin1[10], bin1[11]]),
            3
        );
        assert_eq!(bin1.len(), 12 + 2 * 3);
        assert_eq!(&bin1[12..15], [4, 5, 6]);
        assert_eq!(&bin1[15..18], [40, 50, 60]);

        fs::remove_dir_all(&dir).expect("cleanup");
    }

    /// One edge for the island-drop tests: nothing but its ends, its provenance and its kind matter.
    fn island_edge(a: u32, b: u32, osm: bool, kind: u8, source_id: u32) -> Edge {
        Edge {
            a,
            b,
            poly_x: vec![0, 1],
            poly_y: vec![0, 1],
            length: 1.0,
            cover_left: 0,
            cover_right: 0,
            offset: 0,
            flags: 0,
            name_id: UNNAMED,
            osm,
            source_id,
            kind,
            side: SIDE_NONE,
            sidewalks: 0,
            paved: 0,
            curb_a: false,
            curb_b: false,
        }
    }

    #[test]
    fn a_way_is_stranded_only_when_its_whole_component_goes() {
        // 0-1: a CSCL street with OSM way 10 at node 1; 3-4: an isolated OSM net (ways 20, 21).
        let edges = vec![
            island_edge(0, 1, false, KIND_SIDEWALK, 1),
            island_edge(1, 2, true, KIND_PATH, 10),
            island_edge(3, 4, true, KIND_PATH, 20),
            island_edge(4, 5, true, KIND_PATH, 21),
        ];
        let keep_edge = vec![true, true, false, false];
        let ways = stranded_osm_paths(&edges, &edges, &keep_edge, 6);
        assert_eq!(ways, vec![20, 21]);
    }

    #[test]
    fn a_way_a_surviving_chain_still_carries_is_not_stranded() {
        // A contracted chain names only its least source id, so way 31 must be judged off the parts.
        let parts = vec![
            island_edge(0, 1, false, KIND_SIDEWALK, 1),
            island_edge(1, 2, true, KIND_PATH, 30),
            island_edge(2, 3, true, KIND_PATH, 31),
        ];
        let contracted = vec![
            island_edge(0, 1, false, KIND_SIDEWALK, 1),
            island_edge(1, 3, true, KIND_PATH, 30),
        ];
        let ways = stranded_osm_paths(&parts, &contracted, &vec![true, true], 4);
        assert!(ways.is_empty(), "{ways:?}");
    }

    fn cut_edge(a: u32, b: u32, poly: &[(i32, i32)], pathlike: bool, structure: bool) -> Edge {
        let poly_x: Vec<i32> = poly.iter().map(|point| point.0).collect();
        let poly_y: Vec<i32> = poly.iter().map(|point| point.1).collect();
        let length = conflate::polyline_meters(&poly_x, &poly_y, (1.0, 1.0)) as f32;
        Edge {
            a,
            b,
            poly_x,
            poly_y,
            length,
            cover_left: 0,
            cover_right: 0,
            offset: 40, // a 4 m half-offset, so the corners land 4 m out
            flags: u8::from(pathlike) * GRPH_PATHLIKE | u8::from(structure) * GRPH_STRUCTURE,
            name_id: UNNAMED,
            osm: pathlike,
            source_id: NO_SOURCE_ID,
            kind: KIND_SIDEWALK,
            side: SIDE_NONE,
            sidewalks: SIDEWALK_LEFT | SIDEWALK_RIGHT,
            paved: SIDEWALK_LEFT | SIDEWALK_RIGHT,
            curb_a: false,
            curb_b: false,
        }
    }

    /// A bend node with corners at (4, -4) and (-4, 4) and the given way; returns cuts and their x's.
    fn cut_fixture(
        way: &[(i32, i32)],
        way_structure: bool,
        street_structure: bool,
    ) -> (usize, Vec<i32>) {
        let mut merged_x = vec![0, 100, 0, way[0].0, way[way.len() - 1].0];
        let mut merged_y = vec![0, 0, -100, way[0].1, way[way.len() - 1].1];
        let mut edges = vec![
            cut_edge(0, 1, &[(0, 0), (100, 0)], false, street_structure),
            cut_edge(0, 2, &[(0, 0), (0, -100)], false, false),
            cut_edge(3, 4, way, true, way_structure),
        ];
        let cuts = cut_sidewalks_at_corners(&mut edges, &mut merged_x, &mut merged_y, 1.0, 1.0);
        let mut at: Vec<i32> = edges
            .iter()
            .filter(|edge| edge.osm)
            .map(|edge| edge.poly_x[0])
            .filter(|&x| x != way[0].0)
            .collect();
        at.sort_unstable();
        (cuts, at)
    }

    #[test]
    fn a_corner_cuts_the_unbroken_sidewalk_it_stands_on_and_only_that_corner() {
        // Both corners are within reach of the nodeless way, so only the wedge guard yields one cut.
        let (cuts, at) = cut_fixture(&[(-200, 4), (200, 4)], false, false);
        assert_eq!(cuts, 1);
        assert_eq!(
            at,
            vec![-4],
            "the north-west corner's projection, not the south-east one's"
        );
    }

    #[test]
    fn a_corner_beside_the_way_s_own_node_takes_no_cut() {
        // The way's own ends are within seam reach, so no cut.
        assert_eq!(cut_fixture(&[(-10, 4), (10, 4)], false, false), (0, vec![]));
    }

    #[test]
    fn a_corner_does_not_reach_past_the_seam_radius() {
        // 16 m out the corner couldn't resolve onto the cut anyway.
        assert_eq!(
            cut_fixture(&[(-200, 20), (200, 20)], false, false),
            (0, vec![])
        );
    }

    #[test]
    fn grade_separation_is_never_cut() {
        // A deck shares no ground with the road under it, from either side of the pairing.
        assert_eq!(
            cut_fixture(&[(-200, 4), (200, 4)], true, false),
            (0, vec![])
        );
        assert_eq!(
            cut_fixture(&[(-200, 4), (200, 4)], false, true),
            (0, vec![])
        );
    }

    /// Every field holds a distinct value, so two same-typed fields swapped in decode would fail.
    #[test]
    fn a_base_survives_the_encoding_its_cache_entry_is() {
        let edges = vec![
            V2Edge {
                a: 0,
                b: 1,
                length: 41.5,
                geom: 5,
                cover: 3,
                half_offset: 4,
                name_id: 2,
                kind: 6,
                side: 7,
                flags: 9,
                source_id: 88,
            },
            V2Edge {
                a: 2,
                b: 1,
                length: 12.25,
                geom: 13,
                cover: 15,
                half_offset: 16,
                name_id: 14,
                kind: 17,
                side: 18,
                flags: 19,
                source_id: 99,
            },
        ];
        let (csr, adjacency) = adjacency_of(3, &edges);
        let base = Base {
            origin_lng: -73.5,
            origin_lat: 40.25,
            scale: 0.000_012_5,
            node_lng: vec![11, 12, 13],
            node_lat: vec![21, 22, 23],
            node_component: vec![31, 32, 33],
            component_count: 7,
            edges,
            ordinals: vec![10, 20],
            key_hash: 0xfeed_face_dead_beef,
            geometry_polys: vec![(vec![1, 2], vec![3, 4]), (vec![5], vec![6])],
            names: vec![
                String::new(),
                "Main Street".to_owned(),
                "Broadway".to_owned(),
            ],
            ferry_side_table: vec![(7, 2, 3)],
            transit_routes: vec![TransitRouteRecord {
                color: [51, 52, 53],
                text_color: [54, 55, 56],
                short_name: 57,
                long_name: 58,
                id_name: 59,
            }],
            transit_board_table: vec![(61, 62, 63, 4)],
            transit_ride_table: vec![(64, 65)],
            transit_door_table: vec![(66, 2, SIDE_EAST)],
            stranded_ways: vec![41, 42],
            stats: serde_json::json!({"edges": 2, "nodes": 3}),
            csr,
            adjacency,
        };

        let decoded = Base::decode(&base.encode().expect("the bytes")).expect("a base");

        assert_eq!(decoded, base);
    }
}

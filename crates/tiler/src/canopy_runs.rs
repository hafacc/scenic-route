//! CRUN: where each edge is under canopy, and which of those runs the map draws as a stretch.

use crate::binfmt::{Coord, write_varint};
use crate::geometry::METERS_PER_DEGREE_LAT;
use crate::sampling::Runs;

pub const VERSION: u16 = 2;
pub const HEADER_BYTES: usize = 36;

/// Runs closer than this along the walk are one stretch, through a node as well as along an edge.
pub const MERGE_GAP_METERS: f64 = 4.0;
/// A stretch shorter than this is a single small crown, which the map leaves out.
pub const MIN_STRETCH_METERS: f64 = 3.0;
/// Two edges within this of a straight line through their node are one path going on, not a corner.
pub const STRAIGHT_DEGREES: f64 = 60.0;

const DECIMETERS: f64 = 10.0;
const DRAWN: u64 = 0x1; // the run is part of a stretch long enough to draw
const JOINED: u64 = 0x2; // the gap before the run is drawn too; on an edge's first run, back to its node
const FLAG_BITS: u32 = 2;

/// What the build log says of one city's artifact.
pub struct Stats {
    pub edges: usize,
    pub runs: usize,
    pub covered_meters: f64,
    pub stretches: usize,
    pub drawn_meters: f64,
    /// Cover left undrawn though it runs unbroken for a stretch's length: `(stretches, meters)`.
    pub undrawn: (usize, f64),
    /// The same, for runs of ten meters and more.
    pub undrawn_long: usize,
}

/// What the stretches need of an edge: its two nodes, and which way it leaves each.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EdgeEnds {
    pub a: u32,
    pub b: u32,
    /// Radians counterclockwise from east, heading out of `a` along the edge.
    pub heading_a: f64,
    /// The same out of `b`, back along the edge.
    pub heading_b: f64,
}

/// An edge's ends off the first segment of any length at each; a point or no polyline heads nowhere.
pub fn edge_ends(a: u32, b: u32, poly: &[Coord], meters_per_degree_lng: f64) -> EdgeEnds {
    let heading = |from: &Coord, mut onward: std::slice::Iter<Coord>| -> f64 {
        onward
            .find_map(|to| {
                let east = (to.lng - from.lng) * meters_per_degree_lng;
                let north = (to.lat - from.lat) * METERS_PER_DEGREE_LAT;
                (east != 0.0 || north != 0.0).then(|| north.atan2(east))
            })
            .unwrap_or(0.0)
    };
    let (heading_a, heading_b) = match (poly.first(), poly.last()) {
        (Some(first), Some(last)) => {
            let mut back: Vec<Coord> = poly.to_vec();
            back.reverse();
            (
                heading(first, poly[1..].iter()),
                heading(last, back[1..].iter()),
            )
        }
        _ => (0.0, 0.0),
    };
    EdgeEnds {
        a,
        b,
        heading_a,
        heading_b,
    }
}

/// FNV-1a over the edges' node pairs as words, in order: the edge order a record's index stands on.
pub fn edge_order_hash(edges: &[EdgeEnds]) -> u32 {
    let mut hash = 0x811c_9dc5u32;
    for edge in edges {
        hash = (hash ^ edge.a).wrapping_mul(0x0100_0193);
        hash = (hash ^ edge.b).wrapping_mul(0x0100_0193);
    }
    hash
}

/// Whether `bytes` is this version's whole file for exactly this graph; a cached one that is not is resampled.
pub fn matches(bytes: &[u8], edges: &[EdgeEnds], key_hash: u64) -> bool {
    bytes.len() >= HEADER_BYTES
        && &bytes[0..4] == b"CRUN"
        && bytes[4..6] == VERSION.to_le_bytes()
        && bytes[6..8] == (HEADER_BYTES as u16).to_le_bytes()
        && bytes[8..12] == (edges.len() as u32).to_le_bytes()
        && bytes[16..24] == key_hash.to_le_bytes()
        && bytes[32..36] == edge_order_hash(edges).to_le_bytes()
        && stretches(bytes).is_some()
}

/// None past the end of `bytes`, so a file cut short reads as bad and not as a panic.
fn read_varint(bytes: &[u8], at: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    let mut shift = 0;
    loop {
        let byte = *bytes.get(*at)?;
        *at += 1;
        value |= u64::from(byte & 0x7f).checked_shl(shift)?;
        shift += 7;
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
}

/// An edge's id and its drawn stretches, each from one fraction of its length to another.
pub type EdgeStretches = (u32, Vec<(f64, f64)>);

/// The drawn stretches of a file `encode` wrote, per covered edge, as fractions of the edge.
/// None unless the records are whole, in order, inside their edges, and fill the file exactly.
pub fn stretches(bytes: &[u8]) -> Option<Vec<EdgeStretches>> {
    let word = |at: usize| -> Option<u32> {
        Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
    };
    let (edge_count, covered, run_count) = (word(8)?, word(12)?, word(24)?);
    let mut at = HEADER_BYTES;
    let mut edge = 0u64;
    let mut runs = 0u64;
    let mut out = Vec::new();
    for record in 0..covered {
        let delta = read_varint(bytes, &mut at)?;
        edge = edge.checked_add(delta)?;
        if edge >= u64::from(edge_count) || (record > 0 && delta == 0) {
            return None;
        }
        let samples = read_varint(bytes, &mut at)?;
        let packed = read_varint(bytes, &mut at)?;
        let (count, tail) = (packed >> 1, packed & 1 != 0);
        if samples == 0 || count == 0 {
            return None;
        }
        runs += count;
        let mut drawn: Vec<(f64, f64)> = Vec::new();
        let mut open = false; // whether the last stretch pushed is still being run on
        let mut end = 0u64;
        for run in 0..count {
            let start = end.checked_add(read_varint(bytes, &mut at)?)?;
            let flagged = read_varint(bytes, &mut at)?;
            end = start.checked_add(flagged >> FLAG_BITS)?;
            if end > samples || end == start {
                return None;
            }
            let joined = flagged & JOINED != 0;
            if flagged & DRAWN == 0 {
                open = false;
            } else if open && joined {
                drawn.last_mut()?.1 = end as f64 / samples as f64;
            } else {
                let from = if run == 0 && joined { 0 } else { start };
                drawn.push((from as f64 / samples as f64, end as f64 / samples as f64));
                open = true;
            }
        }
        if let (true, true, Some(last)) = (open, tail, drawn.last_mut()) {
            last.1 = 1.0;
        }
        if !drawn.is_empty() {
            out.push((edge as u32, drawn));
        }
    }
    (at == bytes.len() && runs == u64::from(run_count)).then_some(out)
}

fn find(parent: &mut [u32], start: u32) -> u32 {
    let mut root = start;
    while parent[root as usize] != root {
        root = parent[root as usize];
    }
    let mut at = start;
    while parent[at as usize] != root {
        let next = parent[at as usize];
        parent[at as usize] = root;
        at = next;
    }
    root
}

fn union(parent: &mut [u32], left: u32, right: u32) {
    let (left, right) = (find(parent, left), find(parent, right));
    if left != right {
        parent[right as usize] = left;
    }
}

/// One edge's end that is close enough to its node to be joined through it.
struct End {
    node: u32,
    edge: u32,
    tail: bool,
    run: u32,
    gap: f64,
    /// The run its piece is known by: the piece is the runs of one edge joined across short gaps.
    piece: u32,
    heading: f64,
}

/// The artifact for `runs` over a graph of `edges` in this order, keyed to `key_hash`.
pub fn encode(edges: &[EdgeEnds], runs: &[Runs], key_hash: u64) -> (Vec<u8>, Stats) {
    // Run ids count through the edges in order; `first[edge]` is its first run's.
    let mut first = Vec::with_capacity(runs.len() + 1);
    let mut total = 0u32;
    for edge in runs {
        first.push(total);
        total += edge.runs.len() as u32;
    }
    first.push(total);

    let mut parent: Vec<u32> = (0..total).collect();
    let mut meters = vec![0.0f64; total as usize]; // each run's own length plus the gaps it bridges
    let mut joined = vec![false; total as usize];
    let mut tail_joined = vec![false; runs.len()];
    let mut piece_meters = vec![0.0f64; total as usize];
    let mut through = vec![false; total as usize];
    let mut ends: Vec<End> = Vec::new();
    let mut covered_meters = 0.0;
    for (edge, sampled) in runs.iter().enumerate() {
        let Some(&(last_start, last_count)) = sampled.runs.last() else {
            continue;
        };
        let step = sampled.meters / f64::from(sampled.samples);
        let base = first[edge];
        let mut previous_end = 0u32;
        for (index, &(start, count)) in sampled.runs.iter().enumerate() {
            let run = base + index as u32;
            meters[run as usize] = f64::from(count) * step;
            covered_meters += f64::from(count) * step;
            let gap = f64::from(start - previous_end) * step;
            if index > 0 && gap < MERGE_GAP_METERS {
                joined[run as usize] = true;
                meters[run as usize] += gap;
                union(&mut parent, run - 1, run);
            }
            previous_end = start + count;
        }
        let last = first[edge + 1] - 1;
        let (head_piece, tail_piece) = (find(&mut parent, base), find(&mut parent, last));
        for run in base..=last {
            let piece = find(&mut parent, run);
            piece_meters[piece as usize] += meters[run as usize];
        }
        let ends_of = edges[edge];
        let lead = f64::from(sampled.runs[0].0) * step;
        let trail = f64::from(sampled.samples - last_start - last_count) * step;
        // One piece from node to node is a link in a chain, however short the edge.
        through[head_piece as usize] = head_piece == tail_piece && lead == 0.0 && trail == 0.0;
        if lead < MERGE_GAP_METERS {
            ends.push(End {
                node: ends_of.a,
                edge: edge as u32,
                tail: false,
                run: base,
                gap: lead,
                piece: head_piece,
                heading: ends_of.heading_a,
            });
        }
        if trail < MERGE_GAP_METERS {
            ends.push(End {
                node: ends_of.b,
                edge: edge as u32,
                tail: true,
                run: last,
                gap: trail,
                piece: tail_piece,
                heading: ends_of.heading_b,
            });
        }
    }
    // The pieces as they stand before any node joins them, for the tally of what goes undrawn.
    let pieces = parent.clone();

    // Every pair of ends of two edges at a node whose gaps sum under the limit: `(left, right, straight)`.
    ends.sort_by_key(|end| (end.node, end.edge, end.tail));
    let straight_cosine = (180.0 - STRAIGHT_DEGREES).to_radians().cos();
    let mut near: Vec<(usize, usize, bool)> = Vec::new();
    let mut from = 0;
    while from < ends.len() {
        let mut to = from + 1;
        while to < ends.len() && ends[to].node == ends[from].node {
            to += 1;
        }
        for left in from..to {
            for right in left + 1..to {
                // An edge is never joined to itself: a loop's two ends are one piece already or none.
                if ends[left].edge != ends[right].edge
                    && ends[left].gap + ends[right].gap < MERGE_GAP_METERS
                {
                    let turn = (ends[left].heading - ends[right].heading).cos();
                    near.push((left, right, turn <= straight_cosine));
                }
            }
        }
        from = to;
    }

    // Straight on, cover joins whatever its length. Round a corner only a piece long enough to draw
    // alone joins, or a short one that runs node to node between two others: anything else is a barb.
    let short = |piece: u32| piece_meters[piece as usize] < MIN_STRETCH_METERS;
    let mut turns: Vec<bool> = (0..total)
        .map(|piece| !short(piece) || through[piece as usize])
        .collect();
    let holds = |turns: &[bool], &(left, right, straight): &(usize, usize, bool)| {
        straight || (turns[ends[left].piece as usize] && turns[ends[right].piece as usize])
    };
    // Dropping a short link can strand the next one along, so this runs until none goes.
    loop {
        // Per piece and end: an edge holding it there, and a second one if any differs; `u32::MAX` for none.
        let mut held = vec![[[u32::MAX; 2]; 2]; total as usize];
        for pair in near.iter().filter(|pair| holds(&turns, pair)) {
            for (end, other) in [(pair.0, pair.1), (pair.1, pair.0)] {
                let holders = &mut held[ends[end].piece as usize][usize::from(ends[end].tail)];
                let holder = ends[other].edge;
                if holders[0] == u32::MAX {
                    holders[0] = holder;
                } else if holders[0] != holder {
                    holders[1] = holder;
                }
            }
        }
        let mut dropped = false;
        for piece in 0..total {
            let [head, tail] = held[piece as usize];
            // Held at one end only it is a stub; held at both by the one edge alone it is that edge's twin.
            let link = head[0] != u32::MAX
                && tail[0] != u32::MAX
                && (head[0] != tail[0] || head[1] != u32::MAX || tail[1] != u32::MAX);
            if turns[piece as usize] && short(piece) && !link {
                turns[piece as usize] = false;
                dropped = true;
            }
        }
        if !dropped {
            break;
        }
    }
    let mut reached = vec![false; ends.len()];
    for pair in near.iter().filter(|pair| holds(&turns, pair)) {
        reached[pair.0] = true;
        reached[pair.1] = true;
        union(&mut parent, ends[pair.0].run, ends[pair.1].run);
    }
    for (end, _) in ends.iter().zip(&reached).filter(|(_, reached)| **reached) {
        meters[end.run as usize] += end.gap;
        if end.tail {
            tail_joined[end.edge as usize] = true;
        } else {
            joined[end.run as usize] = true;
        }
    }

    let mut stretch_meters = vec![0.0f64; total as usize];
    for run in 0..total {
        let root = find(&mut parent, run);
        stretch_meters[root as usize] += meters[run as usize];
    }
    let mut stretches = 0;
    let mut drawn_meters = 0.0;
    for run in 0..total {
        let length = stretch_meters[run as usize];
        if parent[run as usize] == run && length >= MIN_STRETCH_METERS {
            stretches += 1;
            drawn_meters += length;
        }
    }
    let drawn: Vec<bool> = (0..total)
        .map(|run| stretch_meters[find(&mut parent, run) as usize] >= MIN_STRETCH_METERS)
        .collect();

    // What the plain merge would have drawn and this does not: undrawn pieces, joined through any node.
    let mut plain = pieces;
    for &(left, right, _) in &near {
        if !drawn[ends[left].run as usize] && !drawn[ends[right].run as usize] {
            union(&mut plain, ends[left].run, ends[right].run);
        }
    }
    let mut plain_meters = vec![0.0f64; total as usize];
    for run in (0..total).filter(|run| !drawn[*run as usize]) {
        let root = find(&mut plain, run);
        plain_meters[root as usize] += meters[run as usize];
    }
    let mut undrawn = (0usize, 0.0f64);
    let mut undrawn_long = 0usize;
    for length in plain_meters {
        if length >= MIN_STRETCH_METERS {
            undrawn.0 += 1;
            undrawn.1 += length;
        }
        if length >= 10.0 {
            undrawn_long += 1;
        }
    }

    let mut bytes = Vec::with_capacity(HEADER_BYTES + 3 * total as usize);
    let mut covered_edges = 0u32;
    bytes.resize(HEADER_BYTES, 0);
    let mut previous_edge = 0u64;
    for (edge, sampled) in runs.iter().enumerate() {
        if sampled.runs.is_empty() {
            continue;
        }
        covered_edges += 1;
        write_varint(&mut bytes, edge as u64 - previous_edge);
        previous_edge = edge as u64;
        write_varint(&mut bytes, u64::from(sampled.samples));
        write_varint(
            &mut bytes,
            (sampled.runs.len() as u64) << 1 | u64::from(tail_joined[edge]),
        );
        let mut previous_end = 0u32;
        for (index, &(start, count)) in sampled.runs.iter().enumerate() {
            let run = first[edge] + index as u32;
            let mut packed = u64::from(count) << FLAG_BITS;
            if drawn[run as usize] {
                packed |= DRAWN;
            }
            if joined[run as usize] {
                packed |= JOINED;
            }
            write_varint(&mut bytes, u64::from(start - previous_end));
            write_varint(&mut bytes, packed);
            previous_end = start + count;
        }
    }
    bytes[0..4].copy_from_slice(b"CRUN");
    bytes[4..6].copy_from_slice(&VERSION.to_le_bytes());
    bytes[6..8].copy_from_slice(&(HEADER_BYTES as u16).to_le_bytes());
    bytes[8..12].copy_from_slice(&(runs.len() as u32).to_le_bytes());
    bytes[12..16].copy_from_slice(&covered_edges.to_le_bytes());
    bytes[16..24].copy_from_slice(&key_hash.to_le_bytes());
    bytes[24..28].copy_from_slice(&total.to_le_bytes());
    bytes[28..30].copy_from_slice(&((MERGE_GAP_METERS * DECIMETERS) as u16).to_le_bytes());
    bytes[30..32].copy_from_slice(&((MIN_STRETCH_METERS * DECIMETERS) as u16).to_le_bytes());
    bytes[32..36].copy_from_slice(&edge_order_hash(edges).to_le_bytes());

    let stats = Stats {
        edges: covered_edges as usize,
        runs: total as usize,
        covered_meters,
        stretches,
        drawn_meters,
        undrawn,
        undrawn_long,
    };
    (bytes, stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binfmt::Polygon;
    use crate::direct_canopy::{byte_of, sampled};
    use crate::geometry::{PolygonGrid, flatten};

    const LAT: f64 = 40.7;

    fn meters_per_degree_lng() -> f64 {
        METERS_PER_DEGREE_LAT * LAT.to_radians().cos()
    }

    /// A point in meters from a reference in New York, so tests exercise the real cos(lat) scaling.
    fn at(east_meters: f64, north_meters: f64) -> Coord {
        Coord {
            lng: -74.0 + east_meters / meters_per_degree_lng(),
            lat: LAT + north_meters / METERS_PER_DEGREE_LAT,
        }
    }

    /// A crown as an axis-aligned ring in meters, corners `(west, south)` to `(east, north)`.
    fn crown(west: f64, south: f64, east: f64, north: f64) -> Polygon {
        vec![vec![
            at(west, south),
            at(east, south),
            at(east, north),
            at(west, north),
        ]]
    }

    /// A crown over the walk along the reference latitude from `west` to `east` meters.
    fn over(west: f64, east: f64) -> Polygon {
        crown(west, -5.0, east, 5.0)
    }

    fn ends(nodes: &[(u32, u32)], polys: &[Vec<Coord>]) -> Vec<EdgeEnds> {
        nodes
            .iter()
            .zip(polys)
            .map(|(&(a, b), poly)| edge_ends(a, b, poly, meters_per_degree_lng()))
            .collect()
    }

    /// Edges as node pairs and polylines in meters, encoded under `crowns` and read back.
    fn drawn_over(
        nodes: &[(u32, u32)],
        lines: &[&[(f64, f64)]],
        crowns: &[Polygon],
    ) -> (Vec<Edge>, Stats) {
        let polys: Vec<Vec<Coord>> = lines
            .iter()
            .map(|line| line.iter().map(|&(east, north)| at(east, north)).collect())
            .collect();
        let (bytes, stats) = encode(&ends(nodes, &polys), &runs_of(&polys, crowns), 7);
        (decode(&bytes), stats)
    }

    fn runs_of(polys: &[Vec<Coord>], crowns: &[Polygon]) -> Vec<Runs> {
        let set = flatten(crowns);
        let grid = PolygonGrid::new(&set);
        sampled(polys, &set, &grid, meters_per_degree_lng())
    }

    #[derive(Debug, PartialEq)]
    struct Run {
        start: u32,
        count: u32,
        joined: bool,
        drawn: bool,
    }

    #[derive(Debug, PartialEq)]
    struct Edge {
        edge: u32,
        samples: u32,
        tail_joined: bool,
        runs: Vec<Run>,
    }

    fn varint(bytes: &[u8], at: &mut usize) -> u64 {
        let mut value = 0u64;
        let mut shift = 0;
        loop {
            let byte = bytes[*at];
            *at += 1;
            value |= u64::from(byte & 0x7f) << shift;
            shift += 7;
            if byte & 0x80 == 0 {
                return value;
            }
        }
    }

    /// A reader of the layout scripts/README.md gives, so a change to it fails here first.
    fn decode(bytes: &[u8]) -> Vec<Edge> {
        assert_eq!(&bytes[0..4], b"CRUN");
        assert_eq!(u16::from_le_bytes([bytes[4], bytes[5]]), VERSION);
        let mut at = usize::from(u16::from_le_bytes([bytes[6], bytes[7]]));
        let count = u32::from_le_bytes(bytes[12..16].try_into().expect("four bytes"));
        let mut edges = Vec::new();
        let mut edge = 0u32;
        for _ in 0..count {
            edge += varint(bytes, &mut at) as u32;
            let samples = varint(bytes, &mut at) as u32;
            let packed = varint(bytes, &mut at);
            let mut runs = Vec::new();
            let mut end = 0u32;
            for _ in 0..packed >> 1 {
                let start = end + varint(bytes, &mut at) as u32;
                let run = varint(bytes, &mut at);
                let count = (run >> FLAG_BITS) as u32;
                runs.push(Run {
                    start,
                    count,
                    joined: run & JOINED != 0,
                    drawn: run & DRAWN != 0,
                });
                end = start + count;
            }
            edges.push(Edge {
                edge,
                samples,
                tail_joined: packed & 1 != 0,
                runs,
            });
        }
        assert_eq!(at, bytes.len(), "the records fill the file");
        edges
    }

    /// West to east along the reference latitude, node `i` at `stops[i]` meters.
    fn walk(stops: &[f64]) -> (Vec<(u32, u32)>, Vec<Vec<Coord>>) {
        let nodes = (0..stops.len() as u32 - 1).map(|node| (node, node + 1));
        let polys = stops
            .windows(2)
            .map(|pair| vec![at(pair[0], 0.0), at(pair[1], 0.0)]);
        (nodes.collect(), polys.collect())
    }

    fn encoded(stops: &[f64], crowns: &[Polygon]) -> (Vec<Edge>, Stats) {
        let (nodes, polys) = walk(stops);
        let (bytes, stats) = encode(&ends(&nodes, &polys), &runs_of(&polys, crowns), 7);
        (decode(&bytes), stats)
    }

    /// The property the artifact is for: its intervals are the baked byte's own samples.
    #[test]
    fn the_runs_of_every_edge_reproduce_its_baked_byte() {
        let polys = vec![
            vec![at(0.0, 0.0), at(100.3, 0.0)],
            vec![at(100.3, 0.0), at(100.3, 61.7), at(140.0, 61.7)],
            vec![at(140.0, 61.7), at(140.4, 61.7)],
            Vec::new(), // a ferry
            vec![at(500.0, 0.0), at(800.0, 0.0)],
            vec![at(0.0, 300.0), at(40.0, 300.0)],
        ];
        let nodes = vec![(0, 1), (1, 2), (2, 3), (3, 9), (4, 5), (6, 7)];
        let crowns = vec![
            over(10.0, 22.5),
            over(30.0, 31.0),
            crown(95.0, -5.0, 105.0, 20.0),
            crown(90.0, 40.0, 141.0, 70.0),
            over(500.0, 640.0),
            over(700.0, 900.0),
            crown(-5.0, 295.0, 50.0, 305.0),
        ];
        let runs = runs_of(&polys, &crowns);
        let (bytes, stats) = encode(&ends(&nodes, &polys), &runs, 0x0123_4567_89ab_cdef);

        assert_eq!(
            u32::from_le_bytes(bytes[8..12].try_into().expect("four bytes")),
            6
        );
        assert_eq!(
            u64::from_le_bytes(bytes[16..24].try_into().expect("eight bytes")),
            0x0123_4567_89ab_cdef
        );
        let decoded = decode(&bytes);
        assert_eq!(decoded.len(), stats.edges);
        let mut baked = vec![0u8; polys.len()];
        for edge in &decoded {
            let covered: u32 = edge.runs.iter().map(|run| run.count).sum();
            baked[edge.edge as usize] = byte_of(f64::from(covered) / f64::from(edge.samples));
        }
        let expected: Vec<u8> = runs.iter().map(|edge| byte_of(edge.fraction())).collect();
        assert_eq!(baked, expected);
        assert_eq!(baked[3], 0, "a ferry has no polyline");
        assert_eq!(baked[5], 254, "wholly covered, and never 255");
        assert!(baked[0] > 0 && baked[1] > 0 && baked[4] > 200);
    }

    #[test]
    fn runs_a_short_gap_apart_are_one_stretch_and_a_long_gap_apart_are_two() {
        let (edges, stats) = encoded(
            &[0.0, 100.0],
            &[over(10.0, 20.0), over(23.0, 30.0), over(40.0, 50.0)],
        );

        let runs = &edges[0].runs;
        assert_eq!(runs.len(), 3);
        assert!(!runs[0].joined, "nothing lies before the first");
        assert!(runs[1].joined, "3 m is under the 4 m limit");
        assert!(!runs[2].joined, "10 m is a real break");
        assert!(runs.iter().all(|run| run.drawn));
        assert_eq!(stats.stretches, 2);
        assert!(!edges[0].tail_joined);
    }

    #[test]
    fn a_stretch_shorter_than_three_meters_is_not_drawn() {
        let (edges, stats) = encoded(&[0.0, 100.0], &[over(10.0, 12.0), over(40.0, 44.0)]);

        assert!(!edges[0].runs[0].drawn, "a 2 m crown");
        assert!(edges[0].runs[1].drawn, "a 4 m one");
        assert_eq!(stats.stretches, 1);
    }

    /// Two crowns of 2 m are each too short, and long enough together with the gap they bridge.
    #[test]
    fn the_stretch_is_measured_after_the_merge() {
        let (edges, _) = encoded(&[0.0, 100.0], &[over(10.0, 12.0), over(13.0, 15.0)]);

        assert!(edges[0].runs.iter().all(|run| run.drawn));
        assert!(edges[0].runs[1].joined);
    }

    #[test]
    fn a_stretch_is_chained_through_a_node_and_measured_along_the_chain() {
        let (edges, stats) = encoded(&[0.0, 50.0, 100.0], &[over(46.4, 53.6)]);

        assert_eq!(edges.len(), 2);
        assert!(edges[0].tail_joined);
        assert!(edges[1].runs[0].joined);
        assert!(
            edges.iter().all(|edge| edge.runs[0].drawn),
            "over 3 m a side, and one stretch of 7 m"
        );
        assert_eq!(stats.stretches, 1);
    }

    const WEST: &[(f64, f64)] = &[(0.0, 0.0), (50.0, 0.0)];

    /// A crown over a corner covers a meter or two of each arm; drawn, each would be a barb.
    #[test]
    fn a_short_piece_round_a_corner_is_not_drawn_onto_the_stretch_it_touches() {
        let (edges, stats) = drawn_over(
            &[(0, 1), (1, 2)],
            &[WEST, &[(50.0, 0.0), (50.0, 50.0)]],
            &[over(20.0, 49.0), crown(48.0, -2.0, 52.0, 1.7)],
        );

        assert!(edges[0].runs.iter().all(|run| run.drawn));
        assert!(!edges[0].tail_joined);
        assert_eq!(edges[1].runs.len(), 1);
        assert!(!edges[1].runs[0].drawn && !edges[1].runs[0].joined);
        assert_eq!(stats.stretches, 1);
        assert_eq!(stats.undrawn.0, 0, "under 3 m of cover is nothing to miss");
    }

    /// The same barb at a T: the long stretch runs straight on, and the stub up the side arm goes.
    #[test]
    fn a_barb_at_a_t_is_not_drawn_and_the_stretch_through_it_is() {
        let (edges, stats) = drawn_over(
            &[(0, 1), (1, 2), (1, 3)],
            &[
                WEST,
                &[(50.0, 0.0), (100.0, 0.0)],
                &[(50.0, 0.0), (50.0, 50.0)],
            ],
            &[crown(20.0, -1.0, 80.0, 1.7)],
        );

        assert!(edges[0].tail_joined && edges[1].runs[0].joined);
        assert!(edges[0].runs[0].drawn && edges[1].runs[0].drawn);
        assert!(!edges[2].runs[0].drawn && !edges[2].runs[0].joined);
        assert_eq!(stats.stretches, 1);
    }

    /// Straight on, cover is one stretch however the graph cuts it: here, five 2 m edges.
    #[test]
    fn a_straight_row_of_short_edges_under_one_crown_is_one_stretch() {
        let (edges, stats) = encoded(
            &[0.0, 30.0, 32.0, 34.0, 36.0, 38.0, 40.0, 70.0],
            &[over(30.5, 39.5)],
        );

        assert_eq!(edges.len(), 5);
        assert!(edges.iter().all(|edge| edge.runs[0].drawn));
        assert_eq!(stats.stretches, 1);
        assert_eq!(stats.undrawn.0, 0);
    }

    #[test]
    fn two_short_pieces_straight_across_a_node_are_one_stretch_and_round_a_corner_are_none() {
        let straight = encoded(&[0.0, 50.0, 100.0], &[over(48.4, 51.6)]);
        let corner = drawn_over(
            &[(0, 1), (1, 2)],
            &[WEST, &[(50.0, 0.0), (50.0, 50.0)]],
            &[crown(48.4, -1.0, 52.0, 1.6)],
        );

        assert!(straight.0.iter().all(|edge| edge.runs[0].drawn));
        assert_eq!(straight.1.stretches, 1);
        assert!(corner.0.iter().all(|edge| !edge.runs[0].drawn));
        assert!(!corner.0[0].tail_joined && !corner.0[1].runs[0].joined);
        assert_eq!(corner.1.stretches, 0);
    }

    /// A 2 m link wholly under cover between two long stretches carries them, corners and all.
    #[test]
    fn a_short_edge_covered_from_node_to_node_carries_the_stretch_round_its_corners() {
        let (edges, stats) = drawn_over(
            &[(0, 1), (1, 2), (2, 3)],
            &[
                WEST,
                &[(50.0, 0.0), (50.0, 2.0)],
                &[(50.0, 2.0), (100.0, 2.0)],
            ],
            &[crown(30.0, -3.0, 70.0, 5.0)],
        );

        assert!(edges.iter().all(|edge| edge.runs[0].drawn));
        assert!(edges[1].runs[0].joined && edges[1].tail_joined);
        assert_eq!(stats.stretches, 1);
    }

    #[test]
    fn a_short_covered_dead_end_round_a_corner_is_a_barb_and_straight_on_is_more_of_the_stretch() {
        let corner = drawn_over(
            &[(0, 1), (1, 2)],
            &[WEST, &[(50.0, 0.0), (50.0, 2.0)]],
            &[crown(30.0, -3.0, 60.0, 5.0)],
        );
        let straight = encoded(&[0.0, 50.0, 52.0], &[over(30.0, 60.0)]);

        assert!(corner.0[0].runs[0].drawn && !corner.0[1].runs[0].drawn);
        assert!(!corner.0[0].tail_joined);
        assert!(straight.0.iter().all(|edge| edge.runs[0].drawn));
        assert!(straight.0[0].tail_joined);
    }

    /// A loop's two ends meet at its own node, which must not pass for being held between two edges.
    #[test]
    fn a_short_loop_under_cover_does_not_join_itself() {
        let (edges, stats) = drawn_over(
            &[(0, 0)],
            &[&[(0.0, 0.0), (0.8, 0.0), (0.4, 0.7), (0.0, 0.0)]],
            &[crown(-5.0, -5.0, 5.0, 5.0)],
        );

        assert!(!edges[0].runs[0].drawn && !edges[0].runs[0].joined);
        assert!(!edges[0].tail_joined);
        assert_eq!(stats.stretches, 0);
    }

    /// Two short edges between the same two nodes hold each other at both ends, and nothing else.
    #[test]
    fn two_short_twin_edges_do_not_make_each_other_a_link() {
        let (edges, stats) = drawn_over(
            &[(0, 1), (0, 1)],
            &[
                &[(0.0, 0.0), (1.0, 0.8), (2.0, 0.0)],
                &[(0.0, 0.0), (1.0, -0.8), (2.0, 0.0)],
            ],
            &[crown(-5.0, -5.0, 5.0, 5.0)],
        );

        assert!(edges.iter().all(|edge| !edge.runs[0].drawn));
        assert_eq!(stats.stretches, 0);
        assert_eq!(
            stats.undrawn.0, 1,
            "5 m of cover in all, and counted as missed"
        );
    }

    #[test]
    fn two_ends_short_of_a_node_are_bridged_through_it_when_their_gaps_sum_under_the_limit() {
        let near = encoded(&[0.0, 50.0, 100.0], &[over(40.0, 48.6), over(51.4, 60.0)]);
        let far = encoded(&[0.0, 50.0, 100.0], &[over(40.0, 47.4), over(52.6, 60.0)]);

        assert!(near.0[0].tail_joined && near.0[1].runs[0].joined);
        assert_eq!(near.1.stretches, 1);
        assert!(!far.0[0].tail_joined && !far.0[1].runs[0].joined);
        assert_eq!(far.1.stretches, 2);
    }

    /// A stretch that stops mid-block keeps its butt end: nothing is drawn on to the node.
    #[test]
    fn an_end_with_nothing_across_its_node_is_not_drawn_on_to_it() {
        let (edges, _) = encoded(&[0.0, 50.0, 100.0], &[over(40.0, 48.6)]);

        assert_eq!(edges.len(), 1);
        assert!(!edges[0].tail_joined);
    }

    #[test]
    fn every_end_at_a_fork_reaches_the_node_as_one_stretch() {
        let nodes = vec![(0, 1), (1, 2), (1, 3)];
        let polys = vec![
            vec![at(0.0, 0.0), at(50.0, 0.0)],
            vec![at(50.0, 0.0), at(100.0, 0.0)],
            vec![at(50.0, 0.0), at(50.0, 50.0)],
        ];
        let crowns = [crown(45.3, -4.7, 54.7, 4.7)];
        let (bytes, stats) = encode(&ends(&nodes, &polys), &runs_of(&polys, &crowns), 7);
        let edges = decode(&bytes);

        assert_eq!(edges.len(), 3);
        assert_eq!(stats.stretches, 1);
        assert!(
            edges.iter().all(|edge| edge.runs[0].drawn),
            "over 4 m on each of three edges is one stretch"
        );
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    /// One small file pinned byte for byte, so any other reader can be held to the same one.
    #[test]
    fn the_fixture_the_client_reads_is_what_the_encoder_writes() {
        let runs_of = |samples: u32, runs: &[(u32, u32)]| Runs {
            samples,
            meters: f64::from(samples),
            runs: runs.to_vec(),
        };
        // West to east in one line, so every node is passed straight through.
        let edges: Vec<EdgeEnds> = (0..4)
            .map(|edge| EdgeEnds {
                a: edge,
                b: edge + 1,
                heading_a: 0.0,
                heading_b: std::f64::consts::PI,
            })
            .collect();
        let runs = [
            runs_of(50, &[(10, 10), (23, 7), (46, 4)]),
            runs_of(50, &[(0, 4), (20, 2)]),
            Runs::default(),
            runs_of(300, &[(150, 150)]),
        ];
        let (bytes, stats) = encode(&edges, &runs, 0xa362_5989_48ca_0eb3);

        assert_eq!(hex(&bytes), PINNED);
        assert_eq!((stats.edges, stats.runs, stats.stretches), (3, 6, 3));
        let run = |start, count, joined, drawn| Run {
            start,
            count,
            joined,
            drawn,
        };
        assert_eq!(
            decode(&bytes),
            vec![
                Edge {
                    edge: 0,
                    samples: 50,
                    tail_joined: true,
                    runs: vec![
                        run(10, 10, false, true),
                        run(23, 7, true, true),
                        run(46, 4, false, true),
                    ],
                },
                Edge {
                    edge: 1,
                    samples: 50,
                    tail_joined: false,
                    runs: vec![run(0, 4, true, true), run(20, 2, false, false)],
                },
                Edge {
                    edge: 3,
                    samples: 300,
                    tail_joined: false,
                    runs: vec![run(150, 150, false, true)],
                },
            ]
        );
    }

    /// A cache entry cut short, padded, or miscounted is a miss and never a panic.
    #[test]
    fn a_file_whose_records_do_not_bear_out_its_header_matches_nothing() {
        let (nodes, polys) = walk(&[0.0, 50.0, 100.0, 150.0]);
        let edges = ends(&nodes, &polys);
        let (bytes, _) = encode(&edges, &runs_of(&polys, &[over(10.0, 120.0)]), 7);
        assert!(matches(&bytes, &edges, 7));

        for cut in HEADER_BYTES..bytes.len() {
            assert!(
                !matches(&bytes[..cut], &edges, 7),
                "{cut} bytes of {}",
                bytes.len()
            );
            assert!(stretches(&bytes[..cut]).is_none());
        }
        let mut padded = bytes.clone();
        padded.push(0);
        assert!(!matches(&padded, &edges, 7));
        let mut miscounted = bytes.clone();
        miscounted[24] += 1;
        assert!(!matches(&miscounted, &edges, 7));
        let mut overlong = bytes.clone();
        overlong[HEADER_BYTES + 1] = 1; // one sample, for runs of dozens
        assert!(stretches(&overlong).is_none());
        assert!(stretches(&bytes[..10]).is_none());
    }

    /// A short link held at its head by two edges and at its tail by one of them is still a link.
    #[test]
    fn a_short_link_held_by_a_twin_at_one_end_and_another_edge_at_the_other_carries_the_stretch() {
        // Edge 1 is the 2 m link; edges 2 and 3 both leave its head, and edge 3 comes back to its tail.
        let (edges, stats) = drawn_over(
            &[(0, 1), (2, 1), (2, 3), (2, 1)],
            &[
                WEST,
                &[(50.0, 2.0), (50.0, 0.0)],
                &[(50.0, 2.0), (100.0, 2.0)],
                &[(50.0, 2.0), (48.5, 1.0), (50.0, 0.0)],
            ],
            &[crown(30.0, -3.0, 70.0, 5.0)],
        );

        assert!(edges[1].runs[0].drawn, "the link");
        assert!(edges[1].runs[0].joined && edges[1].tail_joined);
        assert!(edges[0].runs[0].drawn && edges[2].runs[0].drawn);
        assert_eq!(stats.stretches, 1);
    }

    /// The pyramid is rendered from the file, so its reading of the flags is the client's.
    #[test]
    fn the_drawn_stretches_read_back_off_the_pinned_file() {
        let bytes: Vec<u8> = (0..PINNED.len() / 2)
            .map(|byte| u8::from_str_radix(&PINNED[byte * 2..byte * 2 + 2], 16).expect("hex"))
            .collect();

        assert_eq!(
            stretches(&bytes).expect("a whole file"),
            vec![
                (0, vec![(10.0 / 50.0, 30.0 / 50.0), (46.0 / 50.0, 1.0)]),
                (1, vec![(0.0, 4.0 / 50.0)]),
                (3, vec![(0.5, 1.0)]),
            ]
        );
    }

    const PINNED: &str = "4352554e020024000400000003000000b30eca48895962a30600000028001e00\
                          a14c6da60032070a29031f10110132040013100802ac02029601d904";

    /// Records name edges by index, so the file is one graph's: the same edges in the same order.
    #[test]
    fn a_file_matches_only_the_graph_whose_edge_order_it_was_written_over() {
        let (nodes, polys) = walk(&[0.0, 50.0, 100.0, 150.0]);
        let edges = ends(&nodes, &polys);
        let (bytes, _) = encode(&edges, &runs_of(&polys, &[over(10.0, 120.0)]), 7);

        assert!(matches(&bytes, &edges, 7));
        assert!(!matches(&bytes, &edges, 8), "another key space");
        assert!(!matches(&bytes, &edges[..2], 7), "an edge fewer");
        // A re-ingest that moves a crossing leaves the key space alone and reorders the edges.
        let mut reordered = edges.clone();
        reordered.swap(0, 2);
        assert!(!matches(&bytes, &reordered, 7));
        assert!(!matches(&bytes[..HEADER_BYTES - 1], &edges, 7), "cut short");
        let mut older = bytes.clone();
        older[4] = 1;
        assert!(!matches(&older, &edges, 7), "another format");
        assert!(!matches(b"", &edges, 7));
    }

    #[test]
    fn the_header_names_the_rules_the_flags_were_set_by() {
        let (nodes, polys) = walk(&[0.0, 100.0]);
        let (bytes, _) = encode(
            &ends(&nodes, &polys),
            &runs_of(&polys, &[over(10.0, 20.0)]),
            7,
        );

        assert_eq!(u16::from_le_bytes([bytes[28], bytes[29]]), 40);
        assert_eq!(u16::from_le_bytes([bytes[30], bytes[31]]), 30);
        assert_eq!(bytes.len(), HEADER_BYTES + 5);
    }
}

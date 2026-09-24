//! Scenic per-edge bytes (GRPH v5), 0..254 so no discount edge reads free (`maxAttr < 1`).
//! Landmarks and art fan out over the network; highway and commercial proximity is Euclidean.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use crate::binfmt::{Coord, Polygon};
use crate::geometry::{point_segment_dist2, round_half_up};

const BYTE_CEILING: f64 = 254.0; // a discount edge is never free: keeps maxAttr < 1, as cover does
const FANOUT_SIGMAS: f64 = 3.0; // the Gaussian is negligible past 3σ; searches and fan-outs stop there

// Landmarks read from afar and saturate fast; art is up close and a rich corridor keeps giving.
pub const LANDMARK_PARAMS: PoiParams = PoiParams {
    sigma_meters: 120.0,
    saturation: 1.0,
};
pub const ART_PARAMS: PoiParams = PoiParams {
    sigma_meters: 60.0,
    saturation: 1.2,
};
// A POI more than this from any walking node is off-network and contributes nothing.
const POI_SNAP_RADIUS_METERS: f64 = 150.0;
// The nuisance field's reach: walking within ~a σ of a big road or an el is unpleasant.
const HIGHWAY_SIGMA_METERS: f64 = 35.0;
// Tight enough that the reward stays on the block's own sidewalks, not a parallel block over.
const COMMERCIAL_SIGMA_METERS: f64 = 20.0;

pub struct PoiParams {
    pub sigma_meters: f64,
    pub saturation: f64,
}

/// The walking graph as flat slices in quantized units; `mpu_*` convert a unit to meters.
pub struct Network<'a> {
    pub node_x: &'a [i32],
    pub node_y: &'a [i32],
    pub csr: &'a [u32],       // node n owns half-edges [csr[n], csr[n + 1])
    pub adjacency: &'a [u32], // edge ids, indexed by the CSR
    pub edge_a: &'a [u32],
    pub edge_b: &'a [u32],
    pub edge_len_m: &'a [f64],
    /// Whether a walker uses an edge; zero-length station board edges would carry discounts across.
    pub edge_walkable: &'a [bool],
    pub origin_lng: f64,
    pub origin_lat: f64,
    pub scale: f64,
    pub mpu_lng: f64, // meters per quantized x unit at the origin latitude
    pub mpu_lat: f64, // meters per quantized y unit
}

impl Network<'_> {
    fn node_count(&self) -> usize {
        self.node_x.len()
    }

    fn edge_count(&self) -> usize {
        self.edge_a.len()
    }

    fn node_meters(&self, node: u32) -> (f64, f64) {
        (
            f64::from(self.node_x[node as usize]) * self.mpu_lng,
            f64::from(self.node_y[node as usize]) * self.mpu_lat,
        )
    }

    /// A node with a walking edge on it; a POI snapped to a station would fan out into a dead end.
    fn walkable_nodes(&self) -> Vec<bool> {
        (0..self.node_count())
            .map(|node| {
                self.adjacency[self.csr[node] as usize..self.csr[node + 1] as usize]
                    .iter()
                    .any(|&edge| self.edge_walkable[edge as usize])
            })
            .collect()
    }

    fn coord_meters(&self, coord: Coord) -> (f64, f64) {
        (
            (coord.lng - self.origin_lng) / self.scale * self.mpu_lng,
            (coord.lat - self.origin_lat) / self.scale * self.mpu_lat,
        )
    }
}

// A min-heap entry for the fan-out Dijkstra: ordered so the smallest distance pops first.
struct HeapItem {
    dist: f64,
    node: u32,
}

impl PartialEq for HeapItem {
    fn eq(&self, other: &Self) -> bool {
        self.dist == other.dist
    }
}
impl Eq for HeapItem {}
impl Ord for HeapItem {
    fn cmp(&self, other: &Self) -> Ordering {
        other.dist.total_cmp(&self.dist) // reversed: BinaryHeap is a max-heap
    }
}
impl PartialOrd for HeapItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// A grid of the walkable node ids in meter space, for a nearest-node snap.
fn node_grid(net: &Network, cell_meters: f64) -> HashMap<(i32, i32), Vec<u32>> {
    let walkable = net.walkable_nodes();
    let mut grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
    for (node, &is_walkable) in walkable.iter().enumerate().take(net.node_count()) {
        if !is_walkable {
            continue;
        }
        let (x, y) = net.node_meters(node as u32);
        grid.entry((
            (x / cell_meters).floor() as i32,
            (y / cell_meters).floor() as i32,
        ))
        .or_default()
        .push(node as u32);
    }
    grid
}

pub struct PoiStats {
    pub snapped: usize,
    pub max_byte: u8,
}

/// The per-edge amenity byte for one POI mood: snap, bounded Dijkstra, Gaussian deposit, saturate.
pub fn poi_amenity(net: &Network, params: &PoiParams, pois: &[Coord]) -> (Vec<u8>, PoiStats) {
    let node_count = net.node_count();
    let edge_count = net.edge_count();
    let grid = node_grid(net, POI_SNAP_RADIUS_METERS.max(1.0));
    let cell = POI_SNAP_RADIUS_METERS.max(1.0);
    let radius = params.sigma_meters * FANOUT_SIGMAS;
    let inv_two_sigma2 = 1.0 / (2.0 * params.sigma_meters * params.sigma_meters);

    let mut acc = vec![0.0f64; edge_count];
    let mut dist = vec![f64::INFINITY; node_count];
    let mut touched: Vec<u32> = Vec::new();
    // Dedups an edge seen from both endpoints in one POI's fan-out, stamped with the POI index.
    let mut edge_stamp = vec![u32::MAX; edge_count];
    let mut heap: BinaryHeap<HeapItem> = BinaryHeap::new();
    let mut snapped = 0usize;

    for (index, poi) in pois.iter().enumerate() {
        let (px, py) = net.coord_meters(*poi);
        let (cx, cy) = ((px / cell).floor() as i32, (py / cell).floor() as i32);
        let mut nearest: Option<(u32, f64)> = None;
        for gx in cx - 1..=cx + 1 {
            for gy in cy - 1..=cy + 1 {
                for &node in grid.get(&(gx, gy)).into_iter().flatten() {
                    let (nx, ny) = net.node_meters(node);
                    let meters = (nx - px).hypot(ny - py);
                    if nearest.is_none_or(|(_, best)| meters < best) {
                        nearest = Some((node, meters));
                    }
                }
            }
        }
        let start = match nearest {
            Some((node, meters)) if meters <= POI_SNAP_RADIUS_METERS => node,
            _ => continue,
        };
        snapped += 1;

        let stamp = index as u32;
        dist[start as usize] = 0.0;
        touched.push(start);
        heap.push(HeapItem {
            dist: 0.0,
            node: start,
        });
        while let Some(HeapItem { dist: d, node }) = heap.pop() {
            if d > dist[node as usize] {
                continue; // a stale heap entry, already improved
            }
            let base = net.csr[node as usize] as usize;
            let end = net.csr[node as usize + 1] as usize;
            for &edge in &net.adjacency[base..end] {
                let edge = edge as usize;
                if !net.edge_walkable[edge] {
                    continue;
                }
                // Deposit once per POI, keyed on the edge's near end.
                if edge_stamp[edge] != stamp {
                    edge_stamp[edge] = stamp;
                    let near = dist[net.edge_a[edge] as usize].min(dist[net.edge_b[edge] as usize]);
                    acc[edge] += (-near * near * inv_two_sigma2).exp();
                }
                let other = if net.edge_a[edge] == node {
                    net.edge_b[edge]
                } else {
                    net.edge_a[edge]
                } as usize;
                let stepped = d + net.edge_len_m[edge];
                if stepped <= radius && stepped < dist[other] {
                    if dist[other].is_infinite() {
                        touched.push(other as u32);
                    }
                    dist[other] = stepped;
                    heap.push(HeapItem {
                        dist: stepped,
                        node: other as u32,
                    });
                }
            }
        }
        for &node in &touched {
            dist[node as usize] = f64::INFINITY;
        }
        touched.clear();
        heap.clear();
    }

    let mut bytes = vec![0u8; edge_count];
    let mut max_byte = 0u8;
    for (byte, total) in bytes.iter_mut().zip(&acc) {
        let amenity = 1.0 - (-params.saturation * total).exp();
        *byte = round_half_up(amenity * 255.0).min(BYTE_CEILING) as u8;
        max_byte = max_byte.max(*byte);
    }
    (bytes, PoiStats { snapped, max_byte })
}

/// The per-edge nuisance byte: the max over lines of `severity·e^{-(d/σ)²/2}`, severity per line.
pub fn highway_penalty(net: &Network, lines: &[Polygon], severities: &[f64]) -> (Vec<u8>, u8) {
    line_proximity(net, lines, severities, HIGHWAY_SIGMA_METERS)
}

/// The per-edge commercial-frontage byte: the highway field over commercial lines, as a discount.
pub fn commercial_amenity(net: &Network, lines: &[Polygon]) -> (Vec<u8>, u8) {
    line_proximity(net, lines, &vec![1.0; lines.len()], COMMERCIAL_SIGMA_METERS)
}

/// The per-edge proximity byte to weighted lines, sampled at both endpoints and the midpoint.
/// Lines combine by max, not sum, so an expressway's two carriageways count once.
fn line_proximity(
    net: &Network,
    lines: &[Polygon],
    weights: &[f64],
    sigma_meters: f64,
) -> (Vec<u8>, u8) {
    assert_eq!(
        lines.len(),
        weights.len(),
        "every line needs a weight: {} lines, {} weights",
        lines.len(),
        weights.len()
    );
    let inv_two_sigma2 = 1.0 / (2.0 * sigma_meters * sigma_meters);
    // `w·e^{-d²k}` is largest where `d² - ln(w)/k` is smallest, so no exp per candidate.
    let mut segments: Vec<(f64, f64, f64, f64, f64, f64)> = Vec::new();
    for (polygon, &weight) in lines.iter().zip(weights) {
        assert!(
            (0.0..=1.0).contains(&weight),
            "weight {weight} is outside 0..=1"
        );
        if weight == 0.0 {
            continue;
        }
        let offset = -weight.ln() / inv_two_sigma2;
        for ring in polygon {
            for pair in ring.windows(2) {
                let (ax, ay) = net.coord_meters(pair[0]);
                let (bx, by) = net.coord_meters(pair[1]);
                segments.push((ax, ay, bx, by, weight, offset));
            }
        }
    }
    let search = sigma_meters * FANOUT_SIGMAS;
    let cell = search.max(1.0);
    let mut grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
    for (index, &(ax, ay, bx, by, _, _)) in segments.iter().enumerate() {
        let gx0 = (ax.min(bx) / cell).floor() as i32;
        let gx1 = (ax.max(bx) / cell).floor() as i32;
        let gy0 = (ay.min(by) / cell).floor() as i32;
        let gy1 = (ay.max(by) / cell).floor() as i32;
        for gx in gx0..=gx1 {
            for gy in gy0..=gy1 {
                grid.entry((gx, gy)).or_default().push(index as u32);
            }
        }
    }

    let mut bytes = vec![0u8; net.edge_count()];
    let mut max_byte = 0u8;
    for (edge, byte) in bytes.iter_mut().enumerate() {
        let (ax, ay) = net.node_meters(net.edge_a[edge]);
        let (bx, by) = net.node_meters(net.edge_b[edge]);
        let samples = [(ax, ay), ((ax + bx) / 2.0, (ay + by) / 2.0), (bx, by)];
        let mut best_score = f64::INFINITY;
        let mut best = (0.0f64, f64::INFINITY); // (weight, d²) of the worst line
        for &(px, py) in &samples {
            let (cx, cy) = ((px / cell).floor() as i32, (py / cell).floor() as i32);
            for gx in cx - 1..=cx + 1 {
                for gy in cy - 1..=cy + 1 {
                    for &index in grid.get(&(gx, gy)).into_iter().flatten() {
                        let (sx, sy, tx, ty, weight, offset) = segments[index as usize];
                        let d2 = point_segment_dist2(px, py, sx, sy, tx, ty);
                        if d2 + offset < best_score {
                            best_score = d2 + offset;
                            best = (weight, d2);
                        }
                    }
                }
            }
        }
        let (weight, d2) = best;
        let proximity = if d2.is_finite() {
            weight * (-d2 * inv_two_sigma2).exp()
        } else {
            0.0
        };
        *byte = round_half_up(proximity * 255.0).min(BYTE_CEILING) as u8;
        max_byte = max_byte.max(*byte);
    }
    (bytes, max_byte)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCALE: f64 = 1e-6;
    const ORIGIN_LNG: f64 = -74.0;
    const ORIGIN_LAT: f64 = 40.6;

    // One quantized unit is one meter, so distances read as meters.
    fn at(x: f64, y: f64) -> Coord {
        Coord {
            lng: ORIGIN_LNG + x * SCALE,
            lat: ORIGIN_LAT + y * SCALE,
        }
    }

    /// One 100 m walking edge from (0, 0) to (100, 0).
    struct OneEdge {
        node_x: Vec<i32>,
        node_y: Vec<i32>,
        csr: Vec<u32>,
        adjacency: Vec<u32>,
        edge_a: Vec<u32>,
        edge_b: Vec<u32>,
        edge_len_m: Vec<f64>,
        edge_walkable: Vec<bool>,
    }

    impl OneEdge {
        fn new() -> OneEdge {
            OneEdge {
                node_x: vec![0, 100],
                node_y: vec![0, 0],
                csr: vec![0, 1, 2],
                adjacency: vec![0, 0],
                edge_a: vec![0],
                edge_b: vec![1],
                edge_len_m: vec![100.0],
                edge_walkable: vec![true],
            }
        }

        fn net(&self) -> Network<'_> {
            Network {
                node_x: &self.node_x,
                node_y: &self.node_y,
                csr: &self.csr,
                adjacency: &self.adjacency,
                edge_a: &self.edge_a,
                edge_b: &self.edge_b,
                edge_len_m: &self.edge_len_m,
                edge_walkable: &self.edge_walkable,
                origin_lng: ORIGIN_LNG,
                origin_lat: ORIGIN_LAT,
                scale: SCALE,
                mpu_lng: 1.0,
                mpu_lat: 1.0,
            }
        }
    }

    /// A line parallel to the edge `y` meters off, long enough that every sample's nearest point is perpendicular.
    fn parallel_line(y: f64) -> Polygon {
        vec![vec![at(-500.0, y), at(600.0, y)]]
    }

    fn gaussian(meters: f64) -> f64 {
        (-meters * meters / (2.0 * HIGHWAY_SIGMA_METERS * HIGHWAY_SIGMA_METERS)).exp()
    }

    fn quantized(proximity: f64) -> u8 {
        round_half_up(proximity * 255.0).min(BYTE_CEILING) as u8
    }

    #[test]
    fn the_worst_line_near_an_edge_is_the_one_the_penalty_reads() {
        let fixture = OneEdge::new();
        // A busy road 30 m off and a nearer quiet street 10 m off.
        let lines = [parallel_line(30.0), parallel_line(10.0)];
        let (bytes, max_byte) = highway_penalty(&fixture.net(), &lines, &[1.0, 0.1]);

        let busy = gaussian(30.0);
        let quiet = 0.1 * gaussian(10.0);
        assert!(busy > quiet, "the busy road is the worse of the two");
        assert_eq!(bytes, vec![quantized(busy)]);
        assert_eq!(max_byte, quantized(busy));
        let (alone, _) = highway_penalty(&fixture.net(), &lines[..1], &[1.0]);
        assert_eq!(bytes, alone);
    }

    #[test]
    fn a_quiet_street_alone_reads_its_own_share_and_no_more() {
        let fixture = OneEdge::new();
        let lines = [parallel_line(10.0)];
        let (bytes, _) = highway_penalty(&fixture.net(), &lines, &[0.085]);

        assert_eq!(bytes, vec![quantized(0.085 * gaussian(10.0))]);
        let (motorway, _) = highway_penalty(&fixture.net(), &lines, &[1.0]);
        assert!(bytes[0] < motorway[0] / 4, "{:?} << {motorway:?}", bytes);
    }

    #[test]
    fn a_line_of_no_severity_adds_nothing() {
        let fixture = OneEdge::new();
        let lines = [parallel_line(5.0), parallel_line(40.0)];
        let (bytes, _) = highway_penalty(&fixture.net(), &lines, &[0.0, 0.5]);

        assert_eq!(bytes, vec![quantized(0.5 * gaussian(40.0))]);
        let (none, max_byte) = highway_penalty(&fixture.net(), &lines[..1], &[0.0]);
        assert_eq!((none, max_byte), (vec![0], 0));
    }

    #[test]
    fn a_full_severity_line_reads_the_plain_gaussian() {
        let fixture = OneEdge::new();
        for meters in [5.0, 20.0, 30.0, 60.0, 90.0] {
            let lines = [parallel_line(meters)];
            let (bytes, _) = highway_penalty(&fixture.net(), &lines, &[1.0]);
            assert_eq!(
                bytes,
                vec![quantized(gaussian(meters))],
                "a motorway {meters} m off"
            );
        }
    }

    #[test]
    fn the_commercial_field_is_the_plain_gaussian() {
        let fixture = OneEdge::new();
        let lines = [parallel_line(10.0)];
        let (bytes, max_byte) = commercial_amenity(&fixture.net(), &lines);

        let expected =
            quantized((-100.0 / (2.0 * COMMERCIAL_SIGMA_METERS * COMMERCIAL_SIGMA_METERS)).exp());
        assert_eq!(bytes, vec![expected]);
        assert_eq!(max_byte, expected);
    }
}

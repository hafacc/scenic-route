//! Per-edge direct canopy byte (GRPH v6, byte 28): the unsmoothed share of a sidewalk under a crown.

use std::path::Path;

use rayon::prelude::*;

use crate::Fallible;
use crate::binfmt::{self, Coord};
use crate::geometry::{
    METERS_PER_DEGREE_LAT, PolygonGrid, PolygonSet, flatten_canopy, round_half_up,
};
use crate::sampling::{Runs, contained_runs};

const BYTE_CEILING: f64 = 254.0; // as cover and the scenic bytes: keeps the client's max attr < 1

pub struct DirectCanopy {
    pub bytes: Vec<u8>,
    /// Where each edge's covered samples sit, which the byte is the share of.
    pub runs: Vec<Runs>,
    pub polygons: usize, // the canopy polygons the sampler read
    pub mean: f64,       // the mean covered fraction over the edges, for the build log
    pub max_byte: u8,
}

/// The byte a covered fraction bakes to.
pub fn byte_of(fraction: f64) -> u8 {
    round_half_up(fraction * 255.0).min(BYTE_CEILING) as u8
}

/// Every edge's covered runs, in the graph's edge order.
pub fn sampled(
    edge_polys: &[Vec<Coord>],
    set: &PolygonSet,
    grid: &PolygonGrid,
    meters_per_degree_lng: f64,
) -> Vec<Runs> {
    edge_polys
        .par_iter()
        .map_init(Vec::new, |candidates, poly| {
            contained_runs(poly, set, grid, meters_per_degree_lng, candidates)
        })
        .collect()
}

/// The direct-canopy byte of every edge in graph order; `reference_lat` sets the east-west scale.
pub fn direct_canopy(
    edge_polys: &[Vec<Coord>],
    canopy: &Path,
    reference_lat: f64,
) -> Fallible<DirectCanopy> {
    // Flattened a batch at a time, so the rings never sit beside the flat copy.
    let set = flatten_canopy(&mut binfmt::read_canopy_batches(canopy)?);
    let count = set.len();
    let grid = PolygonGrid::new(&set);
    let meters_per_degree_lng = METERS_PER_DEGREE_LAT * reference_lat.to_radians().cos();

    let runs = sampled(edge_polys, &set, &grid, meters_per_degree_lng);
    let mut bytes = vec![0u8; runs.len()];
    let mut max_byte = 0u8;
    let mut sum = 0.0;
    for (byte, edge) in bytes.iter_mut().zip(&runs) {
        let fraction = edge.fraction();
        *byte = byte_of(fraction);
        max_byte = max_byte.max(*byte);
        sum += fraction;
    }
    let mean = if runs.is_empty() {
        0.0
    } else {
        sum / runs.len() as f64
    };
    Ok(DirectCanopy {
        bytes,
        runs,
        polygons: count,
        mean,
        max_byte,
    })
}

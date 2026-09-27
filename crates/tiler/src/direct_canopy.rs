//! Per-edge direct canopy byte (GRPH v6, byte 28): the unsmoothed share of a sidewalk under a crown.

use std::path::Path;

use rayon::prelude::*;

use crate::Fallible;
use crate::binfmt::{self, Coord};
use crate::geometry::{METERS_PER_DEGREE_LAT, PolygonGrid, flatten_canopy, round_half_up};
use crate::sampling::contained_fraction;

const BYTE_CEILING: f64 = 254.0; // as cover and the scenic bytes: keeps the client's max attr < 1

pub struct DirectCanopy {
    pub bytes: Vec<u8>,
    pub polygons: usize, // the canopy polygons the sampler read
    pub mean: f64,       // the mean covered fraction over the edges, for the build log
    pub max_byte: u8,
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

    let fractions: Vec<f64> = edge_polys
        .par_iter()
        .map_init(Vec::new, |candidates, poly| {
            contained_fraction(poly, &set, &grid, meters_per_degree_lng, candidates)
        })
        .collect();

    let mut bytes = vec![0u8; fractions.len()];
    let mut max_byte = 0u8;
    for (byte, fraction) in bytes.iter_mut().zip(&fractions) {
        *byte = round_half_up(fraction * 255.0).min(BYTE_CEILING) as u8;
        max_byte = max_byte.max(*byte);
    }
    let mean = if fractions.is_empty() {
        0.0
    } else {
        fractions.iter().sum::<f64>() / fractions.len() as f64
    };
    Ok(DirectCanopy {
        bytes,
        polygons: count,
        mean,
        max_byte,
    })
}

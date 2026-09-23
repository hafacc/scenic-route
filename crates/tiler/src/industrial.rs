//! Per-edge industrial-frontage byte (GRPH v10, byte 36): the share of a walk fronting industry.
//! Each side probes sideways for half; a Gaussian would reach past the lot and scale by distance.

use std::path::Path;

use rayon::prelude::*;

use crate::Fallible;
use crate::binfmt::{self, Coord};
use crate::geometry::{METERS_PER_DEGREE_LAT, PolygonGrid, PolygonSet, flatten, round_half_up};
use crate::manifest::Bounds;

const BYTE_CEILING: f64 = 254.0; // as the cover, scenic and direct-canopy bytes
const SAMPLE_STEP_METERS: f64 = 1.0; // as direct_canopy: fine enough for the shortest crossing
// Out past the curb, roughly the middle of the lots fronting the walk.
const PROBE_METERS: f64 = 15.0;
// Tolerance past the probe, so the far side of a wide street reaches ~27 m and nothing beyond.
const PROBE_TOLERANCE_METERS: f64 = 12.0;
const PROBE_REACH_METERS: f64 = PROBE_METERS + PROBE_TOLERANCE_METERS;

pub struct Industrial {
    pub bytes: Vec<u8>,
    pub polygons: usize, // the industrial lots the sampler read
    pub fronting: usize, // edges reading anything at all, for the build log
    pub mean: f64,       // the mean frontage fraction over the edges
    pub max_byte: u8,
}

/// One edge's frontage fraction: each side scores half where its probe lands in or near a lot.
fn frontage_fraction(
    poly: &[Coord],
    set: &PolygonSet,
    grid: &PolygonGrid,
    meters_per_degree_lng: f64,
    candidates: &mut Vec<u32>,
) -> f64 {
    if poly.len() < 2 {
        return 0.0;
    }

    let mut spans: Vec<f64> = Vec::with_capacity(poly.len() - 1);
    let mut total = 0.0;
    let mut clip = Bounds {
        south: f64::INFINITY,
        west: f64::INFINITY,
        north: f64::NEG_INFINITY,
        east: f64::NEG_INFINITY,
    };
    for pair in poly.windows(2) {
        let east = (pair[1].lng - pair[0].lng) * meters_per_degree_lng;
        let north = (pair[1].lat - pair[0].lat) * METERS_PER_DEGREE_LAT;
        let span = east.hypot(north);
        spans.push(span);
        total += span;
    }
    for point in poly {
        clip.south = clip.south.min(point.lat);
        clip.north = clip.north.max(point.lat);
        clip.west = clip.west.min(point.lng);
        clip.east = clip.east.max(point.lng);
    }
    // Grown by the probes' whole reach: the lots this edge fronts need not touch the walk itself.
    clip.south -= PROBE_REACH_METERS / METERS_PER_DEGREE_LAT;
    clip.north += PROBE_REACH_METERS / METERS_PER_DEGREE_LAT;
    clip.west -= PROBE_REACH_METERS / meters_per_degree_lng;
    clip.east += PROBE_REACH_METERS / meters_per_degree_lng;
    grid.candidates(&clip, candidates);
    if total <= 0.0 || candidates.is_empty() {
        return 0.0;
    }

    let samples = (total / SAMPLE_STEP_METERS).ceil().max(1.0) as usize;
    let step = total / samples as f64;
    let mut score = 0.0;
    let mut segment = 0usize;
    let mut behind = 0.0; // meters of the segments before `segment`
    for sample in 0..samples {
        let target = (sample as f64 + 0.5) * step;
        while segment + 1 < spans.len() && behind + spans[segment] < target {
            behind += spans[segment];
            segment += 1;
        }
        let span = spans[segment];
        if span <= 0.0 {
            continue; // a degenerate segment has no direction to probe across
        }
        let along = ((target - behind) / span).clamp(0.0, 1.0);
        let (start, end) = (poly[segment], poly[segment + 1]);
        let lng = start.lng + along * (end.lng - start.lng);
        let lat = start.lat + along * (end.lat - start.lat);
        // The segment's unit normal, taken out to the probe offset and back into degrees.
        let east = (end.lng - start.lng) * meters_per_degree_lng / span;
        let north = (end.lat - start.lat) * METERS_PER_DEGREE_LAT / span;
        let step_lng = -north * PROBE_METERS / meters_per_degree_lng;
        let step_lat = east * PROBE_METERS / METERS_PER_DEGREE_LAT;
        for (probe_lng, probe_lat) in [
            (lng + step_lng, lat + step_lat),
            (lng - step_lng, lat - step_lat),
        ] {
            if set.contains_or_near(
                candidates,
                probe_lng,
                probe_lat,
                PROBE_TOLERANCE_METERS,
                meters_per_degree_lng,
            ) {
                score += 0.5;
            }
        }
    }
    score / samples as f64
}

/// Every edge's frontage fraction in graph order; a deck reads 0, as a viaduct fronts nothing.
fn fractions(
    edge_polys: &[Vec<Coord>],
    on_structure: &[bool],
    set: &PolygonSet,
    grid: &PolygonGrid,
    meters_per_degree_lng: f64,
) -> Vec<f64> {
    edge_polys
        .par_iter()
        .zip(on_structure)
        .map_init(Vec::new, |candidates, (poly, &structure)| {
            if structure {
                0.0
            } else {
                frontage_fraction(poly, set, grid, meters_per_degree_lng, candidates)
            }
        })
        .collect()
}

/// The industrial byte of every edge.
pub fn industrial(
    edge_polys: &[Vec<Coord>],
    on_structure: &[bool],
    lots: &Path,
    reference_lat: f64,
) -> Fallible<Industrial> {
    let polygons = binfmt::read_polygons(lots, "INDL", binfmt::INDUSTRIAL_FORMAT)?;
    let count = polygons.len();
    let set = flatten(&polygons);
    drop(polygons);
    let grid = PolygonGrid::new(&set);
    let meters_per_degree_lng = METERS_PER_DEGREE_LAT * reference_lat.to_radians().cos();

    let fractions = fractions(edge_polys, on_structure, &set, &grid, meters_per_degree_lng);
    let mut bytes = vec![0u8; fractions.len()];
    let mut max_byte = 0u8;
    let mut fronting = 0usize;
    for (byte, fraction) in bytes.iter_mut().zip(&fractions) {
        *byte = round_half_up(fraction * 255.0).min(BYTE_CEILING) as u8;
        max_byte = max_byte.max(*byte);
        fronting += usize::from(*byte > 0);
    }
    let mean = if fractions.is_empty() {
        0.0
    } else {
        fractions.iter().sum::<f64>() / fractions.len() as f64
    };
    Ok(Industrial {
        bytes,
        polygons: count,
        fronting,
        mean,
        max_byte,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binfmt::Polygon;

    const LAT: f64 = 40.7;

    /// A point in meters from a reference in New York, so tests exercise the real cos(lat) scaling.
    fn at(east_meters: f64, north_meters: f64) -> Coord {
        Coord {
            lng: -74.0 + east_meters / meters_per_degree_lng(),
            lat: LAT + north_meters / METERS_PER_DEGREE_LAT,
        }
    }

    fn meters_per_degree_lng() -> f64 {
        METERS_PER_DEGREE_LAT * LAT.to_radians().cos()
    }

    /// An axis-aligned ring in meters, corners `(west, south)` to `(east, north)`.
    fn rectangle(west: f64, south: f64, east: f64, north: f64) -> Vec<Coord> {
        vec![
            at(west, south),
            at(east, south),
            at(east, north),
            at(west, north),
        ]
    }

    /// The fraction of a 100 m east-west walk along the reference latitude that fronts `lots`.
    fn walk_fraction(lots: &[Polygon]) -> f64 {
        fraction_of(&[at(0.0, 0.0), at(100.0, 0.0)], lots, false)
    }

    fn fraction_of(poly: &[Coord], lots: &[Polygon], structure: bool) -> f64 {
        let set = flatten(lots);
        let grid = PolygonGrid::new(&set);
        fractions(
            &[poly.to_vec()],
            &[structure],
            &set,
            &grid,
            meters_per_degree_lng(),
        )[0]
    }

    fn byte_of(fraction: f64) -> u8 {
        round_half_up(fraction * 255.0).min(BYTE_CEILING) as u8
    }

    #[test]
    fn a_walk_through_a_yard_fronts_it_on_both_sides() {
        let fraction = walk_fraction(&[vec![rectangle(-50.0, -50.0, 150.0, 50.0)]]);

        assert_eq!(fraction, 1.0);
        assert_eq!(byte_of(fraction), 254);
    }

    #[test]
    fn a_yard_on_one_side_scores_half_of_one_on_both() {
        let north = walk_fraction(&[vec![rectangle(-50.0, 5.0, 150.0, 200.0)]]);
        let both = walk_fraction(&[
            vec![rectangle(-50.0, 5.0, 150.0, 200.0)],
            vec![rectangle(-50.0, -200.0, 150.0, -5.0)],
        ]);

        assert_eq!(north, 0.5);
        assert_eq!(both, 1.0);
        assert_eq!(byte_of(north), 128); // 127.5, rounded half up as every other byte is
    }

    #[test]
    fn a_walk_away_from_every_lot_fronts_nothing() {
        // 100 m north of the probe's own reach, which stops at 27 m.
        assert_eq!(
            walk_fraction(&[vec![rectangle(-50.0, 100.0, 150.0, 200.0)]]),
            0.0
        );
    }

    /// The reach is a tolerance: a lot across a wide street counts, one a block back doesn't.
    #[test]
    fn the_reach_stops_one_roadway_out() {
        assert_eq!(
            walk_fraction(&[vec![rectangle(-50.0, 26.0, 150.0, 200.0)]]),
            0.5
        );
        assert_eq!(
            walk_fraction(&[vec![rectangle(-50.0, 28.0, 150.0, 200.0)]]),
            0.0
        );
    }

    /// INDL keeps inner rings and containment is even-odd, so a doughnut's hole is outside.
    #[test]
    fn a_walk_in_a_lot_s_hole_fronts_nothing() {
        let doughnut = vec![
            rectangle(-200.0, -200.0, 300.0, 200.0),
            rectangle(-100.0, -100.0, 200.0, 100.0),
        ];

        assert_eq!(walk_fraction(&[doughnut.clone()]), 0.0);
        // The same lot walked through its solid part, between the hole and the outer ring.
        assert_eq!(
            fraction_of(&[at(0.0, 150.0), at(100.0, 150.0)], &[doughnut], false),
            1.0
        );
    }

    #[test]
    fn a_bridge_over_a_yard_does_not_front_it() {
        let yard = vec![vec![rectangle(-50.0, -50.0, 150.0, 50.0)]];

        assert_eq!(
            fraction_of(&[at(0.0, 0.0), at(100.0, 0.0)], &yard, true),
            0.0
        );
    }

    /// A depot at one end prices only its share; the tolerance dilates 20 m of lot to 32 m.
    #[test]
    fn a_single_depot_prices_only_the_length_it_fronts() {
        let fraction = walk_fraction(&[vec![rectangle(0.0, 5.0, 20.0, 200.0)]]);

        assert!(
            (fraction - 0.16).abs() < 0.005,
            "a depot on a fifth of one side reads {fraction}"
        );
    }
}

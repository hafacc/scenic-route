//! The per-edge bridge byte (GRPH record byte 38): the share of a walk that crosses open water on a
//! bridge deck.
//!
//! The graph's structure flag (`GRPH_STRUCTURE`) says an edge is on a bridge OR TUNNEL deck and
//! nothing finer, and that is not by itself the thing worth walking: a tunnel runs under the ground,
//! and a viaduct over a rail yard or an expressway runs over it. What separates the crossing of a
//! river from either is what lies beneath the deck, so the deck's own polyline is tested against the
//! city's land mask — the same LAND outlines the overlays are clipped to — and the byte is the share
//! of its length that is NOT over land. Everything off a deck reads 0, so a street that merely runs
//! along a shore is priced by what it is rather than by where it is.
//!
//! Measured with `geometry::contained_fraction`, as the historic-district byte is: both are asking
//! what the walk itself is over, which is an underfoot question, and neither has anything to probe
//! sideways for.

use std::path::Path;

use rayon::prelude::*;

use crate::Fallible;
use crate::binfmt::{self, Coord};
use crate::geometry::{METERS_PER_DEGREE_LAT, PolygonGrid, PolygonSet, flatten, round_half_up};
use crate::sampling::contained_fraction;

const BYTE_CEILING: f64 = 254.0; // as the cover, scenic and historic bytes

pub struct Bridge {
    pub bytes: Vec<u8>,
    pub polygons: usize, // the land parts the sampler read
    pub decks: usize,    // deck edges reading anything at all
    pub over_water_meters: f64,
    pub max_byte: u8,
}

/// Every edge's over-water share, in the graph's edge order. A deck whose whole bounding box misses
/// the land mask gathers no candidate outline, which `contained_fraction` answers 0 to and which
/// here reads as the open water it is — the middle of a long span is exactly that case.
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
        .map_init(Vec::new, |candidates, (poly, deck)| {
            if !deck || poly.len() < 2 {
                0.0
            } else {
                1.0 - contained_fraction(poly, set, grid, meters_per_degree_lng, candidates)
            }
        })
        .collect()
}

/// The bridge byte of every edge. `reference_lat` is the graph origin's latitude, the one east-west
/// scale the whole city is measured at, as the other per-edge bakes use.
pub fn bridge(
    edge_polys: &[Vec<Coord>],
    on_structure: &[bool],
    lengths: &[f32],
    land: &Path,
    reference_lat: f64,
) -> Fallible<Bridge> {
    let polygons = binfmt::read_polygons(land, "LAND", binfmt::LAND_FORMAT)?;
    let count = polygons.len();
    let set = flatten(&polygons);
    drop(polygons);
    let grid = PolygonGrid::new(&set);
    let meters_per_degree_lng = METERS_PER_DEGREE_LAT * reference_lat.to_radians().cos();
    let fractions = fractions(edge_polys, on_structure, &set, &grid, meters_per_degree_lng);
    Ok(column(&fractions, lengths, count))
}

/// The measured shares as the record carries them, with the figures the build log reports.
fn column(fractions: &[f64], lengths: &[f32], polygons: usize) -> Bridge {
    let mut bytes = vec![0u8; fractions.len()];
    let mut max_byte = 0u8;
    let mut decks = 0usize;
    let mut over_water_meters = 0.0;
    for (index, (byte, fraction)) in bytes.iter_mut().zip(fractions).enumerate() {
        *byte = round_half_up(fraction * 255.0).min(BYTE_CEILING) as u8;
        max_byte = max_byte.max(*byte);
        decks += usize::from(*byte > 0);
        over_water_meters += fraction * f64::from(lengths[index]);
    }
    Bridge {
        bytes,
        polygons,
        decks,
        over_water_meters,
        max_byte,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binfmt::Polygon;

    const LAT: f64 = 40.7;

    fn meters_per_degree_lng() -> f64 {
        METERS_PER_DEGREE_LAT * LAT.to_radians().cos()
    }

    /// A point `east_meters` east and `north_meters` north of a reference in the middle of New York,
    /// so the tests read in metres and still exercise the cos(lat) scaling of the real bake.
    fn at(east_meters: f64, north_meters: f64) -> Coord {
        Coord {
            lng: -74.0 + east_meters / meters_per_degree_lng(),
            lat: LAT + north_meters / METERS_PER_DEGREE_LAT,
        }
    }

    /// An axis-aligned ring in metres, corners `(west, south)` to `(east, north)`.
    fn rectangle(west: f64, south: f64, east: f64, north: f64) -> Vec<Coord> {
        vec![
            at(west, south),
            at(east, south),
            at(east, north),
            at(west, north),
        ]
    }

    /// The share of a 100 m east-west deck (or, with `deck` false, ordinary street) at the reference
    /// latitude that runs over water.
    fn water_share(deck: bool, land: &[Polygon]) -> f64 {
        let set = flatten(land);
        let grid = PolygonGrid::new(&set);
        let poly = vec![at(0.0, 0.0), at(100.0, 0.0)];
        fractions(&[poly], &[deck], &set, &grid, meters_per_degree_lng())[0]
    }

    fn byte_of(fraction: f64) -> u8 {
        round_half_up(fraction * 255.0).min(BYTE_CEILING) as u8
    }

    /// The measurement the whole factor rests on: land under the western half of the deck and open
    /// water under the eastern half reads half a bridge.
    #[test]
    fn a_deck_half_over_water_reads_half() {
        let share = water_share(true, &[vec![rectangle(-50.0, -50.0, 50.0, 50.0)]]);

        assert!((share - 0.5).abs() < 0.01, "half a deck reads {share}");
        // The fixture's deck is a hair over 100 m once its degrees are metres, so it takes 101
        // samples rather than 100 and the share lands a step either side of half.
        assert!(
            matches!(byte_of(share), 127..=129),
            "{share} reads {}",
            byte_of(share)
        );
    }

    /// What the land mask is here to rule out: a viaduct over a rail yard or an expressway is on a
    /// deck for its whole length and over the ground for all of it.
    #[test]
    fn a_deck_over_land_is_not_a_bridge() {
        assert_eq!(
            water_share(true, &[vec![rectangle(-50.0, -50.0, 150.0, 50.0)]]),
            0.0
        );
    }

    /// The same test the structure flag cannot make on its own: a tunnel carries it and passes under
    /// the land, which is land under the line exactly as a viaduct's yard is.
    #[test]
    fn a_tunnel_under_land_is_not_a_bridge() {
        assert_eq!(
            water_share(true, &[vec![rectangle(-1000.0, -1000.0, 1000.0, 1000.0)]]),
            0.0
        );
    }

    /// Nothing off a deck is ever a bridge, whatever is under it — a street on a pier is a street.
    #[test]
    fn a_street_over_water_reads_nothing() {
        assert_eq!(
            water_share(false, &[vec![rectangle(-50.0, -50.0, 0.0, 50.0)]]),
            0.0
        );
    }

    /// A span whose whole box misses the mask has no candidate outline to test, and the open water
    /// that leaves is the answer rather than a gap in it.
    #[test]
    fn a_deck_far_from_any_shore_is_all_water() {
        assert_eq!(
            water_share(
                true,
                &[vec![rectangle(10_000.0, 10_000.0, 11_000.0, 11_000.0)]]
            ),
            1.0
        );
    }

    /// A ferry carries no polyline, and must not lift the graph-wide max the A* floor is taken from.
    #[test]
    fn an_edge_with_no_polyline_reads_nothing() {
        let land = [vec![rectangle(-50.0, -50.0, 50.0, 50.0)]];
        let set = flatten(&land);
        let grid = PolygonGrid::new(&set);

        assert_eq!(
            fractions(&[Vec::new()], &[true], &set, &grid, meters_per_degree_lng())[0],
            0.0
        );
    }

    /// The column the record carries: the byte follows the measured share, only a deck counts, and
    /// the metres reported are the share of each deck's own length.
    #[test]
    fn the_column_counts_only_the_decks_it_measured() {
        let baked = column(&[0.5, 0.0, 1.0], &[100.0, 100.0, 40.0], 7);

        assert_eq!(baked.decks, 2);
        assert_eq!(baked.bytes, vec![128, 0, 254]);
        assert_eq!(baked.max_byte, 254);
        assert_eq!(baked.polygons, 7);
        assert!(
            (baked.over_water_meters - 90.0).abs() < 1e-9,
            "{} m over water",
            baked.over_water_meters
        );
    }
}

//! Per-edge bridge byte (GRPH byte 38): the share of a deck's length not over land.

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

/// Every edge's over-water share in graph order; a deck that misses the land mask reads open water.
fn fractions(
    edge_polys: &[Vec<Coord>],
    on_bridge: &[bool],
    set: &PolygonSet,
    grid: &PolygonGrid,
    meters_per_degree_lng: f64,
) -> Vec<f64> {
    edge_polys
        .par_iter()
        .zip(on_bridge)
        .map_init(Vec::new, |candidates, (poly, deck)| {
            if !deck || poly.len() < 2 {
                0.0
            } else {
                1.0 - contained_fraction(poly, set, grid, meters_per_degree_lng, candidates)
            }
        })
        .collect()
}

/// The bridge byte of every edge; `on_bridge` excludes tunnels.
pub fn bridge(
    edge_polys: &[Vec<Coord>],
    on_bridge: &[bool],
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
    let fractions = fractions(edge_polys, on_bridge, &set, &grid, meters_per_degree_lng);
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

    /// A point in meters from a reference in New York, so tests exercise the real cos(lat) scaling.
    fn at(east_meters: f64, north_meters: f64) -> Coord {
        Coord {
            lng: -74.0 + east_meters / meters_per_degree_lng(),
            lat: LAT + north_meters / METERS_PER_DEGREE_LAT,
        }
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

    /// The water share of a 100 m east-west deck (or street, with `deck` false).
    fn water_share(deck: bool, land: &[Polygon]) -> f64 {
        let set = flatten(land);
        let grid = PolygonGrid::new(&set);
        let poly = vec![at(0.0, 0.0), at(100.0, 0.0)];
        fractions(&[poly], &[deck], &set, &grid, meters_per_degree_lng())[0]
    }

    fn byte_of(fraction: f64) -> u8 {
        round_half_up(fraction * 255.0).min(BYTE_CEILING) as u8
    }

    /// Land under the deck's western half and water under its eastern half reads half a bridge.
    #[test]
    fn a_deck_half_over_water_reads_half() {
        let share = water_share(true, &[vec![rectangle(-50.0, -50.0, 50.0, 50.0)]]);

        assert!((share - 0.5).abs() < 0.01, "half a deck reads {share}");
        // The deck is a hair over 100 m, so it takes 101 samples and lands a step off half.
        assert!(
            matches!(byte_of(share), 127..=129),
            "{share} reads {}",
            byte_of(share)
        );
    }

    /// A viaduct over a rail yard is on a deck over ground for its whole length.
    #[test]
    fn a_deck_over_land_is_not_a_bridge() {
        assert_eq!(
            water_share(true, &[vec![rectangle(-50.0, -50.0, 150.0, 50.0)]]),
            0.0
        );
    }

    /// A tunnel carries the structure flag but passes under land, so it reads as a viaduct does.
    #[test]
    fn a_tunnel_under_land_is_not_a_bridge() {
        assert_eq!(
            water_share(true, &[vec![rectangle(-1000.0, -1000.0, 1000.0, 1000.0)]]),
            0.0
        );
    }

    /// Nothing off a deck is a bridge: a street on a pier is a street.
    #[test]
    fn a_street_over_water_reads_nothing() {
        assert_eq!(
            water_share(false, &[vec![rectangle(-50.0, -50.0, 0.0, 50.0)]]),
            0.0
        );
    }

    /// A span whose box misses the mask has no candidate outline and reads as open water.
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

    /// A ferry carries no polyline and must not lift the graph-wide max the A* floor uses.
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

    /// The byte follows the share, only decks count, and the meters are per deck.
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

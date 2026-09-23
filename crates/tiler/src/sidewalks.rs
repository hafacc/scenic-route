//! Sidewalk positions and street bearings: the field is sampled once either side of the centerline.

use crate::geometry::Bearing;

const METERS_PER_FOOT: f64 = 0.3048;
const MEDIAN_WIDTH_FEET: f64 = 30.0; // what the 2% of streets carrying no width fall back to
const STREET: u8 = 1;
const BRIDGE: u8 = 3;
const TUNNEL: u8 = 4;
const ALLEY: u8 = 10;
// The chunk carries the offset as a byte of decimeters, which caps the drawable roadway width.
const MAX_OFFSET_METERS: f64 = 25.5;

// STRT record byte 23, bit 1: a pedestrian/bike deck, sampled on its own line rather than offset.
pub const FLAG_NON_VEHICULAR: u8 = 1 << 1;

/// Meters from the centerline to each sidewalk; zero for walking surfaces and non-vehicular decks.
pub fn half_offset_meters(road_type: u8, flags: u8, width_feet: u8, inset_meters: f64) -> f64 {
    let width_based =
        road_type == STREET || road_type == ALLEY || road_type == BRIDGE || road_type == TUNNEL;
    if width_based && flags & FLAG_NON_VEHICULAR == 0 {
        let feet = if width_feet == 0 {
            MEDIAN_WIDTH_FEET
        } else {
            f64::from(width_feet)
        };
        (feet * METERS_PER_FOOT / 2.0 + inset_meters).min(MAX_OFFSET_METERS)
    } else {
        0.0
    }
}

/// The unit tangent at each vertex, over the nearest distinct neighbors: CSCL vertices can coincide.
pub fn bearings(xs: &[f64], ys: &[f64]) -> Vec<Bearing> {
    let same = |left: usize, right: usize| xs[left] == xs[right] && ys[left] == ys[right];
    (0..xs.len())
        .map(|vertex| {
            let mut back = vertex;
            while back > 0 && same(back, vertex) {
                back -= 1;
            }
            let mut ahead = vertex;
            while ahead + 1 < xs.len() && same(ahead, vertex) {
                ahead += 1;
            }
            let delta_x = xs[ahead] - xs[back];
            let delta_y = ys[ahead] - ys[back];
            let length = delta_x.hypot(delta_y);
            // Unreachable, since the ingest drops sub-meter segments; keeps a NaN out of the field.
            if length > 0.0 {
                Bearing {
                    along_x: delta_x / length,
                    along_y: delta_y / length,
                }
            } else {
                Bearing {
                    along_x: 1.0,
                    along_y: 0.0,
                }
            }
        })
        .collect()
}

/// The unit normal toward the left sidewalk; left follows CSCL's `l_`/`r_` drawing direction.
pub fn left_normal(bearing: Bearing) -> (f64, f64) {
    (-bearing.along_y, bearing.along_x)
}

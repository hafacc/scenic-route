//! Per-edge ascent and descent bytes, summed along the polyline a->b rather than end to end.

use crate::Fallible;
use crate::binfmt::Coord;
use crate::dem::Field;

/// The grade the byte spans, clearing San Francisco's ~31.5% steepest blocks so nothing saturates.
const REFERENCE_GRADE: f64 = 0.35;

const MAX_BYTE: f64 = 254.0;

/// The shortest run a grade is taken over, so a 1 m curb link spanning 3 m isn't 300%.
const MIN_GRADE_METERS: f64 = 10.0;

pub struct Relief {
    pub ascent: Vec<u8>,
    pub descent: Vec<u8>,
    pub measured: usize,
    pub mean_grade: f64,
    pub max_grade: f64,
}

/// Height climbed and dropped along a polyline a->b, or None with under two readings.
fn climb_of(polyline: &[Coord], field: &Field) -> Option<(f64, f64)> {
    if polyline.len() < 2 {
        return None;
    }
    let mut climbed = 0.0;
    let mut dropped = 0.0;
    let mut previous: Option<f32> = None;
    let mut samples = 0usize;
    for point in polyline {
        let height = field.sample(point.lng, point.lat);
        if !height.is_finite() {
            // A gap breaks the chain rather than being bridged, or every shore reads as a cliff.
            previous = None;
            continue;
        }
        if let Some(last) = previous {
            let step = f64::from(height - last);
            if step >= 0.0 {
                climbed += step;
            } else {
                dropped -= step;
            }
        }
        previous = Some(height);
        samples += 1;
    }
    if samples < 2 {
        None
    } else {
        Some((climbed, dropped))
    }
}

/// Ascent and descent bytes for every edge; `mean_grade` and `max_grade` are over their sum.
pub fn relief(polylines: &[Vec<Coord>], lengths: &[f32], field: &Field) -> Fallible<Relief> {
    let mut ascent = vec![0u8; polylines.len()];
    let mut descent = vec![0u8; polylines.len()];
    let mut measured = 0usize;
    let mut grade_sum = 0.0;
    let mut max_grade = 0.0_f64;
    let to_byte = |grade: f64| ((grade / REFERENCE_GRADE).clamp(0.0, 1.0) * MAX_BYTE).round() as u8;
    for (edge, polyline) in polylines.iter().enumerate() {
        let Some((climbed, dropped)) = climb_of(polyline, field) else {
            continue;
        };
        let length = f64::from(lengths[edge]).max(MIN_GRADE_METERS);
        let grade = (climbed + dropped) / length;
        measured += 1;
        grade_sum += grade;
        max_grade = max_grade.max(grade);
        // Each byte clamps on its own, so a crest can carry 35% of climb and 35% of drop.
        ascent[edge] = to_byte(climbed / length);
        descent[edge] = to_byte(dropped / length);
    }
    Ok(Relief {
        ascent,
        descent,
        measured,
        mean_grade: if measured > 0 {
            grade_sum / measured as f64
        } else {
            0.0
        },
        max_grade,
    })
}

#[cfg(test)]
mod tests {
    use super::{REFERENCE_GRADE, relief};
    use crate::binfmt::Coord;
    use crate::dem::Field;

    /// A one-degree-wide field of four cells running west to east at the given heights.
    fn ramp(heights: [f32; 4]) -> Field {
        Field::from_grid(0.0, 1.0, 1.0, 1.0, 4, 1, heights.to_vec())
    }

    /// An edge far shorter than a cell must climb far less than the cell's height step.
    #[test]
    fn a_short_edge_climbs_in_proportion_to_its_length() {
        // Two cells 10 m apart in height, and an edge crossing a tenth of the gap between them.
        let field = ramp([0.0, 10.0, 20.0, 30.0]);
        let short = vec![Coord { lng: 1.5, lat: 0.5 }, Coord { lng: 1.6, lat: 0.5 }];
        let baked = relief(&[short], &[100.0], &field).unwrap();
        assert!(
            baked.ascent[0] < 40,
            "a tenth-of-a-cell edge read {} of 254; nearest-cell sampling would saturate it",
            baked.ascent[0]
        );
    }

    fn along(count: usize) -> Vec<Coord> {
        (0..count)
            .map(|step| Coord {
                lng: step as f64 + 0.5,
                lat: 0.5,
            })
            .collect()
    }

    /// A block that climbs 10 m and returns reads 10% of climb and 10% of drop over its 100 m.
    #[test]
    fn a_crest_is_not_flat() {
        let field = ramp([0.0, 10.0, 0.0, 0.0]);
        let baked = relief(&[along(3)], &[100.0], &field).unwrap();
        let tenth = ((0.1 / REFERENCE_GRADE) * 254.0).round() as u8;
        assert_eq!(baked.ascent[0], tenth);
        assert_eq!(baked.descent[0], tenth);
        assert!((baked.max_grade - 0.2).abs() < 1e-6);
    }

    /// Reversing the polyline swaps the bytes and leaves their sum, which the hill penalty reads.
    #[test]
    fn reversing_swaps_ascent_and_descent() {
        let field = ramp([0.0, 3.0, 6.0, 9.0]);
        let forward = along(4);
        let backward: Vec<Coord> = forward.iter().rev().copied().collect();
        let baked = relief(&[forward, backward], &[400.0, 400.0], &field).unwrap();
        assert!(baked.ascent[0] > 0);
        assert_eq!(baked.descent[0], 0);
        assert_eq!(baked.descent[1], baked.ascent[0]);
        assert_eq!(baked.ascent[1], baked.descent[0]);
    }

    /// A gap breaks the chain rather than being bridged, so a shoreline doesn't read as a cliff.
    #[test]
    fn a_gap_does_not_invent_a_cliff() {
        let field = ramp([0.0, f32::NAN, 0.0, 50.0]);
        let baked = relief(&[along(3)], &[100.0], &field).unwrap();
        assert_eq!(baked.ascent[0], 0, "the two 0 m readings are level");
        assert_eq!(baked.descent[0], 0);
    }

    /// Each byte saturates on its own, so a steep crest reads 35% of climb and 35% of drop.
    #[test]
    fn each_byte_saturates_at_the_reference_grade() {
        let field = ramp([0.0, 6.0, 0.0, 0.0]);
        let climbed = 6.0;
        let length = climbed / REFERENCE_GRADE;
        let baked = relief(&[along(3)], &[length as f32], &field).unwrap();
        assert_eq!(baked.ascent[0], 254);
        assert_eq!(baked.descent[0], 254);
        assert!((baked.max_grade - 2.0 * REFERENCE_GRADE).abs() < 1e-6);

        let baked = relief(&[along(3)], &[(2.0 * length) as f32], &field).unwrap();
        assert_eq!(
            baked.ascent[0], 127,
            "half the reference grade is half the byte"
        );
    }
}

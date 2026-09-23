//! Cuts tree crowns into the nested rings both the shade pyramid and the client's sweep cast from.

use cavalier_contours::polyline::{
    PlineCreation, PlineOffsetOptions, PlineSource, PlineSourceMut, Polyline,
};
use rayon::prelude::*;

use crate::binfmt::{Coord, Polygon, Ring};
use crate::geometry::METERS_PER_DEGREE_LAT;

/// Crown base as a share of tree height; the shadow casts from this span, not the polygon's height.
/// Assumed from a 0.39-0.60 hardwood crown ratio (Russell & Weiskittel 2011, Table 1).
pub const CROWN_BASE_FRACTION: f64 = 0.4;

/// Where the crown is widest, as a share of tree height; the trunk stands up to here.
pub const CROWN_WIDEST_FRACTION: f64 = (1.0 + CROWN_BASE_FRACTION) / 2.0;

/// Bands a crown is cut into; a caster may use only a divisor, since the insets ship at fixed levels.
pub const CROWN_SEGMENTS: usize = 4;

/// How far up the half-height the innermost ring sits; short of 1.0, where the spheroid is a point.
const CROWN_TIP_FRACTION: f64 = 0.99;

// Arc length the outline is resampled at before its curvature is read.
const RESAMPLE_METERS: f64 = 1.0;
// Smoothing half-width; separates crown radii (2.5-8 m) from the 1-foot raster staircase's noise.
const SMOOTH_METERS: f64 = 2.0;
// Smoothing windows per curvature chord; two is what the disc test settles on.
const CHORD_WINDOWS: usize = 2;
// Radius guard rails: below is raster noise, above is outline too straight to be a crown.
const MIN_RADIUS_METERS: f64 = 1.0;
const MAX_RADIUS_METERS: f64 = 30.0;
// Below this many samples an outline is one small crown of radius `perimeter / 2 pi`.
const MIN_SAMPLES: usize = 12;

// Douglas-Peucker tolerance for every ring (2/3 of a z17 pixel), applied here so both halves agree.
const CROWN_SIMPLIFY_METERS: f64 = 0.6;
// Chord tolerance for arcs an inward offset opens at concave corners.
const JOIN_ARC_METERS: f64 = 0.05;
// Vertices closer than this are one; a repeated position has no direction to offset along.
const REPEAT_POSITION_METERS: f64 = 1e-6;

// Pixels of smear one slice may step by; a shorter smear takes a single slice.
const SMEAR_PIXELS_PER_SEGMENT: f64 = 2.0;

/// One crown, cut: `levels[j]` is the outline inset to `radius_m * ring_share(j)`, in 1+ rings.
pub struct Crown {
    pub levels: Vec<Vec<Ring>>,
    pub radius_m: f64, // radius of the crowns forming the outline, from its curvature
}

/// One swept slice: an inset level and the two shadow displacements (m) to sweep it between.
pub struct Segment {
    pub level: usize,
    pub from_m: f64,
    pub to_m: f64,
}

/// Slice `level`'s offset from the widest section in half-heights, spaced at even heights.
fn band_offset(level: usize) -> f64 {
    level as f64 / (CROWN_SEGMENTS - 1) as f64 * CROWN_TIP_FRACTION
}

/// Slice `level`'s radius as a share of the crown's: the spheroid profile `sqrt(1 - u^2)`.
fn ring_share(level: usize) -> f64 {
    (1.0 - band_offset(level).powi(2)).max(0.0).sqrt()
}

/// The slices one crown's shadow sweeps for one sun and resolution; empty if it casts nothing.
/// The crown is a spheroid; rings are spaced by equal height, since equal inset renders a bar.
pub fn crown_segments(
    height_m: f64,
    shadow_per_height: f64,
    max_shadow_meters: f64,
    meters_per_pixel: f64,
) -> Vec<Segment> {
    if height_m <= 0.0 || shadow_per_height <= 0.0 {
        return Vec::new();
    }
    let smear_m = (1.0 - CROWN_BASE_FRACTION) * height_m * shadow_per_height;
    let wanted = (smear_m / meters_per_pixel / SMEAR_PIXELS_PER_SEGMENT).ceil();
    // Halved to a divisor of CROWN_SEGMENTS so both halves stay on the same shipped rings.
    let mut count = CROWN_SEGMENTS;
    while count > 1 && (count / 2) as f64 >= wanted {
        count /= 2;
    }
    let stride = CROWN_SEGMENTS / count;
    let middle = CROWN_WIDEST_FRACTION;
    let half_height = (1.0 - CROWN_BASE_FRACTION) / 2.0;
    let displacement = |share_of_height: f64| {
        (share_of_height * height_m * shadow_per_height).min(max_shadow_meters)
    };
    let mut segments = Vec::with_capacity(count);
    for slice in 0..count {
        let level = slice * stride;
        let half = band_offset(level);
        let from_m = displacement(middle - half_height * half);
        let to_m = displacement(middle + half_height * half);
        // Slice 0 spans one height and sweeps nothing; past the clip its ring covers all the others.
        if to_m > from_m || slice == 0 {
            segments.push(Segment {
                level,
                from_m,
                to_m,
            });
        }
    }
    segments
}

/// Every crown cut, in the canopy file's order; parallel since insetting is the costly part.
pub fn slice_crowns(crowns: &[Polygon]) -> Vec<Crown> {
    crowns
        .par_iter()
        .map(|crown| match crown.first() {
            Some(outer) if outer.len() >= 3 => crown_slices(outer),
            _ => Crown {
                levels: Vec::new(),
                radius_m: 0.0,
            },
        })
        .collect()
}

/// One outline cut into its nested rings.
/// Simplify before insetting: an offset opens each raster step into an arc that bites the ring.
pub fn crown_slices(outer: &Ring) -> Crown {
    let frame = Frame::of(outer);
    let meters = frame.to_meters(outer);
    let radius_m = curvature_radius(&meters);
    let insets: Vec<f64> = (1..CROWN_SEGMENTS)
        .map(|level| radius_m * (1.0 - ring_share(level)))
        .collect();
    let outline = simplified_or_whole(&meters);
    let mut levels = Vec::with_capacity(CROWN_SEGMENTS);
    levels.push(vec![frame.to_degrees(&outline)]);
    // Cut from the exact trace, since simplifying may drop the neck separating two crowns.
    for inset in offset_rings(&meters, &insets) {
        levels.push(inset.iter().map(|ring| frame.to_degrees(ring)).collect());
    }
    Crown { levels, radius_m }
}

/// A ring simplified, or kept whole if simplifying would leave it below a triangle.
fn simplified_or_whole(points: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let simplified = simplify_closed(points, CROWN_SIMPLIFY_METERS);
    if simplified.len() >= 3 {
        simplified
    } else {
        points.to_vec()
    }
}

/// The upper edge of each histogram bucket the build log reports the radii in.
pub const RADIUS_BUCKETS: [f64; 9] = [1.25, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 20.0, MAX_RADIUS_METERS];

/// Crown counts per `RADIUS_BUCKETS` bucket plus the top clamp; a peak at a guard rail means noise.
pub fn radius_histogram(crowns: &[Crown]) -> Vec<usize> {
    let mut counts = vec![0usize; RADIUS_BUCKETS.len() + 1];
    for crown in crowns.iter().filter(|crown| !crown.levels.is_empty()) {
        let bucket = RADIUS_BUCKETS
            .iter()
            .position(|edge| crown.radius_m < *edge)
            .unwrap_or(RADIUS_BUCKETS.len());
        counts[bucket] += 1;
    }
    counts
}

/// The local meter space one crown is cut in, origin at its first vertex; lossless at decimeters.
struct Frame {
    lng: f64,
    lat: f64,
    meters_per_lng: f64,
}

impl Frame {
    fn of(ring: &Ring) -> Self {
        let Coord { lng, lat } = ring[0];
        Self {
            lng,
            lat,
            meters_per_lng: METERS_PER_DEGREE_LAT * lat.to_radians().cos(),
        }
    }

    /// The ring in meters, wound positively as the curvature and the tracer both expect.
    fn to_meters(&self, ring: &Ring) -> Vec<(f64, f64)> {
        let mut points: Vec<(f64, f64)> = ring
            .iter()
            .map(|point| {
                (
                    (point.lng - self.lng) * self.meters_per_lng,
                    (point.lat - self.lat) * METERS_PER_DEGREE_LAT,
                )
            })
            .collect();
        if signed_double_area(&points) < 0.0 {
            points.reverse();
        }
        points
    }

    fn to_degrees(&self, points: &[(f64, f64)]) -> Ring {
        points
            .iter()
            .map(|(x, y)| Coord {
                lng: self.lng + x / self.meters_per_lng,
                lat: self.lat + y / METERS_PER_DEGREE_LAT,
            })
            .collect()
    }
}

fn signed_double_area(points: &[(f64, f64)]) -> f64 {
    let mut sum = 0.0;
    let mut previous = points.len() - 1;
    for current in 0..points.len() {
        sum += (points[current].0 - points[previous].0) * (points[current].1 + points[previous].1);
        previous = current;
    }
    -sum
}

/// The radius of the crowns forming an outline, from how sharply it turns.
/// A turning-weighted median of `ds / dtheta` across chords, since means and neighbors mislead.
fn curvature_radius(points: &[(f64, f64)]) -> f64 {
    let perimeter = closed_length(points);
    let samples = (perimeter / RESAMPLE_METERS).round() as usize;
    if samples < MIN_SAMPLES {
        return (perimeter / std::f64::consts::TAU).clamp(MIN_RADIUS_METERS, MAX_RADIUS_METERS);
    }
    let traced = resample_closed(points, samples, perimeter);
    let window = ((SMOOTH_METERS * samples as f64 / perimeter).round() as usize).max(1);
    let smoothed = circular_mean(&traced, window);
    let chord = (window * CHORD_WINDOWS).min(samples / 3).max(1);

    let mut turns: Vec<(f64, f64)> = Vec::with_capacity(samples);
    let mut total = 0.0;
    for index in 0..samples {
        let previous = smoothed[(index + samples - chord) % samples];
        let here = smoothed[index];
        let next = smoothed[(index + chord) % samples];
        let (into_x, into_y) = (here.0 - previous.0, here.1 - previous.1);
        let (out_x, out_y) = (next.0 - here.0, next.1 - here.1);
        let turn = f64::atan2(
            into_x * out_y - into_y * out_x,
            into_x * out_x + into_y * out_y,
        );
        if turn > 0.0 {
            let span = (f64::hypot(into_x, into_y) + f64::hypot(out_x, out_y)) / 2.0;
            let radius =
                (span / (2.0 * (turn / 2.0).sin())).clamp(MIN_RADIUS_METERS, MAX_RADIUS_METERS);
            total += turn;
            turns.push((radius, turn));
        }
    }
    if turns.is_empty() {
        return (perimeter / std::f64::consts::TAU).clamp(MIN_RADIUS_METERS, MAX_RADIUS_METERS);
    }
    turns.sort_by(|left, right| left.0.total_cmp(&right.0));
    let mut carried = 0.0;
    for (radius, turn) in &turns {
        carried += turn;
        if carried >= total / 2.0 {
            return *radius;
        }
    }
    turns[turns.len() - 1].0
}

fn closed_length(points: &[(f64, f64)]) -> f64 {
    let mut length = 0.0;
    let mut previous = points.len() - 1;
    for current in 0..points.len() {
        length += f64::hypot(
            points[current].0 - points[previous].0,
            points[current].1 - points[previous].1,
        );
        previous = current;
    }
    length
}

/// `count` points spaced evenly by arc length around the closed ring, starting at its first vertex.
fn resample_closed(points: &[(f64, f64)], count: usize, perimeter: f64) -> Vec<(f64, f64)> {
    let step = perimeter / count as f64;
    let segment = |at: usize| {
        let next = (at + 1) % points.len();
        (
            points[at],
            (points[next].0 - points[at].0, points[next].1 - points[at].1),
        )
    };
    let mut traced = Vec::with_capacity(count);
    let mut at = 0usize; // the segment the walk is on, from points[at] to its successor
    let mut walked = 0.0; // arc length consumed before it
    let mut span = f64::hypot(segment(0).1.0, segment(0).1.1);
    for sample in 0..count {
        let target = sample as f64 * step;
        while walked + span < target && at + 1 < points.len() {
            walked += span;
            at += 1;
            let (_, delta) = segment(at);
            span = f64::hypot(delta.0, delta.1);
        }
        let (from, delta) = segment(at);
        let along = if span > 0.0 {
            ((target - walked) / span).clamp(0.0, 1.0)
        } else {
            0.0
        };
        traced.push((from.0 + delta.0 * along, from.1 + delta.1 * along));
    }
    traced
}

/// Each point averaged with the `window` points either side around the ring, via prefix sums.
fn circular_mean(points: &[(f64, f64)], window: usize) -> Vec<(f64, f64)> {
    let count = points.len();
    let width = 2 * window + 1;
    let mut prefix: Vec<(f64, f64)> = Vec::with_capacity(count + 1);
    prefix.push((0.0, 0.0));
    for (x, y) in points {
        let (carried_x, carried_y) = prefix[prefix.len() - 1];
        prefix.push((carried_x + x, carried_y + y));
    }
    let total = prefix[count];
    // A window wider than the ring wraps all the way round it, so it is whole laps plus a remainder.
    let laps = (width / count) as f64;
    let rest = width % count;
    (0..count)
        .map(|index| {
            let start = (index + count - window % count) % count;
            let end = start + rest;
            let (span_x, span_y) = if end <= count {
                (
                    prefix[end].0 - prefix[start].0,
                    prefix[end].1 - prefix[start].1,
                )
            } else {
                (
                    total.0 - prefix[start].0 + prefix[end - count].0,
                    total.1 - prefix[start].1 + prefix[end - count].1,
                )
            };
            (
                (laps * total.0 + span_x) / width as f64,
                (laps * total.1 + span_y) / width as f64,
            )
        })
        .collect()
}

/// The outline offset inward by each of `insets` with round joins, i.e. Euclidean erosion.
fn offset_rings(outline: &[(f64, f64)], insets: &[f64]) -> Vec<Vec<Vec<(f64, f64)>>> {
    let mut source: Polyline<f64> = Polyline::with_capacity(outline.len(), true);
    for (x, y) in outline {
        source.add(*x, *y, 0.0);
    }
    let source = source
        .remove_repeat_pos(REPEAT_POSITION_METERS)
        .unwrap_or(source);
    let index = source.create_approx_aabb_index();
    // The offset's clearance check is unsigned, so the guards below catch pieces lying outside.
    let options = PlineOffsetOptions {
        aabb_index: Some(&index),
        ..Default::default()
    };
    // Each level is cut from the one above, so carrying the bound down catches stray loops.
    let mut enclosed = signed_double_area(outline);
    insets
        .iter()
        .map(|inset| {
            // Insetting under the vertex noise self-crosses; the outline is that ring within tolerance.
            if *inset < CROWN_SIMPLIFY_METERS {
                return vec![outline.to_vec()];
            }
            let source_area = enclosed;
            let level: Vec<Vec<(f64, f64)>> = source
                .parallel_offset_opt(*inset, &options)
                .iter()
                .filter_map(|ring| {
                    let straight = ring
                        .arcs_to_approx_lines(JOIN_ARC_METERS)
                        .unwrap_or_else(|| ring.clone());
                    let traced: Vec<(f64, f64)> =
                        straight.iter_vertexes().map(|at| (at.x, at.y)).collect();
                    if traced.len() < 3 {
                        return None;
                    }
                    let meters = simplified_or_whole(&traced);
                    let area = signed_double_area(&meters);
                    if area <= 0.0 || area >= source_area {
                        return None;
                    }
                    Some(meters)
                })
                .collect();
            // An empty level bounds nothing, or every level below it would drop too.
            let total: f64 = level.iter().map(|ring| signed_double_area(ring)).sum();
            if total > 0.0 {
                enclosed = total;
            }
            level
        })
        .collect()
}

/// A closed ring simplified by Douglas-Peucker, cut at its first vertex and the farthest one.
fn simplify_closed(points: &[(f64, f64)], tolerance: f64) -> Vec<(f64, f64)> {
    let count = points.len();
    let reach =
        |index: usize| f64::hypot(points[index].0 - points[0].0, points[index].1 - points[0].1);
    let far = (1..count)
        .max_by(|left, right| reach(*left).total_cmp(&reach(*right)))
        .unwrap_or(0);
    let mut keep = vec![false; count + 1];
    keep[0] = true;
    keep[far] = true;
    keep[count] = true;
    let at = |index: usize| points[index % count];
    let mut spans = vec![(0usize, far), (far, count)];
    while let Some((first, end)) = spans.pop() {
        let Some((worst, distance)) = (first + 1..end)
            .map(|index| (index, segment_distance(at(index), at(first), at(end))))
            .max_by(|left, right| left.1.total_cmp(&right.1))
        else {
            continue;
        };
        if distance > tolerance {
            keep[worst] = true;
            spans.push((first, worst));
            spans.push((worst, end));
        }
    }
    (0..count).filter(|index| keep[*index]).map(at).collect()
}

fn segment_distance(point: (f64, f64), from: (f64, f64), to: (f64, f64)) -> f64 {
    let (run, rise) = (to.0 - from.0, to.1 - from.1);
    let length = run * run + rise * rise;
    let along = if length == 0.0 {
        0.0
    } else {
        (((point.0 - from.0) * run + (point.1 - from.1) * rise) / length).clamp(0.0, 1.0)
    };
    f64::hypot(
        point.0 - from.0 - along * run,
        point.1 - from.1 - along * rise,
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    /// The staircase outline of a single-blob `cell`-meter raster, like the canopy file's outlines.
    fn traced(inside: impl Fn(f64, f64) -> bool, span: i64, cell: f64) -> Vec<(f64, f64)> {
        let cells = (2 * span) as usize;
        let at = |col: usize, row: usize| {
            inside(
                (col as i64 - span) as f64 * cell + cell / 2.0,
                (row as i64 - span) as f64 * cell + cell / 2.0,
            )
        };
        let mut sides: HashMap<(i64, i64), (i64, i64)> = HashMap::new();
        for row in 0..cells {
            for col in 0..cells {
                if !at(col, row) {
                    continue;
                }
                let (west, south) = (col as i64, row as i64);
                let (east, north) = (west + 1, south + 1);
                let open = |step: (i64, i64)| {
                    let (col, row) = (col as i64 + step.0, row as i64 + step.1);
                    col < 0
                        || row < 0
                        || col >= cells as i64
                        || row >= cells as i64
                        || !at(col as usize, row as usize)
                };
                for (step, from, to) in [
                    ((1, 0), (east, south), (east, north)),
                    ((0, 1), (east, north), (west, north)),
                    ((-1, 0), (west, north), (west, south)),
                    ((0, -1), (west, south), (east, south)),
                ] {
                    if open(step) {
                        sides.insert(from, to);
                    }
                }
            }
        }
        let start = *sides.keys().next().expect("a traced blob");
        let mut walked = vec![start];
        let mut corner = sides[&start];
        while corner != start {
            walked.push(corner);
            corner = sides[&corner];
        }
        (0..walked.len())
            .filter(|step| {
                let previous = walked[(step + walked.len() - 1) % walked.len()];
                let here = walked[*step];
                let next = walked[(step + 1) % walked.len()];
                (here.0 - previous.0, here.1 - previous.1) != (next.0 - here.0, next.1 - here.1)
            })
            .map(|step| {
                let (col, row) = walked[step];
                ((col - span) as f64 * cell, (row - span) as f64 * cell)
            })
            .collect()
    }

    /// A disc of `radius` meters traced off a one-meter raster.
    fn traced_disc(radius: f64) -> Vec<(f64, f64)> {
        traced(
            |x, y| f64::hypot(x, y) < radius,
            radius.ceil() as i64 + 2,
            1.0,
        )
    }

    /// The estimator against discs of known radius, which calibrates the smoothing window.
    #[test]
    fn reads_a_disc_radius() {
        for radius in [3.0, 5.0, 8.0] {
            let estimate = curvature_radius(&traced_disc(radius));
            assert!(
                (estimate - radius).abs() <= 0.2 * radius,
                "a {radius} m disc read as {estimate} m"
            );
        }
    }

    /// Two merged discs read as one disc's radius, not the blob's.
    #[test]
    fn reads_the_crowns_a_blob_is_made_of() {
        let blob = traced(
            |x, y| f64::hypot(x + 4.0, y) < 5.0 || f64::hypot(x - 4.0, y) < 5.0,
            20,
            1.0,
        );
        let estimate = curvature_radius(&blob);
        assert!(
            (estimate - 5.0).abs() <= 1.5,
            "the blob read as {estimate} m"
        );
    }

    /// An inward offset of a disc is a concentric, positively wound disc of `radius - inset`.
    #[test]
    fn insets_a_disc_by_its_offset() {
        let radius = 30.0;
        let ring: Vec<(f64, f64)> = (0..360)
            .map(|degree| {
                let angle = f64::from(degree).to_radians();
                (radius * angle.cos(), radius * angle.sin())
            })
            .collect();
        for (inset, rings) in [5.0, 10.0].iter().zip(offset_rings(&ring, &[5.0, 10.0])) {
            assert_eq!(rings.len(), 1, "insetting a disc leaves one piece");
            let area = signed_double_area(&rings[0]) / 2.0;
            let expected = std::f64::consts::PI * (radius - inset).powi(2);
            assert!(area > 0.0, "the inset ring winds positively");
            assert!(
                (area - expected).abs() < 0.03 * expected,
                "insetting {radius} m by {inset} m left {area:.1} m2, not {expected:.1}"
            );
        }
    }

    /// A concave corner opens into an arc; a mitred join would lose `(1 - pi/4) * inset^2` at 90°.
    #[test]
    fn rounds_the_joins_a_concave_corner_opens() {
        let ell = [
            (0.0, 0.0),
            (100.0, 0.0),
            (100.0, 40.0),
            (40.0, 40.0),
            (40.0, 100.0),
            (0.0, 100.0),
        ];
        let inset = 10.0;
        let rings = offset_rings(&ell, &[inset]).remove(0);
        assert_eq!(rings.len(), 1);
        let corner = (40.0, 40.0);
        let arc: Vec<&(f64, f64)> = rings[0]
            .iter()
            .filter(|(x, y)| *x > corner.0 - inset && *y > corner.1 - inset)
            .collect();
        assert!(
            arc.len() >= 2,
            "a mitred or squared join would leave nothing inside the corner, this left {arc:?}"
        );
        for (x, y) in &arc {
            let reach = f64::hypot(x - corner.0, y - corner.1);
            assert!(
                (reach - inset).abs() < CROWN_SIMPLIFY_METERS,
                "a corner vertex {reach:.2} m out, not {inset}"
            );
        }
        // The union of the two arms eroded on their own, which is what a mitred join would have left.
        let mitred =
            2.0 * (100.0 - 2.0 * inset) * (40.0 - 2.0 * inset) - (40.0 - 2.0 * inset).powi(2);
        let corner_area = (1.0 - std::f64::consts::FRAC_PI_4) * inset * inset;
        let area = signed_double_area(&rings[0]) / 2.0;
        assert!(
            (area - mitred - corner_area).abs() < 0.3 * corner_area,
            "the corner left {area:.1} m2, nearer the mitred {mitred:.1} than the rounded {:.1}",
            mitred + corner_area
        );
    }

    /// A dumbbell pinches into two rings before it vanishes.
    #[test]
    fn splits_a_blob_that_pinches_in_two() {
        let waist = |x: f64, y: f64| y.abs() < 2.0 && x.abs() < 9.0;
        let dumbbell = simplified_or_whole(&traced(
            |x, y| f64::hypot(x + 8.0, y) < 5.0 || f64::hypot(x - 8.0, y) < 5.0 || waist(x, y),
            20,
            1.0,
        ));
        let inset = offset_rings(&dumbbell, &[1.5, 3.0]);
        assert_eq!(inset[0].len(), 1, "the waist still joins them at 1.5 m");
        assert_eq!(inset[1].len(), 2, "at 3 m the waist is gone");
        for ring in &inset[1] {
            assert!(
                signed_double_area(ring) > 0.0,
                "both pieces wind positively"
            );
        }
    }

    /// Slices nest around the widest section; a sub-two-pixel smear collapses to the widest ring.
    #[test]
    fn nests_the_slices_around_the_widest_section() {
        // A 10 m crown at a 5 degree sun: 0.6 * 10 * 11.43 = 68.6 m of smear over 3.6 m pixels.
        let low = crown_segments(10.0, 11.43, 500.0, 3.6);
        assert_eq!(low.len(), CROWN_SEGMENTS);
        let middle = 0.7 * 10.0 * 11.43;
        assert_eq!(low[0].level, 0);
        assert!((low[0].from_m - middle).abs() < 1e-9);
        assert!((low[0].to_m - middle).abs() < 1e-9);
        for (slice, pair) in low.windows(2).enumerate() {
            assert_eq!(pair[1].level, slice + 1);
            assert!(pair[1].from_m < pair[0].from_m, "reaches back further");
            assert!(pair[1].to_m > pair[0].to_m, "reaches out further");
            assert!(
                ((pair[1].from_m + pair[1].to_m) / 2.0 - middle).abs() < 1e-9,
                "centered on the widest section"
            );
        }
        // Every band is inside the crown, and the innermost one spans all but the crown's two points.
        assert!(low[CROWN_SEGMENTS - 1].from_m > 0.4 * 10.0 * 11.43);
        assert!(low[CROWN_SEGMENTS - 1].to_m < 10.0 * 11.43);
        let swept = low[CROWN_SEGMENTS - 1].to_m - low[CROWN_SEGMENTS - 1].from_m;
        let smear = 0.6 * 10.0 * 11.43;
        assert!((swept - CROWN_TIP_FRACTION * smear).abs() < 1e-9);

        // The same crown at a 60 degree sun smears 3.5 m, under a pixel.
        let high = crown_segments(10.0, 0.577, 500.0, 3.6);
        assert_eq!(high.len(), 1);
        assert_eq!(high[0].level, 0);
        assert!((high[0].to_m - high[0].from_m).abs() < 1e-9);
    }

    /// Rings sample evenly spaced heights; equal inset caps the width at 75% and renders a bar.
    #[test]
    fn spaces_the_rings_by_equal_height() {
        let offsets: Vec<f64> = (0..CROWN_SEGMENTS).map(band_offset).collect();
        for step in offsets.windows(2) {
            assert!(
                (step[1] - step[0] - CROWN_TIP_FRACTION / (CROWN_SEGMENTS - 1) as f64).abs()
                    < 1e-12,
                "evenly spaced in height"
            );
        }
        assert!((offsets[CROWN_SEGMENTS - 1] - CROWN_TIP_FRACTION).abs() < 1e-12);

        // Slice 0 sweeps nothing, so slice 1 sets the width: 94% of r, 75% under equal inset.
        assert!((ring_share(0) - 1.0).abs() < 1e-12);
        assert!(ring_share(1) > 0.94);
        assert!(
            ring_share(1) > (1.0f64 - 1.0 / CROWN_SEGMENTS as f64),
            "wider than the equal-inset spacing this replaced"
        );
        // And it holds that width over a third of the smear, where equal inset held it over two thirds.
        assert!(band_offset(1) < 0.34);
    }

    /// Two slices take every other level, and past the shadow clip only the widest covering ring.
    #[test]
    fn steps_by_stride_and_drops_the_slices_the_clip_flattens() {
        let coarse = crown_segments(10.0, 5.0, 500.0, 8.0);
        assert_eq!(coarse.len(), 2);
        assert_eq!(coarse[1].level, 2);

        let clipped = crown_segments(10.0, 5.0, 21.0, 0.91);
        assert_eq!(clipped.len(), 2, "only the two bands that start inside it");
        assert_eq!(clipped[0].level, 0);
        assert!(clipped.iter().all(|segment| segment.to_m <= 21.0));
    }

    /// Bands both halves cut, in meters of displacement, per (height, shadow per height, m/px).
    /// Duplicated in src/tiles/sweep.test.ts so either side drifting fails.
    #[test]
    fn cuts_the_bands_the_client_cuts() {
        let cases: [(f64, f64, f64, &[(usize, f64, f64)]); 3] = [
            (
                10.0,
                5.0,
                0.91,
                &[
                    (0, 35.0, 35.0),
                    (1, 30.05, 39.95),
                    (2, 25.10, 44.90),
                    (3, 20.15, 49.85),
                ],
            ),
            (
                18.0,
                2.0,
                0.91,
                &[
                    (0, 25.2, 25.2),
                    (1, 21.636, 28.764),
                    (2, 18.072, 32.328),
                    (3, 14.508, 35.892),
                ],
            ),
            (
                7.0,
                11.43,
                3.6,
                &[
                    (0, 56.007, 56.007),
                    (1, 48.08601, 63.92799),
                    (2, 40.16502, 71.84898),
                    (3, 32.24403, 79.76997),
                ],
            ),
        ];
        for (height, shadow_per_height, meters_per_pixel, expected) in cases {
            let cut = crown_segments(height, shadow_per_height, 500.0, meters_per_pixel);
            assert_eq!(cut.len(), expected.len());
            for (segment, (level, from_m, to_m)) in cut.iter().zip(expected) {
                assert_eq!(segment.level, *level);
                assert!(
                    (segment.from_m - from_m).abs() < 1e-6 && (segment.to_m - to_m).abs() < 1e-6,
                    "a {height} m crown's slice {level} swept {:.6}..{:.6}, not {from_m}..{to_m}",
                    segment.from_m,
                    segment.to_m
                );
            }
        }
    }
}

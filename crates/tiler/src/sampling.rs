//! Polyline-in-polygon sampling, kept out of geometry.rs so changing it doesn't re-render shade.

use crate::binfmt::Coord;
use crate::geometry::{METERS_PER_DEGREE_LAT, PolygonGrid, PolygonSet};
use crate::manifest::Bounds;

// One sample per meter: crowns are meters across, and a ~15 m crossing still gets a dozen samples.
const SAMPLE_STEP_METERS: f64 = 1.0;

/// A polyline's samples: how many it took, its length, and each maximal run of contained ones.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Runs {
    pub samples: u32,
    pub meters: f64,
    /// `(first sample, how many)`, in order and never adjacent.
    pub runs: Vec<(u32, u32)>,
}

impl Runs {
    pub fn covered(&self) -> u32 {
        self.runs.iter().map(|&(_, count)| count).sum()
    }

    /// The share of the samples inside the set; 0 for a polyline that took none.
    pub fn fraction(&self) -> f64 {
        if self.samples == 0 {
            0.0
        } else {
            f64::from(self.covered()) / f64::from(self.samples)
        }
    }
}

/// The share of a polyline's length inside `set`, sampled at arc-length midpoints.
pub fn contained_fraction(
    poly: &[Coord],
    set: &PolygonSet,
    grid: &PolygonGrid,
    meters_per_degree_lng: f64,
    candidates: &mut Vec<u32>,
) -> f64 {
    contained_runs(poly, set, grid, meters_per_degree_lng, candidates).fraction()
}

/// Where along a polyline it is inside `set`: the same samples `contained_fraction` counts.
pub fn contained_runs(
    poly: &[Coord],
    set: &PolygonSet,
    grid: &PolygonGrid,
    meters_per_degree_lng: f64,
    candidates: &mut Vec<u32>,
) -> Runs {
    if poly.len() < 2 {
        return Runs::default();
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
    grid.candidates(&clip, candidates);
    if total <= 0.0 || candidates.is_empty() {
        return Runs::default();
    }

    let samples = (total / SAMPLE_STEP_METERS).ceil().max(1.0) as usize;
    let step = total / samples as f64;
    let mut runs: Vec<(u32, u32)> = Vec::new();
    let mut open: Option<u32> = None; // the first sample of the run still growing
    let mut segment = 0usize;
    let mut behind = 0.0; // meters of the segments before `segment`
    // The targets rise, so the segment cursor never walks back.
    for sample in 0..samples {
        let target = (sample as f64 + 0.5) * step;
        while segment + 1 < spans.len() && behind + spans[segment] < target {
            behind += spans[segment];
            segment += 1;
        }
        let along = if spans[segment] > 0.0 {
            ((target - behind) / spans[segment]).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let lng = poly[segment].lng + along * (poly[segment + 1].lng - poly[segment].lng);
        let lat = poly[segment].lat + along * (poly[segment + 1].lat - poly[segment].lat);
        if set.contains_point(candidates, lng, lat) {
            open.get_or_insert(sample as u32);
        } else if let Some(first) = open.take() {
            runs.push((first, sample as u32 - first));
        }
    }
    if let Some(first) = open {
        runs.push((first, samples as u32 - first));
    }
    Runs {
        samples: samples as u32,
        meters: total,
        runs,
    }
}

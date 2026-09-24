//! The caster-chunks pass: bakes shadow casters into one chunk per z15 tile for the client to sweep.
//! Casters are clipped to their chunk, lossless since a Minkowski sweep distributes over a union.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;

use crate::Fallible;
use crate::binfmt::{self, Coord, DECIMETERS_PER_METER, Polygon, Ring, write_varint, zigzag};
use crate::crown;
use crate::geometry::round_half_up;
use crate::manifest::{City, Manifest};
use crate::raster::{
    TILE_SIZE, lat_to_pixel_y, lng_to_pixel_x, pixel_x_to_lng, pixel_y_to_lat, tile_index,
};
use crate::shade;

// layouts: scripts/README.md
const CASTER_FORMAT: u16 = 3;
const CASTER_HEADER_BYTES: usize = 44;
// Degrees per quantized unit (~0.1 m), the grid both sources are already stored on.
const CASTER_COORD_SCALE: f64 = 1e-6;
// The zoom the baked pyramid stops at, so it is also the grid the client fetches its casters on.
const CHUNK_ZOOM: u32 = 15;
// scripts/tree-data-fetch.ts's crown allometry, inverted exactly since it is monotone in dbh.
const CROWN_A: f64 = -0.752;
const CROWN_B: f64 = 2.414;
const CROWN_LOG_BIAS: f64 = 0.00988;
// Dbh clamps (1 and 60 in, as cm); only the upper mirrors the forward pass's MAX_DBH_INCHES.
const MIN_DBH_CM: f64 = 2.54;
const MAX_DBH_CM: f64 = 152.4;
const CENTIMETERS_PER_METER: f64 = 100.0;

pub struct Args {
    pub manifest: PathBuf,
    pub data: PathBuf,
    pub chunks: PathBuf,
    // Only max_shadow_meters is read, so any city's grid does.
    pub params: shade::Params,
}

/// One shadow caster as shipped: ring groups in degrees and a height in decimeters.
/// A building is one group (outer, then holes); a crown has a group per slice, setting its sweep.
struct Caster {
    groups: Vec<Vec<Ring>>,
    height_dm: u16,
}

impl Caster {
    /// The ring a caster is placed and clipped by: its outer one, for a crown the widest slice.
    fn outer(&self) -> &Ring {
        &self.groups[0][0]
    }
}

/// One trunk as shipped: position, radius in cm (a decimeter is too coarse) and height in dm.
struct Trunk {
    coord: Coord,
    radius_cm: u8,
    height_dm: u16,
}

/// A chunk's members, by section: indices into the city's caster lists.
#[derive(Default)]
struct Members {
    buildings: Vec<u32>,
    crowns: Vec<u32>,
    trunks: Vec<u32>,
}

/// What the client needs before fetching: grid, quantization, halo radius and which chunks exist.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkManifest {
    chunk_zoom: u32,
    coord_scale: f64,
    max_shadow_meters: f64,
    chunks: Vec<ChunkEntry>,
}

#[derive(Serialize)]
struct ChunkEntry {
    x: u32,
    y: u32,
    bytes: usize,
}

/// One source's casters at full detail, dropping any with no height or ring as the shade pass does.
/// `holes` keeps inner rings: footprints need them for the base punch-out; crowns never punch.
fn casters(polygons: &[Polygon], heights: &[f64], holes: bool) -> Vec<Caster> {
    polygons
        .iter()
        .zip(heights)
        .filter_map(|(polygon, height)| {
            let outer = polygon.first()?;
            if outer.len() < 3 || *height <= 0.0 {
                return None;
            }
            let mut rings = vec![outer.clone()];
            if holes {
                rings.extend(polygon[1..].iter().filter(|ring| ring.len() >= 3).cloned());
            }
            Some(Caster {
                groups: vec![rings],
                height_dm: round_half_up(height * DECIMETERS_PER_METER) as u16,
            })
        })
        .collect()
}

/// The crowns as casters with their slices, dropping any that cast nothing as the shade pass does.
fn crown_casters(crowns: Vec<crown::Crown>, heights: &[f64]) -> Vec<Caster> {
    crowns
        .into_iter()
        .zip(heights)
        .filter_map(|(crown, height)| {
            if crown.levels.is_empty() || *height <= 0.0 {
                return None;
            }
            Some(Caster {
                groups: crown.levels,
                height_dm: round_half_up(height * DECIMETERS_PER_METER) as u16,
            })
        })
        .collect()
}

/// The trunk radius (m) a crown radius implies, clamped since OSM crowns were never grown from a dbh.
fn trunk_radius_m(crown_radius_m: f64) -> f64 {
    let log_log = ((2.0 * crown_radius_m).ln() - CROWN_A - CROWN_LOG_BIAS) / CROWN_B;
    let dbh_cm = (log_log.exp().exp() - 1.0).clamp(MIN_DBH_CM, MAX_DBH_CM);
    dbh_cm / 2.0 / CENTIMETERS_PER_METER
}

/// One trunk per census tree, empty without a trees blob; `stand_trunks` sets heights and drops some.
fn city_trunks(city: &City, data: &Path) -> Fallible<Vec<Trunk>> {
    let path = data.join("trees").join(&city.field.trees.file);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let trees = binfmt::read_trees(&path)?;
    Ok(trees
        .coords
        .into_iter()
        .zip(trees.crown_radii_m)
        .map(|(coord, crown_radius_m)| Trunk {
            coord,
            radius_cm: round_half_up(trunk_radius_m(crown_radius_m) * CENTIMETERS_PER_METER) as u8,
            height_dm: 0,
        })
        .collect())
}

/// The bounding box of one ring, as a rectangle in degrees.
fn ring_box(ring: &Ring) -> Rect {
    let mut rect = Rect {
        west: f64::INFINITY,
        east: f64::NEG_INFINITY,
        south: f64::INFINITY,
        north: f64::NEG_INFINITY,
    };
    for point in ring {
        rect.west = rect.west.min(point.lng);
        rect.east = rect.east.max(point.lng);
        rect.south = rect.south.min(point.lat);
        rect.north = rect.north.max(point.lat);
    }
    rect
}

/// Every trunk raised to the crown base of the canopy polygon over it, so the two shadows meet.
/// Trunks under no measured crown (342k of NYC's 925k) are dropped: no crown shadow joins them.
fn stand_trunks(trunks: Vec<Trunk>, crowns: &[Caster]) -> Vec<Trunk> {
    let boxes: Vec<Rect> = crowns.iter().map(|crown| ring_box(crown.outer())).collect();
    let mut by_tile: HashMap<(u32, u32), Vec<u32>> = HashMap::new();
    bucket(crowns, |key, index| {
        by_tile.entry(key).or_default().push(index);
    });
    trunks
        .into_iter()
        .filter_map(|trunk| {
            let tile = (
                tile_index(lng_to_pixel_x(trunk.coord.lng, CHUNK_ZOOM), CHUNK_ZOOM),
                tile_index(lat_to_pixel_y(trunk.coord.lat, CHUNK_ZOOM), CHUNK_ZOOM),
            );
            let height_dm = by_tile.get(&tile)?.iter().find_map(|index| {
                let crown = &crowns[*index as usize];
                (boxes[*index as usize].contains(&trunk.coord)
                    && point_inside_ring(crown.outer(), &trunk.coord))
                .then_some(crown.height_dm)
            })?;
            Some(Trunk {
                height_dm: round_half_up(f64::from(height_dm) * crown::CROWN_WIDEST_FRACTION)
                    as u16,
                ..trunk
            })
        })
        .collect()
}

/// Buckets casters into every z15 tile their outer ring's bbox touches; the clip empties overshoot.
fn bucket(casters: &[Caster], mut push: impl FnMut((u32, u32), u32)) {
    for (index, caster) in casters.iter().enumerate() {
        let rect = ring_box(caster.outer());
        let min_x = tile_index(lng_to_pixel_x(rect.west, CHUNK_ZOOM), CHUNK_ZOOM);
        let max_x = tile_index(lng_to_pixel_x(rect.east, CHUNK_ZOOM), CHUNK_ZOOM);
        let min_y = tile_index(lat_to_pixel_y(rect.north, CHUNK_ZOOM), CHUNK_ZOOM);
        let max_y = tile_index(lat_to_pixel_y(rect.south, CHUNK_ZOOM), CHUNK_ZOOM);
        for tile_x in min_x..=max_x {
            for tile_y in min_y..=max_y {
                push((tile_x, tile_y), index as u32);
            }
        }
    }
}

/// Buckets each trunk into the one z15 tile it stands in.
fn bucket_trunks(trunks: &[Trunk], mut push: impl FnMut((u32, u32), u32)) {
    for (index, trunk) in trunks.iter().enumerate() {
        let tile_x = tile_index(lng_to_pixel_x(trunk.coord.lng, CHUNK_ZOOM), CHUNK_ZOOM);
        let tile_y = tile_index(lat_to_pixel_y(trunk.coord.lat, CHUNK_ZOOM), CHUNK_ZOOM);
        push((tile_x, tile_y), index as u32);
    }
}

/// One chunk's rectangle in degrees; tile seams are axis-aligned there, so no projection is needed.
#[derive(Clone, Copy)]
struct Rect {
    west: f64,
    east: f64,
    south: f64,
    north: f64,
}

impl Rect {
    fn contains(&self, point: &Coord) -> bool {
        point.lng >= self.west
            && point.lng <= self.east
            && point.lat >= self.south
            && point.lat <= self.north
    }

    /// The corners counter-clockwise from the south-west, corner `index` at perimeter `index`.
    fn corners(&self) -> [Coord; 4] {
        [
            Coord {
                lng: self.west,
                lat: self.south,
            },
            Coord {
                lng: self.east,
                lat: self.south,
            },
            Coord {
                lng: self.east,
                lat: self.north,
            },
            Coord {
                lng: self.west,
                lat: self.north,
            },
        ]
    }

    /// A boundary point's position in [0, 4), counter-clockwise from the south-west.
    /// Clip points are snapped onto their side, so the tests are exact; a corner starts its side.
    fn perimeter(&self, point: &Coord) -> f64 {
        if point.lat == self.south && point.lng < self.east {
            (point.lng - self.west) / (self.east - self.west)
        } else if point.lng == self.east && point.lat < self.north {
            1.0 + (point.lat - self.south) / (self.north - self.south)
        } else if point.lat == self.north && point.lng > self.west {
            2.0 + (self.east - point.lng) / (self.east - self.west)
        } else {
            3.0 + (self.north - point.lat) / (self.north - self.south)
        }
    }

    /// The rectangle as a ring of the given winding, what a ring swallowing the chunk clips to.
    fn ring(&self, counter_clockwise: bool) -> Ring {
        let mut ring = self.corners().to_vec();
        if !counter_clockwise {
            ring.reverse();
        }
        ring
    }
}

/// The z15 tile a chunk covers.
fn tile_rect(tile_x: u32, tile_y: u32) -> Rect {
    let edge = |tile: u32| f64::from(tile) * TILE_SIZE as f64;
    Rect {
        west: pixel_x_to_lng(edge(tile_x), CHUNK_ZOOM),
        east: pixel_x_to_lng(edge(tile_x + 1), CHUNK_ZOOM),
        south: pixel_y_to_lat(edge(tile_y + 1), CHUNK_ZOOM),
        north: pixel_y_to_lat(edge(tile_y), CHUNK_ZOOM),
    }
}

fn same(left: &Coord, right: &Coord) -> bool {
    left.lng == right.lng && left.lat == right.lat
}

/// Twice the signed area of a ring (shoelace), positive counter-clockwise.
fn signed_double_area(ring: &[Coord]) -> f64 {
    let mut sum = 0.0;
    let mut previous = ring.len() - 1;
    for current in 0..ring.len() {
        sum += (ring[current].lng - ring[previous].lng) * (ring[current].lat + ring[previous].lat);
        previous = current;
    }
    -sum
}

/// Even-odd point-in-ring test, used on a chunk's center to tell a missed ring from a swallowing one.
fn point_inside_ring(ring: &[Coord], point: &Coord) -> bool {
    let mut inside = false;
    let mut previous = ring.len() - 1;
    for current in 0..ring.len() {
        let (from, to) = (&ring[current], &ring[previous]);
        if (from.lat > point.lat) != (to.lat > point.lat)
            && point.lng
                < from.lng + (point.lat - from.lat) / (to.lat - from.lat) * (to.lng - from.lng)
        {
            inside = !inside;
        }
        previous = current;
    }
    inside
}

/// The part of a segment inside the rectangle by Liang-Barsky, None if it misses.
/// Cut ends snap onto their side and inside ends stay the original vertex, so spans join by equality.
fn clip_segment(rect: &Rect, from: &Coord, to: &Coord) -> Option<(Coord, Coord)> {
    let mut enter = 0.0f64;
    let mut leave = 1.0f64;
    // the side each end was cut against, as (is a latitude, that side's coordinate)
    let mut enter_side: Option<(bool, f64)> = None;
    let mut leave_side: Option<(bool, f64)> = None;
    for (is_lat, start, delta, low, high) in [
        (false, from.lng, to.lng - from.lng, rect.west, rect.east),
        (true, from.lat, to.lat - from.lat, rect.south, rect.north),
    ] {
        if delta == 0.0 {
            if start < low || start > high {
                return None;
            }
        } else {
            let (near, far) = if delta > 0.0 {
                (low, high)
            } else {
                (high, low)
            };
            let at_near = (near - start) / delta;
            let at_far = (far - start) / delta;
            if at_near > enter {
                enter = at_near;
                enter_side = Some((is_lat, near));
            }
            if at_far < leave {
                leave = at_far;
                leave_side = Some((is_lat, far));
            }
            if enter > leave {
                return None;
            }
        }
    }
    let cut = |at: f64, side: Option<(bool, f64)>, uncut: &Coord| match side {
        None => *uncut,
        Some((is_lat, value)) => {
            let mut point = Coord {
                lng: from.lng + at * (to.lng - from.lng),
                lat: from.lat + at * (to.lat - from.lat),
            };
            if is_lat {
                point.lat = value;
            } else {
                point.lng = value;
            }
            point
        }
    };
    Some((cut(enter, enter_side, from), cut(leave, leave_side, to)))
}

/// Where the boundary walk gets from one perimeter position to another, going the way the ring runs.
fn advance(from: f64, to: f64, counter_clockwise: bool) -> f64 {
    if counter_clockwise {
        (to - from).rem_euclid(4.0)
    } else {
        (from - to).rem_euclid(4.0)
    }
}

/// A ring clipped to the rectangle as closed pieces of the source winding; one inside is untouched.
/// Weiler-Atherton, since Sutherland-Hodgman's zero-area seam bridges would sweep into false shadow.
fn clip_ring(ring: &[Coord], rect: &Rect) -> Vec<Ring> {
    let Some(start) = ring.iter().position(|point| !rect.contains(point)) else {
        return vec![ring.to_vec()];
    };
    let counter_clockwise = signed_double_area(ring) > 0.0;

    // Start the walk at a vertex outside so a span never wraps around the ring's end.
    let mut spans: Vec<Ring> = Vec::new();
    let mut span: Ring = Vec::new();
    let close = |span: &mut Ring, spans: &mut Vec<Ring>| {
        if span.len() > 1 {
            spans.push(std::mem::take(span));
        } else {
            span.clear();
        }
    };
    for step in 0..ring.len() {
        let from = &ring[(start + step) % ring.len()];
        let to = &ring[(start + step + 1) % ring.len()];
        match clip_segment(rect, from, to) {
            None => close(&mut span, &mut spans),
            Some((entry, exit)) => {
                match span.last() {
                    // the ring left and came back: this is a new span, not a continuation
                    Some(last) if !same(last, &entry) => {
                        close(&mut span, &mut spans);
                        span.push(entry);
                    }
                    None => span.push(entry),
                    Some(_) => {}
                }
                if span.last().is_none_or(|last| !same(last, &exit)) {
                    span.push(exit);
                }
            }
        }
    }
    close(&mut span, &mut spans);

    if spans.is_empty() {
        // the ring never meets the chunk: it either misses it or swallows it whole
        let center = Coord {
            lng: (rect.west + rect.east) / 2.0,
            lat: (rect.south + rect.north) / 2.0,
        };
        return if point_inside_ring(ring, &center) {
            vec![rect.ring(counter_clockwise)]
        } else {
            Vec::new()
        };
    }

    let entries: Vec<f64> = spans.iter().map(|span| rect.perimeter(&span[0])).collect();
    let exits: Vec<f64> = spans
        .iter()
        .map(|span| rect.perimeter(span.last().expect("a span has two ends")))
        .collect();
    let corners = rect.corners();
    let mut used = vec![false; spans.len()];
    let mut pieces: Vec<Ring> = Vec::new();
    for first in 0..spans.len() {
        if used[first] {
            continue;
        }
        let mut piece: Ring = Vec::new();
        let mut current = first;
        loop {
            used[current] = true;
            for point in &spans[current] {
                if piece.last().is_none_or(|last| !same(last, point)) {
                    piece.push(*point);
                }
            }
            // The next span along the boundary; the piece's own first is a candidate, so it closes.
            let exit = exits[current];
            let next = (0..spans.len())
                .filter(|index| !used[*index] || *index == first)
                .min_by(|left, right| {
                    advance(exit, entries[*left], counter_clockwise).total_cmp(&advance(
                        exit,
                        entries[*right],
                        counter_clockwise,
                    ))
                })
                .expect("the piece's own first span");
            let reach = advance(exit, entries[next], counter_clockwise);
            let mut passed: Vec<(f64, Coord)> = corners
                .iter()
                .enumerate()
                .map(|(index, corner)| (advance(exit, index as f64, counter_clockwise), *corner))
                .filter(|(at, _)| *at > 0.0 && *at < reach)
                .collect();
            passed.sort_by(|left, right| left.0.total_cmp(&right.0));
            for (_, corner) in passed {
                if piece.last().is_none_or(|last| !same(last, &corner)) {
                    piece.push(corner);
                }
            }
            if next == first {
                break;
            }
            current = next;
        }
        // the closing vertex is implied by the format, and a piece with no area is bytes for nothing
        if piece.len() > 1 && same(&piece[0], piece.last().expect("a non-empty piece")) {
            piece.pop();
        }
        if piece.len() >= 3 && signed_double_area(&piece) != 0.0 {
            pieces.push(piece);
        }
    }
    pieces
}

/// One building clipped to a chunk, each piece its own record at the same height.
/// A footprint that splits and has holes ships whole, since the format can't assign a hole a piece.
fn clip_building(caster: &Caster, rect: &Rect, out: &mut Vec<Caster>) {
    let rings = &caster.groups[0];
    let mut pieces = clip_ring(&rings[0], rect);
    let holes = &rings[1..];
    if !holes.is_empty() && pieces.len() > 1 {
        out.push(Caster {
            groups: caster.groups.clone(),
            height_dm: caster.height_dm,
        });
    } else if holes.is_empty() {
        out.extend(pieces.into_iter().map(|ring| Caster {
            groups: vec![vec![ring]],
            height_dm: caster.height_dm,
        }));
    } else if let Some(outer) = pieces.pop() {
        // Holes clip against the same rectangle, so they cut the clipped outer as they cut the whole.
        let mut kept = vec![outer];
        for hole in holes {
            kept.extend(clip_ring(hole, rect));
        }
        out.push(Caster {
            groups: vec![kept],
            height_dm: caster.height_dm,
        });
    }
}

/// One crown clipped to a chunk as one record, pieces kept by slice; none if the outline misses.
fn clip_crown(caster: &Caster, rect: &Rect) -> Option<Caster> {
    let groups: Vec<Vec<Ring>> = caster
        .groups
        .iter()
        .map(|rings| {
            rings
                .iter()
                .flat_map(|ring| clip_ring(ring, rect))
                .collect()
        })
        .collect();
    groups
        .first()
        .is_some_and(|outline| !outline.is_empty())
        .then_some(Caster {
            groups,
            height_dm: caster.height_dm,
        })
}

/// A ring's vertex count and varint deltas, continuing the record's running delta chain.
fn encode_ring(
    ring: &Ring,
    origin_lng: f64,
    origin_lat: f64,
    previous: &mut (i64, i64),
    bytes: &mut Vec<u8>,
) {
    write_varint(bytes, ring.len() as u64);
    for point in ring {
        let x = round_half_up((point.lng - origin_lng) / CASTER_COORD_SCALE) as i64;
        let y = round_half_up((point.lat - origin_lat) / CASTER_COORD_SCALE) as i64;
        write_varint(bytes, zigzag(x - previous.0));
        write_varint(bytes, zigzag(y - previous.1));
        *previous = (x, y);
    }
}

/// One building: its height, its ring count, then its rings, the outer one first.
fn encode_building(caster: &Caster, origin_lng: f64, origin_lat: f64, bytes: &mut Vec<u8>) {
    write_varint(bytes, u64::from(caster.height_dm));
    write_varint(bytes, caster.groups[0].len() as u64);
    let mut previous = (0i64, 0i64);
    for ring in &caster.groups[0] {
        encode_ring(ring, origin_lng, origin_lat, &mut previous, bytes);
    }
}

/// One crown: its height, slice count, then per slice a ring count and those rings.
fn encode_crown(caster: &Caster, origin_lng: f64, origin_lat: f64, bytes: &mut Vec<u8>) {
    write_varint(bytes, u64::from(caster.height_dm));
    write_varint(bytes, caster.groups.len() as u64);
    let mut previous = (0i64, 0i64);
    for rings in &caster.groups {
        write_varint(bytes, rings.len() as u64);
        for ring in rings {
            encode_ring(ring, origin_lng, origin_lat, &mut previous, bytes);
        }
    }
}

/// The trunk section: zigzag varint x/y steps in chunk row-major order, radius (cm), height (dm).
fn encode_trunks(
    trunks: &[Trunk],
    indices: &[u32],
    origin_lng: f64,
    origin_lat: f64,
    bytes: &mut Vec<u8>,
) {
    let mut quantized: Vec<(i64, i64, u8, u16)> = indices
        .iter()
        .map(|index| {
            let trunk = &trunks[*index as usize];
            (
                round_half_up((trunk.coord.lng - origin_lng) / CASTER_COORD_SCALE) as i64,
                round_half_up((trunk.coord.lat - origin_lat) / CASTER_COORD_SCALE) as i64,
                trunk.radius_cm,
                trunk.height_dm,
            )
        })
        .collect();
    quantized.sort_unstable_by_key(|(x, y, _, _)| (*y, *x));
    let (mut previous_x, mut previous_y) = (0i64, 0i64);
    for (x, y, radius_cm, height_dm) in quantized {
        write_varint(bytes, zigzag(x - previous_x));
        write_varint(bytes, zigzag(y - previous_y));
        write_varint(bytes, u64::from(radius_cm));
        write_varint(bytes, u64::from(height_dm));
        previous_x = x;
        previous_y = y;
    }
}

// Buildings, crowns, then trunks: the section says how a record casts; counts are clipped pieces.
// layout: scripts/README.md
fn encode_chunk(
    buildings: &[Caster],
    crowns: &[Caster],
    trunks: &[Trunk],
    members: &Members,
    rect: &Rect,
) -> Vec<u8> {
    let (origin_lng, origin_lat) = (rect.west, rect.north);
    let mut bytes = vec![0u8; CASTER_HEADER_BYTES];
    let mut counts = [0u32; 2];
    let mut clipped: Vec<Caster> = Vec::new();
    for index in &members.buildings {
        clipped.clear();
        clip_building(&buildings[*index as usize], rect, &mut clipped);
        counts[0] += clipped.len() as u32;
        for caster in &clipped {
            encode_building(caster, origin_lng, origin_lat, &mut bytes);
        }
    }
    for index in &members.crowns {
        if let Some(caster) = clip_crown(&crowns[*index as usize], rect) {
            counts[1] += 1;
            encode_crown(&caster, origin_lng, origin_lat, &mut bytes);
        }
    }

    encode_trunks(trunks, &members.trunks, origin_lng, origin_lat, &mut bytes);

    bytes[0..4].copy_from_slice(b"CSTR");
    bytes[4..6].copy_from_slice(&CASTER_FORMAT.to_le_bytes());
    bytes[6..8].copy_from_slice(&(CASTER_HEADER_BYTES as u16).to_le_bytes());
    bytes[8..12].copy_from_slice(&counts[0].to_le_bytes());
    bytes[12..16].copy_from_slice(&counts[1].to_le_bytes());
    bytes[16..24].copy_from_slice(&origin_lng.to_le_bytes());
    bytes[24..32].copy_from_slice(&origin_lat.to_le_bytes());
    bytes[32..40].copy_from_slice(&CASTER_COORD_SCALE.to_le_bytes());
    bytes[40..44].copy_from_slice(&(members.trunks.len() as u32).to_le_bytes());
    bytes
}

/// Writes every chunk a city's casters land in, each with its tile's north-west corner as origin.
fn write_chunks(
    buildings: &[Caster],
    crowns: &[Caster],
    trunks: &[Trunk],
    chunks: &Path,
) -> Fallible<Vec<ChunkEntry>> {
    let mut buckets: HashMap<(u32, u32), Members> = HashMap::new();
    bucket(buildings, |key, index| {
        buckets.entry(key).or_default().buildings.push(index);
    });
    bucket(crowns, |key, index| {
        buckets.entry(key).or_default().crowns.push(index);
    });
    bucket_trunks(trunks, |key, index| {
        buckets.entry(key).or_default().trunks.push(index);
    });

    let mut entries = Vec::with_capacity(buckets.len());
    for ((tile_x, tile_y), members) in &buckets {
        let encoded = encode_chunk(
            buildings,
            crowns,
            trunks,
            members,
            &tile_rect(*tile_x, *tile_y),
        );
        // Box bucketing can leave a chunk empty after clipping; it is left unwritten.
        if encoded.len() == CASTER_HEADER_BYTES {
            continue;
        }
        let path = chunks
            .join(tile_x.to_string())
            .join(format!("{tile_y}.bin"));
        fs::create_dir_all(path.parent().expect("a chunk row directory"))?;
        fs::write(path, &encoded)?;
        entries.push(ChunkEntry {
            x: *tile_x,
            y: *tile_y,
            bytes: encoded.len(),
        });
    }
    entries.sort_by_key(|entry| (entry.x, entry.y));
    Ok(entries)
}

pub fn run(args: &Args) -> Fallible<()> {
    let started = Instant::now();
    let manifest: Manifest = serde_json::from_slice(&fs::read(&args.manifest)?)?;
    let params = &args.params;

    let mut entries: Vec<ChunkEntry> = Vec::new();
    for city in &manifest.cities {
        // Either source alone makes chunks worth having; a city with neither is skipped.
        let footprints = args.data.join("buildings").join(format!("{}.bin", city.id));
        let (polygons, heights) = if footprints.exists() {
            binfmt::read_buildings(&footprints)?
        } else {
            (Vec::new(), Vec::new())
        };
        let (sliced, crown_heights) = shade::city_crowns(city, &args.data)?;
        let buildings = casters(&polygons, &heights, true);
        let histogram = crown::radius_histogram(&sliced);
        let crowns = crown_casters(sliced, &crown_heights);
        if buildings.is_empty() && crowns.is_empty() {
            continue;
        }
        let census = city_trunks(city, &args.data)?;
        let standing = census.len();
        let trunks = stand_trunks(census, &crowns);
        let vertices: usize = crowns
            .iter()
            .flat_map(|caster| caster.groups.iter().flatten())
            .map(Ring::len)
            .sum();
        eprintln!(
            "{}: {} footprints, {} crowns with a measured height cut into {} slice vertices, {} of \
             {standing} census trunks standing under one",
            city.id,
            buildings.len(),
            crowns.len(),
            vertices,
            trunks.len(),
        );
        eprintln!(
            "  crown radius (m) {}: {}",
            crown::RADIUS_BUCKETS
                .iter()
                .map(|edge| format!("<{edge}"))
                .collect::<Vec<String>>()
                .join(" "),
            histogram
                .iter()
                .map(usize::to_string)
                .collect::<Vec<String>>()
                .join(" ")
        );
        entries.extend(write_chunks(&buildings, &crowns, &trunks, &args.chunks)?);
    }

    let bytes: usize = entries.iter().map(|entry| entry.bytes).sum();
    let chunks = entries.len();
    fs::write(
        args.chunks.join("manifest.json"),
        serde_json::to_vec(&ChunkManifest {
            chunk_zoom: CHUNK_ZOOM,
            coord_scale: CASTER_COORD_SCALE,
            max_shadow_meters: params.max_shadow_meters,
            chunks: entries,
        })?,
    )?;
    eprintln!(
        "wrote {chunks} caster chunks (z{CHUNK_ZOOM}, {:.1} MiB) in {:.1}s",
        bytes as f64 / 1024.0 / 1024.0,
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::METERS_PER_DEGREE_LAT;

    fn coord(lng: f64, lat: f64) -> Coord {
        Coord { lng, lat }
    }

    /// One chunk read back: buildings, crowns by slice, and trunks (point, radius m, height dm).
    struct Decoded {
        buildings: Vec<(u16, Vec<Ring>)>,
        crowns: Vec<(u16, Vec<Vec<Ring>>)>,
        trunks: Vec<(Coord, f64, u16)>,
    }

    /// Walks a chunk back the way the client will.
    fn decode(bytes: &[u8]) -> Decoded {
        assert_eq!(&bytes[0..4], b"CSTR");
        let counts = [
            u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize,
            u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize,
        ];
        let origin_lng = f64::from_le_bytes(bytes[16..24].try_into().unwrap());
        let origin_lat = f64::from_le_bytes(bytes[24..32].try_into().unwrap());
        let scale = f64::from_le_bytes(bytes[32..40].try_into().unwrap());
        let mut offset = usize::from(u16::from_le_bytes(bytes[6..8].try_into().unwrap()));
        let varint = |offset: &mut usize| -> u64 {
            let mut value = 0u64;
            let mut shift = 0;
            loop {
                let byte = bytes[*offset];
                *offset += 1;
                value |= u64::from(byte & 0x7f) << shift;
                shift += 7;
                if byte & 0x80 == 0 {
                    return value;
                }
            }
        };
        let mut position = (0i64, 0i64);
        let mut read_ring = |offset: &mut usize, position: &mut (i64, i64)| -> Ring {
            let vertices = varint(offset) as usize;
            let mut ring = Vec::with_capacity(vertices);
            for _ in 0..vertices {
                for axis in [&mut position.0, &mut position.1] {
                    let zigzagged = varint(offset);
                    *axis += (zigzagged >> 1) as i64 ^ -((zigzagged & 1) as i64);
                }
                ring.push(coord(
                    origin_lng + position.0 as f64 * scale,
                    origin_lat + position.1 as f64 * scale,
                ));
            }
            ring
        };
        let mut buildings = Vec::with_capacity(counts[0]);
        for _ in 0..counts[0] {
            let height_dm = varint(&mut offset) as u16;
            let rings = varint(&mut offset) as usize;
            position = (0, 0);
            buildings.push((
                height_dm,
                (0..rings)
                    .map(|_| read_ring(&mut offset, &mut position))
                    .collect::<Vec<Ring>>(),
            ));
        }
        let mut crowns = Vec::with_capacity(counts[1]);
        for _ in 0..counts[1] {
            let height_dm = varint(&mut offset) as u16;
            let levels = varint(&mut offset) as usize;
            position = (0, 0);
            crowns.push((
                height_dm,
                (0..levels)
                    .map(|_| {
                        let rings = varint(&mut offset) as usize;
                        (0..rings)
                            .map(|_| read_ring(&mut offset, &mut position))
                            .collect::<Vec<Ring>>()
                    })
                    .collect::<Vec<Vec<Ring>>>(),
            ));
        }

        let mut trunks = Vec::new();
        let (mut x, mut y) = (0i64, 0i64);
        for _ in 0..u32::from_le_bytes(bytes[40..44].try_into().unwrap()) {
            for axis in [&mut x, &mut y] {
                let zigzagged = varint(&mut offset);
                *axis += (zigzagged >> 1) as i64 ^ -((zigzagged & 1) as i64);
            }
            let radius_m = varint(&mut offset) as f64 / CENTIMETERS_PER_METER;
            trunks.push((
                coord(origin_lng + x as f64 * scale, origin_lat + y as f64 * scale),
                radius_m,
                varint(&mut offset) as u16,
            ));
        }
        assert_eq!(offset, bytes.len(), "the chunk decodes with nothing left");
        Decoded {
            buildings,
            crowns,
            trunks,
        }
    }

    // A stand-in chunk on round numbers, encoded about its north-west corner.
    const CHUNK: Rect = Rect {
        west: -74.0114,
        east: -74.0050,
        south: 40.7080,
        north: 40.7130,
    };

    fn close_enough(left: &Coord, right: &Coord) -> bool {
        (left.lng - right.lng).abs() <= CASTER_COORD_SCALE / 2.0
            && (left.lat - right.lat).abs() <= CASTER_COORD_SCALE / 2.0
    }

    /// A ring matches a source ring within the codec's half unit, from any starting vertex.
    fn matches(ring: &[Coord], expected: &[Coord]) -> bool {
        ring.len() == expected.len()
            && (0..expected.len()).any(|shift| {
                ring.iter().enumerate().all(|(index, point)| {
                    close_enough(point, &expected[(index + shift) % ring.len()])
                })
            })
    }

    /// Inside and straddling casters round-trip, sections apart, straddlers clipped to the chunk.
    #[test]
    fn round_trips_a_chunk() {
        let courtyard: Polygon = vec![
            vec![
                coord(-74.0100, 40.7100),
                coord(-74.0090, 40.7100),
                coord(-74.0090, 40.7110),
                coord(-74.0100, 40.7110),
            ],
            vec![
                coord(-74.0097, 40.7103),
                coord(-74.0093, 40.7103),
                coord(-74.0093, 40.7107),
                coord(-74.0097, 40.7107),
            ],
        ];
        // Pokes out past the chunk's east edge, so it ships as one piece closed along that edge.
        let straddler: Polygon = vec![vec![
            coord(-74.0060, 40.7100),
            coord(-74.0040, 40.7100),
            coord(-74.0040, 40.7110),
            coord(-74.0060, 40.7110),
        ]];
        let crown: Polygon = vec![vec![
            coord(-74.0080, 40.7100),
            coord(-74.0078, 40.7100),
            coord(-74.0079, 40.7102),
        ]];
        // A body outside the chunk with two prongs reaching in: one caster, two pieces in this chunk.
        let two_pronged: Polygon = vec![vec![
            coord(-74.0045, 40.7085),
            coord(-74.0040, 40.7085),
            coord(-74.0040, 40.7125),
            coord(-74.0045, 40.7125),
            coord(-74.0045, 40.7120),
            coord(-74.0060, 40.7120),
            coord(-74.0060, 40.7115),
            coord(-74.0045, 40.7115),
            coord(-74.0045, 40.7095),
            coord(-74.0060, 40.7095),
            coord(-74.0060, 40.7090),
            coord(-74.0045, 40.7090),
        ]];
        let buildings = casters(&[courtyard.clone(), straddler.clone()], &[42.5, 12.0], true);
        // A whole crown, then a two-pronged straddler with a second slice that must survive the clip.
        let inset: Polygon = vec![vec![
            coord(-74.0058, 40.7116),
            coord(-74.0052, 40.7116),
            coord(-74.0052, 40.7119),
            coord(-74.0058, 40.7119),
        ]];
        let crowns = vec![
            Caster {
                groups: vec![crown.clone(), Vec::new()],
                height_dm: 93,
            },
            Caster {
                groups: vec![two_pronged.clone(), inset.clone()],
                height_dm: 50,
            },
        ];

        let members = Members {
            buildings: vec![0, 1],
            crowns: vec![0, 1],
            trunks: Vec::new(),
        };
        let encoded = encode_chunk(&buildings, &crowns, &[], &members, &CHUNK);
        let Decoded {
            buildings: decoded_buildings,
            crowns: decoded_crowns,
            ..
        } = decode(&encoded);

        // Two building records (the straddler is one piece); crowns stay one record, pieces by slice.
        assert_eq!(decoded_buildings.len(), 2);
        assert_eq!(decoded_crowns.len(), 2);
        assert_eq!(decoded_buildings[0].0, 425);
        assert_eq!(decoded_crowns[0].0, 93);
        assert_eq!(decoded_crowns[1].0, 50);
        assert_eq!(decoded_crowns[0].1.len(), 2);
        assert!(decoded_crowns[0].1[1].is_empty());
        assert_eq!(decoded_crowns[1].1[0].len(), 2, "the two prongs");
        assert_eq!(
            decoded_crowns[1].1[1].len(),
            1,
            "the inset slice's own piece"
        );

        // A caster wholly inside the chunk is untouched, ring for ring and vertex for vertex.
        for (source, rings) in [
            (&courtyard, &decoded_buildings[0].1),
            (&crown, &decoded_crowns[0].1[0]),
        ] {
            assert_eq!(rings.len(), source.len());
            for (source, ring) in source.iter().zip(rings) {
                assert_eq!(ring.len(), source.len());
                for (source, point) in source.iter().zip(ring) {
                    assert!(close_enough(source, point));
                }
            }
        }

        let clipped_straddler = [
            coord(-74.0060, 40.7100),
            coord(CHUNK.east, 40.7100),
            coord(CHUNK.east, 40.7110),
            coord(-74.0060, 40.7110),
        ];
        assert!(matches(&decoded_buildings[1].1[0], &clipped_straddler));
        let prongs = [
            [
                coord(CHUNK.east, 40.7120),
                coord(-74.0060, 40.7120),
                coord(-74.0060, 40.7115),
                coord(CHUNK.east, 40.7115),
            ],
            [
                coord(CHUNK.east, 40.7095),
                coord(-74.0060, 40.7095),
                coord(-74.0060, 40.7090),
                coord(CHUNK.east, 40.7090),
            ],
        ];
        for prong in &prongs {
            assert!(
                decoded_crowns[1].1[0]
                    .iter()
                    .any(|ring| matches(ring, prong))
            );
        }
    }

    /// The clip keeps a ring's winding, since a piece wound against its source would cancel.
    #[test]
    fn preserves_winding() {
        let ring = vec![
            coord(-74.0060, 40.7100),
            coord(-74.0040, 40.7100),
            coord(-74.0040, 40.7110),
            coord(-74.0060, 40.7110),
        ];
        let reversed: Ring = ring.iter().rev().copied().collect();
        assert!(signed_double_area(&ring) > 0.0);

        let forward = clip_ring(&ring, &CHUNK);
        let backward = clip_ring(&reversed, &CHUNK);
        assert_eq!(forward.len(), 1);
        assert_eq!(backward.len(), 1);
        assert!(signed_double_area(&forward[0]) > 0.0);
        assert!(signed_double_area(&backward[0]) < 0.0);
        assert!((signed_double_area(&forward[0]) + signed_double_area(&backward[0])).abs() < 1e-18);
        let flipped: Ring = backward[0].iter().rev().copied().collect();
        assert!(matches(&forward[0], &flipped));
    }

    /// A ring swallowing the whole chunk clips to the chunk's rectangle, not to nothing.
    #[test]
    fn clips_a_swallowed_chunk() {
        let ring = vec![
            coord(-74.02, 40.70),
            coord(-74.00, 40.70),
            coord(-74.00, 40.72),
            coord(-74.02, 40.72),
        ];
        let pieces = clip_ring(&ring, &CHUNK);
        assert_eq!(pieces.len(), 1);
        assert!(matches(&pieces[0], &CHUNK.corners()));

        let missing = vec![
            coord(-74.00, 40.70),
            coord(-73.99, 40.70),
            coord(-73.99, 40.72),
        ];
        assert!(clip_ring(&missing, &CHUNK).is_empty());
    }

    /// A hole straddling the chunk edge punches exactly its inside part.
    #[test]
    fn clips_a_hole_with_its_outer_ring() {
        let courtyard: Polygon = vec![
            vec![
                coord(-74.0060, 40.7100),
                coord(-74.0040, 40.7100),
                coord(-74.0040, 40.7110),
                coord(-74.0060, 40.7110),
            ],
            vec![
                coord(-74.0058, 40.7102),
                coord(-74.0042, 40.7102),
                coord(-74.0042, 40.7108),
                coord(-74.0058, 40.7108),
            ],
        ];
        let caster = &casters(std::slice::from_ref(&courtyard), &[20.0], true)[0];
        let mut clipped: Vec<Caster> = Vec::new();
        clip_building(caster, &CHUNK, &mut clipped);
        assert_eq!(clipped.len(), 1);
        assert_eq!(clipped[0].groups[0].len(), 2);
        assert!(matches(
            &clipped[0].groups[0][1],
            &[
                coord(-74.0058, 40.7102),
                coord(CHUNK.east, 40.7102),
                coord(CHUNK.east, 40.7108),
                coord(-74.0058, 40.7108),
            ]
        ));
    }

    /// The inversion recovers dbh within 1.5 mm through the decimeter byte; impossible crowns clamp.
    #[test]
    fn inverts_the_crown_allometry() {
        let median_dbh_cm: f64 = 22.86;
        let crown_radius_m =
            (CROWN_A + CROWN_B * (median_dbh_cm + 1.0).ln().ln() + CROWN_LOG_BIAS).exp() / 2.0;
        let expected = median_dbh_cm / 2.0 / CENTIMETERS_PER_METER;
        assert!((trunk_radius_m(crown_radius_m) - expected).abs() < 1e-12);
        let shipped = (crown_radius_m * DECIMETERS_PER_METER).round() / DECIMETERS_PER_METER;
        assert!((trunk_radius_m(shipped) - expected).abs() < 0.0015);
        assert_eq!(
            trunk_radius_m(20.0),
            MAX_DBH_CM / 2.0 / CENTIMETERS_PER_METER
        );
        assert_eq!(
            trunk_radius_m(0.0),
            MIN_DBH_CM / 2.0 / CENTIMETERS_PER_METER
        );
    }

    /// A trunk stands to its crown base, and a tree under no measured crown is dropped.
    #[test]
    fn stands_trunks_under_their_crowns() {
        let square = |lng: f64| -> Polygon {
            vec![vec![
                coord(lng, 40.7100),
                coord(lng + 0.0002, 40.7100),
                coord(lng + 0.0002, 40.7102),
                coord(lng, 40.7102),
            ]]
        };
        let crowns = crown_casters(
            [square(-74.0100), square(-74.0090)]
                .iter()
                .map(|square| crown::Crown {
                    levels: vec![square.clone()],
                    radius_m: 3.0,
                })
                .collect(),
            &[12.0, 8.0],
        );
        let trunk = |lng: f64| Trunk {
            coord: coord(lng, 40.7101),
            radius_cm: 12,
            height_dm: 0,
        };

        let standing = stand_trunks(
            vec![trunk(-74.0099), trunk(-74.0089), trunk(-74.0060)],
            &crowns,
        );
        assert_eq!(standing.len(), 2);
        // to where each crown is widest, not to where it starts
        assert_eq!(standing[0].height_dm, 84);
        assert_eq!(standing[1].height_dm, 56);
    }

    /// Trunks ship unclipped and come back as they went in, whatever order they were given.
    #[test]
    fn round_trips_trunks() {
        let standing = [
            (coord(-74.0100, 40.7120), 12u8, 40u16),
            (coord(-74.0060, 40.7090), 76u8, 130u16),
            (coord(-74.0099, 40.7091), 3u8, 8u16),
        ];
        let trunks: Vec<Trunk> = standing
            .iter()
            .map(|(coord, radius_cm, height_dm)| Trunk {
                coord: *coord,
                radius_cm: *radius_cm,
                height_dm: *height_dm,
            })
            .collect();
        let members = Members {
            trunks: vec![0, 1, 2],
            ..Members::default()
        };

        let decoded = decode(&encode_chunk(&[], &[], &trunks, &members, &CHUNK)).trunks;
        assert_eq!(decoded.len(), standing.len());
        for (at, radius_cm, height_dm) in standing {
            assert!(decoded.iter().any(|(point, radius_m, decoded_height)| {
                close_enough(point, &at)
                    && (radius_m * CENTIMETERS_PER_METER - f64::from(radius_cm)).abs() < 1e-9
                    && *decoded_height == height_dm
            }));
        }
    }
}

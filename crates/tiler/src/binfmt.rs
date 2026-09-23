//! The varint coordinate codec and readers for the `.bin` files TypeScript writes (scripts/README.md).

use std::fs;
use std::path::Path;

use crate::Fallible;

pub const TREE_FORMAT: u16 = 3; // a crown byte and a genus byte per tree
pub const CANOPY_FORMAT: u16 = 2; // magic CNPY, a trailing crown-height u16 per polygon
pub const BLDG_FORMAT: u16 = 1; // magic BLDG, trailing roof-height and base-elevation u16s
pub const LAND_FORMAT: u16 = 1;
pub const STREET_FORMAT: u16 = 6; // the record's flags byte carries per-side sidewalk bits
pub const PATH_FORMAT: u16 = 1; // OSM pedestrian/park ways: STRT's layout, magic "PATH"
pub const SIDEWALK_FORMAT: u16 = 1; // OSM sidewalk/crossing/island ways: STRT's layout, magic "SWLK"
pub const FERRY_FORMAT: u16 = 2; // the NYC ferry graph, magic "FERR"
pub const TRANSIT_FORMAT: u16 = 2; // the rail topology, magic "TRNS"
pub const LANDMARK_FORMAT: u16 = 1; // scenic POI points, the shared point layout, magic "LMRK"
pub const ART_FORMAT: u16 = 1; // public-art POI points, the shared point layout, magic "ARTW"
pub const HIGHWAY_FORMAT: u16 = 1; // highway/elevated-rail lines, LAND's layout, magic "HWAY"
pub const COMMERCIAL_FORMAT: u16 = 1; // commercial-block lines, LAND's layout, magic "CMLN"
pub const INDUSTRIAL_FORMAT: u16 = 1; // industrial tax lots, LAND's layout, magic "INDL"
pub const LANDUSE_FORMAT: u16 = 1; // tax lots carrying a land-use class byte, magic "PLUT"
pub const DINING_FORMAT: u16 = 1; // outdoor-dining points, the shared point layout, magic "DINE"
pub const OPENSTREET_FORMAT: u16 = 1; // Open Streets samples, the point layout, magic "OSTR"
pub const CHUNK_FORMAT: u16 = 4; // the served z12 street chunk, magic "STCK"

pub const SIDES: usize = 2; // the two sidewalks a density blob carries per vertex, left then right
pub const DECIMETERS_PER_METER: f64 = 10.0; // the crown byte's unit: a decimeter of crown radius

#[derive(Clone, Copy)]
pub struct Coord {
    pub lng: f64,
    pub lat: f64,
}

pub type Ring = Vec<Coord>;
pub type Polygon = Vec<Ring>;

struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl Cursor<'_> {
    // Zigzag LEB128; the shift wraps as JavaScript's does, so a corrupt file decodes rather than panics.
    fn varint(&mut self) -> i32 {
        let mut value: u32 = 0;
        let mut shift: u32 = 0;
        loop {
            let byte = self.bytes[self.offset];
            self.offset += 1;
            value |= u32::from(byte & 0x7f).wrapping_shl(shift);
            shift += 7;
            if byte & 0x80 == 0 {
                return ((value >> 1) as i32) ^ -((value & 1) as i32);
            }
        }
    }

    // Plain LEB128, no zigzag: the TRNS pattern-stop blob's two non-negative numbers.
    fn unsigned_varint(&mut self) -> u32 {
        let mut value: u32 = 0;
        let mut shift: u32 = 0;
        loop {
            let byte = self.bytes[self.offset];
            self.offset += 1;
            value |= u32::from(byte & 0x7f).wrapping_shl(shift);
            shift += 7;
            if byte & 0x80 == 0 {
                return value;
            }
        }
    }
}

fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().expect("2 bytes"))
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("4 bytes"))
}

fn i32_at(bytes: &[u8], offset: usize) -> i32 {
    i32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("4 bytes"))
}

fn f32_at(bytes: &[u8], offset: usize) -> f32 {
    f32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("4 bytes"))
}

fn f64_at(bytes: &[u8], offset: usize) -> f64 {
    f64::from_le_bytes(bytes[offset..offset + 8].try_into().expect("8 bytes"))
}

// Also catches an unresolved Git LFS pointer file.
fn check_magic(bytes: &[u8], expected: &str, format: u16, path: &Path) -> Fallible<()> {
    let magic = bytes
        .get(..4)
        .map(String::from_utf8_lossy)
        .unwrap_or_default();
    let version = if bytes.len() >= 6 {
        u16_at(bytes, 4)
    } else {
        0
    };
    if magic != expected || version != format {
        Err(format!(
            "{} is not a v{format} \"{expected}\" file (magic \"{magic}\", version {version})",
            path.display()
        )
        .into())
    } else {
        Ok(())
    }
}

// The header the point and polygon layouts share: count, then the varint deltas' origin and scale.
struct Header {
    count: usize,
    origin_lng: f64,
    origin_lat: f64,
    scale: f64,
    body: usize,
}

fn header(bytes: &[u8]) -> Header {
    Header {
        count: u32_at(bytes, 8) as usize,
        origin_lng: f64_at(bytes, 16),
        origin_lat: f64_at(bytes, 24),
        scale: f64_at(bytes, 32),
        body: usize::from(u16_at(bytes, 6)),
    }
}

/// The tree inventory as parallel arrays: points, crown radii in meters, and genus ids (0..11).
pub struct Trees {
    pub coords: Vec<Coord>,
    pub crown_radii_m: Vec<f64>,
    pub genus_ids: Vec<u8>,
}

/// TREE v3: the points, then `count` crown bytes, then `count` genus bytes.
pub fn read_trees(path: &Path) -> Fallible<Trees> {
    let bytes = fs::read(path)?;
    check_magic(&bytes, "TREE", TREE_FORMAT, path)?;
    let head = header(&bytes);
    let mut cursor = Cursor {
        bytes: &bytes,
        offset: head.body,
    };

    let mut coords = Vec::with_capacity(head.count);
    let mut x: i64 = 0;
    let mut y: i64 = 0;
    for _ in 0..head.count {
        x += i64::from(cursor.varint());
        y += i64::from(cursor.varint());
        coords.push(Coord {
            lng: head.origin_lng + x as f64 * head.scale,
            lat: head.origin_lat + y as f64 * head.scale,
        });
    }
    let crowns = cursor.offset;
    let genera = crowns + head.count;
    let end = genera + head.count;
    if bytes.len() < end {
        return Err(format!(
            "{} is truncated: {} bytes, {} needed for {} crown and genus bytes",
            path.display(),
            bytes.len(),
            end,
            head.count
        )
        .into());
    }
    let crown_radii_m = bytes[crowns..genera]
        .iter()
        .map(|byte| f64::from(*byte) / DECIMETERS_PER_METER)
        .collect();
    let genus_ids = bytes[genera..end].to_vec();
    Ok(Trees {
        coords,
        crown_radii_m,
        genus_ids,
    })
}

// Polygons: u16 ring count, per ring a u32 vertex count and varint deltas; leaves the cursor after.
fn decode_polygons(cursor: &mut Cursor, head: &Header) -> Vec<Polygon> {
    let mut polygons = Vec::with_capacity(head.count);
    for _ in 0..head.count {
        let rings = usize::from(u16_at(cursor.bytes, cursor.offset));
        cursor.offset += 2;
        let mut polygon: Polygon = Vec::with_capacity(rings);
        for _ in 0..rings {
            let vertices = u32_at(cursor.bytes, cursor.offset) as usize;
            cursor.offset += 4;
            let mut ring: Ring = Vec::with_capacity(vertices);
            let mut x: i64 = 0;
            let mut y: i64 = 0;
            for _ in 0..vertices {
                x += i64::from(cursor.varint());
                y += i64::from(cursor.varint());
                ring.push(Coord {
                    lng: head.origin_lng + x as f64 * head.scale,
                    lat: head.origin_lat + y as f64 * head.scale,
                });
            }
            polygon.push(ring);
        }
        polygons.push(polygon);
    }
    polygons
}

pub fn read_polygons(path: &Path, magic: &str, format: u16) -> Fallible<Vec<Polygon>> {
    let bytes = fs::read(path)?;
    check_magic(&bytes, magic, format, path)?;
    let head = header(&bytes);
    let mut cursor = Cursor {
        bytes: &bytes,
        offset: head.body,
    };
    Ok(decode_polygons(&mut cursor, &head))
}

/// BLDG v1: footprints (one per MultiPolygon part), then u16 roof heights and base elevations.
pub fn read_buildings(path: &Path) -> Fallible<(Vec<Polygon>, Vec<f64>)> {
    let bytes = fs::read(path)?;
    check_magic(&bytes, "BLDG", BLDG_FORMAT, path)?;
    let head = header(&bytes);
    let mut cursor = Cursor {
        bytes: &bytes,
        offset: head.body,
    };
    let polygons = decode_polygons(&mut cursor, &head);
    let heights_start = cursor.offset;
    let elevations_start = heights_start + head.count * 2;
    let end = elevations_start + head.count * 2;
    if bytes.len() < end {
        return Err(format!(
            "{} is truncated: {} bytes, {} needed for {} height and elevation u16s",
            path.display(),
            bytes.len(),
            end,
            head.count
        )
        .into());
    }
    let heights = (0..head.count)
        .map(|polygon| {
            f64::from(u16_at(&bytes, heights_start + polygon * 2)) / DECIMETERS_PER_METER
        })
        .collect();
    Ok((polygons, heights))
}

/// The canopy polygons plus the raw file, whose trailing height region the height pass patches.
pub struct Canopy {
    pub bytes: Vec<u8>,
    pub polygons: Vec<Polygon>,
    heights: usize,
}

impl Canopy {
    /// Crown heights in meters; 0 means no cell was measured, below any real reading.
    pub fn heights_m(&self) -> Vec<f64> {
        (0..self.polygons.len())
            .map(|polygon| {
                f64::from(u16_at(&self.bytes, self.heights + polygon * 2)) / DECIMETERS_PER_METER
            })
            .collect()
    }

    /// Fills the trailing region, decimeters in polygon order.
    pub fn set_heights_dm(&mut self, heights: &[u16]) {
        for (polygon, height) in heights.iter().enumerate() {
            let at = self.heights + polygon * 2;
            self.bytes[at..at + 2].copy_from_slice(&height.to_le_bytes());
        }
    }
}

/// CNPY v2: the canopy polygons, then one u16 crown height in decimeters per polygon.
pub fn read_canopy(path: &Path) -> Fallible<Canopy> {
    let bytes = fs::read(path)?;
    check_magic(&bytes, "CNPY", CANOPY_FORMAT, path)?;
    let head = header(&bytes);
    let mut cursor = Cursor {
        bytes: &bytes,
        offset: head.body,
    };
    let polygons = decode_polygons(&mut cursor, &head);
    let heights = cursor.offset;
    let end = heights + head.count * 2;
    if bytes.len() < end {
        return Err(format!(
            "{} is truncated: {} bytes, {end} needed for {} height u16s",
            path.display(),
            bytes.len(),
            head.count
        )
        .into());
    }
    Ok(Canopy {
        bytes,
        polygons,
        heights,
    })
}

// `count` varint (lng, lat) deltas; leaves the cursor after them for any trailing region.
fn decode_points(cursor: &mut Cursor, head: &Header) -> Vec<Coord> {
    let mut coords = Vec::with_capacity(head.count);
    let mut x: i64 = 0;
    let mut y: i64 = 0;
    for _ in 0..head.count {
        x += i64::from(cursor.varint());
        y += i64::from(cursor.varint());
        coords.push(Coord {
            lng: head.origin_lng + x as f64 * head.scale,
            lat: head.origin_lat + y as f64 * head.scale,
        });
    }
    coords
}

/// A bare point set (`LMRK`, `ARTW`, `DINE`, `OSTR`); any trailing name blob is left unread.
pub fn read_points(path: &Path, magic: &str, format: u16) -> Fallible<Vec<Coord>> {
    let bytes = fs::read(path)?;
    check_magic(&bytes, magic, format, path)?;
    let head = header(&bytes);
    let mut cursor = Cursor {
        bytes: &bytes,
        offset: head.body,
    };
    Ok(decode_points(&mut cursor, &head))
}

/// PLUT v1: tax-lot points, then one land-use class byte per point, returned in parallel.
pub fn read_classified_points(
    path: &Path,
    magic: &str,
    format: u16,
) -> Fallible<(Vec<Coord>, Vec<u8>)> {
    let bytes = fs::read(path)?;
    check_magic(&bytes, magic, format, path)?;
    let head = header(&bytes);
    let mut cursor = Cursor {
        bytes: &bytes,
        offset: head.body,
    };
    let coords = decode_points(&mut cursor, &head);
    let classes = cursor.offset;
    let end = classes + head.count;
    if bytes.len() < end {
        return Err(format!(
            "{} is truncated: {} bytes, {end} needed for {} class bytes",
            path.display(),
            bytes.len(),
            head.count
        )
        .into());
    }
    Ok((coords, bytes[classes..end].to_vec()))
}

/// STCK v4: a z12 street chunk's segment polylines in file order, which signals are keyed on.
pub fn read_chunk(path: &Path) -> Fallible<Vec<Vec<Coord>>> {
    let bytes = fs::read(path)?;
    check_magic(&bytes, "STCK", CHUNK_FORMAT, path)?;
    let head = header(&bytes);
    let mut cursor = Cursor {
        bytes: &bytes,
        offset: head.body,
    };
    let mut segments = Vec::with_capacity(head.count);
    for _ in 0..head.count {
        let vertices = usize::from(u16_at(cursor.bytes, cursor.offset));
        cursor.offset += 3; // the vertex count, then the unused sidewalk-offset byte
        let mut polyline = Vec::with_capacity(vertices);
        let mut x: i64 = 0;
        let mut y: i64 = 0;
        for _ in 0..vertices {
            x += i64::from(cursor.varint());
            y += i64::from(cursor.varint());
            polyline.push(Coord {
                lng: head.origin_lng + x as f64 * head.scale,
                lat: head.origin_lat + y as f64 * head.scale,
            });
        }
        cursor.offset += SIDES * vertices;
        segments.push(polyline);
    }
    Ok(segments)
}

/// The street network plus the raw file, whose density blob the density pass patches in place.
pub struct Streets {
    pub bytes: Vec<u8>,
    pub lngs: Vec<f64>, // every vertex of every segment, concatenated
    pub lats: Vec<f64>,
    pub starts: Vec<u32>, // segments + 1 entries; segment i owns [starts[i], starts[i + 1])
    pub ids: Vec<u32>,    // CSCL physicalid (STRT) or OSM way id (PATH)
    pub road_types: Vec<u8>, // 1 street, 3 bridge, 4 tunnel, 5 boardwalk, 6 path, 7 step, 10 alley
    pub width_feet: Vec<u8>, // curb to curb, 0 unknown
    // bit0 vehicular-only, bit1 non-vehicular deck, bit2 structure; on PATH and SWLK bit3 is tunnel
    // on STRT bits 3-6 are sidewalks: OSM-mapped left/right, then surveyed left/right
    pub flags: Vec<u8>,
    pub name_ids: Vec<u16>, // per segment: index into `names`, 0xFFFF when the row carried no label
    pub names: Vec<String>, // the distinct street names, decoded from the trailing name blob
    pub lengths_m: Vec<f32>, // per segment: the stored geodesic length; the graph sums, never recomputes
    pub origin_lng: f64, // the quantized deltas' reference, so the graph pass can recover the ints
    pub origin_lat: f64,
    pub scale: f64, // degrees per quantized unit (1e-6)
    density_offset: usize,
}

impl Streets {
    pub fn segments(&self) -> usize {
        self.starts.len() - 1
    }

    pub fn vertices(&self) -> usize {
        self.lngs.len()
    }

    /// The left and right densities of every vertex, interleaved.
    pub fn densities(&self) -> &[u8] {
        &self.bytes[self.density_offset..self.density_offset + SIDES * self.vertices()]
    }

    pub fn densities_mut(&mut self) -> &mut [u8] {
        let (from, to) = (
            self.density_offset,
            self.density_offset + SIDES * self.lngs.len(),
        );
        &mut self.bytes[from..to]
    }
}

/// STRT v6: the CSCL street network.
pub fn read_streets(path: &Path) -> Fallible<Streets> {
    read_network(path, "STRT", STREET_FORMAT)
}

/// PATH v1: STRT's layout; `road_types` 6 path or 7 steps, `width_feet` 0, only the structure flag.
pub fn read_paths(path: &Path) -> Fallible<Streets> {
    read_network(path, "PATH", PATH_FORMAT)
}

/// SWLK v1: STRT's layout; `road_types` 20 sidewalk, 21 crossing, 22 island, no widths or densities.
pub fn read_sidewalks(path: &Path) -> Fallible<Streets> {
    read_network(path, "SWLK", SIDEWALK_FORMAT)
}

// The networks share STRT's layout; only the magic and version differ.
fn read_network(path: &Path, magic: &str, format: u16) -> Fallible<Streets> {
    let bytes = fs::read(path)?;
    check_magic(&bytes, magic, format, path)?;
    let header_bytes = usize::from(u16_at(&bytes, 6));
    let record_bytes = usize::from(u16_at(&bytes, 8));
    let count = u32_at(&bytes, 12) as usize;
    let origin_lng = f64_at(&bytes, 16);
    let origin_lat = f64_at(&bytes, 24);
    let scale = f64_at(&bytes, 32);
    let coord_offset = u32_at(&bytes, 40) as usize;
    let density_offset = u32_at(&bytes, 48) as usize;
    let density_bytes = u32_at(&bytes, 52) as usize;
    let name_offset = u32_at(&bytes, 56) as usize;
    let name_bytes = u32_at(&bytes, 60) as usize;
    // The name blob is the last region, so this bounds the whole file.
    if bytes.len() < name_offset + name_bytes {
        return Err(format!(
            "{} is truncated: {} bytes, {} needed for {count} segments",
            path.display(),
            bytes.len(),
            name_offset + name_bytes
        )
        .into());
    }

    let vertices = density_bytes / SIDES;
    let mut lngs = Vec::with_capacity(vertices);
    let mut lats = Vec::with_capacity(vertices);
    let mut starts = Vec::with_capacity(count + 1);
    let mut ids = Vec::with_capacity(count);
    let mut road_types = Vec::with_capacity(count);
    let mut width_feet = Vec::with_capacity(count);
    let mut flags = Vec::with_capacity(count);
    let mut name_ids = Vec::with_capacity(count);
    let mut lengths_m = Vec::with_capacity(count);
    for segment in 0..count {
        let record = header_bytes + segment * record_bytes;
        let mut cursor = Cursor {
            bytes: &bytes,
            offset: coord_offset + u32_at(&bytes, record + 4) as usize,
        };
        let length = usize::from(u16_at(&bytes, record + 8));
        starts.push(lngs.len() as u32);
        ids.push(u32_at(&bytes, record));
        road_types.push(bytes[record + 20]);
        width_feet.push(bytes[record + 21]);
        flags.push(bytes[record + 23]);
        name_ids.push(u16_at(&bytes, record + 10));
        lengths_m.push(f32::from_le_bytes(
            bytes[record + 12..record + 16].try_into().expect("4 bytes"),
        ));

        let mut x: i64 = 0;
        let mut y: i64 = 0;
        for _ in 0..length {
            x += i64::from(cursor.varint());
            y += i64::from(cursor.varint());
            lngs.push(origin_lng + x as f64 * scale);
            lats.push(origin_lat + y as f64 * scale);
        }
    }
    starts.push(lngs.len() as u32);
    // Two densities per vertex; a mismatch means records and blob disagree on the network.
    if density_bytes != SIDES * lngs.len() {
        return Err(format!(
            "{} carries {density_bytes} density bytes for {} vertices, not {}",
            path.display(),
            lngs.len(),
            SIDES * lngs.len()
        )
        .into());
    }
    // The name blob: a u32 count, then each name as a u16 byte length and its UTF-8 bytes.
    let mut names = Vec::new();
    let mut name_cursor = name_offset;
    let name_count = u32_at(&bytes, name_cursor) as usize;
    name_cursor += 4;
    names.reserve(name_count);
    for _ in 0..name_count {
        let len = usize::from(u16_at(&bytes, name_cursor));
        name_cursor += 2;
        names.push(String::from_utf8_lossy(&bytes[name_cursor..name_cursor + len]).into_owned());
        name_cursor += len;
    }

    Ok(Streets {
        bytes,
        lngs,
        lats,
        starts,
        ids,
        road_types,
        width_feet,
        flags,
        name_ids,
        names,
        lengths_m,
        origin_lng,
        origin_lat,
        scale,
        density_offset,
    })
}

/// A ferry stop, unsnapped, with its GTFS name.
pub struct FerryStop {
    pub lng: f64,
    pub lat: f64,
    pub name: String,
}

/// A stop pair (`stop_a` the smaller key), its crossing-plus-wait time and route name (maybe empty).
/// `geometry` runs A -> B between the stops' own points, `None` for a straight leg.
pub struct FerrySegment {
    pub stop_a: u32,
    pub stop_b: u32,
    pub raw_time_seconds: f32,
    pub route_name: String,
    pub geometry: Option<Vec<Coord>>,
}

pub struct Ferries {
    pub stops: Vec<FerryStop>,
    pub segments: Vec<FerrySegment>,
}

/// FERR v2: the NYC ferry graph (layout: scripts/README.md).
pub fn read_ferries(path: &Path) -> Fallible<Ferries> {
    const STOP_BYTES: usize = 12;
    const SEGMENT_BYTES: usize = 20;
    const NO_GEOMETRY: u32 = 0xFFFF_FFFF; // a segment's geometry offset when it is a straight A -> B
    const NO_ROUTE_NAME: u16 = 0xFFFF; // a segment's route name id when the feed named no route

    let bytes = fs::read(path)?;
    check_magic(&bytes, "FERR", FERRY_FORMAT, path)?;
    let header_bytes = usize::from(u16_at(&bytes, 6));
    let stop_count = u32_at(&bytes, 8) as usize;
    let segment_count = u32_at(&bytes, 12) as usize;
    let origin_lng = f64_at(&bytes, 16);
    let origin_lat = f64_at(&bytes, 24);
    let scale = f64_at(&bytes, 32);
    let geometry_offset = u32_at(&bytes, 40) as usize;
    let name_offset = u32_at(&bytes, 48) as usize;
    let name_bytes = u32_at(&bytes, 52) as usize;
    if bytes.len() < name_offset + name_bytes {
        return Err(format!(
            "{} is truncated: {} bytes, {} needed for {stop_count} stops and {segment_count} segments",
            path.display(),
            bytes.len(),
            name_offset + name_bytes
        )
        .into());
    }

    // The name blob: a u32 count, then each name as a u16 byte length and its UTF-8 bytes.
    let mut names: Vec<String> = Vec::new();
    let mut name_cursor = name_offset;
    let name_count = u32_at(&bytes, name_cursor) as usize;
    name_cursor += 4;
    names.reserve(name_count);
    for _ in 0..name_count {
        let len = usize::from(u16_at(&bytes, name_cursor));
        name_cursor += 2;
        names.push(String::from_utf8_lossy(&bytes[name_cursor..name_cursor + len]).into_owned());
        name_cursor += len;
    }

    let stop_table = header_bytes;
    let mut stops = Vec::with_capacity(stop_count);
    for index in 0..stop_count {
        let record = stop_table + index * STOP_BYTES;
        let x = i32_at(&bytes, record);
        let y = i32_at(&bytes, record + 4);
        let name_id = u32_at(&bytes, record + 8) as usize;
        stops.push(FerryStop {
            lng: origin_lng + f64::from(x) * scale,
            lat: origin_lat + f64::from(y) * scale,
            name: names.get(name_id).cloned().unwrap_or_default(),
        });
    }

    let segment_table = stop_table + stop_count * STOP_BYTES;
    let mut segments = Vec::with_capacity(segment_count);
    for index in 0..segment_count {
        let record = segment_table + index * SEGMENT_BYTES;
        let stop_a = u32_at(&bytes, record);
        let stop_b = u32_at(&bytes, record + 4);
        let raw_time_seconds = f32_at(&bytes, record + 8);
        let geom_offset = u32_at(&bytes, record + 12);
        let vertex_count = usize::from(u16_at(&bytes, record + 16));
        let route_name_id = u16_at(&bytes, record + 18);
        let route_name = if route_name_id == NO_ROUTE_NAME {
            String::new()
        } else {
            names
                .get(usize::from(route_name_id))
                .cloned()
                .unwrap_or_default()
        };
        let geometry = if geom_offset == NO_GEOMETRY {
            None
        } else {
            let mut cursor = Cursor {
                bytes: &bytes,
                offset: geometry_offset + geom_offset as usize,
            };
            let mut polyline = Vec::with_capacity(vertex_count);
            let mut x: i64 = 0;
            let mut y: i64 = 0;
            for _ in 0..vertex_count {
                x += i64::from(cursor.varint());
                y += i64::from(cursor.varint());
                polyline.push(Coord {
                    lng: origin_lng + x as f64 * scale,
                    lat: origin_lat + y as f64 * scale,
                });
            }
            Some(polyline)
        };
        segments.push(FerrySegment {
            stop_a,
            stop_b,
            raw_time_seconds,
            route_name,
            geometry,
        });
    }

    Ok(Ferries { stops, segments })
}

/// `surface`: entered off the curb, not down a stair; `complex`: agency transfer complex, 0 for none.
pub struct TransitStation {
    pub lng: f64,
    pub lat: f64,
    pub name: String,
    pub complex: u16,
    pub surface: bool,
    /// No free crossover, so one node per direction; never set on a station sharing a complex.
    pub split: bool,
}

/// Entrance kinds in `kind` byte order; `Passage` is any corridor rather than a descent.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EntranceKind {
    Stair,
    Escalator,
    Elevator,
    Ramp,
    StationHouse,
    Passage,
}

/// A way into a station; `sides` bit d reaches platform direction d (3 both or unknown).
pub struct TransitEntrance {
    pub lng: f64,
    pub lat: f64,
    pub station: u16,
    pub sides: u8,
    pub kind: EntranceKind,
    pub entry: bool,
    pub exit: bool,
}

/// A feed route, with the colors the client draws its rides in.
pub struct TransitRoute {
    pub color: [u8; 3],
    pub text_color: [u8; 3],
    pub short_name: String,
    pub long_name: String,
    pub id: String,
}

/// A route direction's ordered `stops` (station indexes) and `offsets` in seconds from the first stop.
pub struct TransitPattern {
    pub lane_id: u32,
    pub route_index: u16,
    /// GTFS `direction_id`, also the platform side a split station boards this from.
    pub direction: u8,
    pub stops: Vec<u32>,
    pub offsets: Vec<u32>,
}

pub struct Transit {
    pub stations: Vec<TransitStation>,
    pub entrances: Vec<TransitEntrance>,
    pub routes: Vec<TransitRoute>,
    pub patterns: Vec<TransitPattern>,
}

/// TRNS v2: the rail topology; `decodeTopology` in scripts/transit.ts is the reference decoder.
pub fn read_transit(path: &Path) -> Fallible<Transit> {
    const STATION_BYTES: usize = 16;
    const ENTRANCE_BYTES: usize = 16;
    const ROUTE_BYTES: usize = 12;
    const PATTERN_BYTES: usize = 16;
    const SURFACE_FLAG: u8 = 1 << 0;
    const SPLIT_FLAG: u8 = 1 << 1;
    const ENTRY_FLAG: u8 = 1 << 0;
    const EXIT_FLAG: u8 = 1 << 1;

    let bytes = fs::read(path)?;
    check_magic(&bytes, "TRNS", TRANSIT_FORMAT, path)?;
    let header_bytes = usize::from(u16_at(&bytes, 6));
    let station_count = u32_at(&bytes, 8) as usize;
    let route_count = u32_at(&bytes, 12) as usize;
    let pattern_count = u32_at(&bytes, 16) as usize;
    let stop_blob_bytes = u32_at(&bytes, 20) as usize;
    let origin_lng = f64_at(&bytes, 24);
    let origin_lat = f64_at(&bytes, 32);
    let scale = f64_at(&bytes, 40);
    let name_offset = u32_at(&bytes, 48) as usize;
    let total = u32_at(&bytes, 52) as usize;
    let entrance_count = u32_at(&bytes, 56) as usize;
    if bytes.len() != total {
        return Err(format!(
            "{} is {} bytes, not the {total} its header claims",
            path.display(),
            bytes.len()
        )
        .into());
    }

    // The name table: a u32 count, then (count + 1) u32 byte offsets into the trailing UTF-8 blob.
    let name_count = u32_at(&bytes, name_offset) as usize;
    let blob = name_offset + 4 + 4 * (name_count + 1);
    let mut names: Vec<String> = Vec::with_capacity(name_count);
    for index in 0..name_count {
        let start = blob + u32_at(&bytes, name_offset + 4 + 4 * index) as usize;
        let end = blob + u32_at(&bytes, name_offset + 8 + 4 * index) as usize;
        if end > bytes.len() || start > end {
            return Err(format!("{}: name {index} runs off the file", path.display()).into());
        }
        names.push(String::from_utf8_lossy(&bytes[start..end]).into_owned());
    }
    let name = |id: usize| names.get(id).cloned().unwrap_or_default();

    let station_table = header_bytes;
    let mut stations = Vec::with_capacity(station_count);
    for index in 0..station_count {
        let record = station_table + index * STATION_BYTES;
        stations.push(TransitStation {
            lng: origin_lng + f64::from(i32_at(&bytes, record)) * scale,
            lat: origin_lat + f64::from(i32_at(&bytes, record + 4)) * scale,
            name: name(u32_at(&bytes, record + 8) as usize),
            complex: u16_at(&bytes, record + 12),
            surface: bytes[record + 14] & SURFACE_FLAG != 0,
            split: bytes[record + 14] & SPLIT_FLAG != 0,
        });
    }

    let entrance_table = station_table + station_count * STATION_BYTES;
    let mut entrances = Vec::with_capacity(entrance_count);
    for index in 0..entrance_count {
        let record = entrance_table + index * ENTRANCE_BYTES;
        let station = u16_at(&bytes, record + 8);
        if usize::from(station) >= station_count {
            return Err(format!(
                "{}: entrance {index} belongs to station {station} of {station_count}",
                path.display()
            )
            .into());
        }
        let kind = match bytes[record + 11] {
            0 => EntranceKind::Stair,
            1 => EntranceKind::Escalator,
            2 => EntranceKind::Elevator,
            3 => EntranceKind::Ramp,
            4 => EntranceKind::StationHouse,
            5 => EntranceKind::Passage,
            other => {
                return Err(
                    format!("{}: entrance {index} is of kind {other}", path.display()).into(),
                );
            }
        };
        entrances.push(TransitEntrance {
            lng: origin_lng + f64::from(i32_at(&bytes, record)) * scale,
            lat: origin_lat + f64::from(i32_at(&bytes, record + 4)) * scale,
            station,
            sides: bytes[record + 10],
            kind,
            entry: bytes[record + 12] & ENTRY_FLAG != 0,
            exit: bytes[record + 12] & EXIT_FLAG != 0,
        });
    }

    let route_table = entrance_table + entrance_count * ENTRANCE_BYTES;
    let mut routes = Vec::with_capacity(route_count);
    for index in 0..route_count {
        let record = route_table + index * ROUTE_BYTES;
        routes.push(TransitRoute {
            color: [bytes[record], bytes[record + 1], bytes[record + 2]],
            text_color: [bytes[record + 3], bytes[record + 4], bytes[record + 5]],
            short_name: name(usize::from(u16_at(&bytes, record + 6))),
            long_name: name(usize::from(u16_at(&bytes, record + 8))),
            id: name(usize::from(u16_at(&bytes, record + 10))),
        });
    }

    let pattern_table = route_table + route_count * ROUTE_BYTES;
    let stop_blob = pattern_table + pattern_count * PATTERN_BYTES;
    if stop_blob + stop_blob_bytes != name_offset {
        return Err(format!(
            "{}: the pattern-stop blob does not run up to the name table",
            path.display()
        )
        .into());
    }
    let mut patterns = Vec::with_capacity(pattern_count);
    for index in 0..pattern_count {
        let record = pattern_table + index * PATTERN_BYTES;
        let stop_count = usize::from(u16_at(&bytes, record + 8));
        let mut cursor = Cursor {
            bytes: &bytes,
            offset: stop_blob + u32_at(&bytes, record + 12) as usize,
        };
        let mut stops = Vec::with_capacity(stop_count);
        let mut offsets = Vec::with_capacity(stop_count);
        let mut elapsed = 0u32;
        for _ in 0..stop_count {
            let station = cursor.unsigned_varint();
            if station as usize >= station_count {
                return Err(format!(
                    "{}: pattern {index} rides to station {station} of {station_count}",
                    path.display()
                )
                .into());
            }
            elapsed += cursor.unsigned_varint();
            stops.push(station);
            offsets.push(elapsed);
        }
        patterns.push(TransitPattern {
            lane_id: u32_at(&bytes, record),
            route_index: u16_at(&bytes, record + 4),
            direction: bytes[record + 6],
            stops,
            offsets,
        });
    }

    Ok(Transit {
        stations,
        entrances,
        routes,
        patterns,
    })
}

pub fn zigzag(value: i64) -> u64 {
    ((value << 1) ^ (value >> 63)) as u64
}

pub fn write_varint(bytes: &mut Vec<u8>, value: u64) {
    let mut remaining = value;
    while remaining >= 0x80 {
        bytes.push((remaining as u8 & 0x7f) | 0x80);
        remaining >>= 7;
    }
    bytes.push(remaining as u8);
}

#[cfg(test)]
mod tests {
    use super::*;

    // A tiny TRNS: two stations (the first split, with two entrances), one route, one pattern.
    fn transit_fixture() -> Vec<u8> {
        const HEADER: usize = 64;
        let names = ["Court Sq", "Bergen St", "G", "Crosstown", "gtfs:G"];
        let mut stations = Vec::new();
        for (index, (x, y, name_id, complex, flags)) in [
            (1_000i32, 2_000i32, 0u32, 3u16, 0b10u8),
            (4_000, 6_000, 1, 0, 0b01),
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(stations.len(), index * 16);
            stations.extend_from_slice(&x.to_le_bytes());
            stations.extend_from_slice(&y.to_le_bytes());
            stations.extend_from_slice(&name_id.to_le_bytes());
            stations.extend_from_slice(&complex.to_le_bytes());
            stations.push(flags);
            stations.push(0);
        }

        // Station 0's doors: a northbound stair, and an exit-only elevator to both sides.
        let mut entrances = Vec::new();
        for (index, (x, y, station, sides, kind, flags)) in [
            (1_100i32, 2_050i32, 0u16, 0b01u8, 0u8, 0b11u8),
            (900, 1_950, 0, 0b11, 2, 0b10),
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(entrances.len(), index * 16);
            entrances.extend_from_slice(&x.to_le_bytes());
            entrances.extend_from_slice(&y.to_le_bytes());
            entrances.extend_from_slice(&station.to_le_bytes());
            entrances.push(sides);
            entrances.push(kind);
            entrances.push(flags);
            entrances.push(0);
            entrances.extend_from_slice(&0xFFFFu16.to_le_bytes());
        }

        let mut routes = vec![0x11, 0x22, 0x33, 0xEE, 0xDD, 0xCC];
        routes.extend_from_slice(&2u16.to_le_bytes());
        routes.extend_from_slice(&3u16.to_le_bytes());
        routes.extend_from_slice(&4u16.to_le_bytes());

        // Two stops: station 0 at 0 s, station 1 at 300 s. Plain LEB128, so 300 is two bytes.
        let stop_blob = vec![0, 0, 1, 0xAC, 0x02, 0, 0, 0];

        let mut patterns = Vec::new();
        patterns.extend_from_slice(&0xDEAD_BEEFu32.to_le_bytes());
        patterns.extend_from_slice(&0u16.to_le_bytes());
        patterns.push(1);
        patterns.push(0);
        patterns.extend_from_slice(&2u16.to_le_bytes());
        patterns.extend_from_slice(&0u16.to_le_bytes());
        patterns.extend_from_slice(&0u32.to_le_bytes());

        let mut name_table = (names.len() as u32).to_le_bytes().to_vec();
        let mut at = 0u32;
        for name in names {
            name_table.extend_from_slice(&at.to_le_bytes());
            at += name.len() as u32;
        }
        name_table.extend_from_slice(&at.to_le_bytes());
        for name in names {
            name_table.extend_from_slice(name.as_bytes());
        }

        let name_offset = HEADER
            + stations.len()
            + entrances.len()
            + routes.len()
            + patterns.len()
            + stop_blob.len();
        let total = name_offset + name_table.len();
        let mut bytes = Vec::with_capacity(total);
        bytes.extend_from_slice(b"TRNS");
        bytes.extend_from_slice(&TRANSIT_FORMAT.to_le_bytes());
        bytes.extend_from_slice(&(HEADER as u16).to_le_bytes());
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&(stop_blob.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&(-73.5f64).to_le_bytes());
        bytes.extend_from_slice(&40.25f64.to_le_bytes());
        bytes.extend_from_slice(&1e-6f64.to_le_bytes());
        bytes.extend_from_slice(&(name_offset as u32).to_le_bytes());
        bytes.extend_from_slice(&(total as u32).to_le_bytes());
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&stations);
        bytes.extend_from_slice(&entrances);
        bytes.extend_from_slice(&routes);
        bytes.extend_from_slice(&patterns);
        bytes.extend_from_slice(&stop_blob);
        bytes.extend_from_slice(&name_table);
        assert_eq!(bytes.len(), total);
        bytes
    }

    #[test]
    fn a_transit_topology_reads_back_what_the_ingest_wrote() {
        let directory = std::env::temp_dir().join("tiler-trns-fixture");
        fs::create_dir_all(&directory).expect("a scratch directory");
        let path = directory.join("fixture.bin");
        fs::write(&path, transit_fixture()).expect("the fixture");

        let transit = read_transit(&path).expect("a topology");

        assert_eq!(transit.stations.len(), 2);
        assert_eq!(transit.stations[0].name, "Court Sq");
        assert_eq!(transit.stations[0].complex, 3);
        assert_eq!(transit.stations[1].complex, 0);
        assert!(!transit.stations[0].surface);
        assert!(transit.stations[1].surface);
        assert!(transit.stations[0].split);
        assert!(!transit.stations[1].split);
        assert_eq!(transit.entrances.len(), 2);
        assert_eq!(transit.entrances[0].station, 0);
        assert_eq!(transit.entrances[0].sides, 0b01);
        assert_eq!(transit.entrances[0].kind, EntranceKind::Stair);
        assert!(transit.entrances[0].entry && transit.entrances[0].exit);
        assert!((transit.entrances[0].lng - -73.4989).abs() < 1e-9);
        assert!((transit.entrances[0].lat - 40.25205).abs() < 1e-9);
        assert_eq!(transit.entrances[1].sides, 0b11);
        assert_eq!(transit.entrances[1].kind, EntranceKind::Elevator);
        assert!(!transit.entrances[1].entry && transit.entrances[1].exit);
        assert!((transit.stations[1].lng - -73.496).abs() < 1e-9);
        assert!((transit.stations[1].lat - 40.256).abs() < 1e-9);
        assert_eq!(transit.routes.len(), 1);
        assert_eq!(transit.routes[0].color, [0x11, 0x22, 0x33]);
        assert_eq!(transit.routes[0].text_color, [0xEE, 0xDD, 0xCC]);
        assert_eq!(transit.routes[0].short_name, "G");
        assert_eq!(transit.routes[0].long_name, "Crosstown");
        assert_eq!(transit.routes[0].id, "gtfs:G");
        assert_eq!(transit.patterns.len(), 1);
        assert_eq!(transit.patterns[0].lane_id, 0xDEAD_BEEF);
        assert_eq!(transit.patterns[0].direction, 1);
        assert_eq!(transit.patterns[0].stops, vec![0, 1]);
        assert_eq!(transit.patterns[0].offsets, vec![0, 300]);

        fs::remove_file(&path).expect("the fixture removed");
    }

    /// The committed artifacts, the only proof this reader agrees with the TypeScript encoder.
    #[test]
    fn the_committed_topologies_decode() {
        let data = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/transit");
        for city in ["nyc", "sf"] {
            let path = data.join(format!("{city}.bin"));
            if !path.exists() {
                continue; // a sparse checkout without the committed data
            }
            let transit = read_transit(&path).expect("a topology");
            assert!(transit.stations.len() > 100, "{city} has stations");
            assert!(transit.routes.len() > 5, "{city} has routes");
            assert!(transit.patterns.len() > 20, "{city} has patterns");
            assert!(
                transit
                    .stations
                    .iter()
                    .all(|station| !station.name.is_empty()),
                "{city} names every station"
            );
            for entrance in &transit.entrances {
                assert!(
                    usize::from(entrance.station) < transit.stations.len(),
                    "{city} entrance names a station"
                );
                assert!(
                    entrance.sides & 0b11 != 0,
                    "{city} entrance reaches a platform"
                );
                assert!(
                    entrance.entry || entrance.exit,
                    "{city} entrance is a way in or a way out"
                );
            }
            let mut complex_size: std::collections::HashMap<u16, usize> = Default::default();
            for station in &transit.stations {
                if station.complex != 0 {
                    *complex_size.entry(station.complex).or_default() += 1;
                }
            }
            assert!(
                transit.stations.iter().all(|station| {
                    !station.split || complex_size.get(&station.complex).copied().unwrap_or(0) <= 1
                }),
                "{city} splits no station that shares a transfer complex"
            );
            for pattern in &transit.patterns {
                assert!(pattern.stops.len() >= 2, "{city} pattern rides somewhere");
                assert_eq!(pattern.stops.len(), pattern.offsets.len());
                assert_eq!(pattern.offsets[0], 0, "{city} pattern starts at zero");
                assert!(
                    pattern.offsets.windows(2).all(|pair| pair[0] <= pair[1]),
                    "{city} pattern never rides backwards"
                );
                assert!(
                    usize::from(pattern.route_index) < transit.routes.len(),
                    "{city} pattern names a route"
                );
            }
        }
    }
}

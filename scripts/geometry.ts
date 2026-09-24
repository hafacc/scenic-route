// Layouts are documented in scripts/README.md.

import type { Bounds } from "./manifest";
import type { Polygon } from "./overpass";
import type { Coord } from "./socrata";

export const HEADER_BYTES = 40;
export const COORD_SCALE = 1e-6; // degrees per quantized unit, ~0.1 m

export const EARTH_RADIUS_METERS = 6_371_008.8;

// Great-circle distance in meters.
export function haversineMeters(from: Coord, to: Coord): number {
  const fromLat = from.lat * (Math.PI / 180);
  const toLat = to.lat * (Math.PI / 180);
  const deltaLat = toLat - fromLat;
  const deltaLng = (to.lng - from.lng) * (Math.PI / 180);
  const chord =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(chord)));
}

export function zigzag(value: number): number {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

export function writeVarint(
  bytes: Uint8Array,
  offset: number,
  value: number,
): number {
  let cursor = offset;
  let remaining = value;
  while (remaining >= 0x80) {
    bytes[cursor] = (remaining & 0x7f) | 0x80;
    remaining >>>= 7;
    cursor += 1;
  }
  bytes[cursor] = remaining;
  return cursor + 1;
}

export function boxOf(polygons: readonly Polygon[]): Bounds {
  let south = Number.POSITIVE_INFINITY;
  let west = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const { lat, lng } of ring) {
        south = Math.min(south, lat);
        north = Math.max(north, lat);
        west = Math.min(west, lng);
        east = Math.max(east, lng);
      }
    }
  }
  return { south, west, north, east };
}

function writeHeader(
  bytes: Uint8Array,
  view: DataView,
  magic: string,
  format: number,
  count: number,
  originLng: number,
  originLat: number,
): void {
  for (let index = 0; index < 4; index++) {
    bytes[index] = magic.charCodeAt(index);
  }
  view.setUint16(4, format, true);
  view.setUint16(6, HEADER_BYTES, true);
  view.setUint32(8, count, true);
  view.setFloat64(16, originLng, true);
  view.setFloat64(24, originLat, true);
  view.setFloat64(32, COORD_SCALE, true);
}

// `genusId` is a top-11 genus 0..10, or 11 ("Other") for a tail, unknown or OSM tree.
export interface CrownedTree extends Coord {
  crownRadiusM: number;
  genusId: number;
}

export const DECIMETERS_PER_METER = 10; // the crown byte's unit

// Sorted by (lat, lng) so each delta is a short step along a row. layout: scripts/README.md
export function encodeTrees(
  format: number,
  trees: readonly CrownedTree[],
): Uint8Array {
  let originLng = Number.POSITIVE_INFINITY;
  let originLat = Number.POSITIVE_INFINITY;
  for (const { lat, lng } of trees) {
    originLng = Math.min(originLng, lng);
    originLat = Math.min(originLat, lat);
  }

  const quantized = trees
    .map(({ lat, lng, crownRadiusM, genusId }) => ({
      x: Math.round((lng - originLng) / COORD_SCALE),
      y: Math.round((lat - originLat) / COORD_SCALE),
      crown: Math.min(
        255,
        Math.max(0, Math.round(crownRadiusM * DECIMETERS_PER_METER)),
      ),
      genusId,
    }))
    .sort((left, right) => left.y - right.y || left.x - right.x);

  // Two varints of at most five bytes each per point, then the crown and genus bytes.
  const bytes = new Uint8Array(HEADER_BYTES + trees.length * 12);
  const view = new DataView(bytes.buffer);
  let offset = HEADER_BYTES;
  let previousX = 0;
  let previousY = 0;
  for (const { x, y } of quantized) {
    offset = writeVarint(bytes, offset, zigzag(x - previousX));
    offset = writeVarint(bytes, offset, zigzag(y - previousY));
    previousX = x;
    previousY = y;
  }
  for (const { crown } of quantized) {
    bytes[offset] = crown;
    offset += 1;
  }
  for (const { genusId } of quantized) {
    bytes[offset] = genusId;
    offset += 1;
  }
  writeHeader(bytes, view, "TREE", format, trees.length, originLng, originLat);
  return bytes.subarray(0, offset);
}

export interface ClassifiedPoint extends Coord {
  klass: number; // 0..255
}

// layout: scripts/README.md
export function encodeClassifiedPoints(
  magic: string,
  format: number,
  points: readonly ClassifiedPoint[],
): Uint8Array {
  let originLng = Number.POSITIVE_INFINITY;
  let originLat = Number.POSITIVE_INFINITY;
  for (const { lat, lng } of points) {
    originLng = Math.min(originLng, lng);
    originLat = Math.min(originLat, lat);
  }

  const quantized = points
    .map(({ lat, lng, klass }) => ({
      x: Math.round((lng - originLng) / COORD_SCALE),
      y: Math.round((lat - originLat) / COORD_SCALE),
      klass,
    }))
    .sort((left, right) => left.y - right.y || left.x - right.x);

  const bytes = new Uint8Array(HEADER_BYTES + points.length * 11);
  const view = new DataView(bytes.buffer);
  let offset = HEADER_BYTES;
  let previousX = 0;
  let previousY = 0;
  for (const { x, y } of quantized) {
    offset = writeVarint(bytes, offset, zigzag(x - previousX));
    offset = writeVarint(bytes, offset, zigzag(y - previousY));
    previousX = x;
    previousY = y;
  }
  for (const { klass } of quantized) {
    bytes[offset] = klass;
    offset += 1;
  }
  writeHeader(bytes, view, magic, format, points.length, originLng, originLat);
  return bytes.subarray(0, offset);
}

export interface NamedPoint extends Coord {
  name?: string;
}

// The trailing name blob is client-only; the Rust reader ignores it. layout: scripts/README.md
export function encodePoints(
  magic: string,
  format: number,
  points: readonly NamedPoint[],
): Uint8Array {
  let originLng = Number.POSITIVE_INFINITY;
  let originLat = Number.POSITIVE_INFINITY;
  for (const { lat, lng } of points) {
    originLng = Math.min(originLng, lng);
    originLat = Math.min(originLat, lat);
  }

  const encoder = new TextEncoder();
  const quantized = points
    .map(({ lat, lng, name }) => ({
      x: Math.round((lng - originLng) / COORD_SCALE),
      y: Math.round((lat - originLat) / COORD_SCALE),
      name: encoder.encode(name ?? ""),
    }))
    .sort((left, right) => left.y - right.y || left.x - right.x);

  const pointBytes = new Uint8Array(HEADER_BYTES + points.length * 10);
  const view = new DataView(pointBytes.buffer);
  let offset = HEADER_BYTES;
  let previousX = 0;
  let previousY = 0;
  for (const { x, y } of quantized) {
    offset = writeVarint(pointBytes, offset, zigzag(x - previousX));
    offset = writeVarint(pointBytes, offset, zigzag(y - previousY));
    previousX = x;
    previousY = y;
  }
  writeHeader(
    pointBytes,
    view,
    magic,
    format,
    points.length,
    originLng,
    originLat,
  );

  let nameBlobLength = 0;
  for (const { name } of quantized) {
    nameBlobLength += 2 + name.length;
  }
  const nameBlob = new Uint8Array(nameBlobLength);
  const nameView = new DataView(nameBlob.buffer);
  let nameCursor = 0;
  for (const { name } of quantized) {
    nameView.setUint16(nameCursor, name.length, true);
    nameCursor += 2;
    nameBlob.set(name, nameCursor);
    nameCursor += name.length;
  }

  const out = new Uint8Array(offset + nameBlobLength);
  out.set(pointBytes.subarray(0, offset));
  out.set(nameBlob, offset);
  return out;
}

// layout: scripts/README.md
export function encodePolygons(
  magic: string,
  format: number,
  polygons: readonly Polygon[],
): Uint8Array {
  let originLng = Number.POSITIVE_INFINITY;
  let originLat = Number.POSITIVE_INFINITY;
  let vertices = 0;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      vertices += ring.length;
      for (const { lat, lng } of ring) {
        originLng = Math.min(originLng, lng);
        originLat = Math.min(originLat, lat);
      }
    }
  }

  // Two 5-byte varints per vertex, a 4-byte count per ring, a 2-byte count per polygon.
  const bytes = new Uint8Array(
    HEADER_BYTES + polygons.length * 2 + vertices * 14,
  );
  const view = new DataView(bytes.buffer);
  let offset = HEADER_BYTES;
  for (const polygon of polygons) {
    view.setUint16(offset, polygon.length, true);
    offset += 2;
    for (const ring of polygon) {
      view.setUint32(offset, ring.length, true);
      offset += 4;
      let previousX = 0;
      let previousY = 0;
      for (const { lat, lng } of ring) {
        const x = Math.round((lng - originLng) / COORD_SCALE);
        const y = Math.round((lat - originLat) / COORD_SCALE);
        offset = writeVarint(bytes, offset, zigzag(x - previousX));
        offset = writeVarint(bytes, offset, zigzag(y - previousY));
        previousX = x;
        previousY = y;
      }
    }
  }
  writeHeader(
    bytes,
    view,
    magic,
    format,
    polygons.length,
    originLng,
    originLat,
  );
  return bytes.subarray(0, offset);
}

// The height region is zeroed here and filled in place by the height pass; 0 reads as unknown.
export function encodeCanopy(
  format: number,
  polygons: readonly Polygon[],
): Uint8Array {
  const body = encodePolygons("CNPY", format, polygons);
  const out = new Uint8Array(body.length + polygons.length * 2);
  out.set(body);
  return out;
}

// The encodePolygons body, then each column in turn: one byte per polygon, in polygon order.
export function encodeClassifiedPolygons(
  magic: string,
  format: number,
  polygons: readonly Polygon[],
  ...columns: readonly (readonly number[])[]
): Uint8Array {
  for (const column of columns) {
    if (column.length !== polygons.length) {
      throw new Error(
        `${magic}: ${column.length} bytes for ${polygons.length} polygons`,
      );
    }
  }
  const body = encodePolygons(magic, format, polygons);
  const out = new Uint8Array(body.length + columns.length * polygons.length);
  out.set(body);
  columns.forEach((column, index) => {
    out.set(new Uint8Array(column), body.length + index * polygons.length);
  });
  return out;
}

// A MultiPolygon becomes several entries, each repeating the building's height and base.
export interface HeightedBuilding {
  polygon: Polygon;
  heightMeters: number;
  baseElevationMeters: number;
}

// Keeps the harbor's slightly negative ground (min ~ -3 m) non-negative in the u16 store.
export const ELEVATION_BIAS_METERS = 100;

// layout: scripts/README.md
export function encodeBuildings(
  format: number,
  buildings: readonly HeightedBuilding[],
): Uint8Array {
  const polygons = buildings.map((building) => building.polygon);
  const body = encodePolygons("BLDG", format, polygons);
  const trailing = new Uint8Array(buildings.length * 4);
  const trailingView = new DataView(trailing.buffer);
  for (let index = 0; index < buildings.length; index++) {
    const heightDecimeters = Math.round(
      buildings[index].heightMeters * DECIMETERS_PER_METER,
    );
    trailingView.setUint16(
      index * 2,
      Math.min(65535, Math.max(0, heightDecimeters)),
      true,
    );
  }
  const baseOffset = buildings.length * 2;
  for (let index = 0; index < buildings.length; index++) {
    const biasedDecimeters = Math.round(
      (buildings[index].baseElevationMeters + ELEVATION_BIAS_METERS) *
        DECIMETERS_PER_METER,
    );
    trailingView.setUint16(
      baseOffset + index * 2,
      Math.min(65535, Math.max(0, biasedDecimeters)),
      true,
    );
  }
  const out = new Uint8Array(body.length + trailing.length);
  out.set(body);
  out.set(trailing, body.length);
  return out;
}

export const NETWORK_HEADER_BYTES = 64;
export const NETWORK_RECORD_BYTES = 24;
export const NETWORK_SIDES = 2; // left then right sidewalk per vertex
export const UNNAMED_ID = 0xffff;

// Dense enough that the sampled field's color varies along a line rather than in one flat block.
export function densify(
  points: readonly Coord[],
  stepMeters: number,
): { points: Coord[]; lengthMeters: number } {
  const dense: Coord[] = [points[0]];
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1];
    const to = points[index];
    const meters = haversineMeters(from, to);
    total += meters;
    const steps = Math.max(1, Math.ceil(meters / stepMeters));
    for (let step = 1; step <= steps; step++) {
      const along = step / steps;
      dense.push({
        lat: from.lat + (to.lat - from.lat) * along,
        lng: from.lng + (to.lng - from.lng) * along,
      });
    }
  }
  return { points: dense, lengthMeters: total };
}

export interface Named {
  name: string;
  nameId: number;
}

// Stamps each record's `nameId` in place and returns the sorted table.
export function buildNameTable(records: readonly Named[]): string[] {
  const distinct = new Set<string>();
  for (const record of records) {
    if (record.name) {
      distinct.add(record.name);
    }
  }
  const names = [...distinct].sort();
  const idOf = new Map(names.map((name, index) => [name, index]));
  for (const record of records) {
    record.nameId = record.name
      ? (idOf.get(record.name) ?? UNNAMED_ID)
      : UNNAMED_ID;
  }
  return names;
}

// PATH and SWLK leave width and speed 0.
export interface NetworkRecord {
  id: number; // CSCL physicalid, or an OSM way id
  nameId: number;
  lengthMeters: number;
  kind: number; // rw_type, or the PATH / SWLK kind
  width: number;
  speed: number;
  flags: number;
  points: Coord[];
}

// The density blob is zeroed here and filled in place by the density pass (never for SWLK).
export function encodeNetwork(
  magic: string,
  format: number,
  records: readonly NetworkRecord[],
  names: readonly string[],
): Uint8Array {
  let originLng = Number.POSITIVE_INFINITY;
  let originLat = Number.POSITIVE_INFINITY;
  let vertices = 0;
  for (const record of records) {
    vertices += record.points.length;
    for (const { lat, lng } of record.points) {
      originLng = Math.min(originLng, lng);
      originLat = Math.min(originLat, lat);
    }
  }

  const table = new Uint8Array(
    NETWORK_HEADER_BYTES + records.length * NETWORK_RECORD_BYTES,
  );
  const view = new DataView(table.buffer);
  const blob = new Uint8Array(vertices * 10);
  let blobEnd = 0;
  let vertex = 0;

  for (let index = 0; index < records.length; index++) {
    const entry = records[index];
    const start = blobEnd;
    let previousX = 0;
    let previousY = 0;
    for (const { lat, lng } of entry.points) {
      const quantizedX = Math.round((lng - originLng) / COORD_SCALE);
      const quantizedY = Math.round((lat - originLat) / COORD_SCALE);
      blobEnd = writeVarint(blob, blobEnd, zigzag(quantizedX - previousX));
      blobEnd = writeVarint(blob, blobEnd, zigzag(quantizedY - previousY));
      previousX = quantizedX;
      previousY = quantizedY;
    }

    const record = NETWORK_HEADER_BYTES + index * NETWORK_RECORD_BYTES;
    view.setUint32(record, entry.id, true);
    view.setUint32(record + 4, start, true);
    view.setUint16(record + 8, entry.points.length, true);
    view.setUint16(record + 10, entry.nameId, true);
    view.setFloat32(record + 12, entry.lengthMeters, true);
    view.setUint32(record + 16, vertex, true);
    table[record + 20] = entry.kind;
    table[record + 21] = entry.width;
    table[record + 22] = entry.speed;
    table[record + 23] = entry.flags;
    vertex += entry.points.length;
  }

  for (let index = 0; index < 4; index++) {
    table[index] = magic.charCodeAt(index);
  }
  view.setUint16(4, format, true);
  view.setUint16(6, NETWORK_HEADER_BYTES, true);
  view.setUint16(8, NETWORK_RECORD_BYTES, true);
  view.setUint32(12, records.length, true);
  view.setFloat64(16, originLng, true);
  view.setFloat64(24, originLat, true);
  view.setFloat64(32, COORD_SCALE, true);
  const encoder = new TextEncoder();
  const nameBytes = names.map((name) => encoder.encode(name));
  let nameBlobLength = 4;
  for (const bytes of nameBytes) {
    nameBlobLength += 2 + bytes.length;
  }
  const nameBlob = new Uint8Array(nameBlobLength);
  const nameView = new DataView(nameBlob.buffer);
  nameView.setUint32(0, names.length, true);
  let nameCursor = 4;
  for (const bytes of nameBytes) {
    nameView.setUint16(nameCursor, bytes.length, true);
    nameCursor += 2;
    nameBlob.set(bytes, nameCursor);
    nameCursor += bytes.length;
  }

  const densityBytes = NETWORK_SIDES * vertices;
  const nameBlobOffset = table.length + blobEnd + densityBytes;
  view.setUint32(40, table.length, true);
  view.setUint32(44, blobEnd, true);
  view.setUint32(48, table.length + blobEnd, true);
  view.setUint32(52, densityBytes, true);
  view.setUint32(56, nameBlobOffset, true);
  view.setUint32(60, nameBlobLength, true);

  const encoded = new Uint8Array(nameBlobOffset + nameBlobLength);
  encoded.set(table);
  encoded.set(blob.subarray(0, blobEnd), table.length);
  encoded.set(nameBlob, nameBlobOffset);
  return encoded;
}

export interface DecodedNetwork {
  magic: string;
  format: number;
  records: NetworkRecord[];
  names: string[];
  densities: Uint8Array; // two bytes a vertex, left then right
}

function readVarint(bytes: Uint8Array, cursor: { offset: number }): number {
  let shift = 0;
  let value = 0;
  for (;;) {
    const byte = bytes[cursor.offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return value;
    }
    shift += 7;
  }
}

// Reads the header's offsets, not the encoder's arithmetic, so a wrong header fails here.
export function decodeNetwork(bytes: Uint8Array): DecodedNetwork {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  const headerBytes = view.getUint16(6, true);
  const recordBytes = view.getUint16(8, true);
  const count = view.getUint32(12, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const coordOffset = view.getUint32(40, true);
  const densityOffset = view.getUint32(48, true);
  const densityBytes = view.getUint32(52, true);
  const nameOffset = view.getUint32(56, true);

  const names: string[] = [];
  const decoder = new TextDecoder();
  const nameCount = view.getUint32(nameOffset, true);
  let nameCursor = nameOffset + 4;
  for (let index = 0; index < nameCount; index++) {
    const length = view.getUint16(nameCursor, true);
    nameCursor += 2;
    names.push(decoder.decode(bytes.subarray(nameCursor, nameCursor + length)));
    nameCursor += length;
  }

  const records: NetworkRecord[] = [];
  for (let index = 0; index < count; index++) {
    const record = headerBytes + index * recordBytes;
    const vertexCount = view.getUint16(record + 8, true);
    const cursor = { offset: coordOffset + view.getUint32(record + 4, true) };
    const points: Coord[] = [];
    let x = 0;
    let y = 0;
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const deltaX = readVarint(bytes, cursor);
      const deltaY = readVarint(bytes, cursor);
      x += deltaX % 2 === 0 ? deltaX / 2 : -(deltaX + 1) / 2;
      y += deltaY % 2 === 0 ? deltaY / 2 : -(deltaY + 1) / 2;
      points.push({ lng: originLng + x * scale, lat: originLat + y * scale });
    }
    records.push({
      id: view.getUint32(record, true),
      nameId: view.getUint16(record + 10, true),
      lengthMeters: view.getFloat32(record + 12, true),
      kind: bytes[record + 20],
      width: bytes[record + 21],
      speed: bytes[record + 22],
      flags: bytes[record + 23],
      points,
    });
  }

  return {
    magic,
    format: view.getUint16(4, true),
    records,
    names,
    densities: bytes.subarray(densityOffset, densityOffset + densityBytes),
  };
}

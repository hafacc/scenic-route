// Polygons as flat typed arrays, so a city's canopy costs 16 bytes a vertex rather than an object each.

import { createHash } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { temporaryPath } from "./cache";
import {
  COORD_SCALE,
  EARTH_RADIUS_METERS,
  HEADER_BYTES,
  writeHeader,
  writeVarint,
  zigzag,
} from "./geometry";
import type { Polygon } from "./overpass";
import type { Coord } from "./socrata";

// Ring r spans vertices ringStarts[r]..ringStarts[r+1]; polygon p spans rings polygonStarts[p]..[p+1].
export interface PackedPolygons {
  lng: Float64Array;
  lat: Float64Array;
  ringStarts: Uint32Array;
  polygonStarts: Uint32Array;
}

export function polygonCount(packed: PackedPolygons): number {
  return packed.polygonStarts.length - 1;
}

function grown<Array extends Float64Array | Uint32Array>(
  array: Array,
  needed: number,
): Array {
  if (needed <= array.length) {
    return array;
  }
  const next = new (array.constructor as new (length: number) => Array)(
    Math.max(needed, array.length * 2),
  );
  next.set(array);
  return next;
}

// Appends rings and closes polygons; `finish` trims the arrays to what was written.
export class PolygonPacker {
  private lng = new Float64Array(1024);
  private lat = new Float64Array(1024);
  private ringStarts = new Uint32Array(256);
  private polygonStarts = new Uint32Array(64);
  private vertices = 0;
  private rings = 0;
  private polygons = 0;
  private openRings = 0; // rings added since the last closed polygon

  constructor() {
    this.ringStarts[0] = 0;
    this.polygonStarts[0] = 0;
  }

  // A ring of [lng, lat] pairs, as GeoJSON and Esri JSON give them.
  ring(points: readonly (readonly number[])[]): void {
    this.reserve(points.length);
    for (const point of points) {
      this.lng[this.vertices] = point[0];
      this.lat[this.vertices] = point[1];
      this.vertices += 1;
    }
    this.closeRing();
  }

  coordRing(points: readonly Coord[]): void {
    this.reserve(points.length);
    for (const { lng, lat } of points) {
      this.lng[this.vertices] = lng;
      this.lat[this.vertices] = lat;
      this.vertices += 1;
    }
    this.closeRing();
  }

  // Copies ring `ring` of `from`.
  copyRing(from: PackedPolygons, ring: number): void {
    const start = from.ringStarts[ring];
    const end = from.ringStarts[ring + 1];
    this.reserve(end - start);
    this.lng.set(from.lng.subarray(start, end), this.vertices);
    this.lat.set(from.lat.subarray(start, end), this.vertices);
    this.vertices += end - start;
    this.closeRing();
  }

  // False, and nothing kept, when no ring was added since the last polygon.
  endPolygon(): boolean {
    if (this.openRings === 0) {
      return false;
    }
    this.openRings = 0;
    this.polygons += 1;
    this.polygonStarts = grown(this.polygonStarts, this.polygons + 1);
    this.polygonStarts[this.polygons] = this.rings;
    return true;
  }

  finish(): PackedPolygons {
    return {
      lng: this.lng.slice(0, this.vertices),
      lat: this.lat.slice(0, this.vertices),
      ringStarts: this.ringStarts.slice(0, this.rings + 1),
      polygonStarts: this.polygonStarts.slice(0, this.polygons + 1),
    };
  }

  private reserve(vertices: number): void {
    this.lng = grown(this.lng, this.vertices + vertices);
    this.lat = grown(this.lat, this.vertices + vertices);
  }

  private closeRing(): void {
    this.rings += 1;
    this.openRings += 1;
    this.ringStarts = grown(this.ringStarts, this.rings + 1);
    this.ringStarts[this.rings] = this.vertices;
  }
}

// Every ring kept, as the land-cut canopy is already cut and filtered.
export function packPolygons(polygons: readonly Polygon[]): PackedPolygons {
  const packer = new PolygonPacker();
  for (const polygon of polygons) {
    for (const ring of polygon) {
      packer.coordRing(ring);
    }
    if (!packer.endPolygon()) {
      throw new Error("a land-cut canopy polygon has no ring left to pack");
    }
  }
  return packer.finish();
}

const METERS_PER_DEGREE_LAT = (EARTH_RADIUS_METERS * Math.PI) / 180;

// Signed by winding; Esri winds holes opposite their outer ring, so a polygon's sum nets them out.
function ringSignedAreaSquareMeters(
  packed: PackedPolygons,
  ring: number,
  refLat: number,
): number {
  const metersPerLng =
    METERS_PER_DEGREE_LAT * Math.cos(refLat * (Math.PI / 180));
  const start = packed.ringStarts[ring];
  const length = packed.ringStarts[ring + 1] - start;
  const { lng, lat } = packed;
  let twiceArea = 0;
  for (let point = 0, previous = length - 1; point < length; point++) {
    const currentX = lng[start + point] * metersPerLng;
    const currentY = lat[start + point] * METERS_PER_DEGREE_LAT;
    const previousX = lng[start + previous] * metersPerLng;
    const previousY = lat[start + previous] * METERS_PER_DEGREE_LAT;
    twiceArea += previousX * currentY - currentX * previousY;
    previous = point;
  }
  return twiceArea / 2;
}

// The canopy kept so far, with the origin, counts and area its encoding and the manifest need.
export class PolygonCollector {
  readonly pages: PackedPolygons[] = [];
  polygons = 0;
  vertices = 0;
  squareMeters = 0;
  originLng = Number.POSITIVE_INFINITY;
  originLat = Number.POSITIVE_INFINITY;

  constructor(private readonly refLat: number) {}

  // One vertex decides the whole polygon: fine for crowns, wrong for polygons the coast cuts through.
  add(page: PackedPolygons, onLand: ((coord: Coord) => boolean) | null): void {
    let kept = page;
    if (onLand !== null) {
      const packer = new PolygonPacker();
      for (let polygon = 0; polygon < polygonCount(page); polygon++) {
        const first = page.polygonStarts[polygon];
        const start = page.ringStarts[first];
        const middle =
          start + Math.floor((page.ringStarts[first + 1] - start) / 2);
        if (onLand({ lat: page.lat[middle], lng: page.lng[middle] })) {
          for (
            let ring = first;
            ring < page.polygonStarts[polygon + 1];
            ring++
          ) {
            packer.copyRing(page, ring);
          }
          packer.endPolygon();
        }
      }
      kept = packer.finish();
    }
    for (let polygon = 0; polygon < polygonCount(kept); polygon++) {
      let net = 0;
      for (
        let ring = kept.polygonStarts[polygon];
        ring < kept.polygonStarts[polygon + 1];
        ring++
      ) {
        net += ringSignedAreaSquareMeters(kept, ring, this.refLat);
      }
      this.squareMeters += Math.abs(net);
    }
    for (let vertex = 0; vertex < kept.lng.length; vertex++) {
      this.originLng = Math.min(this.originLng, kept.lng[vertex]);
      this.originLat = Math.min(this.originLat, kept.lat[vertex]);
    }
    this.polygons += polygonCount(kept);
    this.vertices += kept.lng.length;
    if (polygonCount(kept) > 0) {
      this.pages.push(kept);
    }
  }
}

// The encodePolygons layout, a page per chunk after the header, then `tailBytes` zeros.
export function* polygonChunks(
  magic: string,
  format: number,
  collected: PolygonCollector,
  tailBytes: number,
): Generator<Uint8Array> {
  const header = new Uint8Array(HEADER_BYTES);
  writeHeader(
    header,
    new DataView(header.buffer),
    magic,
    format,
    collected.polygons,
    collected.originLng,
    collected.originLat,
  );
  yield header;
  const { originLng, originLat } = collected;
  for (const page of collected.pages) {
    const polygons = polygonCount(page);
    const rings = page.ringStarts.length - 1;
    // Two 5-byte varints per vertex, a 4-byte count per ring, a 2-byte count per polygon.
    const bytes = new Uint8Array(
      polygons * 2 + rings * 4 + page.lng.length * 10,
    );
    const view = new DataView(bytes.buffer);
    let offset = 0;
    for (let polygon = 0; polygon < polygons; polygon++) {
      const first = page.polygonStarts[polygon];
      const last = page.polygonStarts[polygon + 1];
      view.setUint16(offset, last - first, true);
      offset += 2;
      for (let ring = first; ring < last; ring++) {
        const start = page.ringStarts[ring];
        const end = page.ringStarts[ring + 1];
        view.setUint32(offset, end - start, true);
        offset += 4;
        let previousX = 0;
        let previousY = 0;
        for (let vertex = start; vertex < end; vertex++) {
          const x = Math.round((page.lng[vertex] - originLng) / COORD_SCALE);
          const y = Math.round((page.lat[vertex] - originLat) / COORD_SCALE);
          offset = writeVarint(bytes, offset, zigzag(x - previousX));
          offset = writeVarint(bytes, offset, zigzag(y - previousY));
          previousX = x;
          previousY = y;
        }
      }
    }
    yield bytes.subarray(0, offset);
  }
  if (tailBytes > 0) {
    yield new Uint8Array(tailBytes);
  }
}

// Streams the chunks to `path` through a temporary file, hashing as it goes; a failure leaves the old file.
export async function writeChunks(
  path: string,
  chunks: Iterable<Uint8Array>,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  const temporary = temporaryPath(path);
  const file = await open(temporary, "w");
  let bytes = 0;
  let closed = false;
  try {
    for (const chunk of chunks) {
      for (let written = 0; written < chunk.length; ) {
        const { bytesWritten } = await file.write(
          chunk,
          written,
          chunk.length - written,
        );
        written += bytesWritten;
      }
      hash.update(chunk);
      bytes += chunk.length;
    }
    closed = true;
    await file.close();
    await rename(temporary, path);
  } finally {
    if (!closed) {
      await file.close();
    }
    await rm(temporary, { force: true });
  }
  return { bytes, sha256: hash.digest("hex") };
}

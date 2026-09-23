// Shares the LMRK/ARTW layout the map overlay reads, keeping only the flat arrays the directions need.

import type { RoutingGraph } from "./graph";
import { edgePath } from "./graph";
import type { RouteResult } from "./search";

export type PoiKind = "landmark" | "art";

export interface PoiSet {
  lngs: Float64Array;
  lats: Float64Array;
  names: string[]; // per point, its label ("" when the source named none)
}

function readVarint(bytes: Uint8Array, cursor: { offset: number }): number {
  let value = 0;
  let shift = 0;
  let byte = 0;
  do {
    byte = bytes[cursor.offset];
    cursor.offset += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return (value >>> 1) ^ -(value & 1);
}

// Mirrors crates/tiler/src/binfmt.rs read_points, plus the client-only trailing name blob.
export function decodePois(buffer: ArrayBuffer, magic: string): PoiSet {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const found = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (found !== magic) {
    throw new Error(`not a ${magic} point blob`);
  }
  const count = view.getUint32(8, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const cursor = { offset: view.getUint16(6, true) };

  const lngs = new Float64Array(count);
  const lats = new Float64Array(count);
  let quantizedX = 0;
  let quantizedY = 0;
  for (let point = 0; point < count; point++) {
    quantizedX += readVarint(bytes, cursor);
    quantizedY += readVarint(bytes, cursor);
    lngs[point] = originLng + quantizedX * scale;
    lats[point] = originLat + quantizedY * scale;
  }
  const decoder = new TextDecoder();
  const names: string[] = new Array(count);
  for (let point = 0; point < count; point++) {
    const length = view.getUint16(cursor.offset, true);
    cursor.offset += 2;
    names[point] = decoder.decode(
      bytes.subarray(cursor.offset, cursor.offset + length),
    );
    cursor.offset += length;
  }
  return { lngs, lats, names };
}

const cache = new Map<string, Promise<PoiSet>>();

export function loadPois(url: string, magic: string): Promise<PoiSet> {
  const pending = cache.get(url);
  if (pending) {
    return pending;
  }
  const request = fetch(url)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
      }
      return decodePois(await response.arrayBuffer(), magic);
    })
    .catch((error: unknown) => {
      cache.delete(url);
      throw error;
    });
  cache.set(url, request);
  return request;
}

export interface PassedPoi {
  name: string;
  kind: PoiKind;
  stepIndex: number;
  alongMeters: number;
  at: { lat: number; lng: number };
}

const METERS_PER_DEGREE_LAT = 111_320;

// A station walk is a straight chord under the concourse, so it would report every statue above it.
const CARRIED: ReadonlySet<string> = new Set<string>([
  "ferry",
  "board",
  "ride",
  "access",
]);

// A flat approximation is negligible at these lengths.
function pointSegmentMeters(
  lat: number,
  lng: number,
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
  metersPerLng: number,
): { distance: number; t: number } {
  const px = (lng - aLng) * metersPerLng;
  const py = (lat - aLat) * METERS_PER_DEGREE_LAT;
  const dx = (bLng - aLng) * metersPerLng;
  const dy = (bLat - aLat) * METERS_PER_DEGREE_LAT;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared > 0
      ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared))
      : 0;
  return { distance: Math.hypot(px - t * dx, py - t * dy), t };
}

// Per-set thresholds: a landmark's point is its lot centroid, set back from the frontage, unlike art.
export function passedPois(
  graph: RoutingGraph,
  result: RouteResult,
  sets: readonly { kind: PoiKind; set: PoiSet; thresholdMeters: number }[],
): PassedPoi[] {
  const { lats, lngs } = result.path;
  if (lats.length === 0) {
    return [];
  }
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let west = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  for (let vertex = 0; vertex < lats.length; vertex++) {
    south = Math.min(south, lats[vertex]);
    north = Math.max(north, lats[vertex]);
    west = Math.min(west, lngs[vertex]);
    east = Math.max(east, lngs[vertex]);
  }
  const centerLat = (south + north) / 2;
  const metersPerLng =
    METERS_PER_DEGREE_LAT * Math.cos((centerLat * Math.PI) / 180);
  const maxThreshold = sets.reduce(
    (largest, entry) => Math.max(largest, entry.thresholdMeters),
    0,
  );
  const marginLat = maxThreshold / METERS_PER_DEGREE_LAT;
  const marginLng = maxThreshold / metersPerLng;

  const stepPolys: ({
    lngs: number[];
    lats: number[];
    cum: number[];
    total: number;
  } | null)[] = result.steps.map((step) => {
    if (CARRIED.has(step.kind)) {
      return null;
    }
    const { lngs: edgeLngs, lats: edgeLats } = edgePath(graph, step.edge);
    const polyLngs = step.forward
      ? Array.from(edgeLngs)
      : Array.from(edgeLngs).reverse();
    const polyLats = step.forward
      ? Array.from(edgeLats)
      : Array.from(edgeLats).reverse();
    const cum = new Array<number>(polyLngs.length);
    cum[0] = 0;
    for (let vertex = 1; vertex < polyLngs.length; vertex++) {
      const dx = (polyLngs[vertex] - polyLngs[vertex - 1]) * metersPerLng;
      const dy =
        (polyLats[vertex] - polyLats[vertex - 1]) * METERS_PER_DEGREE_LAT;
      cum[vertex] = cum[vertex - 1] + Math.hypot(dx, dy);
    }
    return { lngs: polyLngs, lats: polyLats, cum, total: cum[cum.length - 1] };
  });

  const stepStart = new Array<number>(result.steps.length);
  let running = 0;
  for (let step = 0; step < result.steps.length; step++) {
    stepStart[step] = running;
    running += result.steps[step].lengthMeters;
  }

  const passed: PassedPoi[] = [];
  for (const { kind, set, thresholdMeters } of sets) {
    for (let point = 0; point < set.names.length; point++) {
      const name = set.names[point];
      if (!name) {
        continue;
      }
      const lat = set.lats[point];
      const lng = set.lngs[point];
      if (
        lat < south - marginLat ||
        lat > north + marginLat ||
        lng < west - marginLng ||
        lng > east + marginLng
      ) {
        continue;
      }
      let best = Number.POSITIVE_INFINITY;
      let bestStep = -1;
      let bestAlong = 0;
      for (let step = 0; step < stepPolys.length; step++) {
        const poly = stepPolys[step];
        if (!poly) {
          continue;
        }
        for (let vertex = 1; vertex < poly.lngs.length; vertex++) {
          const { distance, t } = pointSegmentMeters(
            lat,
            lng,
            poly.lats[vertex - 1],
            poly.lngs[vertex - 1],
            poly.lats[vertex],
            poly.lngs[vertex],
            metersPerLng,
          );
          if (distance < best) {
            best = distance;
            bestStep = step;
            const alongPoly =
              poly.cum[vertex - 1] +
              t * (poly.cum[vertex] - poly.cum[vertex - 1]);
            const fraction = poly.total > 0 ? alongPoly / poly.total : 0;
            bestAlong =
              stepStart[step] + fraction * result.steps[step].lengthMeters;
          }
        }
      }
      if (bestStep >= 0 && best <= thresholdMeters) {
        passed.push({
          name,
          kind,
          stepIndex: bestStep,
          alongMeters: bestAlong,
          at: { lat, lng },
        });
      }
    }
  }
  return passed;
}

// Per-edge shade fractions per sun bin, composited here since only the client knows the date's tau.

import * as SunCalc from "suncalc";
import { activeCity, type City } from "../cities";
import { canopyTau } from "../shade/phenology";
import { declinationOf, hourAngleOf, seasonBand } from "../shade/sun";
import { artifactUrl } from "./artifact-base";
import type { RoutingGraph } from "./graph";

const MAGIC = "SHDB";
const FORMAT_VERSION = 2;
const HEADER_BYTES = 12; // magic(4) + u16 version + u16 pad + u32 edgeCount
// Per city, since a bin index is a sun position only at the latitude it was synthesized for.
const binsUrl = (cityId: string): string => `routing/shade/${cityId}/bins.json`;
const HORIZON_DEG = 0.5; // at or below this the sun is down and there is no shade to bias

// The sun moves ~1.25° per step, well under a bin; past the horizon (~20 km) the sun freezes.
export const SCHEDULE_STEP_SECONDS = 300;
const SCHEDULE_HORIZON_SECONDS = 4 * 3600;
export const SCHEDULE_BUCKETS =
  Math.floor(SCHEDULE_HORIZON_SECONDS / SCHEDULE_STEP_SECONDS) + 1;

// Shared with the scaffolding field so both agree on where the sun is at a point in the walk.
export function scheduleBucket(elapsedSeconds: number): number {
  const clamped = elapsedSeconds > 0 ? elapsedSeconds : 0;
  const bucket = Math.round(clamped / SCHEDULE_STEP_SECONDS);
  return bucket < SCHEDULE_BUCKETS ? bucket : SCHEDULE_BUCKETS - 1;
}

const binUrl = (cityId: string, index: number): string =>
  `routing/shade/${cityId}/${index}.bin`;

// suncalc@2.0.1 as the shade overlay reads it; azimuth a compass bearing in [0, 360).
const sun = SunCalc as unknown as {
  getPosition: (
    date: Date,
    lat: number,
    lng: number,
  ) => { altitude: number; azimuth: number };
};

export interface ShadeBin {
  index: number;
  season: number;
  hourAngle: number;
  elevation: number;
  azimuth: number;
}

export interface ShadeBins {
  edgeCount: number; // must equal the routing graph's edge count
  bins: ShadeBin[];
}

export interface BinFractions {
  buildings: Uint8Array;
  trees: Uint8Array;
}

// The same max(0, sin(elevation)) the tile bake folds into its alpha.
function intensityOf(bin: ShadeBin): number {
  return Math.max(0, Math.sin((bin.elevation * Math.PI) / 180));
}

// Capped at 127 (never -128), so |attr| < 1 keeps the cost model's 1 - w*attr positive for |w| <= 1.
function encodeAttr(attr: number): number {
  return Math.max(-127, Math.min(127, Math.round(attr * 128)));
}

// `intensityAt` lets a caller composite its own opaque cover (a scaffolding deck) into the attribute.
export interface ShadeField {
  attrAt(edge: number, elapsedSeconds: number): number;
  intensityAt(elapsedSeconds: number): number;
  readonly maxAbs: number;
}

// Holds only the referenced bins and bucket tables, not the graph, so it doesn't pin a large scope.
class ScheduledShadeField implements ShadeField {
  // Built on first use and kept, since A* reads an edge's attribute in its innermost loop.
  private readonly rows: (Int8Array | null)[];

  constructor(
    private readonly fractions: BinFractions[], // the referenced bins, in bucket-reference order
    private readonly intensities: Float64Array, // per referenced bin, its solar intensity
    private readonly tau: number, // the share of direct light a crown stops on the departure date
    private readonly rowKeys: string[], // per referenced bin, its key in the shared row cache
    private readonly binA: Int32Array, // per bucket: index into `fractions`, or -1 for a night bucket
    private readonly binB: Int32Array, // per bucket: the second blended bin's index into `fractions`
    private readonly weightA: Float64Array, // per bucket: bin A's blend weight, already divided by 128
    private readonly weightB: Float64Array, // per bucket: bin B's blend weight, already divided by 128
    private readonly blended: Float64Array, // per bucket: the blended solar intensity, 0 at night
    readonly maxAbs: number,
  ) {
    this.rows = fractions.map(() => null);
  }

  intensityAt(elapsedSeconds: number): number {
    return this.blended[scheduleBucket(elapsedSeconds)];
  }

  attrAt(edge: number, elapsedSeconds: number): number {
    const bucket = scheduleBucket(elapsedSeconds);
    const indexA = this.binA[bucket];
    if (indexA < 0) {
      return 0; // the sun is down at this point in the walk
    }
    const indexB = this.binB[bucket];
    const rowA = this.rows[indexA] ?? this.composite(indexA);
    const rowB = this.rows[indexB] ?? this.composite(indexB);
    return (
      rowA[edge] * this.weightA[bucket] + rowB[edge] * this.weightB[bucket]
    );
  }

  // What reaches the edge gets past both occlusions: 1 - (1 - buildings)(1 - tau*trees).
  private composite(index: number): Int8Array {
    const key = this.rowKeys[index];
    const shared = rowCache.get(key);
    if (shared) {
      rowCache.delete(key); // re-inserted below, which is what makes the eviction an LRU
      rowCache.set(key, shared);
      this.rows[index] = shared;
      return shared;
    }
    const { buildings, trees } = this.fractions[index];
    const intensity = this.intensities[index];
    const row = new Int8Array(buildings.length);
    for (let edge = 0; edge < row.length; edge++) {
      const shaded =
        1 - (1 - buildings[edge] / 255) * (1 - (this.tau * trees[edge]) / 255);
      row[edge] = encodeAttr(intensity * (1 - 2 * shaded));
    }
    this.rows[index] = row;
    rowCache.set(key, row);
    for (const oldest of rowCache.keys()) {
      if (rowCache.size <= CACHE_ROWS) {
        break;
      }
      rowCache.delete(oldest);
    }
    return row;
  }
}

// Shared across fields so the minute tick doesn't recomposite a 640 kB row per bin.
const CACHE_ROWS = 8;
const rowCache = new Map<string, Int8Array>();

class ConstantShadeField implements ShadeField {
  constructor(
    private readonly attrs: Float32Array,
    readonly maxAbs: number,
  ) {}

  attrAt(edge: number): number {
    return this.attrs[edge];
  }

  // Taken from maxAbs so a composited attribute stays inside the clip floor's bound.
  intensityAt(): number {
    return this.maxAbs;
  }
}

export function constantShadeField(attrs: Float32Array): ShadeField {
  let maxAbs = 0;
  for (const value of attrs) {
    const magnitude = Math.abs(value);
    if (magnitude > maxAbs) {
      maxAbs = magnitude;
    }
  }
  return new ConstantShadeField(attrs, maxAbs);
}

const binsPromises = new Map<string, Promise<ShadeBins>>();

export function loadShadeBins(
  cityId: string = activeCity().id,
): Promise<ShadeBins> {
  const cached = binsPromises.get(cityId);
  if (cached) {
    return cached;
  }
  const url = artifactUrl(binsUrl(cityId));
  const promise = fetch(url)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
      }
      return (await response.json()) as ShadeBins;
    })
    .catch((error: unknown) => {
      binsPromises.delete(cityId); // a failed load must not be memoized
      throw error;
    });
  binsPromises.set(cityId, promise);
  return promise;
}

// Rows are views after the 12-byte header; Uint8Array has no alignment requirement.
export function decodeShadeBin(buffer: ArrayBuffer): BinFractions {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const version = view.getUint16(4, true);
  if (magic !== MAGIC || version !== FORMAT_VERSION) {
    throw new Error(`not a v${FORMAT_VERSION} shade bin`);
  }
  const edgeCount = view.getUint32(8, true);
  if (HEADER_BYTES + 2 * edgeCount !== buffer.byteLength) {
    throw new Error(
      `shade bin edge count ${edgeCount} does not match its ${buffer.byteLength}-byte payload`,
    );
  }
  return {
    buildings: new Uint8Array(buffer, HEADER_BYTES, edgeCount),
    trees: new Uint8Array(buffer, HEADER_BYTES + edgeCount, edgeCount),
  };
}

// The same index is a different sun position in another city.
const binCache = new Map<string, Promise<BinFractions>>();

// One schedule references up to 8 bins (1.2 MB each in NYC); 16 holds two, so scrubbing back is free.
const CACHE_BINS = 16;

export function loadShadeBin(
  index: number,
  cityId: string = activeCity().id,
): Promise<BinFractions> {
  const key = `${cityId}:${index}`;
  const cached = binCache.get(key);
  if (cached) {
    // Map iterates in insertion order, so re-inserting makes the eviction an LRU.
    binCache.delete(key);
    binCache.set(key, cached);
    return cached;
  }
  const url = artifactUrl(binUrl(cityId, index));
  const promise = fetch(url)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
      }
      return decodeShadeBin(await response.arrayBuffer());
    })
    .catch((error: unknown) => {
      // Delete only this promise: the LRU may have evicted it and a refetch since succeeded.
      if (binCache.get(key) === promise) {
        binCache.delete(key);
      }
      throw error;
    });
  binCache.set(key, promise);
  for (const oldest of binCache.keys()) {
    if (binCache.size <= CACHE_BINS) {
      break;
    }
    binCache.delete(oldest);
  }
  return promise;
}

// Same convention as shade-layer's currentSun, so both map a time to the same bin.
export function sunAt(
  date: Date,
  center: { lat: number; lng: number } = activeCity().center,
): { elevation: number; azimuth: number } {
  const { lat, lng } = center;
  const position = sun.getPosition(date, lat, lng);
  return {
    elevation: position.altitude,
    azimuth: ((position.azimuth % 360) + 360) % 360,
  };
}

// Weights are inverse-distance and sum to 1; null when the sun is at or below the horizon.
interface ShadeBlend {
  nearest: ShadeBin;
  second: ShadeBin;
  nearestWeight: number;
  secondWeight: number;
}

function selectBlend(
  bins: ShadeBin[],
  elevation: number,
  azimuth: number,
  centerLat: number,
): ShadeBlend | null {
  if (elevation <= HORIZON_DEG) {
    return null;
  }
  const declination = declinationOf(elevation, azimuth, centerLat);
  const hourAngle = hourAngleOf(elevation, azimuth, centerLat, declination);
  const season = seasonBand(declination);
  const inBand = bins.filter((bin) => bin.season === season);
  const candidates = inBand.length > 0 ? inBand : bins;

  let nearest = candidates[0];
  let second: ShadeBin | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  let secondDistance = Number.POSITIVE_INFINITY;
  for (const bin of candidates) {
    const distance = Math.abs(bin.hourAngle - hourAngle);
    if (distance < nearestDistance) {
      secondDistance = nearestDistance;
      second = nearest;
      nearestDistance = distance;
      nearest = bin;
    } else if (distance < secondDistance) {
      secondDistance = distance;
      second = bin;
    }
  }

  const total = nearestDistance + secondDistance;
  if (second === null || total === 0 || !Number.isFinite(total)) {
    return { nearest, second: nearest, nearestWeight: 1, secondWeight: 0 };
  }
  return {
    nearest,
    second,
    nearestWeight: secondDistance / total,
    secondWeight: nearestDistance / total,
  };
}

function intern(
  positions: Map<number, number>,
  order: ShadeBin[],
  bin: ShadeBin,
): number {
  const existing = positions.get(bin.index);
  if (existing !== undefined) {
    return existing;
  }
  const position = order.length;
  positions.set(bin.index, position);
  order.push(bin);
  return position;
}

export async function computeEdgeShade(
  graph: RoutingGraph,
  date: Date,
  forCity: City = activeCity(),
): Promise<void> {
  // Read once: the city may change across an await, and `loadRouting` memoizes this graph.
  const { edgeCount, bins } = await loadShadeBins(forCity.id);
  if (edgeCount !== graph.edgeCount) {
    throw new Error(
      `shade edge count ${edgeCount} != graph ${graph.edgeCount}`,
    );
  }
  if (bins.length === 0) {
    graph.shade = null;
    return;
  }
  // A stale bake passes the edge-count check but collapses to bins[0] at every time, so fail loudly.
  for (const bin of bins) {
    if (!Number.isFinite(bin.hourAngle) || !Number.isInteger(bin.season)) {
      throw new Error(
        "shade bins.json lacks season/hourAngle (stale artifact?) — rebuild public/routing/shade",
      );
    }
  }

  const binA = new Int32Array(SCHEDULE_BUCKETS).fill(-1); // -1 marks a night bucket
  const binB = new Int32Array(SCHEDULE_BUCKETS);
  const weightA = new Float64Array(SCHEDULE_BUCKETS);
  const weightB = new Float64Array(SCHEDULE_BUCKETS);
  const blended = new Float64Array(SCHEDULE_BUCKETS);
  const positions = new Map<number, number>();
  const order: ShadeBin[] = []; // the referenced bins, the axis of the field's rows
  let anyDay = false;
  for (let bucket = 0; bucket < SCHEDULE_BUCKETS; bucket++) {
    const when = new Date(
      date.getTime() + bucket * SCHEDULE_STEP_SECONDS * 1000,
    );
    const { elevation, azimuth } = sunAt(when, forCity.center);
    const blend = selectBlend(bins, elevation, azimuth, forCity.center.lat);
    if (!blend) {
      continue; // night bucket: binA stays -1, attrAt returns 0
    }
    anyDay = true;
    binA[bucket] = intern(positions, order, blend.nearest);
    binB[bucket] = intern(positions, order, blend.second);
    weightA[bucket] = blend.nearestWeight / 128;
    weightB[bucket] = blend.secondWeight / 128;
    // Quantized like a row's fully-sunlit entry, so attributes stay within [-maxAbs, maxAbs].
    blended[bucket] =
      (blend.nearestWeight * encodeAttr(intensityOf(blend.nearest)) +
        blend.secondWeight * encodeAttr(intensityOf(blend.second))) /
      128;
  }
  if (!anyDay) {
    graph.shade = null;
    return;
  }

  const fractions = await Promise.all(
    order.map((bin) => loadShadeBin(bin.index, forCity.id)),
  );
  const intensities = Float64Array.from(order, intensityOf);
  const tau = canopyTau(date);
  const rowKeys = order.map((bin) => `${forCity.id}:${bin.index}:${tau}`);
  // Attributes can't exceed their bin's intensity, and some edge is sunlit in every bin.
  let maxAbs = 0;
  for (const [position, row] of fractions.entries()) {
    if (row.buildings.length !== edgeCount) {
      throw new Error(
        `shade bin edge count ${row.buildings.length} != graph ${edgeCount}`,
      );
    }
    maxAbs = Math.max(maxAbs, encodeAttr(intensities[position]) / 128);
  }
  graph.shade = new ScheduledShadeField(
    fractions,
    intensities,
    tau,
    rowKeys,
    binA,
    binB,
    weightA,
    weightB,
    blended,
    maxAbs,
  );
}

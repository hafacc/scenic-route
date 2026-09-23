// Needs the built graph and LFS files ordinary CI has only as pointers, so it runs on deploy only.

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildLandTest } from "../scripts/land-filter";
import type { RouteWeights } from "../src/routing/cost";
import { decodeGraph, type RoutingGraph } from "../src/routing/graph";
import {
  type CrossingReversal,
  crossingReversals,
  detourRatio,
  longestCrossingRun,
} from "../src/routing/route-metrics";
import { findRoute } from "../src/routing/search";
import {
  buildSnapIndex,
  haversineMeters,
  SNAP_RADIUS_METERS,
  type SnapIndex,
  snapPair,
} from "../src/routing/snap";
import { DEFAULT_WEIGHTS } from "../src/url-state";

const ROOT = join(import.meta.dirname, "..");
const GRAPH_PATH = join(ROOT, "public/routing/nyc.bin");
const LAND_PATH = join(ROOT, "data/land/nyc.bin");
const LOTS_PATH = join(ROOT, "data/landuse/nyc.bin");

// Puts the sampling error on a ~19% share at about 2 points.
const TRIPS_PER_BOROUGH = 400;
// Straight-line distances long enough to force choices, short enough that nobody takes the train.
const MIN_TRIP_METERS = 400;
const MAX_TRIP_METERS = 2500;

// Defaults measure 1.31-1.42 by borough and the strongest slider 1.48.
const MAX_DETOUR_MEDIAN = 1.5;
// p90, not p95: p95 moved by 0.3 between seeds. Defaults measure 1.45-1.87, the strongest slider 2.19.
const MAX_DETOUR_P90 = 2.0;

// Reversals the cost model bought: 0% at zero weights, at most 0.3% at defaults, 15.8% at extremes.
const MAX_AVOIDABLE_SHARE = 0.03;

// Loose on purpose: the graph's own corners force most reversals, and it swings 7 points by seed.
const MAX_REVERSAL_SHARE = 0.35;
// Measured 12.2% city-wide, with a sampling error of ~0.7 points.
const MAX_CITY_REVERSAL_SHARE = 0.15;

// A divided street is two chained crossings and a big junction more; the worst measured is 6.
const MAX_CROSSING_RUN = 8;

// The smallest borough (Manhattan) has ~37,000 lots; far fewer means a mislabeled or dropped borough.
const MIN_LOTS_PER_BOROUGH = 20_000;

// The land blob keeps no borough identity, so each is labeled by the polygon holding a landmark.
const BOROUGH_LANDMARKS: readonly (readonly [string, Coord])[] = [
  ["Manhattan", { lat: 40.758, lng: -73.9855 }], // Times Square
  ["Bronx", { lat: 40.8448, lng: -73.8648 }], // Bronx Zoo
  ["Brooklyn", { lat: 40.6782, lng: -73.9442 }], // Bedford-Stuyvesant
  ["Queens", { lat: 40.7282, lng: -73.7949 }], // Jamaica
  ["Staten Island", { lat: 40.5795, lng: -74.1502 }], // St George
];

interface Coord {
  lat: number;
  lng: number;
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

// The header every `scripts/geometry.ts` blob starts with.
function readHeader(bytes: Uint8Array, magic: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (found !== magic) {
    throw new Error(`not a ${magic} blob`);
  }
  return {
    view,
    count: view.getUint32(8, true),
    originLng: view.getFloat64(16, true),
    originLat: view.getFloat64(24, true),
    scale: view.getFloat64(32, true),
    bodyOffset: view.getUint16(6, true),
  };
}

// Mirrors encodePolygons; deltas restart from the origin at each ring.
function decodeLandPolygons(bytes: Uint8Array): Coord[][][] {
  const head = readHeader(bytes, "LAND");
  const cursor = { offset: head.bodyOffset };
  const polygons: Coord[][][] = [];
  for (let polygon = 0; polygon < head.count; polygon++) {
    const ringCount = head.view.getUint16(cursor.offset, true);
    cursor.offset += 2;
    const rings: Coord[][] = [];
    for (let ring = 0; ring < ringCount; ring++) {
      const vertexCount = head.view.getUint32(cursor.offset, true);
      cursor.offset += 4;
      const vertices: Coord[] = new Array(vertexCount);
      let quantizedX = 0;
      let quantizedY = 0;
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        quantizedX += readVarint(bytes, cursor);
        quantizedY += readVarint(bytes, cursor);
        vertices[vertex] = {
          lng: head.originLng + quantizedX * head.scale,
          lat: head.originLat + quantizedY * head.scale,
        };
      }
      rings.push(vertices);
    }
    polygons.push(rings);
  }
  return polygons;
}

// Mirrors encodeClassifiedPoints but skips the trailing land-use class bytes.
function decodeTaxLots(bytes: Uint8Array): Coord[] {
  const head = readHeader(bytes, "PLUT");
  const cursor = { offset: head.bodyOffset };
  const lots: Coord[] = new Array(head.count);
  let quantizedX = 0;
  let quantizedY = 0;
  for (let lot = 0; lot < head.count; lot++) {
    quantizedX += readVarint(bytes, cursor);
    quantizedY += readVarint(bytes, cursor);
    lots[lot] = {
      lng: head.originLng + quantizedX * head.scale,
      lat: head.originLat + quantizedY * head.scale,
    };
  }
  return lots;
}

// mulberry32: seeded so a bound near the measurement doesn't flap between runs.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function percentileOf(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

interface TripFailure {
  reason: string;
  origin: Coord;
  dest: Coord;
}

interface BoroughResult {
  borough: string;
  routed: number;
  failures: TripFailure[];
  detours: number[]; // sorted
  reversalRoutes: number; // trips with at least one reversal, forced or bought
  avoidableRoutes: number; // trips with at least one the network offered a way round
  worstReversal: (CrossingReversal & { borough: string }) | null;
  worstAvoidable: (CrossingReversal & { borough: string }) | null;
  longestRun: number;
  longestRunAt: Coord | null;
  farthestSnapMeters: number;
}

function measureBorough(
  borough: string,
  lots: readonly Coord[],
  graph: RoutingGraph,
  index: SnapIndex,
  weights: RouteWeights,
  count: number,
  seed: number,
): BoroughResult {
  const random = seededRandom(seed);
  const result: BoroughResult = {
    borough,
    routed: 0,
    failures: [],
    detours: [],
    reversalRoutes: 0,
    avoidableRoutes: 0,
    worstReversal: null,
    worstAvoidable: null,
    longestRun: 0,
    longestRunAt: null,
    farthestSnapMeters: 0,
  };
  const pick = (): Coord => lots[Math.floor(random() * lots.length)];
  let attempts = 0;
  while (result.routed < count && attempts < count * 40) {
    attempts += 1;
    const origin = pick();
    // Rejection sampling is cheap and unbiased here, since the band holds most of a borough's lots.
    let dest: Coord | null = null;
    for (let tries = 0; tries < 60 && dest === null; tries++) {
      const candidate = pick();
      const straight = haversineMeters(
        origin.lat,
        origin.lng,
        candidate.lat,
        candidate.lng,
      );
      if (straight >= MIN_TRIP_METERS && straight <= MAX_TRIP_METERS) {
        dest = candidate;
      }
    }
    if (dest === null) {
      continue;
    }
    result.routed += 1;

    const pair = snapPair(graph, index, origin, dest);
    if (!pair.ok) {
      result.failures.push({ reason: `snap ${pair.reason}`, origin, dest });
      continue;
    }
    result.farthestSnapMeters = Math.max(
      result.farthestSnapMeters,
      pair.start.distanceMeters,
      pair.dest.distanceMeters,
    );
    const route = findRoute(graph, pair.start, pair.dest, weights);
    if (route === null) {
      result.failures.push({ reason: "no route", origin, dest });
      continue;
    }

    const ratio = detourRatio(route);
    if (ratio !== null) {
      result.detours.push(ratio);
    }
    const reversals = crossingReversals(graph, route);
    if (reversals.length > 0) {
      result.reversalRoutes += 1;
    }
    if (reversals.some((reversal) => reversal.avoidable)) {
      result.avoidableRoutes += 1;
    }
    for (const reversal of reversals) {
      if (
        result.worstReversal === null ||
        reversal.crossedMeters > result.worstReversal.crossedMeters
      ) {
        result.worstReversal = { ...reversal, borough };
      }
      if (
        reversal.avoidable &&
        (result.worstAvoidable === null ||
          reversal.crossedMeters > result.worstAvoidable.crossedMeters)
      ) {
        result.worstAvoidable = { ...reversal, borough };
      }
    }
    const run = longestCrossingRun(route);
    if (run > result.longestRun) {
      result.longestRun = run;
      result.longestRunAt = pair.start.point;
    }
  }
  result.detours.sort((left, right) => left - right);
  return result;
}

async function readBlob(path: string, what: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error: unknown) {
    throw new Error(
      `${path} is unreadable, so the ${what} cannot be sampled. This suite runs on the deploy ` +
        `path, after \`bun export\` has built the graph and with the data/ LFS payload checked ` +
        `out; \`bun run test-routes\` runs it locally against the same files. (${error})`,
    );
  }
}

const [landBytes, lotBytes, graphBytes] = await Promise.all([
  readBlob(LAND_PATH, "borough boundaries"),
  readBlob(LOTS_PATH, "tax lots"),
  readBlob(GRAPH_PATH, "routing graph"),
]);

const landPolygons = decodeLandPolygons(landBytes);
const polygonTests = landPolygons.map((polygon) => buildLandTest([polygon]));
const boroughTests = BOROUGH_LANDMARKS.map(([borough, landmark]) => {
  const test = polygonTests.find((inside) => inside(landmark));
  if (!test) {
    throw new Error(`no land polygon contains the ${borough} landmark`);
  }
  return { borough, inside: test };
});

const lotsByBorough = new Map<string, Coord[]>(
  BOROUGH_LANDMARKS.map(([borough]) => [borough, [] as Coord[]]),
);
for (const lot of decodeTaxLots(lotBytes)) {
  for (const { borough, inside } of boroughTests) {
    if (inside(lot)) {
      (lotsByBorough.get(borough) as Coord[]).push(lot);
      break;
    }
  }
}

const graph = decodeGraph(
  graphBytes.buffer.slice(
    graphBytes.byteOffset,
    graphBytes.byteOffset + graphBytes.byteLength,
  ) as ArrayBuffer,
  { hash: "", keyHash: "" },
);
const snapIndex = buildSnapIndex(graph);

// No ferries or trains: a ride leg would make the walk-versus-straight-line ratio meaningless.
const WEIGHTS: RouteWeights = {
  ...DEFAULT_WEIGHTS,
  allowFerries: false,
  allowTransit: false,
};

const measured = [...lotsByBorough].map(([borough, lots], index) =>
  measureBorough(
    borough,
    lots,
    graph,
    snapIndex,
    WEIGHTS,
    TRIPS_PER_BOROUGH,
    0x5ca1ab1e + index,
  ),
);

const percent = (share: number): string => `${(100 * share).toFixed(1)}%`;

test("every borough offers enough real addresses to sample from", () => {
  const thin = [...lotsByBorough]
    .filter(([, lots]) => lots.length < MIN_LOTS_PER_BOROUGH)
    .map(([borough, lots]) => `${borough}: ${lots.length} lots`);

  expect(thin).toEqual([]);

  const short = measured
    .filter((result) => result.routed < TRIPS_PER_BOROUGH)
    .map((result) => `${result.borough}: ${result.routed} trips sampled`);
  expect(short).toEqual([]);
});

test("a trip between two real addresses always routes", () => {
  // Every sampled point is a real parcel, so each failure is an address the app cannot serve.
  const failures = measured.flatMap((result) =>
    result.failures.map(
      (failure) =>
        `${result.borough}: ${failure.reason} for ${failure.origin.lat.toFixed(6)},${failure.origin.lng.toFixed(6)} -> ${failure.dest.lat.toFixed(6)},${failure.dest.lng.toFixed(6)}`,
    ),
  );

  expect(failures).toEqual([]);

  // Headroom in the snap radius: the farthest snap measured 80 m against 300.
  const farthest = Math.max(
    ...measured.map((result) => result.farthestSnapMeters),
  );
  expect(farthest).toBeLessThan(SNAP_RADIUS_METERS / 2);
});

test("the walk is not far longer than the straight line, in any borough", () => {
  const over = measured
    .filter(
      (result) =>
        percentileOf(result.detours, 0.5) > MAX_DETOUR_MEDIAN ||
        percentileOf(result.detours, 0.9) > MAX_DETOUR_P90,
    )
    .map(
      (result) =>
        `${result.borough}: median ${percentileOf(result.detours, 0.5).toFixed(3)} (limit ${MAX_DETOUR_MEDIAN}), ` +
        `p90 ${percentileOf(result.detours, 0.9).toFixed(3)} (limit ${MAX_DETOUR_P90}) over ${result.detours.length} trips`,
    );

  expect(over).toEqual([]);
});

test("a route never buys a crossing reversal the network offered a way round", () => {
  const over = measured
    .filter(
      (result) => result.avoidableRoutes / result.routed > MAX_AVOIDABLE_SHARE,
    )
    .map((result) => {
      const worst = result.worstAvoidable;
      return (
        `${result.borough}: ${percent(result.avoidableRoutes / result.routed)} of trips cross and cross back where ` +
        `the pavement joined the same two ends (limit ${percent(MAX_AVOIDABLE_SHARE)}), worst ` +
        `${worst?.name ?? "unnamed"} at ${worst?.at.lat.toFixed(6)},${worst?.at.lng.toFixed(6)} — ` +
        `${worst?.crossedMeters.toFixed(1)} m of roadway for ${worst?.walkBetweenMeters.toFixed(1)} m of pavement`
      );
    });

  expect(over).toEqual([]);
});

test("a route rarely crosses a street and crosses straight back at all", () => {
  const over = measured
    .filter(
      (result) => result.reversalRoutes / result.routed > MAX_REVERSAL_SHARE,
    )
    .map((result) => {
      const worst = result.worstReversal;
      return (
        `${result.borough}: ${percent(result.reversalRoutes / result.routed)} of trips reverse a crossing ` +
        `(limit ${percent(MAX_REVERSAL_SHARE)}), worst ${worst?.name ?? "unnamed"} at ` +
        `${worst?.at.lat.toFixed(6)},${worst?.at.lng.toFixed(6)} — ${worst?.crossedMeters.toFixed(1)} m of roadway ` +
        `for ${worst?.walkBetweenMeters.toFixed(1)} m of pavement`
      );
    });

  expect(over).toEqual([]);

  const routes = measured.reduce((sum, result) => sum + result.routed, 0);
  const reversing = measured.reduce(
    (sum, result) => sum + result.reversalRoutes,
    0,
  );
  expect(
    reversing / routes > MAX_CITY_REVERSAL_SHARE
      ? `city-wide ${percent(reversing / routes)} of trips reverse a crossing, over ${percent(MAX_CITY_REVERSAL_SHARE)}`
      : "",
  ).toBe("");
});

test("a crossing is traversed in one move", () => {
  const over = measured
    .filter((result) => result.longestRun > MAX_CROSSING_RUN)
    .map(
      (result) =>
        `${result.borough}: ${result.longestRun} crossings back to back (limit ${MAX_CROSSING_RUN}) on the trip from ` +
        `${result.longestRunAt?.lat.toFixed(6)},${result.longestRunAt?.lng.toFixed(6)}`,
    );

  expect(over).toEqual([]);
});

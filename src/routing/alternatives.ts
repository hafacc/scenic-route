// The sweep steps `minMultiplier`, not the weight scale, which is a cliff: t = 0 to 0.5 can be one route.

import {
  GATE_KEYS,
  INTERNAL_FLAGS,
  type RouteWeights,
  SCENIC_KEYS,
} from "./cost";
import type { FactorKey } from "./factors";
import type { RouteResult } from "./search";

// A street's two pavements are 12-19 m apart in NYC and must stay one route; this is 2.5x the widest.
export const DIFFERENT_METERS = 50;

const MAX_CARDS = 4;
// Shade: the bracket is exact only while the sun term is a path constant; transit: it's a penalty.
const FIXED_FACTORS: ReadonlySet<FactorKey> = new Set<FactorKey>([
  "shade",
  "hill",
  "transit",
]);

const SWEEP_STEPS = 5;
const BREAKPOINT_SEARCHES = 4;
// Lead on a factor, as a share of its graph max, that paints a card in that factor's color.
const COLOR_MARGIN = 0.15;

// Well under DIFFERENT_METERS, so the sample mean approximates the arc-length integral.
const SAMPLE_METERS = 20;
const METERS_PER_DEGREE_LAT = 111_320;

export interface PlannedRoute {
  result: RouteResult;
  // Absolute, not a share, so a trip spent mostly getting there earns only what it walks.
  scenicScore: number;
  // Null where nothing stands out, or where the mode asks for one factor: the UI ramps instead.
  colorFactor: FactorKey | null;
}

export interface Plan {
  routes: PlannedRoute[];
  bestByFactor: Partial<Record<FactorKey, number>>;
  searches: number;
  superseded: boolean;
}

export interface PlanInput {
  weights: RouteWeights;
  search: (weights: RouteWeights) => RouteResult | null;
  minMultiplier: (weights: RouteWeights) => number;
  factorMax?: Partial<Record<FactorKey, number>>; // graph max per factor; missing reads as 1
  onCandidate?: (result: RouteResult) => void; // per distinct route as it is found, R_max first
  // The await matters: a worker only learns of a newer request when it yields to the event loop.
  superseded?: () => Promise<boolean>;
}

// One place, because the owner wants to try other orders.
export function CARD_ORDER(left: PlannedRoute, right: PlannedRoute): number {
  return (
    right.scenicScore - left.scenicScore ||
    left.result.travelSeconds - right.result.travelSeconds
  );
}

// Flat earth over a city is exact enough at tens of meters.
interface Polyline {
  east: Float64Array;
  north: Float64Array;
}

export function projectRoute(
  result: RouteResult,
  referenceLat: number,
): Polyline {
  const { lats, lngs } = result.path;
  const metersPerDegreeLng =
    METERS_PER_DEGREE_LAT * Math.cos((referenceLat * Math.PI) / 180);
  const east = new Float64Array(lats.length);
  const north = new Float64Array(lats.length);
  for (let vertex = 0; vertex < lats.length; vertex++) {
    east[vertex] = lngs[vertex] * metersPerDegreeLng;
    north[vertex] = lats[vertex] * METERS_PER_DEGREE_LAT;
  }
  return { east, north };
}

// Samples by arc length, so a straight mile and a switchback of the same length weigh alike.
function densify(line: Polyline): Polyline {
  const { east, north } = line;
  const count = east.length;
  if (count < 2) {
    return line;
  }
  const spans = new Float64Array(count - 1);
  let total = 0;
  for (let segment = 0; segment < count - 1; segment++) {
    spans[segment] = Math.hypot(
      east[segment + 1] - east[segment],
      north[segment + 1] - north[segment],
    );
    total += spans[segment];
  }
  if (total === 0) {
    return { east: east.slice(0, 1), north: north.slice(0, 1) };
  }
  const steps = Math.ceil(total / SAMPLE_METERS);
  const sampleEast = new Float64Array(steps + 1);
  const sampleNorth = new Float64Array(steps + 1);
  let segment = 0;
  let walked = 0; // arc length at the start of `segment`
  for (let step = 0; step <= steps; step++) {
    const along = (total * step) / steps;
    while (segment < count - 2 && walked + spans[segment] < along) {
      walked += spans[segment];
      segment += 1;
    }
    const share = spans[segment] > 0 ? (along - walked) / spans[segment] : 0;
    sampleEast[step] =
      east[segment] + (east[segment + 1] - east[segment]) * share;
    sampleNorth[step] =
      north[segment] + (north[segment + 1] - north[segment]) * share;
  }
  return { east: sampleEast, north: sampleNorth };
}

function segmentDistance(
  east: number,
  north: number,
  line: Polyline,
  segment: number,
): number {
  const fromEast = line.east[segment];
  const fromNorth = line.north[segment];
  const runEast = line.east[segment + 1] - fromEast;
  const runNorth = line.north[segment + 1] - fromNorth;
  const squared = runEast * runEast + runNorth * runNorth;
  const along =
    squared > 0
      ? Math.min(
          1,
          Math.max(
            0,
            ((east - fromEast) * runEast + (north - fromNorth) * runNorth) /
              squared,
          ),
        )
      : 0;
  return Math.hypot(
    east - (fromEast + runEast * along),
    north - (fromNorth + runNorth * along),
  );
}

// Seeds from the previous sample's nearest segment and box-tests; neither changes the answer.
function meanDistance(
  samples: Polyline,
  line: Polyline,
  limit = Number.POSITIVE_INFINITY,
): number {
  const count = samples.east.length;
  const segments = line.east.length - 1;
  if (count === 0 || segments < 0) {
    return 0;
  } else if (segments === 0) {
    let total = 0;
    for (let sample = 0; sample < count; sample++) {
      total += Math.hypot(
        samples.east[sample] - line.east[0],
        samples.north[sample] - line.north[0],
      );
    }
    return total / count;
  }
  let total = 0;
  let nearest = 0; // the segment the previous sample came closest to
  for (let sample = 0; sample < count; sample++) {
    const east = samples.east[sample];
    const north = samples.north[sample];
    let best = segmentDistance(east, north, line, nearest);
    for (let segment = 0; segment < segments; segment++) {
      const fromEast = line.east[segment];
      const fromNorth = line.north[segment];
      const toEast = line.east[segment + 1];
      const toNorth = line.north[segment + 1];
      if (
        east - Math.max(fromEast, toEast) > best ||
        Math.min(fromEast, toEast) - east > best ||
        north - Math.max(fromNorth, toNorth) > best ||
        Math.min(fromNorth, toNorth) - north > best
      ) {
        continue;
      }
      const apart = segmentDistance(east, north, line, segment);
      if (apart < best) {
        best = apart;
        nearest = segment;
      }
    }
    total += best;
    if (total >= count * limit) {
      return Number.POSITIVE_INFINITY;
    }
  }
  return total / count;
}

// Symmetric, and equal to the area between the two lines over their length.
export function routeDistanceMeters(
  left: RouteResult,
  right: RouteResult,
): number {
  const referenceLat = left.path.lats.length > 0 ? left.path.lats[0] : 0;
  const leftLine = projectRoute(left, referenceLat);
  const rightLine = projectRoute(right, referenceLat);
  return lineDistanceMeters(
    { line: leftLine, samples: densify(leftLine) },
    { line: rightLine, samples: densify(rightLine) },
  );
}

interface Sampled {
  line: Polyline;
  samples: Polyline;
}

// Returns POSITIVE_INFINITY once the two halves prove the average exceeds `limit`.
function lineDistanceMeters(
  left: Sampled,
  right: Sampled,
  limit = Number.POSITIVE_INFINITY,
): number {
  const there = meanDistance(left.samples, right.line, 2 * limit);
  if (!Number.isFinite(there)) {
    return there;
  }
  const back = meanDistance(right.samples, left.line, 2 * limit - there);
  return Number.isFinite(back) ? (there + back) / 2 : back;
}

const SCENIC: ReadonlySet<FactorKey> = new Set<FactorKey>(SCENIC_KEYS);

// The reader's gates and the planner's own rail flag, which it moves itself below.
const SWITCHES: readonly (keyof RouteWeights)[] = [
  ...GATE_KEYS,
  ...INTERNAL_FLAGS,
];

function factorKeys(weights: RouteWeights): FactorKey[] {
  const switches: readonly string[] = SWITCHES;
  return (Object.keys(weights) as (keyof RouteWeights)[])
    .filter((key): key is FactorKey => !switches.includes(key))
    .sort();
}

// Null for ferry, the one factor `RouteFactors` carries no mean for.
function factorMean(result: RouteResult, key: FactorKey): number | null {
  const means: Partial<Record<FactorKey, number>> = result.factors;
  return means[key] ?? null;
}

function factorSeconds(result: RouteResult, key: FactorKey): number {
  const totals: Partial<Record<FactorKey, number>> = result.factorSeconds;
  return totals[key] ?? 0;
}

// Counts legs, not lines: one subway ride is the same trip as any other, whatever line it is.
export function rideSignature(result: RouteResult): string {
  const { rides, ferries } = result;
  return `${rides.length}:${ferries.length}`;
}

interface Pooled extends Sampled {
  result: RouteResult;
  rideSignature: string;
  index: number; // its place in the pool, which is its row in the separation cache
}

// Cached, since a pair costs a walk down both polylines and selection asks the same pairs repeatedly.
interface Separation {
  // Floored at DIFFERENT_METERS for pairs that ride differently, so the widest distinct pair still wins.
  meters(left: Pooled, right: Pooled): number;
  differ(left: Pooled, right: Pooled): boolean;
}

function separationCache(): Separation {
  const meters = new Map<string, number>();
  const different = new Map<string, boolean>();
  const keyOf = (left: Pooled, right: Pooled): string =>
    left.index < right.index
      ? `${left.index},${right.index}`
      : `${right.index},${left.index}`;
  const exact = (key: string, left: Pooled, right: Pooled): number => {
    const known = meters.get(key);
    if (known !== undefined) {
      return known;
    } else {
      const apart = lineDistanceMeters(left, right);
      meters.set(key, apart);
      different.set(key, apart >= DIFFERENT_METERS);
      return apart;
    }
  };
  return {
    meters(left: Pooled, right: Pooled): number {
      const apart = exact(keyOf(left, right), left, right);
      return left.rideSignature === right.rideSignature
        ? apart
        : Math.max(apart, DIFFERENT_METERS);
    },
    differ(left: Pooled, right: Pooled): boolean {
      if (left.rideSignature !== right.rideSignature) {
        return true;
      } else {
        const key = keyOf(left, right);
        const settled = different.get(key);
        if (settled !== undefined) {
          return settled;
        } else {
          const apart = lineDistanceMeters(left, right, DIFFERENT_METERS);
          const differs = apart >= DIFFERENT_METERS;
          if (Number.isFinite(apart)) {
            meters.set(key, apart);
          }
          different.set(key, differs);
          return differs;
        }
      }
    },
  };
}

// Routes equal on both keys are the same offer twice, and the earlier one stands for them.
export function undominated(
  travelSeconds: readonly number[],
  scenicScores: readonly number[],
): number[] {
  const kept: number[] = [];
  for (let candidate = 0; candidate < travelSeconds.length; candidate++) {
    let dominated = false;
    for (let rival = 0; rival < travelSeconds.length && !dominated; rival++) {
      if (rival !== candidate) {
        const quicker = travelSeconds[rival] < travelSeconds[candidate];
        const duller = scenicScores[rival] < scenicScores[candidate];
        const nicer = scenicScores[rival] > scenicScores[candidate];
        const slower = travelSeconds[rival] > travelSeconds[candidate];
        dominated =
          !slower && !duller && (quicker || nicer || rival < candidate);
      }
    }
    if (!dominated) {
      kept.push(candidate);
    }
  }
  return kept;
}

// Accumulates until the reader zeroes it.
export const selectionDiagnostics = { dominated: 0, visited: 0, enumerated: 0 };

// Searched depth-first, not built greedily, since a greedy first pick can block a better pair.
export function selectCards(
  separations: readonly Float64Array[],
  travelSeconds: readonly number[],
): number[] {
  const count = separations.length;
  const compatible: boolean[][] = [];
  for (let left = 0; left < count; left++) {
    const row: boolean[] = [];
    for (let right = 0; right < count; right++) {
      row.push(separations[left][right] >= DIFFERENT_METERS);
    }
    compatible.push(row);
  }

  const picked: number[] = [];
  let best: number[] = [];
  let bestSeparation = 0;
  let bestSeconds = 0;

  const extend = (from: number, closest: number, seconds: number): void => {
    selectionDiagnostics.visited += 1;
    if (picked.length > 0) {
      const better =
        picked.length > best.length ||
        (picked.length === best.length &&
          (closest > bestSeparation ||
            (closest === bestSeparation && seconds < bestSeconds)));
      if (better) {
        best = [...picked];
        bestSeparation = closest;
        bestSeconds = seconds;
      }
    }
    const reachable = Math.min(MAX_CARDS - 1, picked.length + count - from);
    const hopeless =
      reachable < best.length ||
      (reachable === best.length && closest < bestSeparation);
    if (!hopeless && picked.length + 1 < MAX_CARDS) {
      for (let next = from; next < count; next++) {
        let fits = compatible[0][next];
        for (const taken of picked) {
          fits = fits && compatible[taken][next];
        }
        if (fits) {
          let widened = Math.min(closest, separations[0][next]);
          for (const taken of picked) {
            widened = Math.min(widened, separations[taken][next]);
          }
          picked.push(next);
          extend(next + 1, widened, seconds + travelSeconds[next]);
          picked.pop();
        }
      }
    }
  };

  extend(1, Number.POSITIVE_INFINITY, 0);
  let sets = 1; // the empty set the search starts from
  let choices = 1;
  for (let size = 1; size < MAX_CARDS; size++) {
    choices = (choices * (count - size)) / size;
    sets += choices;
  }
  selectionDiagnostics.enumerated += sets;
  return [0, ...best];
}

function selectRoutes(
  pool: readonly Pooled[],
  maxRoute: Pooled,
  separation: Separation,
): Pooled[] {
  const routes = [
    maxRoute,
    ...pool.filter((candidate) => candidate !== maxRoute),
  ];
  const separations = routes.map((left) => {
    const row = new Float64Array(routes.length);
    for (let right = 0; right < routes.length; right++) {
      row[right] =
        left === routes[right] ? 0 : separation.meters(left, routes[right]);
    }
    return row;
  });
  const travelSeconds = routes.map((route) => route.result.travelSeconds);
  return selectCards(separations, travelSeconds).map((index) => routes[index]);
}

// The bound only falls as the weights rise, so this bisects; it costs no searches.
function solveScale(
  boundAt: (scale: number) => number,
  target: number,
): number {
  let low = 0;
  let high = 1;
  for (let step = 0; step < 40; step++) {
    const middle = (low + high) / 2;
    if (boundAt(middle) > target) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return (low + high) / 2;
}

export async function planRoutes(input: PlanInput): Promise<Plan> {
  const { weights, search, minMultiplier, factorMax, onCandidate } = input;

  const pool: Pooled[] = [];
  const bySignature = new Map<string, Pooled>();
  const byWeights = new Map<string, Pooled | null>();
  let searches = 0;
  let referenceLat = 0;
  const separation = separationCache();
  const differs = (left: Pooled, right: Pooled): boolean =>
    separation.differ(left, right);

  let superseded = false;
  const run = async (candidate: RouteWeights): Promise<Pooled | null> => {
    if (superseded) {
      return null;
    }
    const key = JSON.stringify(
      factorKeys(candidate)
        .map((factor) => candidate[factor])
        .concat(SWITCHES.map((switched) => (candidate[switched] ? 1 : 0))),
    );
    const memoised = byWeights.get(key);
    if (memoised !== undefined) {
      return memoised;
    }
    if (searches > 0 && input.superseded && (await input.superseded())) {
      superseded = true;
      return null;
    }
    searches += 1;
    const result = search(candidate);
    if (result === null) {
      byWeights.set(key, null);
      return null;
    }
    if (pool.length === 0 && result.path.lats.length > 0) {
      referenceLat = result.path.lats[0];
    }
    const signature = result.steps.map((step) => step.edge).join(",");
    const seen = bySignature.get(signature);
    if (seen) {
      byWeights.set(key, seen);
      return seen;
    }
    const line = projectRoute(result, referenceLat);
    const pooled: Pooled = {
      result,
      rideSignature: rideSignature(result),
      line,
      samples: densify(line),
      index: pool.length,
    };
    pool.push(pooled);
    bySignature.set(signature, pooled);
    byWeights.set(key, pooled);
    onCandidate?.(result);
    return pooled;
  };

  const maxRoute = await run(weights);
  if (maxRoute === null) {
    return { routes: [], bestByFactor: {}, searches, superseded };
  }

  const scenic = factorKeys(weights).filter(
    (key) => !FIXED_FACTORS.has(key) && weights[key] !== 0,
  );
  const scaled = (scale: number): RouteWeights => {
    const next = { ...weights };
    for (const key of scenic) {
      next[key] = weights[key] * scale;
    }
    return next;
  };

  const zeroRoute = await run(scaled(0));
  // The baseline's transit penalty can leave it walking from a station, so also ask with nothing priced.
  await run({ ...scaled(0), transit: 0 });

  // A mode of penalties alone moves the bound not at all, so the weight scale is stepped instead.
  const openBound = minMultiplier(scaled(0));
  const fullBound = minMultiplier(weights);
  const boundAt = (scale: number): number => minMultiplier(scaled(scale));
  const samples: { scale: number; route: Pooled | null }[] = [
    { scale: 0, route: zeroRoute },
  ];
  for (let step = 1; step < SWEEP_STEPS; step++) {
    const share = step / SWEEP_STEPS;
    let scale = share;
    if (openBound - fullBound > 1e-9) {
      scale = solveScale(boundAt, openBound - share * (openBound - fullBound));
    }
    samples.push({ scale, route: await run(scaled(scale)) });
  }
  samples.push({ scale: 1, route: maxRoute });

  if (zeroRoute !== null) {
    let low = 0;
    let high = -1;
    for (const sample of samples) {
      if (sample.route !== null && differs(sample.route, zeroRoute)) {
        high = sample.scale;
        break;
      } else if (sample.route !== null) {
        low = sample.scale;
      }
    }
    if (high >= 0) {
      for (let step = 0; step < BREAKPOINT_SEARCHES; step++) {
        const middle = (low + high) / 2;
        const route = await run(scaled(middle));
        if (route !== null && differs(route, zeroRoute)) {
          high = middle;
        } else {
          low = middle;
        }
      }
    }
  }

  // A path's cost is affine in one weight, so a route winning at both ends of an interval wins throughout.
  const dropAxes: FactorKey[] =
    weights.transit === 0 ? scenic : [...scenic, "transit"];
  for (const key of dropAxes) {
    await run({ ...weights, [key]: 0 });
  }
  if (!weights.allowSheds) {
    await run({ ...weights, allowSheds: true });
  }
  // A mode pricing no ride (Rain) never backs off into walking, so ask for the walk outright.
  if (
    weights.transit === 0 &&
    weights.allowTransit &&
    maxRoute.result.steps.some((step) => step.kind === "ride")
  ) {
    await run({ ...weights, allowTransit: false });
  }
  // Barring a crossing is a switch, not a weight, so no back-off axis reaches the surface-only walk.
  if (
    maxRoute.result.steps.some(
      (step) => step.kind === "ferry" || step.kind === "ride",
    )
  ) {
    await run({ ...weights, allowFerries: false, allowTransit: false });
  }

  if (superseded) {
    return { routes: [], bestByFactor: {}, searches, superseded };
  }

  // Penalties are never scored or chipped: a card says what a route has, not what it avoided.
  const scored = scenic.filter(
    (key) => SCENIC.has(key) && factorMean(maxRoute.result, key) !== null,
  );
  const scenicScores = pool.map((pooled) => {
    let total = 0;
    for (const key of scored) {
      total += weights[key] * factorSeconds(pooled.result, key);
    }
    return total;
  });
  const survivors = undominated(
    pool.map((pooled) => pooled.result.travelSeconds),
    scenicScores,
  ).map((index) => pool[index]);
  selectionDiagnostics.dominated += pool.length - survivors.length;
  const chosen = selectRoutes(survivors, maxRoute, separation);

  const routes: PlannedRoute[] = chosen.map((pooled) => {
    const scenicScore = scenicScores[pooled.index];
    let colorFactor: FactorKey | null = null;
    if (scored.length > 1 && chosen.length > 1) {
      let bestMargin = 0;
      for (const key of scored) {
        let rivals = 0;
        for (const other of chosen) {
          if (other !== pooled) {
            rivals = Math.max(rivals, factorMean(other.result, key) ?? 0);
          }
        }
        const margin =
          ((factorMean(pooled.result, key) ?? 0) - rivals) /
          (factorMax?.[key] || 1);
        if (margin > bestMargin) {
          bestMargin = margin;
          colorFactor = key;
        }
      }
      if (bestMargin < COLOR_MARGIN) {
        colorFactor = null;
      }
    }
    return { result: pooled.result, scenicScore, colorFactor };
  });
  routes.sort(CARD_ORDER);

  const bestByFactor: Partial<Record<FactorKey, number>> = {};
  for (const key of scored) {
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < routes.length; index++) {
      const value = factorMean(routes[index].result, key) ?? 0;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    }
    bestByFactor[key] = bestIndex;
  }

  return { routes, bestByFactor, searches, superseded };
}

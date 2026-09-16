// Pure and synchronous over an injected search, so it runs on the main thread and in the worker.
// The sweep steps `minMultiplier` rather than the weight scale, which is a cliff: Times Sq to Battery
// is the identical route at t = 0, 0.25 and 0.5.

import {
  GATE_KEYS,
  INTERNAL_FLAGS,
  type RouteWeights,
  SCENIC_KEYS,
} from "./cost";
import type { FactorKey } from "./factors";
import type { RouteResult } from "./search";

// How far apart two routes have to run, on average, to count as different walks. Measured against
// the 0.35-Jaccard selection it replaces, over the engine bench's six New York trips at four modes:
// agreement rises the lower this goes — 12 of those 24 plans pick the same cards at 30 m, 9 at 50 m,
// 7 at 100 m — because a Jaccard over 40 m cells is a permissive test that two routes parting for a
// couple of blocks already cleared. What stops it going lower is the floor: the two pavements of one
// street are 12-19 m apart in New York and must stay one route, so this keeps 2.5x over the widest.
export const DIFFERENT_METERS = 50;

const MAX_CARDS = 4;
// Held still while the sweep scales the rest. Shade because the bracket is exact only while the
// moving-sun term is a path constant; transit because it is a PENALTY, and a sweep that scales it
// toward zero makes its own baseline the most train-happy route there is — when what the baseline is
// for is the fastest walk to compare the scenic ones against.
const FIXED_FACTORS: ReadonlySet<FactorKey> = new Set<FactorKey>([
  "shade",
  "hill",
  "transit",
]);

// Eight searches between them, per the plan's budget.
const SWEEP_STEPS = 5;
const BREAKPOINT_SEARCHES = 4;
// Lead on a factor, as a share of its graph max, that paints a card in that factor's colour.
const COLOR_MARGIN = 0.15;

// How finely each route is walked before the distances are taken. Well under the separation the
// threshold is set at, so the mean over the samples is the arc-length integral it stands for.
const SAMPLE_METERS = 20;
const METERS_PER_DEGREE_LAT = 111_320;

export interface PlannedRoute {
  result: RouteResult;
  // Absolute, not a share: weight times the seconds spent on the attribute, summed over the mode's
  // discounts. A trip that spends most of its time getting there earns only what it walks.
  scenicScore: number;
  // Null where nothing stands out, or where the mode asks for one factor: the UI ramps instead.
  colorFactor: FactorKey | null;
}

export interface Plan {
  routes: PlannedRoute[];
  bestByFactor: Partial<Record<FactorKey, number>>;
  searches: number;
}

export interface PlanInput {
  weights: RouteWeights;
  // One A* at these weights; the caller has already fixed the endpoints, clock and contexts.
  search: (weights: RouteWeights) => RouteResult | null;
  minMultiplier: (weights: RouteWeights) => number;
  factorMax?: Partial<Record<FactorKey, number>>; // graph max per factor; missing reads as 1
  onCandidate?: (result: RouteResult) => void; // per distinct route as it is found, R_max first
}

// Most scenic first, most direct last — the end the owner cares about is the one read first. One
// place, because the owner wants to try other orders.
export function CARD_ORDER(left: PlannedRoute, right: PlannedRoute): number {
  return (
    right.scenicScore - left.scenicScore ||
    left.result.travelSeconds - right.result.travelSeconds
  );
}

// A route in a local equirectangular frame: metres east and north of the reference latitude. Flat
// earth over a city is exact enough for a separation measured in tens of metres, and it is the frame
// every distance below is taken in.
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

// The line walked at `SAMPLE_METERS` by arc length, both ends included, so each sample stands for
// the same length of route and their mean is an average over the route rather than over its
// vertices — a straight mile and a switchback of the same length weigh alike.
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

// The distance from one point to one segment of `line`, the foot of the perpendicular clamped to
// the segment's ends.
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

// The mean over `samples` of the distance to the nearest point of `line`, or POSITIVE_INFINITY as
// soon as the running mean passes `limit` — the only caller that passes one is asking whether two
// routes are different walks, which a mean already over the floor answers without the figure.
//
// Two things keep the inner scan affordable. The box test rejects every segment further off than
// the best so far on a subtraction; and the scan starts from the segment the PREVIOUS sample was
// nearest to, which for samples walked in order along a route is nearly always this one's too, so
// the box test has a tight bound to reject against from the first segment on. Neither changes the
// answer: the seed is an upper bound on the minimum, and the box test only drops segments that
// cannot beat it.
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

// How far apart two routes run, in metres: the mean over one route of the distance to the other,
// both ways round, averaged. Symmetric by construction, 0 for a route against itself, and — being
// an arc-length mean of a perpendicular offset — the area between the two lines divided by their
// length, with no intersections to find and no polygon to close.
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

// A route as the planner holds it for comparison: its own vertices, and the samples taken along it.
interface Sampled {
  line: Polyline;
  samples: Polyline;
}

// `limit` is what the answer is being compared against, and is returned as POSITIVE_INFINITY once
// the two halves prove the average is over it: either half at twice the limit settles it on its own,
// and once the first is in, what the second must reach to settle it is whatever is left.
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

// Every switch the sweep must hold fixed and key its memo on: the reader's gates and the planner's
// own rail flag, which it moves itself below.
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

// The attribute's seconds, which is the same sum before it was made a share.
function factorSeconds(result: RouteResult, key: FactorKey): number {
  const totals: Partial<Record<FactorKey, number>> = result.factorSeconds;
  return totals[key] ?? 0;
}

// How many legs a route rides, trains and boats counted apart. What the reader chooses between is a
// walk, a ride, a connection and a boat — not the A against the C — so one subway ride is the same
// trip as any other whatever line it is, and two rides the same as any other two. Routes that ride
// alike fall through to the ground between them; routes that do not are different cards however
// close they run, a walk and the same walk with a train in the middle of it included.
export function rideSignature(result: RouteResult): string {
  const { rides, ferries } = result;
  return `${rides.length}:${ferries.length}`;
}

interface Pooled extends Sampled {
  result: RouteResult;
  rideSignature: string;
  index: number; // its place in the pool, which is its row in the separation cache
}

// How far apart two pooled routes run, taken once and kept. A pair costs a walk down both
// polylines, and the selection below asks for the same pairs over and over.
interface Separation {
  // The figure itself, which the card search needs to pick the set that runs widest apart. Floored
  // at DIFFERENT_METERS for a pair that rides differently, so the objective still prefers the
  // geometrically widest pair among routes that are all distinct.
  meters(left: Pooled, right: Pooled): number;
  // Whether the two are different trips: a different count of rides settles it, and so does a pair
  // already over the floor, without a figure.
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

// Which candidates are worth a card at all, as indices into the pool and in its order: a route is
// dropped as soon as another is both no slower and no less scenic, with one of the two strict, since
// a reader offered the better one is never also wanting this. Routes equal on both keys are the same
// offer twice, and the earlier one stands for them.
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

// Last-plan instrumentation, for the bench: the candidates dropped as dominated, and the partial
// sets the search below actually looked at against the number a plain enumeration of every set would
// have. All of them accumulate until the reader zeroes them.
export const selectionDiagnostics = { dominated: 0, visited: 0, enumerated: 0 };

// The set of cards, exactly, as indices into a pool whose route 0 is the max-scenic one and is
// always kept: the largest number of cards whose closest pair still clears the floor, and of those
// the set whose closest pair runs furthest apart, shortest total walk breaking the tie.
// Furthest-from-chosen is greedy, and its first pick can block a better pair behind it, so the sets
// are searched rather than built up: depth-first, extending only by a candidate that is a different
// walk from every card already picked, and abandoning a branch the moment it can no longer beat the
// best set held — either because it cannot grow that long, or because its closest pair is already
// nearer than that set's and only closes further. Exported for the test that holds it against an
// enumeration of every set.
export function selectCards(
  separations: readonly Float64Array[],
  travelSeconds: readonly number[],
): number[] {
  const count = separations.length;
  // Whether two routes are different walks is a property of the pair, so it is settled here once
  // and the search below only reads it.
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

export function planRoutes(input: PlanInput): Plan {
  const { weights, search, minMultiplier, factorMax, onCandidate } = input;

  const pool: Pooled[] = [];
  const bySignature = new Map<string, Pooled>();
  const byWeights = new Map<string, Pooled | null>();
  let searches = 0;
  let referenceLat = 0;
  const separation = separationCache();
  const differs = (left: Pooled, right: Pooled): boolean =>
    separation.differ(left, right);

  const run = (candidate: RouteWeights): Pooled | null => {
    const key = JSON.stringify(
      factorKeys(candidate)
        .map((factor) => candidate[factor])
        .concat(SWITCHES.map((switched) => (candidate[switched] ? 1 : 0))),
    );
    const memoised = byWeights.get(key);
    if (memoised !== undefined) {
      return memoised;
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

  const maxRoute = run(weights);
  if (maxRoute === null) {
    return { routes: [], bestByFactor: {}, searches };
  }

  // What the back-off axes may move.
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

  const zeroRoute = run(scaled(0));
  // The baseline still carries the mode's transit penalty, which can leave it walking from a station
  // it should have stayed on the train past. The trip with nothing priced at all is the quickest one
  // there is, and it is the card the reader reaches for when none of the scenery is worth the time.
  run({ ...scaled(0), transit: 0 });

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
    samples.push({ scale, route: run(scaled(scale)) });
  }
  samples.push({ scale: 1, route: maxRoute });

  // The least scenic route that is still a different walk: bracketed by the sweep, then bisected
  // into the pool, where it stands as a candidate like any other.
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
        const route = run(scaled(middle));
        if (route !== null && differs(route, zeroRoute)) {
          high = middle;
        } else {
          low = middle;
        }
      }
    }
  }

  // A factor that was not binding returns the max-scenic route again; expected, and cheap. The
  // transit penalty earns a drop of its own even though the sweep holds it still: dropping it is how
  // the route that rides gets asked for.
  //
  // Nothing is asked BETWEEN 0 and the mode's weight: a fixed path's cost is affine in one weight, so
  // the cheapest cost over the paths is concave in it, and a route that wins at both ends of the
  // interval wins at every point of it.
  const dropAxes: FactorKey[] =
    weights.transit === 0 ? scenic : [...scenic, "transit"];
  for (const key of dropAxes) {
    run({ ...weights, [key]: 0 });
  }
  if (!weights.allowSheds) {
    run({ ...weights, allowSheds: true });
  }
  // A mode that prices no ride at all — Rain, for which a train is shelter — rides every trip the
  // rail is quicker on, and the sweep would never think to ask what walking looks like, since
  // backing a weight of zero off changes nothing. So the walk is asked for outright, the way the
  // shed gate above is. Only when the chosen route does ride: otherwise the answer is the route we
  // already have, for a search.
  if (
    weights.transit === 0 &&
    weights.allowTransit &&
    maxRoute.result.steps.some((step) => step.kind === "ride")
  ) {
    run({ ...weights, allowTransit: false });
  }
  // And whatever the chosen route rides — a boat as readily as a train — the walk that stays on the
  // surface the whole way is a card worth offering, which no back-off axis can reach: barring a
  // crossing is a switch, not a weight. Asked outright, as the two above are, and only when the
  // route does ride, since otherwise the answer is the route already in the pool.
  if (
    maxRoute.result.steps.some(
      (step) => step.kind === "ferry" || step.kind === "ride",
    )
  ) {
    run({ ...weights, allowFerries: false, allowTransit: false });
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
  // Selection chooses between what is left once the dominated candidates are gone, so a card it
  // could have spent on a route nothing recommends goes to one that differs on its own terms.
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

  return { routes, bestByFactor, searches };
}

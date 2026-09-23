// Cost is effective seconds; A* is admissible only while discount attributes are < 1 and |w| <= 1.

import {
  edgeKind,
  isTunnel,
  laneOf,
  type RoutingGraph,
  stopIndexOf,
  transitForward,
} from "./graph";
import { shedShade } from "./sheds";
import {
  edgeGrade,
  edgeWalkSeconds,
  maxSpeedFactor,
  WALK_METERS_PER_SECOND,
} from "./walk-speed";

// Re-exported because everything that prices a walk asks this module.
export {
  edgeAscentGrade,
  edgeDescentGrade,
  edgeGrade,
  gradeSpeedFactor,
  maxSpeedFactor,
  WALK_METERS_PER_SECOND,
  walkSecondsPerMeter,
  walkSpeedOn,
} from "./walk-speed";

// NYC DCP study: 50 timed walks lost ~3 s per crossing; one number since the term is worth a minute.
export const CROSSING_SECONDS = 3;

// A router-only price on the act, so a crossing undone for the shady side and back is never worth it.
export const CROSSING_AVOID_MULTIPLE = 10;

// SF Bay ferries are the only way across and have a 140-minute midday gap, hence a per-city cap.
export const DEFAULT_MAX_FERRY_WAIT_SECONDS = 90 * 60;

// Stairs, platform and doors, which the timetable's clock doesn't cover.
export const BOARDING_SECONDS = 60;

// A headway past half an hour is night service, where walking is the better answer.
export const DEFAULT_MAX_TRANSIT_WAIT_SECONDS = 30 * 60;

// w must stay <= 1 or a discount floor (1 - w*max) goes negative and breaks A*.
export const MAX_TREE_WEIGHT = 1;
export const DEFAULT_TREE_WEIGHT = 0.8;
// At w = 1 a ferry still costs FERRY_FLOOR of its duration, so the search can't loop one for credit.
export const MAX_FERRY_WEIGHT = 1;
export const DEFAULT_FERRY_WEIGHT = 0.1;
export const FERRY_FLOOR = 1e-3;
export const MAX_LANDMARK_WEIGHT = 1;
export const DEFAULT_LANDMARK_WEIGHT = 0.1;
export const MAX_ART_WEIGHT = 1;
export const DEFAULT_ART_WEIGHT = 0.1;
// Measured over 300 trips per city: 3 removes ~90% of attainable highway frontage for 6% more walking.
export const MAX_HIGHWAY_WEIGHT = 3;
// Measured on Potrero Hill: 1 still climbed a 12% block; past 5 routes go a long way round.
export const MAX_HILL_WEIGHT = 5;

// The penalty equals the weight at this grade; squared, so a steep wall costs more than a spread climb.
const HILL_REFERENCE_GRADE = 0.12;

// The -1 no-node default means the stored a -> b direction.
export function edgeForward(
  graph: RoutingGraph,
  edge: number,
  fromNode: number,
): boolean {
  return fromNode !== graph.edgeNodeB[edge];
}

// Clamped for the summary only; the cost deliberately runs past 1.
export function hillFractionOf(graph: RoutingGraph, edge: number): number {
  return Math.min(1, edgeGrade(graph, edge) / HILL_REFERENCE_GRADE);
}

// Moves 64% of seeded highway trips for 1.6% more walking.
export const DEFAULT_HIGHWAY_WEIGHT = 0.5;
// Hill time is already charged by the grade-adjusted walking speed; this is only how much you mind one.
export const DEFAULT_HILL_WEIGHT = 0;
export const MAX_COMMERCIAL_WEIGHT = 1;
export const DEFAULT_COMMERCIAL_WEIGHT = 0.1;
// Near-binary attribute, so at w = 1 an in-district meter is nearly free; still admissible below 254.
export const MAX_HISTORIC_WEIGHT = 1;
export const DEFAULT_HISTORIC_WEIGHT = 0.1;
// The bake's land mask, not the structure flag, tells a bridge over water from one over a rail yard.
export const MAX_BRIDGE_WEIGHT = 1;
export const DEFAULT_BRIDGE_WEIGHT = 0.1;
// Over 234 industrial trips, 1 removed only 40% of frontage; 5 removes 70% for 14.5% more walking.
export const MAX_INDUSTRIAL_WEIGHT = 5;
// At the max a walkable trip is walked, but a rail-length trip still rides.
export const MAX_TRANSIT_WEIGHT = 3;
export const DEFAULT_TRANSIT_WEIGHT = MAX_TRANSIT_WEIGHT;
// 0.5 moves under half the seeded trips; 1 moves 63% for 3.6% more walking.
export const DEFAULT_INDUSTRIAL_WEIGHT = 1;
// |w| <= 1 keeps the shade factor's floor (1 - |w|*maxAbsAttr) positive since maxAbsAttr < 1.
export const MAX_SHADE_WEIGHT = 1;
export const DEFAULT_SHADE_WEIGHT = 0;
export const MAX_SHELTER_WEIGHT = 1;
export const DEFAULT_SHELTER_WEIGHT = 0;

// The byte ceiling rather than 1, so no meter of the network is ever free.
export const TUNNEL_SHELTER = 254 / 255;

// A corner-cross-back detour breaks even near 4x; finite so an endpoint under a deck stays routable.
export const SHED_AVOID_PENALTY = 20;

// ~5% cover: a side gap this small is too close to call.
export const SIDE_TIE_BYTES = 12;

// The single list of switches, so the cache's staleness check can't miss one.
export const GATE_KEYS = [
  "allowSheds",
  "allowFerries",
  "allowCrossings",
] as const;

export type GateKey = (typeof GATE_KEYS)[number];

// Not a gate or a weight: the planner shuts it for the walk-only candidate.
export const INTERNAL_FLAGS = ["allowTransit"] as const;

export type InternalFlag = (typeof INTERNAL_FLAGS)[number];

// Factors that discount a meter (1 - w*attr); ferry discounts a crossing's seconds instead.
export const DISCOUNT_KEYS = [
  "tree",
  "landmark",
  "art",
  "commercial",
  "historic",
  "bridge",
  "shade",
  "shelter",
] as const;

export type DiscountKey = (typeof DISCOUNT_KEYS)[number];

export const SCENIC_KEYS = [...DISCOUNT_KEYS, "ferry"] as const;

export type ScenicKey = (typeof SCENIC_KEYS)[number];

// Factors that price what they touch (1 + w*attr), so the A* lower bound never sees one.
export const PENALTY_KEYS = [
  "highway",
  "hill",
  "industrial",
  "transit",
] as const;

export type PenaltyKey = (typeof PENALTY_KEYS)[number];

export type WeightKey = Exclude<keyof RouteWeights, GateKey | InternalFlag>;

export const WEIGHT_KEYS = [...SCENIC_KEYS, ...PENALTY_KEYS] as const;

type Listed = (typeof WEIGHT_KEYS)[number];

// Fails to compile if a numeric weight is missing from, or listed twice in, the lists above.
type NoStrays<Key extends never> = Key;

export type WeightListsAreComplete = NoStrays<
  Exclude<WeightKey, Listed> | Exclude<Listed, WeightKey>
>;

export interface RouteWeights {
  tree: number;
  ferry: number;
  landmark: number;
  art: number;
  highway: number;
  // Absolute grade, so a hill costs the same up or down.
  hill: number;
  commercial: number;
  // Counted per side, so both sides cost twice one.
  industrial: number;
  // Independent of `landmark`, which prices passing an individual monument.
  historic: number;
  bridge: number;
  shade: number; // signed sun/shade preference in [-1, 1]; positive prefers sun, negative shade
  shelter: number; // preference for cover overhead in the rain: decks and canopy
  transit: number;
  allowFerries: boolean;
  // Not a reader's switch: the planner turns it off so a no-ride mode still offers the walk.
  allowTransit: boolean;
  allowSheds: boolean; // false routes around scaffolding, at a large per-meter penalty
  // False prices every crossing far above its time, which stops a route zigzagging for the shady side.
  allowCrossings: boolean;
}

// In v2 the side is topology, so an edge carries a single value.
export function edgeCover(graph: RoutingGraph, edge: number): number {
  return graph.edgeCover[edge] / 255;
}

// 0 while no shed artifact is loaded.
export function edgeShed(graph: RoutingGraph, edge: number): number {
  return graph.sheds ? graph.sheds.coverage[edge] / 255 : 0;
}

export function edgeShedShade(
  graph: RoutingGraph,
  edge: number,
  elapsedSeconds: number,
): number {
  return graph.sheds ? shedShade(graph.sheds, edge, elapsedSeconds) : 0;
}

// A deck's share reads fully shaded, mixed with the baked rest by length; a tunnel is fully shaded.
export function shadeAttrOf(
  graph: RoutingGraph,
  edge: number,
  elapsedSeconds: number,
  shed: number,
): number {
  if (!graph.shade) {
    return 0;
  } else if (graph.hasTunnels && isTunnel(graph, edge)) {
    return -graph.shade.intensityAt(elapsedSeconds);
  } else if (shed === 0) {
    return graph.shade.attrAt(edge, elapsedSeconds);
  } else {
    return (
      graph.shade.attrAt(edge, elapsedSeconds) * (1 - shed) -
      shed * graph.shade.intensityAt(elapsedSeconds)
    );
  }
}

// Union of deck and crown coverage, assumed independent; a tunnel is the byte ceiling.
export function shelterAttrOf(
  graph: RoutingGraph,
  edge: number,
  shed: number,
): number {
  if (graph.hasTunnels && isTunnel(graph, edge)) {
    return TUNNEL_SHELTER;
  } else if (!graph.sheds) {
    return 0;
  } else {
    const canopy =
      graph.sheds.rainTau * (graph.edgeDirectCanopy[edge] / 255) * (1 - shed);
    return shed + canopy;
  }
}

// Deck, crown and tunnel share the byte ceiling, so this stays < 1 and the shelter floor positive.
export function maxShelter(graph: RoutingGraph): number {
  const tunnel = graph.hasTunnels ? TUNNEL_SHELTER : 0;
  if (!graph.sheds) {
    return tunnel;
  } else {
    const { maxCoverage, rainTau } = graph.sheds;
    const decked =
      maxCoverage + rainTau * graph.maxDirectCanopy * (1 - maxCoverage);
    return Math.max(tunnel, decked);
  }
}

// `elapsedSeconds` advances the sun, so an edge costs differently late in a long route.
export function edgeMultiplier(
  graph: RoutingGraph,
  edge: number,
  weights: RouteWeights,
  elapsedSeconds = 0,
): number {
  const shed = edgeShed(graph, edge);
  // A deck shelters all it covers but shades only what its 4 m depth covers; both count when barred.
  const shaded = edgeShedShade(graph, edge, elapsedSeconds);
  const tree = 1 - weights.tree * (graph.edgeCover[edge] / 255);
  const landmark = 1 - weights.landmark * (graph.edgeLandmark[edge] / 255);
  const art = 1 - weights.art * (graph.edgeArt[edge] / 255);
  const highway = 1 + weights.highway * (graph.edgeHighway[edge] / 255);
  // Unclamped above the reference, since San Francisco has streets at three times it.
  const gradeShare = edgeGrade(graph, edge) / HILL_REFERENCE_GRADE;
  const hill = 1 + weights.hill * gradeShare * gradeShare;
  const commercial =
    1 - weights.commercial * (graph.edgeCommercial[edge] / 255);
  const industrial =
    1 + weights.industrial * (graph.edgeIndustrial[edge] / 255);
  const historic = 1 - weights.historic * (graph.edgeHistoric[edge] / 255);
  const bridge = 1 - weights.bridge * (graph.edgeBridge[edge] / 255);
  const shade =
    1 - weights.shade * shadeAttrOf(graph, edge, elapsedSeconds, shaded);
  const shelter = 1 - weights.shelter * shelterAttrOf(graph, edge, shed);
  const scenic =
    tree *
    landmark *
    art *
    highway *
    hill *
    commercial *
    industrial *
    historic *
    bridge *
    shade *
    shelter;
  if (weights.allowSheds) {
    return scenic;
  } else {
    // Per meter, and the decked share pays the full penalty however sure the shed placement is.
    return scenic * (1 - shed) + shed + SHED_AVOID_PENALTY * shed;
  }
}

// A possibly loose lower bound on every edge's multiplier, so the A* heuristic never overestimates.
export function minMultiplier(
  graph: RoutingGraph,
  weights: RouteWeights,
): number {
  let product = 1;
  for (const key of DISCOUNT_KEYS) {
    // A deck or tunnel mixes the attribute toward -intensity, which stays within the field's maxAbs.
    product *= 1 - Math.abs(weights[key]) * discountMax(graph, key);
  }
  return product;
}

// The switch is the list: a discount added without a maximum here does not compile.
export function discountMax(graph: RoutingGraph, key: DiscountKey): number {
  switch (key) {
    case "tree":
      return graph.maxCover;
    case "landmark":
      return graph.maxLandmark;
    case "art":
      return graph.maxArt;
    case "commercial":
      return graph.maxCommercial;
    case "historic":
      return graph.maxHistoric;
    case "bridge":
      return graph.maxBridge;
    case "shade":
      return graph.shade ? graph.shade.maxAbs : 0;
    case "shelter":
      return maxShelter(graph);
  }
}

// A divided street chains crossing edges via islands; `fromNode` tells a start from a continuation.
export function crossingWait(
  graph: RoutingGraph,
  edge: number,
  fromNode: number,
): number {
  return edgeKind(graph, edge) === "crossing" &&
    graph.nodeMidRoadway[fromNode] === 0
    ? CROSSING_SECONDS
    : 0;
}

// Infinity after the last boat; without a timetable, the baked direction- and time-independent figure.
export function ferrySeconds(
  graph: RoutingGraph,
  edge: number,
  fromNode: number,
  elapsedSeconds: number,
): { wait: number; crossing: number } {
  if (!graph.ferries?.covers(edge)) {
    return { wait: 0, crossing: graph.edgeDurationSeconds[edge] };
  }
  const sailing = graph.ferries.board(edge, fromNode, elapsedSeconds);
  const cap = graph.maxFerryWaitSeconds ?? DEFAULT_MAX_FERRY_WAIT_SECONDS;
  if (!sailing || sailing.wait > cap) {
    return { wait: Number.POSITIVE_INFINITY, crossing: 0 };
  } else {
    return { wait: sailing.wait, crossing: sailing.crossing };
  }
}

// Infinity with no timetable, since the graph bakes no fallback duration: no schedule, no train.
export function boardSeconds(
  graph: RoutingGraph,
  edge: number,
  elapsedSeconds: number,
): number {
  const lane = laneOf(graph, edge);
  if (!graph.transit?.covers(lane)) {
    return Number.POSITIVE_INFINITY;
  }
  const departure = graph.transit.board(
    lane,
    stopIndexOf(graph, edge),
    elapsedSeconds,
  );
  const cap = graph.maxTransitWaitSeconds ?? DEFAULT_MAX_TRANSIT_WAIT_SECONDS;
  if (!departure || departure.wait > cap) {
    return Number.POSITIVE_INFINITY;
  } else {
    return departure.wait + BOARDING_SECONDS;
  }
}

// Floored so a ride is never free; shade and scenic factors don't apply underground.
export function transitMultiplier(weights: RouteWeights): number {
  return (1 + weights.transit) * Math.max(FERRY_FLOOR, 1 - weights.shelter);
}

// Floored like `transitMultiplier` so a crossing is never free.
export function ferryCrossingDiscount(weights: RouteWeights): number {
  return (
    Math.max(FERRY_FLOOR, 1 - weights.ferry) *
    Math.max(FERRY_FLOOR, 1 - weights.shelter)
  );
}

// The ETA unit: the reported trip time sums it.
export function rawSeconds(
  graph: RoutingGraph,
  edge: number,
  fromNode: number,
  elapsedSeconds = 0,
): number {
  const kind = edgeKind(graph, edge);
  if (kind === "ferry") {
    const { wait, crossing } = ferrySeconds(
      graph,
      edge,
      fromNode,
      elapsedSeconds,
    );
    return wait + crossing;
  } else if (kind === "board") {
    return boardSeconds(graph, edge, elapsedSeconds);
  } else if (kind === "ride" || kind === "access") {
    return graph.edgeDurationSeconds[edge];
  } else {
    return (
      walkedSeconds(graph, edge, fromNode) + crossingWait(graph, edge, fromNode)
    );
  }
}

// A partial end edge is not this; it's its own length at the same seconds per meter.
function walkedSeconds(
  graph: RoutingGraph,
  edge: number,
  fromNode: number,
): number {
  return edgeWalkSeconds(graph, edge, edgeForward(graph, edge, fromNode));
}

// Written into a caller-owned record so the relax loop allocates nothing per edge.
export interface EdgeSeconds {
  effective: number;
  raw: number;
}

export function edgeSeconds(
  graph: RoutingGraph,
  edge: number,
  weights: RouteWeights,
  elapsedSeconds: number,
  fromNode: number,
  into: EdgeSeconds,
): void {
  const kind = edgeKind(graph, edge);
  if (kind === "board" || kind === "ride" || kind === "access") {
    // Transit topology is directed; this also skips alight edges' timetable lookups.
    if (
      !transitForward(graph, edge, fromNode) ||
      (kind === "board" && !weights.allowTransit)
    ) {
      into.raw = 0;
      into.effective = Number.POSITIVE_INFINITY;
    } else if (kind === "access") {
      into.raw = graph.edgeDurationSeconds[edge];
      into.effective = into.raw; // the walk in and out of a station, priced plainly
    } else {
      into.raw =
        kind === "board"
          ? boardSeconds(graph, edge, elapsedSeconds)
          : graph.edgeDurationSeconds[edge];
      into.effective = into.raw * transitMultiplier(weights);
    }
  } else if (kind === "ferry") {
    if (!weights.allowFerries) {
      into.raw = 0;
      into.effective = Number.POSITIVE_INFINITY;
    } else {
      const { wait, crossing } = ferrySeconds(
        graph,
        edge,
        fromNode,
        elapsedSeconds,
      );
      into.raw = wait + crossing;
      // The ferry and shelter weights discount the crossing, not the wait, else a later sailing wins.
      into.effective = wait + crossing * ferryCrossingDiscount(weights);
    }
  } else {
    const walked = walkedSeconds(graph, edge, fromNode);
    into.raw = walked + crossingWait(graph, edge, fromNode);
    // Added after the multiplier, since a shade preference discounting it would defeat it.
    into.effective =
      walked * edgeMultiplier(graph, edge, weights, elapsedSeconds) +
      crossingPrice(graph, edge, fromNode, weights);
  }
}

const oneEdge: EdgeSeconds = { effective: 0, raw: 0 };

export function effSeconds(
  graph: RoutingGraph,
  edge: number,
  weights: RouteWeights,
  elapsedSeconds = 0,
  fromNode = -1,
): number {
  edgeSeconds(graph, edge, weights, elapsedSeconds, fromNode, oneEdge);
  return oneEdge.effective;
}

// Charged through `crossingWait`, so a divided street is priced once, not once per carriageway.
export function crossingPrice(
  graph: RoutingGraph,
  edge: number,
  fromNode: number,
  weights: RouteWeights,
): number {
  return weights.allowCrossings
    ? 0
    : crossingWait(graph, edge, fromNode) * CROSSING_AVOID_MULTIPLE;
}

// A* scales straight-line distance by this lower bound on a meter's seconds.
export function walkSecondsCoeff(
  graph: RoutingGraph,
  weights: RouteWeights,
): number {
  // The fastest speed is a gentle descent's, above the flat 1.3 m/s, so this stays a lower bound.
  return (
    minMultiplier(graph, weights) /
    (WALK_METERS_PER_SECOND * maxSpeedFactor(graph))
  );
}

// Summed over every transit edge at zero wait, so it bounds any path's saving.
export function transitCredit(
  graph: RoutingGraph,
  weights: RouteWeights,
): number {
  if (
    !weights.allowTransit ||
    graph.transit === null ||
    graph.boardEdges.length === 0
  ) {
    return 0;
  }
  const coeff = walkSecondsCoeff(graph, weights);
  const multiplier = transitMultiplier(weights);
  let credit = 0;
  for (const edge of graph.transitEdges) {
    // A board edge's wait has no lower bound, so its span inside a transfer complex counts as saving.
    const kind = edgeKind(graph, edge);
    const cheapest =
      kind === "ride"
        ? graph.edgeDurationSeconds[edge] * multiplier
        : kind === "access"
          ? graph.edgeDurationSeconds[edge]
          : 0;
    credit += Math.max(0, coeff * graph.edgeLength[edge] - cheapest);
  }
  return credit;
}

// Summed over every ferry edge, since three hops of a multi-stop line can save more than the best two.
export function ferryCredit(
  graph: RoutingGraph,
  weights: RouteWeights,
): number {
  if (!weights.allowFerries) {
    return 0;
  }
  const coeff = walkSecondsCoeff(graph, weights);
  const discount = ferryCrossingDiscount(weights);
  let credit = 0;
  for (const edge of graph.ferryEdges) {
    const quickest = graph.ferries?.covers(edge)
      ? graph.ferries.minRideSeconds(edge)
      : graph.edgeDurationSeconds[edge];
    credit += Math.max(0, coeff * graph.edgeLength[edge] - quickest * discount);
  }
  return credit;
}

// Credits can swamp the straight-line term, so the caller takes the max of both estimates.
export function heuristicFloor(
  graph: RoutingGraph,
  weights: RouteWeights,
): number {
  let floor = walkSecondsCoeff(graph, weights);
  if (weights.allowFerries) {
    // Per ferry, not the baked figure, which fuses in the average wait.
    const discount = ferryCrossingDiscount(weights);
    for (const edge of graph.ferryEdges) {
      const length = graph.edgeLength[edge];
      const quickest = graph.ferries?.covers(edge)
        ? graph.ferries.minRideSeconds(edge)
        : graph.edgeDurationSeconds[edge];
      if (length > 0) {
        floor = Math.min(floor, (quickest * discount) / length);
      }
    }
  }
  if (weights.allowTransit && graph.transit !== null) {
    const multiplier = transitMultiplier(weights);
    floor = Math.min(
      floor,
      graph.minRideSecPerMeter * multiplier,
      graph.minAccessSecPerMeter,
    );
    for (const edge of graph.boardEdges) {
      const length = graph.edgeLength[edge];
      if (length > 0) {
        floor = Math.min(floor, (BOARDING_SECONDS * multiplier) / length);
      }
    }
  }
  return floor;
}

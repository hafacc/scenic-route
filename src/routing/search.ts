// The ferry and transit credits make the heuristic inconsistent, so nodes may reopen (no closed set).

import {
  crossingWait,
  type EdgeSeconds,
  edgeCover,
  edgeMultiplier,
  edgeSeconds,
  edgeShed,
  ferryCredit,
  ferrySeconds,
  heuristicFloor,
  hillFractionOf,
  type RouteWeights,
  rawSeconds,
  shadeAttrOf,
  shelterAttrOf,
  transitCredit,
  walkSecondsCoeff,
  walkSecondsPerMeter,
} from "./cost";
import {
  type EdgeKind,
  edgeKind,
  edgeName,
  edgePath,
  edgeSideLabel,
  isStayAboard,
  laneOf,
  otherEnd,
  type RoutingGraph,
  routeOf,
  type SideLabel,
  stationName,
  stopIndexOf,
  subEdgePath,
  type TransitRoute,
} from "./graph";
import { NodeHeap } from "./node-heap";
import { haversineMeters, type Snap } from "./snap";

// The crossing wait is charged and a ferry boarded at this node.
export function stepFrom(graph: RoutingGraph, step: RouteStep): number {
  return step.forward ? graph.edgeNodeA[step.edge] : graph.edgeNodeB[step.edge];
}

// End steps are partial walks and ferry costs step with the clock, so every route clock uses this.
export function stepSeconds(
  graph: RoutingGraph,
  step: RouteStep,
  elapsedSeconds: number,
): number {
  const from = stepFrom(graph, step);
  if (step.kind === "ferry" || isTransitKind(step.kind)) {
    // Neither is walked: a ferry costs its sailing, a train the wait at exactly this point in the trip.
    return rawSeconds(graph, step.edge, from, elapsedSeconds);
  } else {
    return (
      step.lengthMeters * walkSecondsPerMeter(graph, step.edge, step.forward) +
      crossingWait(graph, step.edge, from)
    );
  }
}

export function isTransitKind(kind: EdgeKind): boolean {
  return kind === "access" || kind === "board" || kind === "ride";
}

export interface RouteStep {
  edge: number;
  forward: boolean; // traveled a -> b?
  kind: EdgeKind;
  side: SideLabel; // the stored side of the sidewalk (null for crossings/links/paths), not travel-flipped
  name: string | null; // the edge's street name, unprettified, or null
  cover: number; // 0..1, this edge's cover
  lengthMeters: number; // walked length; partial on the end edges
}

// Shares of the whole trip's time; `shade` is the sunlit part; rides and boats count as sheltered.
export interface RouteFactors {
  tree: number;
  shade: number; // sun exposure, not shade — see above
  landmark: number;
  art: number;
  highway: number;
  hill: number;
  commercial: number;
  industrial: number;
  historic: number;
  bridge: number; // the share of the walk that crosses open water on a bridge deck
  shelter: number; // what is overhead in the rain: the decked share plus the crowns over the rest
  ferry: number; // the share of the trip spent on the boat itself, the pier wait excluded
}

export interface TransitLeg {
  route: TransitRoute | null;
  boardStation: string | null;
  alightStation: string | null;
  stops: number;
  waitSeconds: number; // the platform wait plus the boarding constant
  rideSeconds: number;
  // Null with no timetable loaded, which is also a route that could not have boarded at all.
  departureSeconds: number | null;
}

// `ridesBefore` counts trains ridden before this boat, which puts it in trip order beside them.
export interface FerryLeg {
  route: string | null;
  waitSeconds: number;
  crossingSeconds: number;
  ridesBefore: number;
}

export interface RouteResult {
  path: { lats: Float64Array; lngs: Float64Array }; // stitched, end-edge partials trimmed at the snaps
  steps: RouteStep[];
  lengthMeters: number; // total trip distance, walking plus ferry and ride spans (nav-progress and the path rely on it)
  walkMeters: number; // walking-only distance, ferry and transit spans excluded — the mileage the summary shows
  travelSeconds: number; // reported ETA: sum of undiscounted raw seconds over the chosen steps
  // The platform wait and boarding plus every ride; 0 for a route that never gets on a train.
  transitSeconds: number;
  // Built here because only the search's clock knows which departure was caught.
  rides: TransitLeg[];
  // Built here for the same reason as `rides`: only the search's clock knows the pier wait.
  ferries: FerryLeg[];
  factors: RouteFactors; // each scenic attribute's share of the trip's time
  // Undivided attribute-seconds, which a card's absolute scenic score is summed from.
  factorSeconds: RouteFactors;
  start: Snap;
  dest: Snap;
}

// Last-search instrumentation, for profiling and tests.
export const routeDiagnostics = { nodesSettled: 0 };

function appendPolyline(
  lngsOut: number[],
  latsOut: number[],
  lngs: number[],
  lats: number[],
  forward: boolean,
  first: boolean,
): void {
  const count = lngs.length;
  for (let index = 0; index < count; index++) {
    const source = forward ? index : count - 1 - index;
    if (!first && index === 0) {
      continue;
    }
    lngsOut.push(lngs[source]);
    latsOut.push(lats[source]);
  }
}

function makeStep(
  graph: RoutingGraph,
  edge: number,
  forward: boolean,
  lengthMeters: number,
): RouteStep {
  return {
    edge,
    forward,
    kind: edgeKind(graph, edge),
    side: edgeSideLabel(graph, edge),
    name: edgeName(graph, edge),
    cover: edgeCover(graph, edge),
    lengthMeters,
  };
}

// Consecutive hops of one line with no wait are one boat, matching the maneuvers.
function ferryLegs(
  graph: RoutingGraph,
  steps: readonly RouteStep[],
  rides: readonly TransitLeg[],
): FerryLeg[] {
  if (!steps.some((step) => step.kind === "ferry")) {
    return [];
  }
  const legs: FerryLeg[] = [];
  let boat: FerryLeg | null = null;
  let boarded = 0; // trains ridden so far
  let elapsedSeconds = 0;
  for (const step of steps) {
    if (step.kind === "ferry") {
      const from = stepFrom(graph, step);
      const { wait, crossing } = ferrySeconds(
        graph,
        step.edge,
        from,
        elapsedSeconds,
      );
      const route =
        graph.ferries?.board(step.edge, from, elapsedSeconds)?.route ??
        edgeName(graph, step.edge);
      if (boat && wait === 0 && boat.route === route) {
        boat.crossingSeconds += crossing;
      } else {
        boat = {
          route,
          waitSeconds: wait,
          crossingSeconds: crossing,
          ridesBefore: boarded,
        };
        legs.push(boat);
      }
      elapsedSeconds += wait + crossing;
      continue;
    }
    // Anything else between two hops is a walk off the boat.
    boat = null;
    if (step.kind === "board") {
      elapsedSeconds +=
        rides[boarded]?.waitSeconds ?? stepSeconds(graph, step, elapsedSeconds);
      boarded += 1;
    } else {
      elapsedSeconds += stepSeconds(graph, step, elapsedSeconds);
    }
  }
  return legs;
}

// Walked back from the destination and reversed, since unshifting would be a shift per edge.
interface PathWalk {
  interior: number[];
  seed: number; // startA or startB, whichever the route left the start edge by
}

function walkParents(
  graph: RoutingGraph,
  parentEdge: Int32Array,
  bestDestNode: number,
): PathWalk {
  const interior: number[] = [];
  let node = bestDestNode;
  while (parentEdge[node] !== -1) {
    const edge = parentEdge[node];
    interior.push(edge);
    node = otherEnd(graph, edge, node);
  }
  interior.reverse();
  return { interior, seed: node };
}

// Taken off the parent tree, so a caller already holding the route pays nothing.
function pathSignature(
  start: Snap,
  dest: Snap,
  walk: PathWalk | null,
  bestDestNode: number,
): string {
  const ends = `${start.edge}@${start.metersFromA}>${dest.edge}@${dest.metersFromA}`;
  return walk
    ? `${ends}|${bestDestNode}:${walk.interior.join(",")}`
    : `${ends}|same`;
}

// bestDestNode is -1 with bestSameEdge for a walk along the shared edge; needs no distance array.
function reconstruct(
  graph: RoutingGraph,
  start: Snap,
  dest: Snap,
  parentEdge: Int32Array,
  bestDestNode: number,
  bestSameEdge: boolean,
  walked?: PathWalk,
): RouteResult {
  const startB = graph.edgeNodeB[start.edge];
  const startLength = graph.edgeLength[start.edge];
  const destA = graph.edgeNodeA[dest.edge];
  const destLength = graph.edgeLength[dest.edge];

  const steps: RouteStep[] = [];
  const lngsOut: number[] = [];
  const latsOut: number[] = [];

  if (bestSameEdge) {
    const forward = start.metersFromA <= dest.metersFromA;
    const low = Math.min(start.metersFromA, dest.metersFromA);
    const high = Math.max(start.metersFromA, dest.metersFromA);
    steps.push(makeStep(graph, start.edge, forward, high - low));
    const { lngs, lats } = subEdgePath(graph, start.edge, low, high);
    appendPolyline(lngsOut, latsOut, lngs, lats, forward, true);
  } else {
    const { interior, seed } =
      walked ?? walkParents(graph, parentEdge, bestDestNode);

    const startForward = seed === startB;
    const startWalked = startForward
      ? startLength - start.metersFromA
      : start.metersFromA;
    const startPiece = startForward
      ? subEdgePath(graph, start.edge, start.metersFromA, startLength)
      : subEdgePath(graph, start.edge, 0, start.metersFromA);
    steps.push(makeStep(graph, start.edge, startForward, startWalked));
    appendPolyline(
      lngsOut,
      latsOut,
      startPiece.lngs,
      startPiece.lats,
      startForward,
      true,
    );

    let previous = seed;
    for (const edge of interior) {
      const forward = graph.edgeNodeA[edge] === previous;
      steps.push(makeStep(graph, edge, forward, graph.edgeLength[edge]));
      const { lngs, lats } = edgePath(graph, edge);
      appendPolyline(
        lngsOut,
        latsOut,
        Array.from(lngs),
        Array.from(lats),
        forward,
        false,
      );
      previous = otherEnd(graph, edge, previous);
    }

    const destForward = bestDestNode === destA;
    const destWalked = destForward
      ? dest.metersFromA
      : destLength - dest.metersFromA;
    const destPiece = destForward
      ? subEdgePath(graph, dest.edge, 0, dest.metersFromA)
      : subEdgePath(graph, dest.edge, dest.metersFromA, destLength);
    steps.push(makeStep(graph, dest.edge, destForward, destWalked));
    appendPolyline(
      lngsOut,
      latsOut,
      destPiece.lngs,
      destPiece.lats,
      destForward,
      false,
    );
  }

  let lengthMeters = 0;
  let walkLengthMeters = 0; // the distance actually walked: ferry and rail spans excluded
  let travelSeconds = 0; // undiscounted ETA: walked time by span, ferry and rail time by the clock
  let transitSeconds = 0; // the rail share of it: waiting on the platform and riding
  const rides: TransitLeg[] = [];
  let leg: TransitLeg | null = null; // the train currently being ridden, while one is
  // Raw seconds at each step's start, so the sun matches what routing costed the edge against.
  let elapsedSeconds = 0;
  // Normalized by the field's peak so full sun at peak reads ~100%; 0 disables the sun chip.
  const shadeMaxAbs = graph.shade ? graph.shade.maxAbs : 0;
  const sums: RouteFactors = {
    tree: 0,
    shade: 0,
    landmark: 0,
    art: 0,
    highway: 0,
    hill: 0,
    commercial: 0,
    industrial: 0,
    historic: 0,
    bridge: 0,
    shelter: 0,
    ferry: 0,
  };
  for (const step of steps) {
    lengthMeters += step.lengthMeters;
    if (step.kind === "ferry" || isTransitKind(step.kind)) {
      const seconds = stepSeconds(graph, step, elapsedSeconds);
      if (step.kind === "board") {
        // The departure the search costed, so the leg names the train the reported time allowed for.
        const departure =
          graph.transit?.board(
            laneOf(graph, step.edge),
            stopIndexOf(graph, step.edge),
            elapsedSeconds,
          ) ?? null;
        leg = {
          route: routeOf(graph, step.edge),
          boardStation: stationName(graph, stepFrom(graph, step)),
          alightStation: null,
          stops: 0,
          waitSeconds: seconds,
          rideSeconds: 0,
          departureSeconds: departure?.departure ?? null,
        };
        rides.push(leg);
      } else if (
        step.kind === "ride" &&
        leg &&
        !isStayAboard(graph, step.edge)
      ) {
        // Staying aboard is internal to the boarding: no stop and no seconds of its own.
        leg.stops += 1;
        leg.rideSeconds += seconds;
      } else if (step.kind === "access" && leg) {
        leg.alightStation = stationName(
          graph,
          otherEnd(graph, step.edge, stepFrom(graph, step)),
        );
        leg = null;
      }
      travelSeconds += seconds;
      elapsedSeconds += seconds;
      // Station walks count as walking, and are out in the weather unlike the platform and train.
      if (step.kind === "board" || step.kind === "ride") {
        transitSeconds += seconds;
        sums.shelter += seconds;
      } else if (step.kind === "ferry") {
        // A boat has a cabin and a pier has none, so the wait is time on a pier.
        const crossing = ferrySeconds(
          graph,
          step.edge,
          stepFrom(graph, step),
          elapsedSeconds - seconds,
        ).crossing;
        sums.shelter += crossing;
        sums.ferry += crossing;
      }
    } else {
      const { edge, lengthMeters: stepMeters } = step;
      walkLengthMeters += stepMeters;
      const seconds = stepSeconds(graph, step, elapsedSeconds);
      sums.tree += step.cover * seconds;
      sums.landmark += (graph.edgeLandmark[edge] / 255) * seconds;
      sums.art += (graph.edgeArt[edge] / 255) * seconds;
      sums.highway += (graph.edgeHighway[edge] / 255) * seconds;
      sums.hill += hillFractionOf(graph, edge) * seconds;
      sums.commercial += (graph.edgeCommercial[edge] / 255) * seconds;
      sums.industrial += (graph.edgeIndustrial[edge] / 255) * seconds;
      sums.historic += (graph.edgeHistoric[edge] / 255) * seconds;
      sums.bridge += (graph.edgeBridge[edge] / 255) * seconds;
      const shed = edgeShed(graph, edge);
      // The same attribute the shelter discount prices, so the chip and the cost agree.
      sums.shelter += shelterAttrOf(graph, edge, shed) * seconds;
      // Reads the deck's whole coverage, not its sun-slid share: up to 0.18 points too shaded.
      const shadeAttr = shadeAttrOf(graph, edge, elapsedSeconds, shed);
      sums.shade += Math.max(0, shadeAttr) * seconds;
      travelSeconds += seconds;
      elapsedSeconds += seconds;
    }
  }
  const factorSeconds: RouteFactors = {
    ...sums,
    shade: shadeMaxAbs > 0 ? sums.shade / shadeMaxAbs : 0,
  };
  const share = (total: number): number =>
    travelSeconds > 0 ? total / travelSeconds : 0;

  return {
    path: {
      lats: Float64Array.from(latsOut),
      lngs: Float64Array.from(lngsOut),
    },
    steps,
    lengthMeters,
    walkMeters: walkLengthMeters,
    travelSeconds,
    transitSeconds,
    rides,
    ferries: ferryLegs(graph, steps, rides),
    factorSeconds,
    factors: {
      tree: share(factorSeconds.tree),
      shade: share(factorSeconds.shade),
      landmark: share(factorSeconds.landmark),
      art: share(factorSeconds.art),
      highway: share(factorSeconds.highway),
      hill: share(factorSeconds.hill),
      commercial: share(factorSeconds.commercial),
      industrial: share(factorSeconds.industrial),
      historic: share(factorSeconds.historic),
      bridge: share(factorSeconds.bridge),
      shelter: share(factorSeconds.shelter),
      ferry: share(factorSeconds.ferry),
    },
    start,
    dest,
  };
}

// Keyed to a graph and a departure; a plan is sixteen searches over one.
export interface SearchReuse {
  labels?: SearchLabels;
  // Infinity where the backward search did not reach. See `networkMetersTo`.
  networkMeters?: Float32Array;
  // A plan gets the same path back at most of its weight vectors, so the repeats cost no stitching.
  results?: Map<string, RouteResult>;
}

// A fresh set is 11 MB in New York; clearing only touched nodes makes reuse cheaper than reallocation.
export class SearchLabels {
  readonly distance: Float64Array;
  readonly elapsed: Float64Array;
  readonly parentEdge: Int32Array;
  readonly heuristic: Float64Array;
  private readonly touched: number[] = [];

  constructor(readonly nodeCount: number) {
    this.distance = new Float64Array(nodeCount).fill(Number.POSITIVE_INFINITY);
    this.elapsed = new Float64Array(nodeCount);
    this.parentEdge = new Int32Array(nodeCount).fill(-1);
    this.heuristic = new Float64Array(nodeCount).fill(-1);
  }

  // Touched exactly when first given a finite distance, the only way it gets a parent or estimate.
  touch(node: number): void {
    this.touched.push(node);
  }

  reset(): void {
    for (const node of this.touched) {
      this.distance[node] = Number.POSITIVE_INFINITY;
      this.elapsed[node] = 0;
      this.parentEdge[node] = -1;
      this.heuristic[node] = -1;
    }
    this.touched.length = 0;
  }
}

// A tighter lower bound than the straight line; ungated, so one table serves every weight vector.
export function networkMetersTo(
  graph: RoutingGraph,
  dest: Snap,
  radiusMeters = Number.POSITIVE_INFINITY,
): Float32Array {
  const meters = new Float32Array(graph.nodeCount).fill(
    Number.POSITIVE_INFINITY,
  );
  const destA = graph.edgeNodeA[dest.edge];
  const destB = graph.edgeNodeB[dest.edge];
  const settled = new Uint8Array(graph.nodeCount);
  const heap = new NodeHeap(1024);
  meters[destA] = dest.metersFromA;
  meters[destB] = graph.edgeLength[dest.edge] - dest.metersFromA;
  heap.push(meters[destA], destA);
  heap.push(meters[destB], destB);
  while (heap.length > 0) {
    const key = heap.peekKey();
    const node = heap.pop();
    if (key > meters[node] || key > radiusMeters) {
      continue;
    }
    settled[node] = 1;
    for (let slot = graph.csr[node]; slot < graph.csr[node + 1]; slot++) {
      const edge = graph.adjacency[slot];
      const neighbor = otherEnd(graph, edge, node);
      const reached = key + graph.edgeLength[edge];
      if (reached < meters[neighbor]) {
        meters[neighbor] = reached;
        // Push the stored float, not the double, or the key sits above its label and reads as stale.
        heap.push(meters[neighbor], neighbor);
      }
    }
  }
  // A node the cap stopped short of holds an upper bound, so it falls back to the straight line.
  for (let node = 0; node < meters.length; node += 1) {
    if (settled[node] === 0) {
      meters[node] = Number.POSITIVE_INFINITY;
    }
  }
  return meters;
}

export function findRoute(
  graph: RoutingGraph,
  start: Snap,
  dest: Snap,
  weights: RouteWeights,
  reuse?: SearchReuse,
): RouteResult | null {
  const nodeCount = graph.nodeCount;
  const labels =
    reuse?.labels?.nodeCount === nodeCount
      ? reuse.labels
      : new SearchLabels(nodeCount);
  labels.reset();
  const { distance, parentEdge, heuristic } = labels;
  // Actual raw seconds, not weighted cost, so the shade field advances the sun by real walking time.
  const elapsed = labels.elapsed;

  const walkCoeff = walkSecondsCoeff(graph, weights);
  const credit = ferryCredit(graph, weights) + transitCredit(graph, weights);
  const floor = heuristicFloor(graph, weights);
  const network = reuse?.networkMeters;
  const heuristicOf = (node: number): number => {
    if (heuristic[node] < 0) {
      const alongNetwork = network?.[node] ?? Number.POSITIVE_INFINITY;
      const meters = Number.isFinite(alongNetwork)
        ? alongNetwork
        : haversineMeters(
            graph.originLat + graph.nodeQy[node] * graph.scale,
            graph.originLng + graph.nodeQx[node] * graph.scale,
            dest.point.lat,
            dest.point.lng,
          );
      heuristic[node] = Math.max(
        0,
        walkCoeff * meters - credit,
        floor * meters,
      );
    }
    return heuristic[node];
  };

  // The start edge's halves are walked in opposite directions, so a hill prices them differently.
  const startA = graph.edgeNodeA[start.edge];
  const startB = graph.edgeNodeB[start.edge];
  const startMultiplier = edgeMultiplier(graph, start.edge, weights);
  const startSecondsToA = walkSecondsPerMeter(graph, start.edge, false);
  const startSecondsToB = walkSecondsPerMeter(graph, start.edge, true);
  const startPerMeterToA = startMultiplier * startSecondsToA;
  const startPerMeterToB = startMultiplier * startSecondsToB;
  const startLength = graph.edgeLength[start.edge];

  const destA = graph.edgeNodeA[dest.edge];
  const destB = graph.edgeNodeB[dest.edge];
  const destLength = graph.edgeLength[dest.edge];
  // The dest edge is walked last, so its shade is the sun at arrival through whichever endpoint.
  const destPerMeterAt = (node: number): number =>
    edgeMultiplier(graph, dest.edge, weights, elapsed[node]) *
    walkSecondsPerMeter(graph, dest.edge, node === destA);

  let bestTotal = Number.POSITIVE_INFINITY;
  let bestDestNode = -1; // the edge endpoint the winning route reaches the dest edge through
  let bestSameEdge = false;
  const consider = (total: number, node: number, sameEdge: boolean): void => {
    if (total < bestTotal) {
      bestTotal = total;
      bestDestNode = node;
      bestSameEdge = sameEdge;
    }
  };

  if (start.edge === dest.edge) {
    const forward = dest.metersFromA > start.metersFromA;
    consider(
      Math.abs(dest.metersFromA - start.metersFromA) *
        (forward ? startPerMeterToB : startPerMeterToA),
      -1,
      true,
    );
  }

  const heap = new NodeHeap(1024);
  distance[startA] = start.metersFromA * startPerMeterToA;
  distance[startB] = (startLength - start.metersFromA) * startPerMeterToB;
  elapsed[startA] = start.metersFromA * startSecondsToA;
  elapsed[startB] = (startLength - start.metersFromA) * startSecondsToB;
  labels.touch(startA);
  labels.touch(startB);
  heap.push(distance[startA] + heuristicOf(startA), startA);
  heap.push(distance[startB] + heuristicOf(startB), startB);

  // One record for the whole search, so relaxing allocates nothing.
  const priced: EdgeSeconds = { effective: 0, raw: 0 };
  let settled = 0;
  while (heap.length > 0) {
    const key = heap.peekKey();
    if (key >= bestTotal) {
      break;
    }
    const node = heap.pop();
    // Lazy deletion: a stale entry has a key above the node's now-final f-value.
    if (key > distance[node] + heuristicOf(node)) {
      continue;
    }
    settled += 1;

    if (node === destA) {
      consider(
        distance[destA] + dest.metersFromA * destPerMeterAt(destA),
        destA,
        false,
      );
    }
    if (node === destB) {
      consider(
        distance[destB] +
          (destLength - dest.metersFromA) * destPerMeterAt(destB),
        destB,
        false,
      );
    }

    for (let slot = graph.csr[node]; slot < graph.csr[node + 1]; slot++) {
      const edge = graph.adjacency[slot];
      // A platform nobody may board is a dead end, so barring board edges cuts off the rest of transit.
      const kind = edgeKind(graph, edge);
      if (
        (!weights.allowFerries && kind === "ferry") ||
        (!weights.allowTransit && kind === "board")
      ) {
        continue;
      }
      const neighbor = otherEnd(graph, edge, node);
      edgeSeconds(graph, edge, weights, elapsed[node], node, priced);
      const relaxed = distance[node] + priced.effective;
      // A cost-only label per node drops a costlier path that catches an earlier train: good, not optimal.
      if (relaxed < distance[neighbor]) {
        if (distance[neighbor] === Number.POSITIVE_INFINITY) {
          labels.touch(neighbor);
        }
        distance[neighbor] = relaxed;
        elapsed[neighbor] = elapsed[node] + priced.raw;
        parentEdge[neighbor] = edge;
        heap.push(relaxed + heuristicOf(neighbor), neighbor);
      }
    }
  }

  routeDiagnostics.nodesSettled = settled;
  if (bestTotal === Number.POSITIVE_INFINITY) {
    return null;
  }

  const walked = bestSameEdge
    ? null
    : walkParents(graph, parentEdge, bestDestNode);
  const signature = pathSignature(start, dest, walked, bestDestNode);
  const known = reuse?.results?.get(signature);
  if (known) {
    return known;
  }
  const result = reconstruct(
    graph,
    start,
    dest,
    parentEdge,
    bestDestNode,
    bestSameEdge,
    walked ?? undefined,
  );
  reuse?.results?.set(signature, result);
  return result;
}

// Never reopens a closed node, so exact only with a consistent heuristic; start drags run the sun back.
export class RouteSolver {
  private readonly graph: RoutingGraph;
  private readonly source: Snap;
  private readonly weights: RouteWeights;
  private readonly sunAnchorSeconds: number; // forward wall-clock seconds since departure AT the source
  private readonly sunDirection: number; // +1 counts the sun forward from the source, -1 backward

  private readonly distance: Float64Array; // best-known g (effective seconds) from source
  private readonly elapsed: Float64Array; // raw walking seconds from source along the min-cost path
  private readonly parentEdge: Int32Array;
  private readonly closed: Uint8Array; // 1 once a node has been settled; never reopened
  private readonly reached: number[] = []; // every node ever given a finite distance

  private readonly sourceA: number;
  private readonly sourceB: number;
  // The two halves are walked in opposite directions, so a hill takes them at different speeds.
  private readonly sourcePerMeterToA: number;
  private readonly sourcePerMeterToB: number;
  private readonly sourceLength: number;

  constructor(
    graph: RoutingGraph,
    source: Snap,
    weights: RouteWeights,
    sunAnchorSeconds = 0,
    sunDirection: 1 | -1 = 1,
  ) {
    this.graph = graph;
    this.source = source;
    this.weights = weights;
    this.sunAnchorSeconds = sunAnchorSeconds;
    this.sunDirection = sunDirection;

    const nodeCount = graph.nodeCount;
    this.distance = new Float64Array(nodeCount).fill(Number.POSITIVE_INFINITY);
    this.elapsed = new Float64Array(nodeCount);
    this.parentEdge = new Int32Array(nodeCount).fill(-1);
    this.closed = new Uint8Array(nodeCount);

    this.sourceA = graph.edgeNodeA[source.edge];
    this.sourceB = graph.edgeNodeB[source.edge];
    // Priced at the source's wall-clock time: departure for a dest drag, arrival for a start drag.
    const sourceMultiplier = edgeMultiplier(
      graph,
      source.edge,
      weights,
      Math.max(0, sunAnchorSeconds),
    );
    const sourceSecondsToA = walkSecondsPerMeter(graph, source.edge, false);
    const sourceSecondsToB = walkSecondsPerMeter(graph, source.edge, true);
    this.sourcePerMeterToA = sourceMultiplier * sourceSecondsToA;
    this.sourcePerMeterToB = sourceMultiplier * sourceSecondsToB;
    this.sourceLength = graph.edgeLength[source.edge];

    this.distance[this.sourceA] = source.metersFromA * this.sourcePerMeterToA;
    this.distance[this.sourceB] =
      (this.sourceLength - source.metersFromA) * this.sourcePerMeterToB;
    // Anchored at the source, so every reused node's raw time is stable across dest drags.
    this.elapsed[this.sourceA] = source.metersFromA * sourceSecondsToA;
    this.elapsed[this.sourceB] =
      (this.sourceLength - source.metersFromA) * sourceSecondsToB;
    this.reached.push(this.sourceA, this.sourceB);
  }

  // Floored at departure.
  private sunElapsed(node: number): number {
    const seconds =
      this.sunAnchorSeconds + this.sunDirection * this.elapsed[node];
    return seconds > 0 ? seconds : 0;
  }

  solveApprox(dest: Snap): RouteResult | null {
    const graph = this.graph;
    const destA = graph.edgeNodeA[dest.edge];
    const destB = graph.edgeNodeB[dest.edge];
    const destLength = graph.edgeLength[dest.edge];
    const destPerMeterAt = (node: number): number =>
      edgeMultiplier(graph, dest.edge, this.weights, this.sunElapsed(node)) *
      walkSecondsPerMeter(graph, dest.edge, node === destA);

    let bestTotal = Number.POSITIVE_INFINITY;
    let bestDestNode = -1;
    let bestSameEdge = false;
    const consider = (total: number, node: number, sameEdge: boolean): void => {
      if (total < bestTotal) {
        bestTotal = total;
        bestDestNode = node;
        bestSameEdge = sameEdge;
      }
    };

    if (this.source.edge === dest.edge) {
      const forward = dest.metersFromA > this.source.metersFromA;
      consider(
        Math.abs(dest.metersFromA - this.source.metersFromA) *
          (forward ? this.sourcePerMeterToB : this.sourcePerMeterToA),
        -1,
        true,
      );
    }

    // A merely-reached endpoint's distance is tentative and a resumed search may improve it.
    if (this.closed[destA] === 1) {
      consider(
        this.distance[destA] + dest.metersFromA * destPerMeterAt(destA),
        destA,
        false,
      );
    }
    if (this.closed[destB] === 1) {
      consider(
        this.distance[destB] +
          (destLength - dest.metersFromA) * destPerMeterAt(destB),
        destB,
        false,
      );
    }

    if (bestTotal < Number.POSITIVE_INFINITY) {
      return reconstruct(
        graph,
        this.source,
        dest,
        this.parentEdge,
        bestDestNode,
        bestSameEdge,
      );
    }

    // Built after the fast path so a settled-dest drag frame allocates nothing.
    const walkCoeff = walkSecondsCoeff(graph, this.weights);
    const credit =
      ferryCredit(graph, this.weights) + transitCredit(graph, this.weights);
    const floor = heuristicFloor(graph, this.weights);
    const heuristicCache = new Float64Array(graph.nodeCount).fill(-1);
    const heuristicOf = (node: number): number => {
      if (heuristicCache[node] < 0) {
        const meters = haversineMeters(
          graph.originLat + graph.nodeQy[node] * graph.scale,
          graph.originLng + graph.nodeQx[node] * graph.scale,
          dest.point.lat,
          dest.point.lng,
        );
        heuristicCache[node] = Math.max(
          0,
          walkCoeff * meters - credit,
          floor * meters,
        );
      }
      return heuristicCache[node];
    };

    const priced: EdgeSeconds = { effective: 0, raw: 0 };
    const heap = new NodeHeap(1024);
    for (const id of this.reached) {
      if (this.closed[id] === 0) {
        heap.push(this.distance[id] + heuristicOf(id), id);
      }
    }

    while (heap.length > 0) {
      const key = heap.peekKey();
      const node = heap.pop();
      if (this.closed[node] === 1) {
        continue;
      }
      // Lazy deletion: a stale entry has a key above the node's now-final f-value.
      if (key > this.distance[node] + heuristicOf(node)) {
        continue;
      }
      this.closed[node] = 1;

      if (node === destA) {
        consider(
          this.distance[destA] + dest.metersFromA * destPerMeterAt(destA),
          destA,
          false,
        );
      }
      if (node === destB) {
        consider(
          this.distance[destB] +
            (destLength - dest.metersFromA) * destPerMeterAt(destB),
          destB,
          false,
        );
      }
      // Expand before the goal test, so a later drag can still route through this dest endpoint.
      for (let slot = graph.csr[node]; slot < graph.csr[node + 1]; slot++) {
        const edge = graph.adjacency[slot];
        const kind = edgeKind(graph, edge);
        if (
          (!this.weights.allowFerries && kind === "ferry") ||
          (!this.weights.allowTransit && kind === "board")
        ) {
          continue;
        }
        const neighbor = otherEnd(graph, edge, node);
        if (this.closed[neighbor] === 1) {
          continue;
        }
        edgeSeconds(
          graph,
          edge,
          this.weights,
          this.sunElapsed(node),
          node,
          priced,
        );
        const relaxed = this.distance[node] + priced.effective;
        if (relaxed < this.distance[neighbor]) {
          if (this.distance[neighbor] === Number.POSITIVE_INFINITY) {
            this.reached.push(neighbor);
          }
          this.distance[neighbor] = relaxed;
          this.elapsed[neighbor] = this.elapsed[node] + priced.raw;
          this.parentEdge[neighbor] = edge;
          heap.push(relaxed + heuristicOf(neighbor), neighbor);
        }
      }

      // Approximate goal test: stop once a dest endpoint has settled.
      if (bestTotal < Number.POSITIVE_INFINITY) {
        return reconstruct(
          graph,
          this.source,
          dest,
          this.parentEdge,
          bestDestNode,
          bestSameEdge,
        );
      }
    }

    return bestTotal < Number.POSITIVE_INFINITY
      ? reconstruct(
          graph,
          this.source,
          dest,
          this.parentEdge,
          bestDestNode,
          bestSameEdge,
        )
      : null;
  }
}

// Each step costed at the clock time it's reached, because a ferry's cost steps with the clock.
function routeSeconds(
  graph: RoutingGraph,
  steps: readonly RouteStep[],
): number {
  let elapsed = 0;
  for (const step of steps) {
    elapsed += stepSeconds(graph, step, elapsed);
  }
  return elapsed;
}
// The ETA is re-run over the flipped steps, since walking a hill the other way climbs what it dropped.
export function reverseResult(
  graph: RoutingGraph,
  result: RouteResult,
): RouteResult {
  const steps = result.steps
    .slice()
    .reverse()
    .map((step) => ({ ...step, forward: !step.forward }));
  const lats = result.path.lats.slice().reverse();
  const lngs = result.path.lngs.slice().reverse();
  return {
    path: { lats, lngs },
    steps,
    lengthMeters: result.lengthMeters,
    walkMeters: result.walkMeters,
    travelSeconds: routeSeconds(graph, steps),
    transitSeconds: result.transitSeconds,
    // Only right because the one caller, a start drag, bars transit, so there are none to flip.
    rides: result.rides,
    // Re-read off the flipped steps: the boat the other way sails at another time from the other pier.
    ferries: ferryLegs(graph, steps, result.rides),
    factors: result.factors,
    factorSeconds: result.factorSeconds,
    start: result.dest,
    dest: result.start,
  };
}

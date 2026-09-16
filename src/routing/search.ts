// A* over the routing graph with virtual start/dest points sitting partway along their snapped
// edges. Cost is effective seconds (raw travel time times a clipped discount): a shaded metre costs
// less at high tree weight, a ferry costs its discounted crossing time, and a train costs its wait
// and ride at the transit penalty. The straight-line heuristic scales distance by the least seconds
// a walked metre can cost, then subtracts a bounded ferry credit (the two best ferry shortcuts) and
// the transit credit (every ride's shortcut), never falling below what the cheapest metre of the
// network costs — a lower bound on remaining cost that keeps the search admissible. The heap allows
// node reopening (no closed set), so admissible suffices for optimality even though those credits
// make the heuristic inconsistent.

import {
  crossingWait,
  edgeCover,
  edgeMultiplier,
  edgeShed,
  effSeconds,
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
  walkSpeedOn,
} from "./cost";
import {
  type EdgeKind,
  edgeKind,
  edgeName,
  edgePath,
  edgeSideLabel,
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

// The node a step is entered by, which its direction fixes: the crossing wait is charged there, and
// a ferry is boarded there.
export function stepFrom(graph: RoutingGraph, step: RouteStep): number {
  return step.forward ? graph.edgeNodeA[step.edge] : graph.edgeNodeB[step.edge];
}

// The raw seconds one route STEP takes, reached `elapsedSeconds` into the trip. Not the same as
// `rawSeconds`, which prices a whole edge: the first and last steps are partial walks along theirs,
// so a step is charged its own `lengthMeters`. Everything that runs a clock over the finished route
// — the ETA summary and the directions — has to use this one, because a ferry's cost is a step
// function of the clock and two clocks a minute apart can board different boats.
export function stepSeconds(
  graph: RoutingGraph,
  step: RouteStep,
  elapsedSeconds: number,
): number {
  const from = stepFrom(graph, step);
  if (step.kind === "ferry" || isTransitKind(step.kind)) {
    // Neither is walked, so neither is charged by the step's own length: a ferry's cost is its
    // sailing and a train's is the wait the timetable gives it at exactly this point in the trip.
    return rawSeconds(graph, step.edge, from, elapsedSeconds);
  } else {
    return (
      step.lengthMeters / walkSpeedOn(graph, step.edge, step.forward) +
      crossingWait(graph, step.edge, from)
    );
  }
}

// The three kinds no one walks: into a station, onto a train, and along the line.
export function isTransitKind(kind: EdgeKind): boolean {
  return kind === "access" || kind === "board" || kind === "ride";
}

export interface RouteStep {
  edge: number;
  forward: boolean; // travelled a -> b?
  kind: EdgeKind;
  side: SideLabel; // the stored side of the sidewalk (null for crossings/links/paths), not travel-flipped
  name: string | null; // the edge's street name, unprettified, or null
  cover: number; // 0..1, this edge's cover
  lengthMeters: number; // walked length; partial on the end edges
}

// Each scenic attribute's share of the WHOLE trip's time, keyed to match the panel's slider factors.
// Each is 0..1: an attribute earns the seconds spent walking under it, and the total is divided by
// the trip's own seconds — so a route that rides the subway half the way shows half the trees it
// walks under, which is what a share of the trip means. `shade` is *sun* exposure (the positive, i.e.
// sunlit, part of the signed shade attribute, normalized by the field's peak intensity so a trip
// walked entirely in peak sun reads ~100%), to contrast with the trees' canopy. The summary renders
// a chip per factor.
//
// A ride and a crossing have none of these attributes — nothing overhead is a tree — save `shelter`,
// which they have outright: waiting on the platform and riding count as covered, and so does a ferry
// crossing, since a boat has a cabin. The walk in and out of a station, and the wait on the pier,
// are open sky. The boat is the exception twice over: the crossing itself is the `ferry` attribute.
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
  shelter: number; // what is overhead in the rain: the decked share plus the crowns over the rest
  ferry: number; // the share of the trip spent on the boat itself, the pier wait excluded
}

// One boarding: the line, where it was got on and off, and the minutes it cost.
export interface TransitLeg {
  route: TransitRoute | null;
  boardStation: string | null;
  alightStation: string | null;
  stops: number;
  waitSeconds: number; // the platform wait plus the boarding constant
  rideSeconds: number;
  // The caught train's departure, seconds from midnight of the routed day, or null with no timetable
  // loaded — which is also a route that could not have boarded at all.
  departureSeconds: number | null;
}

// One boat boarded: the line the timetable put you on, the wait on the pier for it and the crossing
// itself. `ridesBefore` counts the trains ridden before this boat, which is what puts it in trip
// order beside them — a card names a trip's legs in the order they are taken.
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
  // Of that ETA, the seconds spent on rail: the platform wait and boarding plus every ride. What a
  // card reports as "12 min on the A"; 0 for a route that never gets on a train.
  transitSeconds: number;
  // One entry per train boarded, in trip order. Built here because only the search's own clock knows
  // which departure was caught — the page has no timetable to ask, so a card or a maneuver that says
  // "the 3:42" is saying what this recorded.
  rides: TransitLeg[];
  // One entry per boat boarded, in trip order, for the same reason `rides` is built here: the wait
  // on the pier is the one the search's own clock found, and nothing downstream can ask again.
  ferries: FerryLeg[];
  factors: RouteFactors; // each scenic attribute's share of the trip's time
  // The same sums before they are divided: attribute-seconds, which is what a card's absolute
  // scenic score is summed from — half a mile of trees is worth half a mile of trees.
  factorSeconds: RouteFactors;
  start: Snap;
  dest: Snap;
}

// Last-search instrumentation, for profiling and tests. Not part of the route itself.
export const routeDiagnostics = { nodesSettled: 0 };

// Append a step's polyline to the running path, dropping the shared junction vertex except on the
// very first step.
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

// The boats an oriented step list boards, in trip order. A line calls at several piers and each
// pier-to-pier hop is its own edge, but a walker boards once: a hop with nothing to wait for on the
// same line is the same boat, which is the rule the maneuvers merge on too. A board step's seconds
// come off the leg the search recorded rather than out of the timetable, so this runs the same clock
// the directions do.
function ferryLegs(
  graph: RoutingGraph,
  steps: readonly RouteStep[],
  rides: readonly TransitLeg[],
): FerryLeg[] {
  // Most routes take no boat at all, and the clock below is a pass over every step of the walk.
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
    // Anything else between two hops is a walk off the boat, so the next one is a new boat.
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

// Build the oriented route from a settled search: the parent-edge tree, the dest endpoint the
// route reaches through (bestDestNode, or -1 with bestSameEdge for a walk along the shared edge),
// and the two snaps. Reads only the parent tree and graph geometry — no distance array needed.
function reconstruct(
  graph: RoutingGraph,
  start: Snap,
  dest: Snap,
  parentEdge: Int32Array,
  bestDestNode: number,
  bestSameEdge: boolean,
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
    // Interior edges from the start-edge endpoint we depart through to the dest-edge endpoint.
    const interior: number[] = [];
    let node = bestDestNode;
    while (parentEdge[node] !== -1) {
      const edge = parentEdge[node];
      interior.unshift(edge);
      node = otherEnd(graph, edge, node);
    }
    const seed = node; // startA or startB, whichever the route left the start edge by

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
  // Raw seconds elapsed at the *start* of each step, so the sun sampled for the sun-exposure mean matches
  // what routing costed the edge against (advances during walked spans and ferry crossings alike).
  let elapsedSeconds = 0;
  // Normalize sun exposure by the field's peak intensity, so a fully-sunlit-at-peak-sun edge reads ~100%
  // rather than being scaled down by the sun's (elevation-dependent) intensity. 0 disables the sun chip.
  const shadeMaxAbs = graph.shade ? graph.shade.maxAbs : 0;
  // Attribute-seconds: every factor's attribute over the seconds spent on it, which both the shares
  // and the absolute score are taken from.
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
    shelter: 0,
    ferry: 0,
  };
  for (const step of steps) {
    lengthMeters += step.lengthMeters;
    if (step.kind === "ferry" || isTransitKind(step.kind)) {
      const seconds = stepSeconds(graph, step, elapsedSeconds);
      if (step.kind === "board") {
        // The departure the search itself costed this edge against, so the leg names the train the
        // reported time allowed for and not the one a second clock would have caught.
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
      } else if (step.kind === "ride" && leg) {
        leg.stops += 1;
        leg.rideSeconds += seconds;
      } else if (step.kind === "access" && leg) {
        // The walk back up to a station ends the leg, and names the stop it was got off at.
        leg.alightStation = stationName(
          graph,
          otherEnd(graph, step.edge, stepFrom(graph, step)),
        );
        leg = null;
      }
      travelSeconds += seconds;
      elapsedSeconds += seconds;
      // The walk in and out of a station is time on the trip but not time on the train, so it is
      // reported with the walking rather than with the ride — and it is out in the weather, where
      // the platform and the train are not.
      if (step.kind === "board" || step.kind === "ride") {
        transitSeconds += seconds;
        sums.shelter += seconds;
      } else if (step.kind === "ferry") {
        // A boat has a cabin and a pier has none, which is the split the ferry cost prices too, and
        // the same split the crossing is scenery over: the wait is time on a pier.
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
      const shed = edgeShed(graph, edge);
      // The same attribute the shelter discount is priced off, so the chip and the cost agree about
      // what is overhead.
      sums.shelter += shelterAttrOf(graph, edge, shed) * seconds;
      // Sun exposure only: the positive (sunlit) part of the signed shade attribute at this point in the
      // walk, with a deck composited in whether or not scaffolding is barred, which is what the cost
      // model does too. It reads the deck's whole coverage rather than the share the sun has not slid
      // off it, so a decked stretch reads a little more shaded here than the router costed it — worst
      // measured 0.18 points of a route's exposure. 0 when shaded, at night, or with no artifact loaded.
      const shadeAttr = shadeAttrOf(graph, edge, elapsedSeconds, shed);
      sums.shade += Math.max(0, shadeAttr) * seconds;
      travelSeconds += seconds;
      elapsedSeconds += seconds;
    }
  }
  // The sun-exposure sum is the one that is not already 0..1 per second; the rest are attributes.
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
      shelter: share(factorSeconds.shelter),
      ferry: share(factorSeconds.ferry),
    },
    start,
    dest,
  };
}

export function findRoute(
  graph: RoutingGraph,
  start: Snap,
  dest: Snap,
  weights: RouteWeights,
): RouteResult | null {
  const nodeCount = graph.nodeCount;
  const distance = new Float64Array(nodeCount).fill(Number.POSITIVE_INFINITY);
  // Raw walking seconds along each node's min-cost path — the ACTUAL time elapsed, not the weighted
  // cost, so the shade field advances the sun by how long the walk really takes to get here.
  const elapsed = new Float64Array(nodeCount);
  const parentEdge = new Int32Array(nodeCount).fill(-1);
  const heuristic = new Float64Array(nodeCount).fill(-1);

  // The walking floor (seconds per straight-line metre), the bounded ferry credit and the floor that
  // keeps the credits from flattening the estimate all depend on the weights, so they are computed
  // once here and reused for every node's estimate.
  const walkCoeff = walkSecondsCoeff(graph, weights);
  const credit = ferryCredit(graph, weights) + transitCredit(graph, weights);
  const floor = heuristicFloor(graph, weights);
  const heuristicOf = (node: number): number => {
    if (heuristic[node] < 0) {
      const meters = haversineMeters(
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

  // The snap edges are always walking edges (ferries are excluded from the snap index), so their
  // per-metre cost is the walking multiplier over speed — effective seconds, matching the interior.
  // The two halves of the start edge are walked in OPPOSITE directions — the walk out to node a runs
  // b -> a — so a hill on it takes them at different speeds.
  const startA = graph.edgeNodeA[start.edge];
  const startB = graph.edgeNodeB[start.edge];
  const startMultiplier = edgeMultiplier(graph, start.edge, weights);
  const startSpeedToA = walkSpeedOn(graph, start.edge, false);
  const startSpeedToB = walkSpeedOn(graph, start.edge, true);
  const startPerMeterToA = startMultiplier / startSpeedToA;
  const startPerMeterToB = startMultiplier / startSpeedToB;
  const startLength = graph.edgeLength[start.edge];

  const destA = graph.edgeNodeA[dest.edge];
  const destB = graph.edgeNodeB[dest.edge];
  const destLength = graph.edgeLength[dest.edge];
  // The dest edge is a partial walked at the very end, so its shade is the sun at the arrival time —
  // the elapsed raw seconds of the endpoint the route reaches it through. Arriving through node a
  // walks it a -> b, through node b the other way.
  const destPerMeterAt = (node: number): number =>
    edgeMultiplier(graph, dest.edge, weights, elapsed[node]) /
    walkSpeedOn(graph, dest.edge, node === destA);

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

  // Walking directly along the shared edge, never leaving it, is a candidate when both snaps sit
  // on the same edge.
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
  // Seed the elapsed clock with the raw time to walk each half of the start edge to its node.
  elapsed[startA] = start.metersFromA / startSpeedToA;
  elapsed[startB] = (startLength - start.metersFromA) / startSpeedToB;
  heap.push(distance[startA] + heuristicOf(startA), startA);
  heap.push(distance[startB] + heuristicOf(startB), startB);

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
      // A ferry is boardable only when ferries are allowed; otherwise skip it so no route uses one.
      // A train the same way, on its board edges: a platform nobody may board is a dead end, so the
      // rest of the topology falls out of reach on its own.
      const kind = edgeKind(graph, edge);
      if (
        (!weights.allowFerries && kind === "ferry") ||
        (!weights.allowTransit && kind === "board")
      ) {
        continue;
      }
      const neighbour = otherEnd(graph, edge, node);
      const relaxed =
        distance[node] + effSeconds(graph, edge, weights, elapsed[node], node);
      // One label per node, keyed on cost alone: a costlier path that reaches a platform EARLIER,
      // and so catches an earlier train, is discarded here. Accepted — the ferries have always been
      // costed the same way and the Dijkstra oracle shares the convention — but it is why a route
      // over a timetable is a good route rather than provably the best one.
      if (relaxed < distance[neighbour]) {
        distance[neighbour] = relaxed;
        elapsed[neighbour] =
          elapsed[node] + rawSeconds(graph, edge, node, elapsed[node]);
        parentEdge[neighbour] = edge;
        heap.push(relaxed + heuristicOf(neighbour), neighbour);
      }
    }
  }

  routeDiagnostics.nodesSettled = settled;
  if (bestTotal === Number.POSITIVE_INFINITY) {
    return null;
  }

  return reconstruct(
    graph,
    start,
    dest,
    parentEdge,
    bestDestNode,
    bestSameEdge,
  );
}

// An incremental A* from a fixed source that reuses its settled search across successive dests, for
// live endpoint dragging. It keeps the g-values, parent tree, and closed set from one call to the
// next and never reopens a closed node — the deliberate approximation that makes reuse cheap. When a
// dragged dest lands in already-explored territory it answers with no search at all; otherwise it
// resumes the frontier toward the new goal. Exact when the heuristic is consistent (ferries off and
// no shade), near-optimal otherwise.
//
// The elapsed clock counts raw walking seconds from the source, but the sun runs on WALL-CLOCK time
// from the fixed departure. A dest-drag roots at the true start, so departure is elapsed 0 and the sun
// counts forward (sunAnchorSeconds 0, sunDirection +1). A start-drag roots at the DEST and reverses the
// path, so the source is where you ARRIVE: pin sunAnchorSeconds to the last route's trip time and count
// the sun BACKWARD (sunDirection -1), so a node reached partway back from the dest is costed against
// the sun at its true forward time. The anchor is a stale estimate the release's fresh A* corrects.
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
  // The two halves of the source edge are walked in opposite directions, so a hill on it takes them
  // at different speeds.
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
    // The source edge is a partial walked at the source's wall-clock time (departure for a dest-drag,
    // arrival for a start-drag), so price it against the sun at the anchor.
    const sourceMultiplier = edgeMultiplier(
      graph,
      source.edge,
      weights,
      Math.max(0, sunAnchorSeconds),
    );
    const sourceSpeedToA = walkSpeedOn(graph, source.edge, false);
    const sourceSpeedToB = walkSpeedOn(graph, source.edge, true);
    this.sourcePerMeterToA = sourceMultiplier / sourceSpeedToA;
    this.sourcePerMeterToB = sourceMultiplier / sourceSpeedToB;
    this.sourceLength = graph.edgeLength[source.edge];

    this.distance[this.sourceA] = source.metersFromA * this.sourcePerMeterToA;
    this.distance[this.sourceB] =
      (this.sourceLength - source.metersFromA) * this.sourcePerMeterToB;
    // The elapsed clock is anchored at the source, so it is stable across dest drags — every reused
    // node's raw time from the source is the same no matter where the moving endpoint goes.
    this.elapsed[this.sourceA] = source.metersFromA / sourceSpeedToA;
    this.elapsed[this.sourceB] =
      (this.sourceLength - source.metersFromA) / sourceSpeedToB;
    this.reached.push(this.sourceA, this.sourceB);
  }

  // A node's forward wall-clock seconds since departure: the anchor plus the raw time from the source,
  // signed by the search direction, floored at departure. This is what the sun-dependent shade reads.
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
    // The dest edge is a partial walked at the moving endpoint: cost it against the sun at that node's
    // forward wall-clock time.
    const destPerMeterAt = (node: number): number =>
      edgeMultiplier(graph, dest.edge, this.weights, this.sunElapsed(node)) /
      walkSpeedOn(graph, dest.edge, node === destA);

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

    // Only a settled (closed) endpoint has a final g; a merely-reached one still holds a tentative
    // distance that a resumed search may improve, so it can't shortcut here.
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

    // Fast path: the dest edge is already settled from the explored region, so answer with no
    // search at all.
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

    // The heuristic and its per-node cache are only needed for the search below, so they are built
    // after the fast path to keep a settled-dest drag frame allocation-free.
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

    // Resume the frontier toward this dest: reseed the heap from every open reached node.
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
      // Expand the settled node before any goal stop, so a later drag can still route through a dest
      // endpoint that was closed on this call.
      for (let slot = graph.csr[node]; slot < graph.csr[node + 1]; slot++) {
        const edge = graph.adjacency[slot];
        const kind = edgeKind(graph, edge);
        if (
          (!this.weights.allowFerries && kind === "ferry") ||
          (!this.weights.allowTransit && kind === "board")
        ) {
          continue;
        }
        const neighbour = otherEnd(graph, edge, node);
        if (this.closed[neighbour] === 1) {
          continue;
        }
        const relaxed =
          this.distance[node] +
          effSeconds(graph, edge, this.weights, this.sunElapsed(node), node);
        if (relaxed < this.distance[neighbour]) {
          if (this.distance[neighbour] === Number.POSITIVE_INFINITY) {
            this.reached.push(neighbour);
          }
          this.distance[neighbour] = relaxed;
          this.elapsed[neighbour] =
            this.elapsed[node] +
            rawSeconds(graph, edge, node, this.sunElapsed(node));
          this.parentEdge[neighbour] = edge;
          heap.push(relaxed + heuristicOf(neighbour), neighbour);
        }
      }

      // Approximate goal test: stop once a dest endpoint has settled (and been expanded above).
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

// The ETA over an oriented step list: raw seconds, each step costed at the clock time it is reached,
// because a ferry's cost is a step function of that clock.
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
// The same route travelled the other way: swap the two snaps, reverse the step list and flip each
// step's travel direction, and reverse the stitched path. Length, walk and the attribute sums carry
// over unchanged; the ETA is NOT — walking a hill the other way climbs what it dropped — so it is
// re-run over the flipped steps, leaving the shares taken against the ETA walked the other way.
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
    // Carried unflipped, which is only right because the one caller — a start drag's backward solve
    // — bars transit and so never has any: reversing a ride would have to swap the board and alight
    // stations, and the leg does not carry enough to do that.
    rides: result.rides,
    // A ferry edge IS walkable backwards, so these are re-read off the flipped steps: the boat
    // caught going the other way sails at another time, and is waited for at the other pier.
    ferries: ferryLegs(graph, steps, result.rides),
    factors: result.factors,
    factorSeconds: result.factorSeconds,
    start: result.dest,
    dest: result.start,
  };
}

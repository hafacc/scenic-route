// Checks on a walk that no single edge can answer; run over sampled trips in tests/route-sampling.test.ts.

import { edgePath, isTransitEdge, otherEnd, type RoutingGraph } from "./graph";
import type { RouteResult } from "./search";
import { haversineMeters } from "./snap";

const METERS_PER_DEGREE_LAT = 111_320;

// A street's own two crossings share a curb node (0 m); a corner wrap is a few meters.
export const REVERSAL_GAP_METERS = 20;
// -0.7 is 135°, so a corner's right angle (cosine 0) is never a reversal.
export const REVERSAL_COSINE = -0.7;

export interface CrossingReversal {
  stepIndex: number; // the first of the two crossing steps
  name: string | null; // the street crossed, as the first crossing names it
  walkBetweenMeters: number; // pavement walked between leaving the first crossing and starting the second
  crossedMeters: number; // the two crossings' own lengths, i.e. what the reversal cost
  at: { lat: number; lng: number }; // where the first crossing starts, for a failure message
  // True when a path no longer than the reversal joins its ends without those crossings, so it was bought.
  avoidable: boolean;
}

// Bounded by the budget, so the frontier stays at a few dozen nodes.
function reachableWithout(
  graph: RoutingGraph,
  from: number,
  to: number,
  budget: number,
  banned: readonly [number, number],
): boolean {
  const best = new Map<number, number>([[from, 0]]);
  // A linear-scan frontier: at these budgets a heap would cost more than it saves.
  const frontier: number[] = [from];
  while (frontier.length > 0) {
    let at = 0;
    for (let index = 1; index < frontier.length; index++) {
      if ((best.get(frontier[index]) ?? 0) < (best.get(frontier[at]) ?? 0)) {
        at = index;
      }
    }
    const node = frontier[at];
    frontier[at] = frontier[frontier.length - 1];
    frontier.pop();
    if (node === to) {
      return true;
    }
    const distance = best.get(node) ?? 0;
    for (let slot = graph.csr[node]; slot < graph.csr[node + 1]; slot++) {
      const edge = graph.adjacency[slot];
      if (
        edge === banned[0] ||
        edge === banned[1] ||
        isTransitEdge(graph, edge)
      ) {
        continue; // the way round a reversal is a walk, never a ride
      }
      const relaxed = distance + graph.edgeLength[edge];
      const neighbor = otherEnd(graph, edge, node);
      if (relaxed <= budget && relaxed < (best.get(neighbor) ?? Infinity)) {
        best.set(neighbor, relaxed);
        frontier.push(neighbor);
      }
    }
  }
  return false;
}

function stepDirection(
  graph: RoutingGraph,
  edge: number,
  forward: boolean,
): { x: number; y: number; from: { lat: number; lng: number } } {
  const { lngs, lats } = edgePath(graph, edge);
  const first = forward ? 0 : lngs.length - 1;
  const last = forward ? lngs.length - 1 : 0;
  const cosLat = Math.cos((lats[first] * Math.PI) / 180);
  const deltaX = (lngs[last] - lngs[first]) * METERS_PER_DEGREE_LAT * cosLat;
  const deltaY = (lats[last] - lats[first]) * METERS_PER_DEGREE_LAT;
  const norm = Math.hypot(deltaX, deltaY) || 1;
  return {
    x: deltaX / norm,
    y: deltaY / norm,
    from: { lat: lats[first], lng: lngs[first] },
  };
}

// Tagged `avoidable` by asking the network whether the ends join without the crossings.
export function crossingReversals(
  graph: RoutingGraph,
  result: RouteResult,
): CrossingReversal[] {
  const reversals: CrossingReversal[] = [];
  let previous: {
    stepIndex: number;
    edge: number;
    fromNode: number;
    x: number;
    y: number;
    name: string | null;
    from: { lat: number; lng: number };
    endsAtMeters: number;
    lengthMeters: number;
  } | null = null;
  let along = 0;
  for (let index = 0; index < result.steps.length; index++) {
    const step = result.steps[index];
    const startsAtMeters = along;
    along += step.lengthMeters;
    if (step.kind !== "crossing") {
      continue;
    }
    const { x, y, from } = stepDirection(graph, step.edge, step.forward);
    if (previous) {
      const gap = startsAtMeters - previous.endsAtMeters;
      const cosine = previous.x * x + previous.y * y;
      if (gap <= REVERSAL_GAP_METERS && cosine <= REVERSAL_COSINE) {
        const crossedMeters = previous.lengthMeters + step.lengthMeters;
        const toNode = step.forward
          ? graph.edgeNodeB[step.edge]
          : graph.edgeNodeA[step.edge];
        reversals.push({
          stepIndex: previous.stepIndex,
          name: previous.name,
          walkBetweenMeters: gap,
          crossedMeters,
          at: previous.from,
          avoidable: reachableWithout(
            graph,
            previous.fromNode,
            toNode,
            crossedMeters + gap,
            [previous.edge, step.edge],
          ),
        });
      }
    }
    previous = {
      stepIndex: index,
      edge: step.edge,
      fromNode: step.forward
        ? graph.edgeNodeA[step.edge]
        : graph.edgeNodeB[step.edge],
      x,
      y,
      name: step.name,
      from,
      endsAtMeters: along,
      lengthMeters: step.lengthMeters,
    };
  }
  return reversals;
}

// Half a median crossing looks like a whole one until you see the walk go through it.
export function longestCrossingRun(result: RouteResult): number {
  let longest = 0;
  let run = 0;
  for (const step of result.steps) {
    if (step.kind === "crossing") {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  return longest;
}

// Between the snapped points; ferry and rail spans are excluded, and a zero straight line has no ratio.
export function detourRatio(result: RouteResult): number | null {
  const straight = haversineMeters(
    result.start.point.lat,
    result.start.point.lng,
    result.dest.point.lat,
    result.dest.point.lng,
  );
  return straight > 0 ? result.walkMeters / straight : null;
}

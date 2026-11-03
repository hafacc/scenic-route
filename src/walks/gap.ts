// Fills a stretch with the watch off: the streets every plausible walk between its two fixes crossed.

import {
  edgeDurableKey,
  edgeKind,
  isTransitEdge,
  NO_SOURCE_ID,
  otherEnd,
  type RoutingGraph,
} from "../routing/graph";
import { NodeHeap } from "../routing/node-heap";
import { haversineMeters, nearestEdge, type SnapIndex } from "../routing/snap";
import { WALK_METERS_PER_SECOND } from "../routing/walk-speed";
import {
  type Fix,
  MATCH_METERS,
  MAX_ACCURACY_METERS,
  MAX_WALK_METERS_PER_SECOND,
} from "./tracker";

// A watch on the move reports every second or so, so a longer silence means it was off.
export const FILL_AFTER_MS = 10_000;
// Walkers keep close to the shortest way; a walk this much longer is not one they took.
export const PLAUSIBLE_DETOUR = 1.25;
// Either fix can sit up to MATCH_METERS off its street, so the shortest walk is that unsure at each end.
const SNAP_SLACK_METERS = 2 * MATCH_METERS;
// Past this the plausible walks spread over a neighborhood, which says little and costs a big search.
export const MAX_GAP_MS = 10 * 60 * 1000;
// Slower than this the gap held a stop or a wander, which no near-direct walk stands for.
export const MIN_GAP_METERS_PER_SECOND = WALK_METERS_PER_SECOND / 2;

// A point on an edge, as the meters to each of its ends.
interface End {
  edge: number;
  toA: number;
  toB: number;
}

interface Walk {
  meters: number;
  edges: number[];
}

export class WalkGaps {
  private last: Fix | null = null;

  // Durable keys to count for the gap before this fix; empty when there was none or nothing is certain.
  observe(fix: Fix, graph: RoutingGraph, index: SnapIndex): number[] {
    if (!(fix.accuracy <= MAX_ACCURACY_METERS)) {
      return [];
    }
    const previous = this.last;
    this.last = fix;
    return previous === null ? [] : crossed(graph, index, previous, fix);
  }
}

// The streets on the shortest walk whose loss pushes every other walk past the plausible bound.
export function crossed(
  graph: RoutingGraph,
  index: SnapIndex,
  from: Fix,
  to: Fix,
): number[] {
  const seconds = (to.at - from.at) / 1000;
  const reach = seconds * MAX_WALK_METERS_PER_SECOND;
  const straight = haversineMeters(from.lat, from.lng, to.lat, to.lng);
  if (
    to.at - from.at < FILL_AFTER_MS ||
    to.at - from.at > MAX_GAP_MS ||
    (to.speed !== null && to.speed > MAX_WALK_METERS_PER_SECOND) ||
    straight > reach
  ) {
    return [];
  }
  const start = endOf(graph, index, from);
  const finish = endOf(graph, index, to);
  if (start === null || finish === null || start.edge === finish.edge) {
    return [];
  }
  const shortest = walk(graph, start, finish, reach, () => 0);
  if (
    shortest === null ||
    shortest.meters / seconds < MIN_GAP_METERS_PER_SECOND
  ) {
    return [];
  }
  const bound = Math.min(
    reach,
    shortest.meters * PLAUSIBLE_DETOUR + SNAP_SLACK_METERS,
  );
  const toFinish = distances(graph, finish, bound);
  const streets = shortest.edges.map(streetOf(graph, shortest.edges));
  const ends = new Set([start.edge, finish.edge]);
  const tried = new Set<readonly number[]>();
  const ambiguous = new Set<readonly number[]>();
  const keys: number[] = [];
  for (const [at, edge] of shortest.edges.entries()) {
    const street = streets[at];
    if (
      edgeDurableKey(graph, edge) === -1 ||
      street.some((side) => ends.has(side)) ||
      tried.has(street) ||
      ambiguous.has(street)
    ) {
      continue;
    }
    tried.add(street);
    const detour = walk(
      graph,
      start,
      finish,
      bound,
      (node) => toFinish.get(node) ?? Number.POSITIVE_INFINITY,
      new Set(street),
    );
    if (detour === null) {
      keys.push(...street.map((side) => edgeDurableKey(graph, side)));
    } else {
      // Every street the detour also skips is just as avoidable.
      const kept = new Set(detour.edges);
      for (const skipped of streets) {
        if (!skipped.some((side) => kept.has(side))) {
          ambiguous.add(skipped);
        }
      }
    }
  }
  return keys;
}

// A sidewalk stands for its whole street: every side offset from the same source record shares its id.
function streetOf(
  graph: RoutingGraph,
  edges: readonly number[],
): (edge: number) => readonly number[] {
  const sides = new Map<number, number[]>();
  for (const edge of edges) {
    if (edgeKind(graph, edge) === "sidewalk") {
      sides.set(graph.edgeSourceId[edge], []);
    }
  }
  sides.delete(NO_SOURCE_ID);
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    if (edgeKind(graph, edge) === "sidewalk") {
      sides.get(graph.edgeSourceId[edge])?.push(edge);
    }
  }
  return (edge) => sides.get(graph.edgeSourceId[edge]) ?? [edge];
}

function endOf(graph: RoutingGraph, index: SnapIndex, fix: Fix): End | null {
  const match = nearestEdge(graph, index, fix, MATCH_METERS);
  return match === null
    ? null
    : {
        edge: match.edge,
        toA: match.metersFromA,
        toB: graph.edgeLength[match.edge] - match.metersFromA,
      };
}

// On foot only: a ferry or a train leg is a ride, not a street walked.
function walkable(graph: RoutingGraph, edge: number): boolean {
  return edgeKind(graph, edge) !== "ferry" && !isTransitEdge(graph, edge);
}

// A* toward `to` under `bound`, never along `banned`; `toGoal` must not overestimate.
function walk(
  graph: RoutingGraph,
  from: End,
  to: End,
  bound: number,
  toGoal: (node: number) => number,
  banned: ReadonlySet<number> = new Set(),
): Walk | null {
  const goal = graph.nodeCount;
  const toA = graph.edgeNodeA[to.edge];
  const toB = graph.edgeNodeB[to.edge];
  const { meters, via, back } = grow(
    graph,
    from,
    bound,
    toGoal,
    banned,
    (node, g, offer) => {
      if (node === toA) {
        offer(goal, g + to.toA, to.edge, 0);
      }
      if (node === toB) {
        offer(goal, g + to.toB, to.edge, 0);
      }
      return node === goal;
    },
  );
  const total = meters.get(goal);
  if (total === undefined) {
    return null;
  }
  const edges: number[] = [];
  for (let node = goal; node !== -1; node = back.get(node) ?? -1) {
    edges.push(via.get(node) ?? -1);
  }
  return { meters: total, edges };
}

// Meters from `from` to every node within `bound`; the graph is undirected, so also to `from`.
function distances(
  graph: RoutingGraph,
  from: End,
  bound: number,
): Map<number, number> {
  return grow(
    graph,
    from,
    bound,
    () => 0,
    new Set(),
    () => false,
  ).meters;
}

type Offer = (node: number, g: number, edge: number, h: number) => void;

// Best-first from both ends of `from`'s edge; `settle` may offer extra nodes and ends the search by returning true.
function grow(
  graph: RoutingGraph,
  from: End,
  bound: number,
  toGoal: (node: number) => number,
  banned: ReadonlySet<number>,
  settle: (node: number, g: number, offer: Offer) => boolean,
): {
  meters: Map<number, number>;
  via: Map<number, number>;
  back: Map<number, number>;
} {
  const meters = new Map<number, number>();
  const via = new Map<number, number>();
  const back = new Map<number, number>();
  const done = new Set<number>();
  const heap = new NodeHeap(64);
  let current = -1;
  const offer: Offer = (node, g, edge, h) => {
    if (g + h <= bound && g < (meters.get(node) ?? Number.POSITIVE_INFINITY)) {
      meters.set(node, g);
      via.set(node, edge);
      back.set(node, current);
      heap.push(g + h, node);
    }
  };
  const fromA = graph.edgeNodeA[from.edge];
  const fromB = graph.edgeNodeB[from.edge];
  offer(fromA, from.toA, from.edge, toGoal(fromA));
  offer(fromB, from.toB, from.edge, toGoal(fromB));
  while (heap.length > 0) {
    const node = heap.pop();
    if (done.has(node)) {
      continue;
    }
    done.add(node);
    current = node;
    const g = meters.get(node) ?? 0;
    if (settle(node, g, offer)) {
      break;
    }
    for (let slot = graph.csr[node]; slot < graph.csr[node + 1]; slot++) {
      const edge = graph.adjacency[slot];
      if (!banned.has(edge) && walkable(graph, edge)) {
        const next = otherEnd(graph, edge, node);
        offer(next, g + graph.edgeLength[edge], edge, toGoal(next));
      }
    }
  }
  return { meters, via, back };
}

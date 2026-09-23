// Leg errors are independent once both ends are pinned, so an exact DP picks the pins; one per junction.

import {
  crossingWait,
  edgeForward,
  effSeconds,
  type RouteWeights,
  WALK_METERS_PER_SECOND,
  walkSecondsPerMeter,
} from "./cost";
import { edgeKind, isTransitEdge, otherEnd, type RoutingGraph } from "./graph";
import { NodeHeap } from "./node-heap";
import { type RouteStep, stepFrom, stepSeconds } from "./search";

// The worker is sent only the steps; the stitched path is bulky and prices nothing.
export interface PlannedRoute {
  steps: readonly RouteStep[];
}

export interface Waypoint {
  lat: number;
  lng: number;
}

export interface WaypointPlan {
  waypoints: Waypoint[]; // the pinned points, in route order
  lostSeconds: number; // effective seconds of scenic value the approximation gives up
  candidateCount: number; // corners the choice was made over, for diagnostics
  // A walking router handed the stations would walk between them, so Google gets the ends in transit mode.
  rides: boolean;
}

// Plain Tobler walking; crossings must be freed explicitly, and boats and trains barred.
export const PROXY_WEIGHTS: RouteWeights = {
  tree: 0,
  ferry: 0,
  landmark: 0,
  art: 0,
  highway: 0,
  hill: 0,
  commercial: 0,
  industrial: 0,
  historic: 0,
  bridge: 0,
  shade: 0,
  shelter: 0,
  transit: 0,
  allowFerries: false,
  allowTransit: false,
  allowSheds: true,
  allowCrossings: true,
};

// Finite so a plan still comes out when the route crosses water the proxy can't.
const UNREACHABLE_LEG_SECONDS = 1e9;

// Floating slack, so a bound that is exactly the answer still admits it.
const BOUND_SLACK_SECONDS = 1e-6;

function nodeLat(graph: RoutingGraph, node: number): number {
  return graph.originLat + graph.nodeQy[node] * graph.scale;
}

function nodeLng(graph: RoutingGraph, node: number): number {
  return graph.originLng + graph.nodeQx[node] * graph.scale;
}

// Google snaps a mid-block pin to either side of the street; a corner snaps where you meant.
function isCorner(graph: RoutingGraph, node: number): boolean {
  if (graph.nodeMidRoadway[node] === 1) {
    return false;
  } else {
    let touchesCrossing = false;
    const to = graph.csr[node + 1];
    for (let slot = graph.csr[node]; slot < to && !touchesCrossing; slot += 1) {
      touchesCrossing = edgeKind(graph, graph.adjacency[slot]) === "crossing";
    }
    return touchesCrossing;
  }
}

// Bounded by crossings chained through islands, not by distance.
function junctionNodes(graph: RoutingGraph, node: number): Set<number> {
  const junction = new Set([node]);
  const frontier = [node];
  for (let head = 0; head < frontier.length; head += 1) {
    const at = frontier[head];
    const to = graph.csr[at + 1];
    for (let slot = graph.csr[at]; slot < to; slot += 1) {
      const edge = graph.adjacency[slot];
      if (edgeKind(graph, edge) === "crossing") {
        const across = otherEnd(graph, edge, at);
        if (!junction.has(across)) {
          junction.add(across);
          if (graph.nodeMidRoadway[across] === 1) {
            frontier.push(across);
          }
        }
      }
    }
  }
  return junction;
}

// Direction is part of the identity, since a climb one way is a descent the other.
function directedEdge(edge: number, forward: boolean): number {
  return edge * 2 + (forward ? 1 : 0);
}

interface RouteWalk {
  nodes: number[];
  valueCost: Float64Array; // cumulative reader-weighted cost from nodes[0]
  proxyCost: Float64Array; // cumulative proxy cost, which bounds each search's radius
  elapsed: Float64Array; // raw seconds since departure at each node, for the sun
}

function walkRoute(
  graph: RoutingGraph,
  route: PlannedRoute,
  weights: RouteWeights,
): RouteWalk {
  const nodes: number[] = [];
  const valueCost: number[] = [0];
  const proxyCost: number[] = [0];
  const elapsedAt: number[] = [];
  // The end partials run between no two nodes, so no pin carves them, but the clock still runs.
  let elapsed = 0;
  for (const [index, step] of route.steps.entries()) {
    const from = stepFrom(graph, step);
    const last = index === route.steps.length - 1;
    if (index > 0 && !last) {
      valueCost.push(
        valueCost[valueCost.length - 1] +
          effSeconds(graph, step.edge, weights, elapsed, from),
      );
      // Only ever read as a search radius, so pricing a ferry as a flat walk keeps it bounded.
      proxyCost.push(
        proxyCost[proxyCost.length - 1] +
          (step.kind === "ferry"
            ? graph.edgeLength[step.edge] / WALK_METERS_PER_SECOND
            : effSeconds(graph, step.edge, PROXY_WEIGHTS, elapsed, from)),
      );
    }
    const seconds = stepSeconds(graph, step, elapsed);
    if (!last) {
      nodes.push(otherEnd(graph, step.edge, from));
      elapsedAt.push(elapsed + seconds);
    }
    elapsed += seconds;
  }
  return {
    nodes,
    valueCost: Float64Array.from(valueCost),
    proxyCost: Float64Array.from(proxyCost),
    elapsed: Float64Array.from(elapsedAt),
  };
}

// One search per anchor fills a whole cost row; arrays are cleared only where written.
class ProxyExplorer {
  private readonly graph: RoutingGraph;
  private readonly weights: RouteWeights;
  private readonly routeEdges: ReadonlySet<number>; // `directedEdge` of every step the route walks
  private readonly distance: Float64Array; // proxy cost from the anchor
  private readonly valueCost: Float64Array; // the reader's price for that same proxy path
  private readonly elapsed: Float64Array; // raw seconds since departure along it
  private readonly settled: Uint8Array;
  private readonly touched: number[] = [];
  private readonly heap = new NodeHeap(1024);

  constructor(
    graph: RoutingGraph,
    weights: RouteWeights,
    routeEdges: ReadonlySet<number>,
  ) {
    this.graph = graph;
    this.weights = weights;
    this.routeEdges = routeEdges;
    this.distance = new Float64Array(graph.nodeCount).fill(
      Number.POSITIVE_INFINITY,
    );
    this.valueCost = new Float64Array(graph.nodeCount);
    this.elapsed = new Float64Array(graph.nodeCount);
    this.settled = new Uint8Array(graph.nodeCount);
  }

  // The bound is what the route itself achieves, so it never cuts off a useful target.
  run(
    source: number,
    elapsedAtSource: number,
    targets: Iterable<number>,
    bound: number,
  ): void {
    for (const node of this.touched) {
      this.distance[node] = Number.POSITIVE_INFINITY;
      this.settled[node] = 0;
    }
    this.touched.length = 0;
    this.heap.clear();

    const pending = new Set(targets);
    this.distance[source] = 0;
    this.valueCost[source] = 0;
    this.elapsed[source] = elapsedAtSource;
    this.touched.push(source);
    this.heap.push(0, source);

    const { csr, adjacency } = this.graph;
    const limit = bound + BOUND_SLACK_SECONDS;
    while (this.heap.length > 0 && pending.size > 0) {
      if (this.heap.peekKey() > limit) {
        break;
      }
      const node = this.heap.pop();
      if (this.settled[node] === 1) {
        continue; // a stale duplicate left by lazy deletion
      }
      this.settled[node] = 1;
      pending.delete(node);
      const to = csr[node + 1];
      for (let slot = csr[node]; slot < to; slot += 1) {
        const edge = adjacency[slot];
        if (
          edgeKind(this.graph, edge) === "ferry" ||
          isTransitEdge(this.graph, edge)
        ) {
          continue; // the proxy walks; it cannot put anyone on a boat or a train
        }
        const neighbor = otherEnd(this.graph, edge, node);
        // At PROXY_WEIGHTS every factor is 1, so this is just the walk; `proxyPricesAWalk` pins it.
        const forward = edgeForward(this.graph, edge, node);
        const walked =
          this.graph.edgeLength[edge] *
          walkSecondsPerMeter(this.graph, edge, forward);
        const relaxed = this.distance[node] + walked;
        if (relaxed < this.distance[neighbor]) {
          if (this.distance[neighbor] === Number.POSITIVE_INFINITY) {
            this.touched.push(neighbor);
          }
          this.distance[neighbor] = relaxed;
          this.record(neighbor, node, edge, walked);
          this.heap.push(relaxed, neighbor);
        } else if (
          relaxed === this.distance[neighbor] &&
          this.routeEdges.has(directedEdge(edge, forward))
        ) {
          // Ties go to the route's own walk; only the recorded price moves, so the heap entry still holds.
          this.record(neighbor, node, edge, walked);
        }
      }
    }
  }

  private record(
    neighbor: number,
    node: number,
    edge: number,
    walked: number,
  ): void {
    this.valueCost[neighbor] =
      this.valueCost[node] +
      effSeconds(this.graph, edge, this.weights, this.elapsed[node], node);
    this.elapsed[neighbor] =
      this.elapsed[node] + walked + crossingWait(this.graph, edge, node);
  }

  // Null when the last search never reached `node`.
  costTo(node: number): number | null {
    return this.settled[node] === 1 ? this.valueCost[node] : null;
  }
}

// Exactly optimal over the corner candidates, given the proxy above.
export function planWaypoints(
  graph: RoutingGraph,
  route: PlannedRoute,
  weights: RouteWeights,
  limit: number,
): WaypointPlan {
  // A walking router would walk between the stations, so a route that rides is handed over whole.
  if (route.steps.some((step) => step.kind === "ride")) {
    return {
      waypoints: [],
      lostSeconds: 0,
      candidateCount: 0,
      rides: true,
    };
  }
  const walk = walkRoute(graph, route, weights);
  const lastIndex = walk.nodes.length - 1;
  if (lastIndex <= 0) {
    // The ends are snaps part way along an edge, which no pin can carve and no leg can join.
    return { waypoints: [], lostSeconds: 0, candidateCount: 0, rides: false };
  } else {
    // Revisited nodes are skipped: a backward leg can't be expressed in the DAG and would wedge the tab.
    const anchors = [0];
    const visited = new Set([walk.nodes[0]]);
    // Seeded with the start's intersection, where anchor 0 already stands.
    let junction = junctionNodes(graph, walk.nodes[0]);
    for (let index = 1; index < lastIndex; index += 1) {
      const node = walk.nodes[index];
      if (!visited.has(node) && !junction.has(node) && isCorner(graph, node)) {
        anchors.push(index);
        junction = junctionNodes(graph, node);
      }
      visited.add(node);
    }
    anchors.push(lastIndex);

    const count = anchors.length;
    // What pinning a then b gives up: the proxy's a..b walk at the reader's weights, less the route's own.
    const cost = new Float64Array(count * count).fill(UNREACHABLE_LEG_SECONDS);
    const explorer = new ProxyExplorer(
      graph,
      weights,
      new Set(route.steps.map((step) => directedEdge(step.edge, step.forward))),
    );
    for (let from = 0; from < count - 1; from += 1) {
      const fromIndex = anchors[from];
      const ahead = anchors.slice(from + 1);
      explorer.run(
        walk.nodes[fromIndex],
        walk.elapsed[fromIndex],
        ahead.map((index) => walk.nodes[index]),
        walk.proxyCost[lastIndex] - walk.proxyCost[fromIndex],
      );
      for (let to = from + 1; to < count; to += 1) {
        const toIndex = anchors[to];
        const reached = explorer.costTo(walk.nodes[toIndex]);
        if (reached !== null) {
          cost[from * count + to] =
            reached - (walk.valueCost[toIndex] - walk.valueCost[fromIndex]);
        }
      }
    }

    if (count === 2) {
      return {
        waypoints: [],
        lostSeconds: cost[count - 1],
        candidateCount: 0,
        rides: false,
      };
    } else {
      // Legs run to one more than the pins allowed, since the last leg lands on the destination.
      const maxLegs = Math.min(limit, count - 2) + 1;
      const best = new Float64Array((maxLegs + 1) * count).fill(
        Number.POSITIVE_INFINITY,
      );
      const previous = new Int32Array((maxLegs + 1) * count).fill(-1);
      best[0] = 0;
      for (let legs = 1; legs <= maxLegs; legs += 1) {
        for (let to = legs; to < count; to += 1) {
          for (let from = legs - 1; from < to; from += 1) {
            const total =
              best[(legs - 1) * count + from] + cost[from * count + to];
            if (total < best[legs * count + to]) {
              best[legs * count + to] = total;
              previous[legs * count + to] = from;
            }
          }
        }
      }

      let bestLegs = 1;
      for (let legs = 2; legs <= maxLegs; legs += 1) {
        if (
          best[legs * count + count - 1] < best[bestLegs * count + count - 1]
        ) {
          bestLegs = legs;
        }
      }

      const pins: number[] = [];
      let at = count - 1;
      for (let legs = bestLegs; legs > 1; legs -= 1) {
        at = previous[legs * count + at];
        pins.unshift(anchors[at]);
      }
      return {
        waypoints: pins.map((index) => ({
          lat: nodeLat(graph, walk.nodes[index]),
          lng: nodeLng(graph, walk.nodes[index]),
        })),
        lostSeconds: best[bestLegs * count + count - 1],
        candidateCount: count - 2,
        rides: false,
      };
    }
  }
}

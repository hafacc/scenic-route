import { beforeEach, expect, test } from "bun:test";
import {
  edgeMultiplier,
  effSeconds,
  FERRY_FLOOR,
  ferryCredit,
  heuristicFloor,
  WALK_METERS_PER_SECOND,
  walkSecondsCoeff,
} from "./cost";
import { buildGraph, snapAtNode, weights } from "./ferry.fixture";
import { clearEdgePathCache, otherEnd, type RoutingGraph } from "./graph";
import { findRoute, networkMetersTo, type RouteResult } from "./search";
import { haversineMeters, type Snap } from "./snap";

// The reference optimum: a plain Dijkstra (heuristic identically 0, no early exit) over effective
// seconds, using exactly findRoute's virtual-source and virtual-goal partial-edge semantics.
function dijkstraCost(
  graph: RoutingGraph,
  start: Snap,
  dest: Snap,
  treeWeight: number,
  ferryWeight: number,
  allowFerries: boolean,
): number {
  const nodeCount = graph.nodeCount;
  const distance = new Float64Array(nodeCount).fill(Number.POSITIVE_INFINITY);
  const settled = new Uint8Array(nodeCount);

  const routeWeights = weights(treeWeight, ferryWeight, allowFerries);
  const startA = graph.edgeNodeA[start.edge];
  const startB = graph.edgeNodeB[start.edge];
  const startPerMeter =
    edgeMultiplier(graph, start.edge, routeWeights) / WALK_METERS_PER_SECOND;
  const startLength = graph.edgeLength[start.edge];
  distance[startA] = start.metersFromA * startPerMeter;
  distance[startB] = (startLength - start.metersFromA) * startPerMeter;

  const destA = graph.edgeNodeA[dest.edge];
  const destB = graph.edgeNodeB[dest.edge];
  const destPerMeter =
    edgeMultiplier(graph, dest.edge, routeWeights) / WALK_METERS_PER_SECOND;
  const destLength = graph.edgeLength[dest.edge];

  let best = Number.POSITIVE_INFINITY;
  if (start.edge === dest.edge) {
    best = Math.abs(dest.metersFromA - start.metersFromA) * startPerMeter;
  }

  for (;;) {
    let node = -1;
    let nodeDistance = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate < nodeCount; candidate++) {
      if (!settled[candidate] && distance[candidate] < nodeDistance) {
        nodeDistance = distance[candidate];
        node = candidate;
      }
    }
    if (node === -1) {
      break;
    }
    settled[node] = 1;
    for (let slot = graph.csr[node]; slot < graph.csr[node + 1]; slot++) {
      const edge = graph.adjacency[slot];
      const relaxed = distance[node] + effSeconds(graph, edge, routeWeights);
      const neighbour = otherEnd(graph, edge, node);
      if (relaxed < distance[neighbour]) {
        distance[neighbour] = relaxed;
      }
    }
  }

  best = Math.min(
    best,
    distance[destA] + dest.metersFromA * destPerMeter,
    distance[destB] + (destLength - dest.metersFromA) * destPerMeter,
  );
  return best;
}

// The effective-seconds cost of a returned route, reconstructed from its steps: walking steps by
// their walked span, ferry steps by their discounted duration. Must equal the Dijkstra optimum.
function effectiveCostOf(
  graph: RoutingGraph,
  result: RouteResult,
  treeWeight: number,
  ferryWeight: number,
): number {
  let cost = 0;
  for (const step of result.steps) {
    if (step.kind === "ferry") {
      cost +=
        graph.edgeDurationSeconds[step.edge] *
        Math.max(FERRY_FLOOR, 1 - ferryWeight);
    } else {
      cost +=
        (step.lengthMeters / WALK_METERS_PER_SECOND) *
        edgeMultiplier(
          graph,
          step.edge,
          weights(treeWeight, ferryWeight, false),
        );
    }
  }
  return cost;
}

function pathSignature(result: RouteResult | null): string {
  if (!result) {
    return "∅";
  }
  return result.steps
    .map((step) => `${step.edge}${step.forward ? "f" : "b"}`)
    .join(";");
}

function hasFerryStep(result: RouteResult | null): boolean {
  return result?.steps.some((step) => step.kind === "ferry") ?? false;
}

// Fixture A — one ferry that is a large shortcut: crossing 0 -> 1 by water is far cheaper than the
// long walk 0 -> 2 -> 1 around it. The plain walking heuristic from 0 would over-estimate the true
// (ferry) cost, so this exercises the ferry credit.
const graphA = buildGraph(
  [
    { lat: 40.7, lng: -74.02 }, // 0 start shore
    { lat: 40.62, lng: -74.08 }, // 1 far shore
    { lat: 40.58, lng: -74.16 }, // 2 detour inland, making the walk long
  ],
  [
    { a: 0, b: 1, ferry: true, cover: 0, durationSeconds: 400 },
    { a: 0, b: 2, ferry: false, cover: 0.3, durationSeconds: 0 },
    { a: 2, b: 1, ferry: false, cover: 0.6, durationSeconds: 0 },
  ],
);
const walkEdgeA0 = 1; // walking edge 0 -> 2, for a snap at node 0
const walkEdgeA1 = 2; // walking edge 2 -> 1, for a snap at node 1

// Fixture B — a two-ferry chain: 0 =ferry= 1 -walk- 2 =ferry= 3, with a very long all-walking
// detour 0 -walk- 4 -walk- 3. The optimum from 0 to 3 rides both ferries, so admissibility needs
// the sum of the two largest ferry shortcuts.
const graphB = buildGraph(
  [
    { lat: 40.6, lng: -74.12 }, // 0 start
    { lat: 40.61, lng: -74.06 }, // 1 island A
    { lat: 40.62, lng: -74.05 }, // 2 island B (short walk from 1)
    { lat: 40.7, lng: -74.0 }, // 3 dest
    { lat: 40.45, lng: -73.85 }, // 4 far detour node
  ],
  [
    { a: 0, b: 1, ferry: true, cover: 0, durationSeconds: 300 },
    { a: 1, b: 2, ferry: false, cover: 0.4, durationSeconds: 0 },
    { a: 2, b: 3, ferry: true, cover: 0, durationSeconds: 300 },
    { a: 0, b: 4, ferry: false, cover: 0.2, durationSeconds: 0 },
    { a: 4, b: 3, ferry: false, cover: 0.5, durationSeconds: 0 },
  ],
);
const walkEdgeB0 = 3; // walking edge 0 -> 4, for a snap at node 0
const walkEdgeB3 = 4; // walking edge 4 -> 3, for a snap at node 3

// Fixture C — the Bay Area's shape: two land masses with NO walking edge between them, joined by
// one ferry. Every fixture above has a walk to fall back on, so none of them asks what the heuristic
// does when the only path crosses water five times faster than anyone walks. Kept separate from the
// scenarios above because barring its ferry leaves no path at all, and those assert one.
const graphC = buildGraph(
  [
    { lat: 37.7749, lng: -122.4394 }, // 0 west, a long walk in
    { lat: 37.7955, lng: -122.3937 }, // 1 west pier
    { lat: 37.7955, lng: -122.2777 }, // 2 east pier
    { lat: 37.8272, lng: -122.2513 }, // 3 east, a long walk out
  ],
  [
    { a: 0, b: 1, ferry: false, cover: 0.3, durationSeconds: 0 },
    { a: 1, b: 2, ferry: true, cover: 0, durationSeconds: 1500 },
    { a: 2, b: 3, ferry: false, cover: 0.3, durationSeconds: 0 },
  ],
);
const walkEdgeC0 = 0; // walking edge 0 -> 1
const walkEdgeC3 = 2; // walking edge 2 -> 3

// Fixture D — a three-hop ferry line: one boat calling at four piers in a row, which the graph draws
// as three edges rather than one. Riding all three saves more than the best two of them do, so a
// credit bounded to the two largest shortcuts claims a cheaper remainder than any route can deliver.
// The walk round by land is there so both snaps have pavement to sit on, and is far too long to take.
const graphD = buildGraph(
  [
    { lat: 40.6, lng: -74.1 }, // 0 the first pier, where the walk starts
    { lat: 40.6, lng: -74.04 }, // 1
    { lat: 40.6, lng: -73.98 }, // 2
    { lat: 40.6, lng: -73.92 }, // 3 the last pier, where it ends
    { lat: 40.483, lng: -74.01 }, // 4 the long way round, by land
  ],
  [
    { a: 0, b: 1, ferry: true, cover: 0, durationSeconds: 900 },
    { a: 1, b: 2, ferry: true, cover: 0, durationSeconds: 900 },
    { a: 2, b: 3, ferry: true, cover: 0, durationSeconds: 900 },
    { a: 0, b: 4, ferry: false, cover: 0, durationSeconds: 0 },
    { a: 4, b: 3, ferry: false, cover: 0, durationSeconds: 0 },
  ],
);
const walkEdgeD0 = 3; // walking edge 0 -> 4, for a snap at node 0
const walkEdgeD3 = 4; // walking edge 4 -> 3, for a snap at node 3

// Fixture E — the same line with a fourth hop, and the first one sailing the wrong way: the boat
// leaves the start westward, and the three hops after it carry the walker back east past the start
// to a dest that was a short straight line from it all along. Three hops of saving are left ahead
// after the first, which is more than the two largest, so the two-largest credit leaves the far
// pier's estimate above the cost of walking round — and A* stops at the walk without ever riding.
const graphE = buildGraph(
  [
    { lat: 40.6, lng: -74.0 }, // 0 the start, and the pier it sails from
    { lat: 40.6, lng: -74.16 }, // 1 the far pier, west of everything
    { lat: 40.6, lng: -74.1 }, // 2
    { lat: 40.6, lng: -74.04 }, // 3
    { lat: 40.6, lng: -73.98 }, // 4 the dest pier, back east of the start
    { lat: 40.5156, lng: -73.99 }, // 5 the long way round, by land
  ],
  [
    // The first hop is as slow as walking its span would be, so its own shortcut is nothing and the
    // two largest in the graph are both among the three that follow.
    { a: 0, b: 1, ferry: true, cover: 0, durationSeconds: 10391 },
    { a: 1, b: 2, ferry: true, cover: 0, durationSeconds: 900 },
    { a: 2, b: 3, ferry: true, cover: 0, durationSeconds: 900 },
    { a: 3, b: 4, ferry: true, cover: 0, durationSeconds: 900 },
    { a: 0, b: 5, ferry: false, cover: 0, durationSeconds: 0 },
    { a: 5, b: 4, ferry: false, cover: 0, durationSeconds: 0 },
  ],
);
const walkEdgeE0 = 4; // walking edge 0 -> 5, for a snap at node 0
const walkEdgeE4 = 5; // walking edge 5 -> 4, for a snap at node 4

const TREE_WEIGHTS = [0, 0.4, 1];
const FERRY_WEIGHTS = [0, 0.4, 1];
const ALLOW = [true, false];

interface Scenario {
  name: string;
  graph: RoutingGraph;
  start: Snap;
  dest: Snap;
}

const scenarios: Scenario[] = [
  {
    name: "A: big ferry shortcut, 0 -> 1",
    graph: graphA,
    start: snapAtNode(graphA, 0, walkEdgeA0),
    dest: snapAtNode(graphA, 1, walkEdgeA1),
  },
  {
    name: "A: reverse, 1 -> 0",
    graph: graphA,
    start: snapAtNode(graphA, 1, walkEdgeA1),
    dest: snapAtNode(graphA, 0, walkEdgeA0),
  },
  {
    name: "B: two-ferry chain, 0 -> 3",
    graph: graphB,
    start: snapAtNode(graphB, 0, walkEdgeB0),
    dest: snapAtNode(graphB, 3, walkEdgeB3),
  },
  {
    name: "D: three-hop line, 0 -> 3",
    graph: graphD,
    start: snapAtNode(graphD, 0, walkEdgeD0),
    dest: snapAtNode(graphD, 3, walkEdgeD3),
  },
  {
    name: "E: four-hop line out and back, 0 -> 4",
    graph: graphE,
    start: snapAtNode(graphE, 0, walkEdgeE0),
    dest: snapAtNode(graphE, 4, walkEdgeE4),
  },
];

// The edge-geometry cache is keyed by edge id; these fixtures reuse ids across graphs, so reset it
// before each test so no stale polyline leaks in (also protecting other files' synthetic graphs).
beforeEach(clearEdgePathCache);

test("A* effective cost matches the Dijkstra oracle across the weight matrix", () => {
  let combinations = 0;
  for (const scenario of scenarios) {
    for (const treeWeight of TREE_WEIGHTS) {
      for (const ferryWeight of FERRY_WEIGHTS) {
        for (const allowFerries of ALLOW) {
          const optimum = dijkstraCost(
            scenario.graph,
            scenario.start,
            scenario.dest,
            treeWeight,
            ferryWeight,
            allowFerries,
          );
          const result = findRoute(
            scenario.graph,
            scenario.start,
            scenario.dest,
            weights(treeWeight, ferryWeight, allowFerries),
          );
          expect(result).not.toBeNull();
          const cost = effectiveCostOf(
            scenario.graph,
            result as RouteResult,
            treeWeight,
            ferryWeight,
          );
          const label = `${scenario.name} tw=${treeWeight} fw=${ferryWeight} allow=${allowFerries}`;
          // The A* optimum must equal the true optimum; a mismatch means the heuristic over-estimated.
          expect(Math.abs(cost - optimum), label).toBeLessThan(1e-3);
          combinations += 1;
        }
      }
    }
  }
  // 5 scenarios x 3 tree x 3 ferry x 2 allow.
  expect(combinations).toBe(90);
});

// The same matrix with the estimate measured along the network instead of through the air. A
// tighter lower bound is still a lower bound, so every answer has to be the one above.
test("the network estimate leaves the A* optimum where it was", () => {
  for (const scenario of scenarios) {
    const reuse = {
      networkMeters: networkMetersTo(scenario.graph, scenario.dest),
    };
    for (const treeWeight of TREE_WEIGHTS) {
      for (const ferryWeight of FERRY_WEIGHTS) {
        for (const allowFerries of ALLOW) {
          const optimum = dijkstraCost(
            scenario.graph,
            scenario.start,
            scenario.dest,
            treeWeight,
            ferryWeight,
            allowFerries,
          );
          const result = findRoute(
            scenario.graph,
            scenario.start,
            scenario.dest,
            weights(treeWeight, ferryWeight, allowFerries),
            reuse,
          );
          const label = `${scenario.name} tw=${treeWeight} fw=${ferryWeight} allow=${allowFerries}`;
          expect(result, label).not.toBeNull();
          const cost = effectiveCostOf(
            scenario.graph,
            result as RouteResult,
            treeWeight,
            ferryWeight,
          );
          expect(Math.abs(cost - optimum), label).toBeLessThan(1e-3);
        }
      }
    }
  }
});

test("the sole crossing is optimal, and barring it leaves no route", () => {
  const start = snapAtNode(graphC, 0, walkEdgeC0);
  const dest = snapAtNode(graphC, 3, walkEdgeC3);
  for (const treeWeight of TREE_WEIGHTS) {
    for (const ferryWeight of FERRY_WEIGHTS) {
      const label = `C tw=${treeWeight} fw=${ferryWeight}`;
      const result = findRoute(
        graphC,
        start,
        dest,
        weights(treeWeight, ferryWeight, true),
      );
      expect(result, label).not.toBeNull();
      const optimum = dijkstraCost(
        graphC,
        start,
        dest,
        treeWeight,
        ferryWeight,
        true,
      );
      const cost = effectiveCostOf(
        graphC,
        result as RouteResult,
        treeWeight,
        ferryWeight,
      );
      // A twelve-kilometre boat against a 1.3 m/s walking bound is the widest gap the ferry credit
      // has to close; over-estimate here and the search would settle for something worse or, with
      // nothing worse to settle for, wander.
      expect(Math.abs(cost - optimum), label).toBeLessThan(1e-3);
      expect(
        findRoute(graphC, start, dest, weights(treeWeight, ferryWeight, false)),
        label,
      ).toBeNull();
    }
  }
});

test("the big-shortcut route boards the ferry when it is allowed", () => {
  for (const ferryWeight of FERRY_WEIGHTS) {
    const result = findRoute(
      graphA,
      snapAtNode(graphA, 0, walkEdgeA0),
      snapAtNode(graphA, 1, walkEdgeA1),
      weights(1, ferryWeight, true),
    );
    expect(hasFerryStep(result)).toBe(true);
  }
});

test("the two-ferry route boards both ferries when they are allowed", () => {
  const result = findRoute(
    graphB,
    snapAtNode(graphB, 0, walkEdgeB0),
    snapAtNode(graphB, 3, walkEdgeB3),
    weights(1, 0.4, true),
  );
  const ferrySteps = (result?.steps ?? []).filter(
    (step) => step.kind === "ferry",
  );
  expect(ferrySteps).toHaveLength(2);
});

test("each boat boarded is a leg of its own, timed at the crossing", () => {
  const result = findRoute(
    graphB,
    snapAtNode(graphB, 0, walkEdgeB0),
    snapAtNode(graphB, 3, walkEdgeB3),
    weights(1, 0.4, true),
  );
  const ferrySteps = (result?.steps ?? []).filter(
    (step) => step.kind === "ferry",
  );
  // The fixture carries no timetable, so a crossing costs the graph's baked figure and nothing is
  // waited for; two boats with a walk between them are two legs all the same.
  expect(result?.ferries).toEqual(
    ferrySteps.map((step) => ({
      route: null,
      waitSeconds: 0,
      crossingSeconds: graphB.edgeDurationSeconds[step.edge],
      ridesBefore: 0,
    })),
  );
});

// The boat is scenery in a mode that asks for it, and what a card says it got is the crossing: the
// wait on the pier is time on a pier.
test("the ferry chip is the crossing's share of the trip", () => {
  const result = findRoute(
    graphB,
    snapAtNode(graphB, 0, walkEdgeB0),
    snapAtNode(graphB, 3, walkEdgeB3),
    weights(1, 0.4, true),
  ) as RouteResult;
  const crossing = result.ferries.reduce(
    (total, boat) => total + boat.crossingSeconds,
    0,
  );
  expect(crossing).toBeGreaterThan(0);
  expect(result.factorSeconds.ferry).toBeCloseTo(crossing, 6);
  expect(result.factors.ferry).toBeCloseTo(crossing / result.travelSeconds, 6);
  expect(result.factors.ferry).toBeLessThan(1);
});

test("barred ferries are never boarded and the walk is ferry-weight-independent", () => {
  for (const scenario of scenarios) {
    let baseline: string | null = null;
    for (const ferryWeight of FERRY_WEIGHTS) {
      const result = findRoute(
        scenario.graph,
        scenario.start,
        scenario.dest,
        weights(1, ferryWeight, false),
      );
      expect(result).not.toBeNull();
      expect(hasFerryStep(result)).toBe(false);
      const signature = pathSignature(result);
      // Ferries barred, so the ferry weight cannot change the walking route.
      baseline ??= signature;
      expect(signature).toBe(baseline);
    }
  }
});

// What every node's trip to `goal` really costs, by plain Dijkstra out of it: the graph is
// undirected here, so the distances out of the goal are the costs into it.
function costsTo(
  graph: RoutingGraph,
  goal: number,
  routeWeights: ReturnType<typeof weights>,
): Float64Array {
  const distance = new Float64Array(graph.nodeCount).fill(
    Number.POSITIVE_INFINITY,
  );
  const settled = new Uint8Array(graph.nodeCount);
  distance[goal] = 0;
  for (;;) {
    let node = -1;
    let nodeDistance = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate < graph.nodeCount; candidate++) {
      if (!settled[candidate] && distance[candidate] < nodeDistance) {
        nodeDistance = distance[candidate];
        node = candidate;
      }
    }
    if (node === -1) {
      return distance;
    }
    settled[node] = 1;
    for (let slot = graph.csr[node]; slot < graph.csr[node + 1]; slot++) {
      const edge = graph.adjacency[slot];
      const neighbour = otherEnd(graph, edge, node);
      const relaxed = distance[node] + effSeconds(graph, edge, routeWeights);
      if (relaxed < distance[neighbour]) {
        distance[neighbour] = relaxed;
      }
    }
  }
}

// The A* estimate at `node`, built the way findRoute builds it: the walking bound on the straight
// line, less the ferry credit — the only credit a graph with no rail on it has — and never below
// what the floor alone bounds the same line by.
function estimateTo(
  graph: RoutingGraph,
  node: number,
  goal: number,
  routeWeights: ReturnType<typeof weights>,
): number {
  const meters = haversineMeters(
    graph.originLat + graph.nodeQy[node] * graph.scale,
    graph.originLng + graph.nodeQx[node] * graph.scale,
    graph.originLat + graph.nodeQy[goal] * graph.scale,
    graph.originLng + graph.nodeQx[goal] * graph.scale,
  );
  return Math.max(
    0,
    walkSecondsCoeff(graph, routeWeights) * meters -
      ferryCredit(graph, routeWeights),
    heuristicFloor(graph, routeWeights) * meters,
  );
}

test("the estimate to a pier never beats the cost of getting there", () => {
  const lines: { name: string; graph: RoutingGraph; goal: number }[] = [
    { name: "D", graph: graphD, goal: 3 },
    { name: "E", graph: graphE, goal: 4 },
  ];
  for (const { name, graph, goal } of lines) {
    for (const treeWeight of TREE_WEIGHTS) {
      for (const ferryWeight of FERRY_WEIGHTS) {
        const routeWeights = weights(treeWeight, ferryWeight, true);
        const truth = costsTo(graph, goal, routeWeights);
        for (let node = 0; node < graph.nodeCount; node++) {
          const label = `${name} node ${node} tw=${treeWeight} fw=${ferryWeight}`;
          expect(
            estimateTo(graph, node, goal, routeWeights),
            label,
          ).toBeLessThanOrEqual(truth[node] + 1e-6);
        }
      }
    }
  }
});

test("the four-hop line is ridden rather than walked round", () => {
  const result = findRoute(
    graphE,
    snapAtNode(graphE, 0, walkEdgeE0),
    snapAtNode(graphE, 4, walkEdgeE4),
    weights(0, 0, true),
  );
  const ferrySteps = (result?.steps ?? []).filter(
    (step) => step.kind === "ferry",
  );
  expect(ferrySteps).toHaveLength(4);
});

import { expect, test } from "bun:test";
import {
  ALL_FACTORS,
  DEFAULT_MODE,
  DEFAULT_TOGGLES,
  effectiveWeights,
} from "../modes/modes";
import {
  DEFAULT_HIGHWAY_WEIGHT,
  edgeMultiplier,
  effSeconds,
  MAX_BRIDGE_WEIGHT,
  MAX_HIGHWAY_WEIGHT,
  MAX_HISTORIC_WEIGHT,
  MAX_INDUSTRIAL_WEIGHT,
  minMultiplier,
  type RouteWeights,
  WALK_METERS_PER_SECOND,
} from "./cost";
import { NO_GEOMETRY, otherEnd, type RoutingGraph } from "./graph";
import { findRoute, type RouteResult } from "./search";
import { haversineMeters, type Snap } from "./snap";

// The oracle is its own Dijkstra, not findRoute, an independent check rather than A* against A*.

const SCALE = 1e-6;
const NAME_NONE = 0xffff;
const KIND_SIDEWALK = 0;

const noScenic = (over: Partial<RouteWeights> = {}): RouteWeights => ({
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
  allowSheds: true,
  // Stated because omitting it would read as "avoid crossings".
  allowTransit: false,
  allowCrossings: true,
  ...over,
});

interface NodeSpec {
  lat: number;
  lng: number;
}

// The ingest bytes are these × 255.
interface EdgeAttrs {
  cover?: number;
  landmark?: number;
  art?: number;
  highway?: number;
  commercial?: number;
  industrial?: number;
  historic?: number;
  bridge?: number;
}

interface EdgeSpec extends EdgeAttrs {
  a: number;
  b: number;
}

function buildGraph(nodes: NodeSpec[], edges: EdgeSpec[]): RoutingGraph {
  const nodeCount = nodes.length;
  const edgeCount = edges.length;
  const nodeQx = new Int32Array(nodeCount);
  const nodeQy = new Int32Array(nodeCount);
  for (let node = 0; node < nodeCount; node++) {
    nodeQx[node] = Math.round(nodes[node].lng / SCALE);
    nodeQy[node] = Math.round(nodes[node].lat / SCALE);
  }
  const nodeLat = (node: number): number => nodeQy[node] * SCALE;
  const nodeLng = (node: number): number => nodeQx[node] * SCALE;

  const edgeNodeA = new Uint32Array(edgeCount);
  const edgeNodeB = new Uint32Array(edgeCount);
  const edgeLength = new Float32Array(edgeCount);
  const edgeCover = new Uint8Array(edgeCount);
  const edgeLandmark = new Uint8Array(edgeCount);
  const edgeArt = new Uint8Array(edgeCount);
  const edgeHighway = new Uint8Array(edgeCount);
  const edgeCommercial = new Uint8Array(edgeCount);
  const edgeIndustrial = new Uint8Array(edgeCount);
  const edgeHistoric = new Uint8Array(edgeCount);
  const edgeBridge = new Uint8Array(edgeCount);
  const edgeKindSide = new Uint8Array(edgeCount);
  const edgeDurationSeconds = new Uint16Array(edgeCount);
  const edgeNameId = new Uint16Array(edgeCount).fill(NAME_NONE);
  const edgeGeomOffset = new Uint32Array(edgeCount).fill(NO_GEOMETRY);
  const edgeGeomCount = new Uint16Array(edgeCount);
  const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
  const byte = (fraction: number | undefined): number =>
    Math.min(254, Math.round((fraction ?? 0) * 255));
  let maxCover = 0;
  let maxLandmark = 0;
  let maxArt = 0;
  let maxCommercial = 0;
  let maxIndustrial = 0;
  let maxHistoric = 0;
  let maxBridge = 0;
  for (let edge = 0; edge < edgeCount; edge++) {
    const spec = edges[edge];
    edgeNodeA[edge] = spec.a;
    edgeNodeB[edge] = spec.b;
    edgeLength[edge] = haversineMeters(
      nodeLat(spec.a),
      nodeLng(spec.a),
      nodeLat(spec.b),
      nodeLng(spec.b),
    );
    edgeKindSide[edge] = KIND_SIDEWALK;
    edgeCover[edge] = byte(spec.cover);
    edgeLandmark[edge] = byte(spec.landmark);
    edgeArt[edge] = byte(spec.art);
    edgeHighway[edge] = byte(spec.highway);
    edgeCommercial[edge] = byte(spec.commercial);
    edgeIndustrial[edge] = byte(spec.industrial);
    edgeHistoric[edge] = byte(spec.historic);
    edgeBridge[edge] = byte(spec.bridge);
    maxCover = Math.max(maxCover, edgeCover[edge]);
    maxLandmark = Math.max(maxLandmark, edgeLandmark[edge]);
    maxArt = Math.max(maxArt, edgeArt[edge]);
    maxCommercial = Math.max(maxCommercial, edgeCommercial[edge]);
    maxIndustrial = Math.max(maxIndustrial, edgeIndustrial[edge]);
    maxHistoric = Math.max(maxHistoric, edgeHistoric[edge]);
    maxBridge = Math.max(maxBridge, edgeBridge[edge]);
    adjacency[spec.a].push(edge);
    adjacency[spec.b].push(edge);
  }

  const csr = new Uint32Array(nodeCount + 1);
  const flatAdjacency = new Uint32Array(2 * edgeCount);
  let cursor = 0;
  for (let node = 0; node < nodeCount; node++) {
    csr[node] = cursor;
    for (const edge of adjacency[node]) {
      flatAdjacency[cursor] = edge;
      cursor += 1;
    }
  }
  csr[nodeCount] = cursor;

  return {
    nodeCount,
    edgeCount,
    originLng: 0,
    originLat: 0,
    scale: SCALE,
    nodeQx,
    nodeQy,
    csr,
    adjacency: flatAdjacency,
    edgeNodeA,
    edgeNodeB,
    edgeLength,
    edgeGeomOffset,
    edgeGeomCount,
    edgeCover,
    edgeNameId,
    edgeKindSide,
    maxCover: maxCover / 255,
    edgeLandmark,
    edgeArt,
    edgeHighway,
    edgeAscent: new Uint8Array(edgeCount),
    edgeDescent: new Uint8Array(edgeCount),
    maxRelief: 0,
    edgeCommercial,
    edgeIndustrial,
    edgeHistoric,
    edgeBridge,
    maxLandmark: maxLandmark / 255,
    maxArt: maxArt / 255,
    maxCommercial: maxCommercial / 255,
    maxIndustrial: maxIndustrial / 255,
    maxHistoric: maxHistoric / 255,
    maxBridge: maxBridge / 255,
    shade: null,
    edgeDurationSeconds,
    ferryEdges: new Uint32Array(0),
    names: [],
    geometry: new Uint8Array(0),
  } as unknown as RoutingGraph;
}

function snapAtNode(graph: RoutingGraph, node: number, walkEdge: number): Snap {
  const atA = graph.edgeNodeA[walkEdge] === node;
  return {
    edge: walkEdge,
    metersFromA: atA ? 0 : graph.edgeLength[walkEdge],
    point: {
      lat: graph.nodeQy[node] * graph.scale,
      lng: graph.nodeQx[node] * graph.scale,
    },
    distanceMeters: 0,
    component: 0,
  };
}

// Mirrors findRoute's virtual-source and virtual-goal partial-edge semantics.
function dijkstraCost(
  graph: RoutingGraph,
  start: Snap,
  dest: Snap,
  weights: RouteWeights,
): number {
  const nodeCount = graph.nodeCount;
  const distance = new Float64Array(nodeCount).fill(Number.POSITIVE_INFINITY);
  const settled = new Uint8Array(nodeCount);

  const startA = graph.edgeNodeA[start.edge];
  const startB = graph.edgeNodeB[start.edge];
  const startPerMeter =
    edgeMultiplier(graph, start.edge, weights) / WALK_METERS_PER_SECOND;
  const startLength = graph.edgeLength[start.edge];
  distance[startA] = start.metersFromA * startPerMeter;
  distance[startB] = (startLength - start.metersFromA) * startPerMeter;

  const destA = graph.edgeNodeA[dest.edge];
  const destB = graph.edgeNodeB[dest.edge];
  const destPerMeter =
    edgeMultiplier(graph, dest.edge, weights) / WALK_METERS_PER_SECOND;
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
      const relaxed = distance[node] + effSeconds(graph, edge, weights);
      const neighbor = otherEnd(graph, edge, node);
      if (relaxed < distance[neighbor]) {
        distance[neighbor] = relaxed;
      }
    }
  }

  return Math.min(
    best,
    distance[destA] + dest.metersFromA * destPerMeter,
    distance[destB] + (destLength - dest.metersFromA) * destPerMeter,
  );
}

function effectiveCostOf(
  graph: RoutingGraph,
  result: RouteResult,
  weights: RouteWeights,
): number {
  let cost = 0;
  for (const step of result.steps) {
    cost +=
      (step.lengthMeters / WALK_METERS_PER_SECOND) *
      edgeMultiplier(graph, step.edge, weights);
  }
  return cost;
}

// 0->1->3 is the "upper", 0->2->3 the "lower"; `upperLat`/`lowerLat` make one a genuine detour.
function diamond(
  upper: EdgeAttrs,
  lower: EdgeAttrs,
  upperLat = 0.001,
  lowerLat = 0.001,
): {
  graph: RoutingGraph;
  start: Snap;
  dest: Snap;
} {
  const nodes: NodeSpec[] = [
    { lat: 0, lng: 0 }, // 0 origin
    { lat: upperLat, lng: 0.0015 }, // 1 upper
    { lat: -lowerLat, lng: 0.0015 }, // 2 lower
    { lat: 0, lng: 0.003 }, // 3 destination
    { lat: 0, lng: -0.0005 }, // 4 start stub
    { lat: 0, lng: 0.0035 }, // 5 dest stub
  ];
  const edges: EdgeSpec[] = [
    { a: 4, b: 0 }, // start stub (plain)
    { a: 0, b: 1, ...upper },
    { a: 1, b: 3, ...upper },
    { a: 0, b: 2, ...lower },
    { a: 2, b: 3, ...lower },
    { a: 3, b: 5 }, // dest stub (plain)
  ];
  const graph = buildGraph(nodes, edges);
  return {
    graph,
    start: snapAtNode(graph, 0, 0),
    dest: snapAtNode(graph, 3, 5),
  };
}

function upperTaken(result: RouteResult | null): boolean {
  return (result?.steps ?? []).some(
    (step) => step.edge === 1 || step.edge === 2,
  );
}

test("edgeMultiplier and minMultiplier reduce to the tree-only model when the new weights are zero", () => {
  const { graph } = diamond({ cover: 0.6, landmark: 0.4 }, { highway: 0.5 });
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    expect(edgeMultiplier(graph, edge, noScenic())).toBeCloseTo(1, 12);
    // Exactly 1 - w*cover.
    const treeOnly = noScenic({ tree: 0.8 });
    expect(edgeMultiplier(graph, edge, treeOnly)).toBeCloseTo(
      1 - 0.8 * (graph.edgeCover[edge] / 255),
      12,
    );
  }
  expect(minMultiplier(graph, noScenic())).toBeCloseTo(1, 12);
  expect(minMultiplier(graph, noScenic({ tree: 0.8 }))).toBeCloseTo(
    1 - 0.8 * graph.maxCover,
    12,
  );
});

test("edgeMultiplier is the product of the three discounts and the highway penalty", () => {
  const { graph } = diamond(
    { cover: 0.5, landmark: 0.4, art: 0.2, highway: 0.6 },
    {},
  );
  const weights = noScenic({
    tree: 0.8,
    landmark: 0.5,
    art: 0.3,
    highway: 0.7,
    hill: 0,
  });
  const edge = 1; // the upper 0->1 edge, which carries all four attributes
  const expected =
    (1 - 0.8 * (graph.edgeCover[edge] / 255)) *
    (1 - 0.5 * (graph.edgeLandmark[edge] / 255)) *
    (1 - 0.3 * (graph.edgeArt[edge] / 255)) *
    (1 + 0.7 * (graph.edgeHighway[edge] / 255));
  expect(edgeMultiplier(graph, edge, weights)).toBeCloseTo(expected, 12);
  expect(edgeMultiplier(graph, edge, weights)).toBeGreaterThan(0);
});

test("findRoute matches the Dijkstra optimum across scenic-weight combinations", () => {
  // Sweeping the weights makes each route optimal in some regime.
  const { graph, start, dest } = diamond(
    { landmark: 0.8, art: 0.6 },
    { highway: 0.7 },
  );
  const grid = [0, 0.5, 1];
  let combinations = 0;
  for (const tree of grid) {
    for (const landmark of grid) {
      for (const art of grid) {
        for (const highway of grid) {
          const weights = noScenic({ tree, landmark, art, highway });
          const optimum = dijkstraCost(graph, start, dest, weights);
          const result = findRoute(graph, start, dest, weights);
          expect(result).not.toBeNull();
          const cost = effectiveCostOf(graph, result as RouteResult, weights);
          const label = `tree=${tree} lm=${landmark} art=${art} hw=${highway}`;
          expect(Math.abs(cost - optimum), label).toBeLessThan(1e-3);
          combinations += 1;
        }
      }
    }
  }
  expect(combinations).toBe(81);
});

test("a strong landmark weight steers the route onto a longer landmarked path", () => {
  // A ~35% detour, so the discount has to overcome real extra distance.
  const { graph, start, dest } = diamond(
    { landmark: 0.9 },
    {},
    0.0028, // upper bows far out — the longer path
    0.0002, // lower stays near the straight line — the shorter path
  );
  expect(upperTaken(findRoute(graph, start, dest, noScenic()))).toBe(false);
  expect(
    upperTaken(findRoute(graph, start, dest, noScenic({ landmark: 1 }))),
  ).toBe(true);
});

test("a strong commercial weight steers the route onto a nicer commercial street", () => {
  // A ~35% detour, so the discount has to overcome real extra distance.
  const { graph, start, dest } = diamond(
    { commercial: 0.9 },
    {},
    0.0028, // upper bows far out — the longer path
    0.0002, // lower stays near the straight line — the shorter path
  );
  expect(upperTaken(findRoute(graph, start, dest, noScenic()))).toBe(false);
  expect(
    upperTaken(findRoute(graph, start, dest, noScenic({ commercial: 1 }))),
  ).toBe(true);
});

test("edgeMultiplier prices a historic district as a discount beside the landmark one", () => {
  // Independent factors, so they multiply.
  const { graph } = diamond({ landmark: 0.4, historic: 0.9 }, {});
  const weights = noScenic({ landmark: 0.5, historic: 0.3 });
  const edge = 1; // the upper 0->1 edge, which carries both
  const expected =
    (1 - 0.5 * (graph.edgeLandmark[edge] / 255)) *
    (1 - 0.3 * (graph.edgeHistoric[edge] / 255));

  expect(edgeMultiplier(graph, edge, weights)).toBeCloseTo(expected, 12);
  // A discount enters the heuristic's lower bound, unlike the industrial penalty below.
  expect(minMultiplier(graph, weights)).toBeCloseTo(
    (1 - 0.3 * graph.maxHistoric) * (1 - 0.5 * graph.maxLandmark),
    12,
  );
});

test("a strong historic weight steers the route through a district it would otherwise skirt", () => {
  // A ~35% detour, so the discount has to overcome real extra distance.
  const { graph, start, dest } = diamond(
    { historic: 0.9 },
    {},
    0.0028, // upper bows far out — the longer path
    0.0002, // lower stays near the straight line — the shorter path
  );

  expect(upperTaken(findRoute(graph, start, dest, noScenic()))).toBe(false);
  expect(
    upperTaken(findRoute(graph, start, dest, noScenic({ historic: 1 }))),
  ).toBe(true);
});

test("the historic discount keeps a positive floor at the top of its slider", () => {
  // Why the bake caps at 254: at w = 1 a saturated floor of 0 would make in-district meters free.
  const { graph, start, dest } = diamond({ historic: 1 }, { historic: 1 });
  const full = noScenic({ historic: MAX_HISTORIC_WEIGHT });

  expect(graph.maxHistoric).toBeLessThan(1);
  expect(minMultiplier(graph, full)).toBeGreaterThan(0);
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    expect(edgeMultiplier(graph, edge, full)).toBeGreaterThan(0);
    // The bound has to hold edge by edge, which is what makes the estimate admissible.
    expect(edgeMultiplier(graph, edge, full)).toBeGreaterThanOrEqual(
      minMultiplier(graph, full) - 1e-12,
    );
  }
  const result = findRoute(graph, start, dest, full);
  expect(result).not.toBeNull();
  expect(
    Math.abs(
      effectiveCostOf(graph, result as RouteResult, full) -
        dijkstraCost(graph, start, dest, full),
    ),
  ).toBeLessThan(1e-3);
});

test("edgeMultiplier prices industrial frontage as a penalty beside the highway one", () => {
  const { graph } = diamond({ highway: 0.6, industrial: 0.4 }, {});
  const weights = noScenic({ highway: 0.7, industrial: 0.5 });
  const edge = 1; // the upper 0->1 edge, which carries both penalties
  const expected =
    (1 + 0.7 * (graph.edgeHighway[edge] / 255)) *
    (1 + 0.5 * (graph.edgeIndustrial[edge] / 255));

  expect(edgeMultiplier(graph, edge, weights)).toBeCloseTo(expected, 12);
  // A penalty's minimum factor is 1, so it must not enter the heuristic's lower bound.
  expect(minMultiplier(graph, weights)).toBeCloseTo(
    minMultiplier(graph, noScenic()),
    12,
  );
});

test("an industrial weight steers the route away from a shorter walk past the yards", () => {
  // Both sides industrial, so the byte is near its ceiling.
  const { graph, start, dest } = diamond(
    { industrial: 0.9 },
    {},
    0.0002, // upper is the shorter path...
    0.001, // ...the lower a modestly longer detour the penalty can tip
  );

  expect(upperTaken(findRoute(graph, start, dest, noScenic()))).toBe(true);
  expect(
    upperTaken(findRoute(graph, start, dest, noScenic({ industrial: 1 }))),
  ).toBe(false);
});

test("a highway weight steers the route away from a shorter nuisance path", () => {
  const { graph, start, dest } = diamond(
    { highway: 0.9 },
    {},
    0.0002, // upper is the shorter path...
    0.001, // ...the lower a modestly longer detour the penalty can tip
  );
  expect(upperTaken(findRoute(graph, start, dest, noScenic()))).toBe(true);
  expect(
    upperTaken(findRoute(graph, start, dest, noScenic({ highway: 1 }))),
  ).toBe(false);
});

test("Naturalist spends the top of the highway slider", () => {
  const mode = effectiveWeights(DEFAULT_MODE, DEFAULT_TOGGLES, ALL_FACTORS);
  expect(mode.highway).toBe(MAX_HIGHWAY_WEIGHT);
  expect(mode.industrial).toBe(MAX_INDUSTRIAL_WEIGHT);

  // The lower detour is long enough that only the top of the highway slider pays for it.
  const { graph, start, dest } = diamond({ highway: 0.9 }, {}, 0.0002, 0.003);
  const naturalist = (highway: number): RouteWeights =>
    noScenic({
      tree: mode.tree,
      bridge: mode.bridge,
      industrial: mode.industrial,
      highway,
    });

  expect(upperTaken(findRoute(graph, start, dest, naturalist(0)))).toBe(true);
  expect(
    upperTaken(
      findRoute(graph, start, dest, naturalist(DEFAULT_HIGHWAY_WEIGHT)),
    ),
  ).toBe(true);
  expect(upperTaken(findRoute(graph, start, dest, naturalist(1)))).toBe(true);
  expect(
    upperTaken(findRoute(graph, start, dest, naturalist(mode.highway))),
  ).toBe(false);
});

test("edgeMultiplier prices a bridge over water as a discount of its own", () => {
  // Independent facts about the same meter, so they multiply.
  const { graph } = diamond({ landmark: 0.4, bridge: 0.8 }, {});
  const weights = noScenic({ landmark: 0.5, bridge: 0.3 });
  const edge = 1; // the upper 0->1 edge, which carries both

  expect(edgeMultiplier(graph, edge, weights)).toBeCloseTo(
    (1 - 0.5 * (graph.edgeLandmark[edge] / 255)) *
      (1 - 0.3 * (graph.edgeBridge[edge] / 255)),
    12,
  );
  expect(minMultiplier(graph, weights)).toBeCloseTo(
    (1 - 0.3 * graph.maxBridge) * (1 - 0.5 * graph.maxLandmark),
    12,
  );
});

test("a strong bridge weight takes the span rather than the shorter way round", () => {
  const { graph, start, dest } = diamond(
    { bridge: 0.9 },
    {},
    0.0028, // upper bows far out — the longer path, and the one over water
    0.0002, // lower stays near the straight line — the shorter path
  );

  expect(upperTaken(findRoute(graph, start, dest, noScenic()))).toBe(false);
  expect(
    upperTaken(findRoute(graph, start, dest, noScenic({ bridge: 1 }))),
  ).toBe(true);
});

test("the bridge discount keeps a positive floor at the top of its slider", () => {
  // A mid-span edge saturates the byte, so at w = 1 the graph's floor must stay positive.
  const { graph } = diamond({ bridge: 1 }, { bridge: 1 });
  const full = noScenic({ bridge: MAX_BRIDGE_WEIGHT });

  expect(graph.maxBridge).toBeLessThan(1);
  expect(minMultiplier(graph, full)).toBeGreaterThan(0);
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    expect(edgeMultiplier(graph, edge, full)).toBeGreaterThanOrEqual(
      minMultiplier(graph, full) - 1e-12,
    );
  }
});

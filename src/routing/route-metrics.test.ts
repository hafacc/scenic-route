import { expect, test } from "bun:test";
import {
  clearEdgePathCache,
  NO_GEOMETRY,
  NO_SOURCE_ID,
  type RoutingGraph,
} from "./graph";
import {
  crossingReversals,
  detourRatio,
  longestCrossingRun,
} from "./route-metrics";
import type { RouteFactors, RouteResult, RouteStep } from "./search";
import { haversineMeters, type Snap } from "./snap";

// Geometry-less edges draw straight between their nodes, which is what a real crossing is too.

const SCALE = 1e-6;
const NAME_NONE = 0xffff;
const KIND_SIDEWALK = 0;
const KIND_CROSSING = 1;

interface NodeSpec {
  lat: number;
  lng: number;
}

interface EdgeSpec {
  a: number;
  b: number;
  crossing?: boolean;
  name?: string;
}

function buildGraph(nodes: NodeSpec[], edges: EdgeSpec[]): RoutingGraph {
  clearEdgePathCache(); // edge ids repeat across the graphs these tests build
  const nodeCount = nodes.length;
  const edgeCount = edges.length;
  const nodeQx = Int32Array.from(nodes, (node) => Math.round(node.lng / SCALE));
  const nodeQy = Int32Array.from(nodes, (node) => Math.round(node.lat / SCALE));
  const nodeLat = (node: number): number => nodeQy[node] * SCALE;
  const nodeLng = (node: number): number => nodeQx[node] * SCALE;

  const names: string[] = [];
  const edgeNodeA = new Uint32Array(edgeCount);
  const edgeNodeB = new Uint32Array(edgeCount);
  const edgeLength = new Float32Array(edgeCount);
  const edgeKindSide = new Uint8Array(edgeCount);
  const edgeNameId = new Uint16Array(edgeCount).fill(NAME_NONE);
  const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
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
    edgeKindSide[edge] = spec.crossing ? KIND_CROSSING : KIND_SIDEWALK;
    if (spec.name !== undefined) {
      edgeNameId[edge] = names.length;
      names.push(spec.name);
    }
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
    hash: "",
    keyHash: "",
    nodeCount,
    edgeCount,
    originLng: 0,
    originLat: 0,
    scale: SCALE,
    nodeQx,
    nodeQy,
    nodeComponent: new Uint16Array(nodeCount),
    csr,
    adjacency: flatAdjacency,
    edgeNodeA,
    edgeNodeB,
    edgeLength,
    edgeGeomOffset: new Uint32Array(edgeCount).fill(NO_GEOMETRY),
    edgeGeomCount: new Uint16Array(edgeCount),
    edgeCover: new Uint8Array(edgeCount),
    edgeNameId,
    edgeKindSide,
    edgeSourceId: new Uint32Array(edgeCount).fill(NO_SOURCE_ID),
    edgeOrdinal: new Uint8Array(edgeCount),
    nodeMidRoadway: new Uint8Array(nodeCount),
    maxCover: 0,
    edgeLandmark: new Uint8Array(edgeCount),
    edgeArt: new Uint8Array(edgeCount),
    edgeHighway: new Uint8Array(edgeCount),
    edgeCommercial: new Uint8Array(edgeCount),
    edgeIndustrial: new Uint8Array(edgeCount),
    edgeHistoric: new Uint8Array(edgeCount),
    edgeBridge: new Uint8Array(edgeCount),
    maxLandmark: 0,
    maxArt: 0,
    maxCommercial: 0,
    maxIndustrial: 0,
    maxHistoric: 0,
    maxBridge: 0,
    edgeDirectCanopy: new Uint8Array(edgeCount),
    edgeAscent: new Uint8Array(edgeCount),
    edgeDescent: new Uint8Array(edgeCount),
    maxRelief: 0,
    maxDirectCanopy: 0,
    walkSeconds: null,
    shade: null,
    sheds: null,
    ferries: null,
    edgeDurationSeconds: new Uint16Array(edgeCount),
    ferryEdges: new Uint32Array(0),
    minFerrySecPerMeter: Number.POSITIVE_INFINITY,
    transitEdges: new Uint32Array(0),
    boardEdges: new Uint32Array(0),
    transitRoutes: [],
    minRideSecPerMeter: Number.POSITIVE_INFINITY,
    minAccessSecPerMeter: Number.POSITIVE_INFINITY,
    transitLaneOf: new Map(),
    transitStopOf: new Map(),
    transitRouteOf: new Map(),
    transitDoorStreet: new Map(),
    nodePlatform: new Uint8Array(nodeCount),
    transit: null,
    edgeFlags: new Uint8Array(edgeCount),
    hasTunnels: false,
    names,
    geometry: new Uint8Array(0),
    ferryEndpointNames: new Map(),
  };
}

// Each traveled a -> b unless `false` is given; snaps pinned to the route's end nodes.
function routeOver(
  graph: RoutingGraph,
  legs: readonly (readonly [number, boolean])[],
): RouteResult {
  const steps: RouteStep[] = legs.map(([edge, forward]) => ({
    edge,
    forward,
    kind: graph.edgeKindSide[edge] === KIND_CROSSING ? "crossing" : "sidewalk",
    side: null,
    name:
      graph.edgeNameId[edge] === NAME_NONE
        ? null
        : graph.names[graph.edgeNameId[edge]],
    cover: 0,
    lengthMeters: graph.edgeLength[edge],
  }));
  const pointOf = (node: number): { lat: number; lng: number } => ({
    lat: graph.nodeQy[node] * SCALE,
    lng: graph.nodeQx[node] * SCALE,
  });
  const [firstEdge, firstForward] = legs[0];
  const [lastEdge, lastForward] = legs[legs.length - 1];
  const snap = (point: { lat: number; lng: number }): Snap => ({
    edge: 0,
    metersFromA: 0,
    point,
    distanceMeters: 0,
    component: 0,
  });
  const noFactors = (): RouteFactors => ({
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
  });
  return {
    path: { lats: new Float64Array(0), lngs: new Float64Array(0) },
    steps,
    lengthMeters: steps.reduce((sum, step) => sum + step.lengthMeters, 0),
    walkMeters: steps.reduce((sum, step) => sum + step.lengthMeters, 0),
    travelSeconds: 0,
    transitSeconds: 0,
    rides: [],
    ferries: [],
    factors: noFactors(),
    factorSeconds: noFactors(),
    start: snap(
      pointOf(
        firstForward ? graph.edgeNodeA[firstEdge] : graph.edgeNodeB[firstEdge],
      ),
    ),
    dest: snap(
      pointOf(
        lastForward ? graph.edgeNodeB[lastEdge] : graph.edgeNodeA[lastEdge],
      ),
    ),
  };
}

// South (0-1-2) and north (3-4-5) pavements 12 m apart; 2 -> 6 crosses a perpendicular street.
const JUNCTION_NODES: NodeSpec[] = [
  { lat: 0, lng: 0 }, // 0 south pavement, west end
  { lat: 0, lng: 0.0005 }, // 1 south pavement, mid block (~42 m east)
  { lat: 0, lng: 0.001 }, // 2 south pavement, east end
  { lat: 0.000108, lng: 0 }, // 3 north pavement, west end (~12 m north of 0)
  { lat: 0.000108, lng: 0.0005 }, // 4 north pavement, mid block
  { lat: 0.000108, lng: 0.001 }, // 5 north pavement, east end
  { lat: 0, lng: 0.00118 }, // 6 across the cross street from 2 (~20 m east)
];

// Mid-block pair pulled to ~11 m from the west end, within the reversal gap.
const NEAR_NODES: NodeSpec[] = JUNCTION_NODES.map((node, index) =>
  index === 1 || index === 4 ? { ...node, lng: 0.0001 } : node,
);

const JUNCTION_EDGES: EdgeSpec[] = [
  { a: 0, b: 1 }, // 0 south pavement, west half
  { a: 1, b: 2 }, // 1 south pavement, east half
  { a: 3, b: 4 }, // 2 north pavement, west half
  { a: 4, b: 5 }, // 3 north pavement, east half
  { a: 0, b: 3, crossing: true, name: "WEST CROSSING" }, // 4
  { a: 1, b: 4, crossing: true, name: "MID CROSSING" }, // 5
  { a: 2, b: 5, crossing: true, name: "EAST CROSSING" }, // 6
  { a: 2, b: 6, crossing: true, name: "CROSS ST" }, // 7
];

test("crossing out and straight back at one corner is a reversal", () => {
  const graph = buildGraph(JUNCTION_NODES, JUNCTION_EDGES);
  const route = routeOver(graph, [
    [0, true],
    [5, true],
    [5, false],
  ]);

  const reversals = crossingReversals(graph, route);

  expect(reversals).toHaveLength(1);
  expect(reversals[0].name).toBe("MID CROSSING");
  expect(reversals[0].walkBetweenMeters).toBeCloseTo(0, 5);
  expect(reversals[0].crossedMeters).toBeCloseTo(24, 0);
});

test("crossing out, walking a few meters, and crossing back is still a reversal", () => {
  const graph = buildGraph(JUNCTION_NODES, JUNCTION_EDGES);
  // A full block between the crossings exceeds the gap, hence the near junction.
  const near = buildGraph(NEAR_NODES, JUNCTION_EDGES);
  const route = routeOver(near, [
    [4, true],
    [2, true],
    [5, false],
  ]);

  const reversals = crossingReversals(near, route);

  expect(reversals).toHaveLength(1);
  expect(reversals[0].walkBetweenMeters).toBeCloseTo(11.1, 0);
  const far = routeOver(graph, [
    [4, true],
    [2, true],
    [5, false],
  ]);
  expect(crossingReversals(graph, far)).toHaveLength(0);
});

test("turning the corner across two different streets is not a reversal", () => {
  const graph = buildGraph(JUNCTION_NODES, JUNCTION_EDGES);
  // Back to back with no pavement between but at right angles: only the direction test rules it out.
  const route = routeOver(graph, [
    [6, false],
    [7, true],
  ]);

  expect(crossingReversals(graph, route)).toHaveLength(0);

  const back = routeOver(graph, [
    [1, true],
    [6, true],
    [6, false],
  ]);
  expect(crossingReversals(graph, back)).toHaveLength(1);
});

test("a reversal is avoidable when the near side joins its two ends, and forced when it does not", () => {
  const near = buildGraph(NEAR_NODES, JUNCTION_EDGES);
  // The south pavement joins the ends in 11 m, inside the 35 m the reversal spent.
  const bought = crossingReversals(
    near,
    routeOver(near, [
      [4, true],
      [2, true],
      [5, false],
    ]),
  );

  expect(bought.map((reversal) => reversal.avoidable)).toEqual([true]);

  const broken = buildGraph(
    NEAR_NODES,
    JUNCTION_EDGES.filter((_, edge) => edge !== 0),
  );
  const forced = crossingReversals(
    broken,
    routeOver(broken, [
      [3, true], // edge ids shift down by one with edge 0 gone: the west crossing
      [1, true], // north pavement, west half
      [4, false], // the mid crossing, back to the south side
    ]),
  );
  expect(forced.map((reversal) => reversal.avoidable)).toEqual([false]);
});

test("the longest crossing run counts consecutive crossings, not all of them", () => {
  const graph = buildGraph(JUNCTION_NODES, JUNCTION_EDGES);
  // A median crossing's two halves look exactly like this.
  const route = routeOver(graph, [
    [4, true],
    [2, true],
    [3, true],
    [6, false],
    [1, false],
    [5, true],
  ]);

  expect(longestCrossingRun(route)).toBe(1);
  expect(
    longestCrossingRun(
      routeOver(graph, [
        [0, true],
        [5, true],
        [3, true],
        [6, false],
        [7, true],
      ]),
    ),
  ).toBe(2);
});

test("the detour ratio is walked meters over the straight line between the snaps", () => {
  const graph = buildGraph(JUNCTION_NODES, JUNCTION_EDGES);
  const straight = routeOver(graph, [
    [0, true],
    [1, true],
  ]);

  expect(detourRatio(straight)).toBeCloseTo(1, 3);

  const around = routeOver(graph, [
    [4, true],
    [2, true],
    [3, true],
    [6, false],
  ]);
  const straightMeters = haversineMeters(
    around.start.point.lat,
    around.start.point.lng,
    around.dest.point.lat,
    around.dest.point.lng,
  );
  expect(detourRatio(around)).toBeCloseTo(
    around.walkMeters / straightMeters,
    6,
  );
  expect(detourRatio(around) as number).toBeGreaterThan(1.2);
});

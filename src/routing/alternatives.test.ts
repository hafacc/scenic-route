import { expect, test } from "bun:test";
import {
  CARD_ORDER,
  DIFFERENT_METERS,
  planRoutes,
  routeDistanceMeters,
  selectCards,
  selectionDiagnostics,
  undominated,
} from "./alternatives";
import {
  MAX_COMMERCIAL_WEIGHT,
  MAX_INDUSTRIAL_WEIGHT,
  MAX_SHELTER_WEIGHT,
  MAX_TRANSIT_WEIGHT,
  MAX_TREE_WEIGHT,
  minMultiplier,
  type RouteWeights,
} from "./cost";
import { clearEdgePathCache, NO_GEOMETRY, type RoutingGraph } from "./graph";
import { findRoute, type RouteResult } from "./search";
import { haversineMeters, type Snap } from "./snap";
import {
  ACCESS_SECONDS,
  departureReaching,
  EAST_SIDEWALK,
  fixtureTimetable,
  snapAtNode,
  transitGraph,
  transitWeights,
  WEST_SIDEWALK,
} from "./transit-graph.fixture";

// Four corridors: direct wins at zero, deep canopy at full weight, shallow canopy for t in (0.10, 0.51).

const SCALE = 1e-6;
const KIND_SIDEWALK = 0;
const NAME_NONE = 0xffff;
const SPACING = 0.004; // degrees; ~445 m at the equator

interface EdgeSpec {
  a: number;
  b: number;
  cover?: number;
  commercial?: number;
  industrial?: number;
}

function buildGraph(
  nodes: { lat: number; lng: number }[],
  edges: EdgeSpec[],
): RoutingGraph {
  const nodeCount = nodes.length;
  const edgeCount = edges.length;
  const nodeQx = new Int32Array(nodeCount);
  const nodeQy = new Int32Array(nodeCount);
  for (let node = 0; node < nodeCount; node++) {
    nodeQx[node] = Math.round(nodes[node].lng / SCALE);
    nodeQy[node] = Math.round(nodes[node].lat / SCALE);
  }

  const edgeNodeA = new Uint32Array(edgeCount);
  const edgeNodeB = new Uint32Array(edgeCount);
  const edgeLength = new Float32Array(edgeCount);
  const edgeCover = new Uint8Array(edgeCount);
  const edgeCommercial = new Uint8Array(edgeCount);
  const edgeIndustrial = new Uint8Array(edgeCount);
  const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
  const byte = (fraction: number | undefined): number =>
    Math.min(254, Math.round((fraction ?? 0) * 255));
  let maxCover = 0;
  let maxCommercial = 0;
  let maxIndustrial = 0;
  for (let edge = 0; edge < edgeCount; edge++) {
    const spec = edges[edge];
    edgeNodeA[edge] = spec.a;
    edgeNodeB[edge] = spec.b;
    edgeLength[edge] = haversineMeters(
      nodes[spec.a].lat,
      nodes[spec.a].lng,
      nodes[spec.b].lat,
      nodes[spec.b].lng,
    );
    edgeCover[edge] = byte(spec.cover);
    edgeCommercial[edge] = byte(spec.commercial);
    edgeIndustrial[edge] = byte(spec.industrial);
    maxCover = Math.max(maxCover, edgeCover[edge]);
    maxCommercial = Math.max(maxCommercial, edgeCommercial[edge]);
    maxIndustrial = Math.max(maxIndustrial, edgeIndustrial[edge]);
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
    edgeGeomOffset: new Uint32Array(edgeCount).fill(NO_GEOMETRY),
    edgeGeomCount: new Uint16Array(edgeCount),
    edgeCover,
    edgeNameId: new Uint16Array(edgeCount).fill(NAME_NONE),
    edgeKindSide: new Uint8Array(edgeCount).fill(KIND_SIDEWALK),
    maxCover: maxCover / 255,
    edgeLandmark: new Uint8Array(edgeCount),
    edgeArt: new Uint8Array(edgeCount),
    edgeHighway: new Uint8Array(edgeCount),
    edgeAscent: new Uint8Array(edgeCount),
    edgeDescent: new Uint8Array(edgeCount),
    maxRelief: 0,
    edgeCommercial,
    edgeIndustrial,
    edgeHistoric: new Uint8Array(edgeCount),
    edgeBridge: new Uint8Array(edgeCount),
    maxLandmark: 0,
    maxArt: 0,
    maxCommercial: maxCommercial / 255,
    maxIndustrial: maxIndustrial / 255,
    maxHistoric: 0,
    maxBridge: 0,
    shade: null,
    sheds: null,
    ferries: null,
    edgeDurationSeconds: new Uint16Array(edgeCount),
    ferryEdges: new Uint32Array(0),
    transitEdges: new Uint32Array(0),
    boardEdges: new Uint32Array(0),
    names: [],
    geometry: new Uint8Array(0),
  } as unknown as RoutingGraph;
}

interface Fixture {
  graph: RoutingGraph;
  start: Snap;
  dest: Snap;
  corridorOf: (result: RouteResult) => string;
}

const CORRIDORS: { name: string; lat: number; attributes: EdgeSpec }[] = [
  { name: "direct", lat: 0, attributes: { a: 0, b: 0, industrial: 0.4 } },
  { name: "canopy", lat: 0.002, attributes: { a: 0, b: 0, cover: 0.45 } },
  { name: "deep", lat: 0.004, attributes: { a: 0, b: 0, cover: 0.9 } },
  // Shops must out-score deep canopy, else it's dominated and no card at all.
  { name: "shops", lat: 0.008, attributes: { a: 0, b: 0, commercial: 1 } },
];

function buildFixture(): Fixture {
  clearEdgePathCache(); // this fixture's edge ids belong to other synthetic graphs too
  const nodes: { lat: number; lng: number }[] = [];
  const edges: EdgeSpec[] = [];
  const rowOf = new Map<number, number>(); // edge -> corridor index
  for (let corridor = 0; corridor < CORRIDORS.length; corridor++) {
    const { lat, attributes } = CORRIDORS[corridor];
    const first = nodes.length;
    for (let column = 0; column < 5; column++) {
      nodes.push({ lat, lng: column * SPACING });
    }
    for (let column = 0; column < 4; column++) {
      rowOf.set(edges.length, corridor);
      edges.push({ ...attributes, a: first + column, b: first + column + 1 });
    }
    if (corridor > 0) {
      rowOf.set(edges.length, corridor);
      edges.push({ a: 0, b: first });
      rowOf.set(edges.length, corridor);
      edges.push({ a: 4, b: first + 4 });
    }
  }
  const graph = buildGraph(nodes, edges);
  const snapAt = (node: number, edge: number): Snap => ({
    edge,
    metersFromA: graph.edgeNodeA[edge] === node ? 0 : graph.edgeLength[edge],
    point: { lat: nodes[node].lat, lng: nodes[node].lng },
    distanceMeters: 0,
    component: 0,
  });
  const corridorOf = (result: RouteResult): string => {
    for (const step of result.steps) {
      const corridor = rowOf.get(step.edge) ?? 0;
      if (corridor > 0) {
        return CORRIDORS[corridor].name;
      }
    }
    return "direct";
  };
  return { graph, start: snapAt(0, 0), dest: snapAt(4, 3), corridorOf };
}

function weightsOf(over: Partial<RouteWeights> = {}): RouteWeights {
  return {
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
    allowTransit: true,
    allowSheds: true,
    allowCrossings: false,
    ...over,
  };
}

const MODE_WEIGHTS = weightsOf({
  tree: MAX_TREE_WEIGHT,
  commercial: MAX_COMMERCIAL_WEIGHT,
  industrial: MAX_INDUSTRIAL_WEIGHT,
});

function planOn(
  fixture: Fixture,
  weights: RouteWeights,
  seen?: RouteWeights[],
): ReturnType<typeof planRoutes> {
  return planRoutes({
    weights,
    search: (candidate) => {
      seen?.push(candidate);
      return findRoute(fixture.graph, fixture.start, fixture.dest, candidate);
    },
    minMultiplier: (candidate) => minMultiplier(fixture.graph, candidate),
    factorMax: {
      tree: fixture.graph.maxCover,
      commercial: fixture.graph.maxCommercial,
    },
  });
}

test("the fixture's corridors win where they were designed to", async () => {
  const fixture = buildFixture();
  const route = (weights: RouteWeights): string =>
    fixture.corridorOf(
      findRoute(fixture.graph, fixture.start, fixture.dest, weights)!,
    );
  expect(route(weightsOf())).toBe("direct");
  expect(route(MODE_WEIGHTS)).toBe("deep");
  const scaled = (scale: number): RouteWeights =>
    weightsOf({
      tree: MAX_TREE_WEIGHT * scale,
      commercial: MAX_COMMERCIAL_WEIGHT * scale,
      industrial: MAX_INDUSTRIAL_WEIGHT * scale,
    });
  expect(route(scaled(0.05))).toBe("direct");
  expect(route(scaled(0.3))).toBe("canopy");
  expect(route(scaled(0.8))).toBe("deep");
});

// At the equator a degree of longitude is 111,320 m, so these read in meters without projection.
const alongLatitude = (lat: number, east = 0.01): RouteResult =>
  ({
    path: {
      lats: new Float64Array([lat, lat]),
      lngs: new Float64Array([0, east]),
    },
  }) as RouteResult;

test("two routes are as far apart as the ground between them", async () => {
  const fixture = buildFixture();
  const direct = findRoute(
    fixture.graph,
    fixture.start,
    fixture.dest,
    weightsOf(),
  )!;
  const deep = findRoute(
    fixture.graph,
    fixture.start,
    fixture.dest,
    MODE_WEIGHTS,
  )!;
  expect(routeDistanceMeters(direct, direct)).toBeCloseTo(0, 9);
  expect(routeDistanceMeters(direct, deep)).toBeGreaterThan(DIFFERENT_METERS);

  // Parallel lines are exactly their offset apart.
  expect(
    routeDistanceMeters(alongLatitude(0), alongLatitude(0.0009)),
  ).toBeCloseTo(100, 0);
  // Unlike a Jaccard, which saturates at 1.
  expect(
    routeDistanceMeters(alongLatitude(0), alongLatitude(0.05)),
  ).toBeGreaterThan(5000);
});

test("opposite sidewalks of one street are the same walk", async () => {
  const apart = routeDistanceMeters(alongLatitude(0), alongLatitude(0.00018));

  expect(apart).toBeCloseTo(20, 0);
  expect(apart).toBeLessThan(DIFFERENT_METERS / 2);
});

test("the sweep finds the corridor that is cheapest only in a band", async () => {
  const fixture = buildFixture();
  const found: string[] = [];
  await planRoutes({
    weights: MODE_WEIGHTS,
    search: (candidate) =>
      findRoute(fixture.graph, fixture.start, fixture.dest, candidate),
    minMultiplier: (candidate) => minMultiplier(fixture.graph, candidate),
    onCandidate: (result) => found.push(fixture.corridorOf(result)),
  });
  expect(found[0]).toBe("deep"); // R_max is streamed first
  expect(found[1]).toBe("direct"); // then the fastest
  expect(found).toContain("canopy");
});

test("the first breakpoint above the fastest route is the shallow corridor", async () => {
  const fixture = buildFixture();
  const seen: RouteWeights[] = [];
  const plan = await planOn(fixture, MODE_WEIGHTS, seen);
  const corridors = plan.routes.map((route) =>
    fixture.corridorOf(route.result),
  );
  expect(corridors).toContain("canopy");
  // Around where the shallow corridor overtakes the direct one (t ~ 0.104).
  const scales = seen
    .map((weights) => weights.tree / MAX_TREE_WEIGHT)
    .filter((scale) => scale > 0 && scale < 0.15)
    .sort((left, right) => left - right);
  expect(scales.at(-1)).toBeGreaterThan(0.1);
  expect(scales.at(-1)).toBeLessThan(0.12);
});

test("dropping a factor finds the route only that factor was hiding", async () => {
  const fixture = buildFixture();
  const plan = await planOn(fixture, MODE_WEIGHTS);
  const corridors = plan.routes.map((route) =>
    fixture.corridorOf(route.result),
  );
  // Only reachable by dropping the tree weight alone: with it the deep canopy always wins.
  expect(corridors).toContain("shops");
  expect(corridors.sort()).toEqual(["canopy", "deep", "direct", "shops"]);
  expect(new Set(corridors).size).toBe(corridors.length);
});

test("a plan stays inside its search budget and repeats no weight vector", async () => {
  const fixture = buildFixture();
  const seen: RouteWeights[] = [];
  const plan = await planOn(fixture, MODE_WEIGHTS, seen);
  // 1 max + 1 fastest + 4 sweep + 4 bisection + 3 drops; four routes, so no per-factor bisection.
  expect(plan.searches).toBe(13);
  expect(seen.length).toBe(plan.searches);
  const keys = seen.map((weights) => JSON.stringify(weights));
  expect(new Set(keys).size).toBe(keys.length);
});

test("cards are the max-scenic route, the direct one and what differs from both", async () => {
  const fixture = buildFixture();
  const plan = await planOn(fixture, MODE_WEIGHTS);
  expect(plan.routes.length).toBe(4);
  const deep = plan.routes.find(
    (route) => fixture.corridorOf(route.result) === "deep",
  );
  expect(deep).toBeDefined();
  // Shops leads on score although the full weights chose the deep canopy.
  const scores = plan.routes.map((route) => route.scenicScore);
  expect([...scores].sort((left, right) => right - left)).toEqual(scores);
  expect(fixture.corridorOf(plan.routes[0].result)).toBe("shops");
  expect(fixture.corridorOf(plan.routes[plan.routes.length - 1].result)).toBe(
    "direct",
  );
  expect(CARD_ORDER(plan.routes[0], plan.routes[1])).toBeLessThanOrEqual(0);
  for (let left = 0; left < plan.routes.length; left++) {
    for (let right = left + 1; right < plan.routes.length; right++) {
      expect(
        routeDistanceMeters(
          plan.routes[left].result,
          plan.routes[right].result,
        ),
      ).toBeGreaterThanOrEqual(DIFFERENT_METERS);
    }
  }
});

test("two cards worth the same scenery are read shortest first", async () => {
  const card = (scenicScore: number, travelSeconds: number) => ({
    result: { travelSeconds } as RouteResult,
    scenicScore,
    colorFactor: null,
  });
  expect(CARD_ORDER(card(0.5, 900), card(0.9, 300))).toBeGreaterThan(0);
  expect(CARD_ORDER(card(0.5, 300), card(0.5, 900))).toBeLessThan(0);
});

test("selection stops rather than offering a route that is not different", async () => {
  const fixture = buildFixture();
  const plan = await planOn(fixture, weightsOf({ tree: MAX_TREE_WEIGHT }));
  expect(plan.routes.length).toBeLessThan(4);
  expect(plan.routes.length).toBeGreaterThanOrEqual(2);
  for (const route of plan.routes) {
    expect(route.colorFactor).toBeNull(); // single-discount-factor plan
  }
});

test("the scenic score and the color factor say what a card has", async () => {
  const fixture = buildFixture();
  const plan = await planOn(fixture, MODE_WEIGHTS);
  const scoreOf = (corridor: string): number =>
    plan.routes.find((route) => fixture.corridorOf(route.result) === corridor)!
      .scenicScore;
  // The direct corridor has none of the discounted attributes.
  expect(scoreOf("direct")).toBeCloseTo(0, 5);
  expect(scoreOf("deep")).toBeGreaterThan(scoreOf("canopy"));
  expect(scoreOf("deep")).toBeGreaterThan(0.5);

  const colorOf = (corridor: string): string | null =>
    plan.routes.find((route) => fixture.corridorOf(route.result) === corridor)!
      .colorFactor;
  expect(colorOf("deep")).toBe("tree");
  expect(colorOf("shops")).toBe("commercial");
  expect(colorOf("direct")).toBeNull();

  const treeBest = plan.bestByFactor.tree;
  expect(treeBest).toBeDefined();
  expect(fixture.corridorOf(plan.routes[treeBest!].result)).toBe("deep");
  expect(
    fixture.corridorOf(plan.routes[plan.bestByFactor.commercial!].result),
  ).toBe("shops");
});

// The cheapest cost is concave in one weight, so a route winning at both ends wins in between.
test("a factor whose drop changed nothing is never asked for in between", async () => {
  const fixture = buildFixture();
  const seen: RouteWeights[] = [];
  const plan = await planOn(
    fixture,
    weightsOf({ tree: MAX_TREE_WEIGHT, industrial: MAX_INDUSTRIAL_WEIGHT }),
    seen,
  );
  const halved = seen.filter(
    (weights) =>
      weights.industrial > 0 &&
      weights.industrial < MAX_INDUSTRIAL_WEIGHT &&
      weights.tree === MAX_TREE_WEIGHT,
  );
  expect(halved).toEqual([]);
  expect(plan.routes.length).toBeLessThan(4);
});

test("a search that finds nothing plans nothing", async () => {
  const plan = await planRoutes({
    weights: MODE_WEIGHTS,
    search: () => null,
    minMultiplier: () => 1,
  });
  expect(plan.routes).toEqual([]);
  expect(plan.searches).toBe(1);
});

test("the sweep's baseline is the fastest walk, not the ride", async () => {
  const graph = transitGraph(undefined, { detours: true });
  graph.transit = fixtureTimetable(departureReaching(ACCESS_SECONDS));
  const start = snapAtNode(graph, 0, WEST_SIDEWALK);
  const dest = snapAtNode(graph, 2, EAST_SIDEWALK);
  const mode = transitWeights({
    tree: MAX_TREE_WEIGHT,
    transit: MAX_TRANSIT_WEIGHT,
  });
  const onFoot = findRoute(
    graph,
    start,
    dest,
    transitWeights({ allowTransit: false }),
  );
  const asked: RouteWeights[] = [];
  const plan = await planRoutes({
    weights: mode,
    search: (candidate) => {
      asked.push(candidate);
      return findRoute(graph, start, dest, candidate);
    },
    minMultiplier: (candidate) => minMultiplier(graph, candidate),
  });
  expect(
    asked.every(
      (candidate) =>
        candidate.transit === MAX_TRANSIT_WEIGHT || candidate.transit === 0,
    ),
  ).toBe(true);
  const walks = plan.routes.filter(
    (planned) => planned.result.transitSeconds === 0,
  );
  expect(walks.length).toBeGreaterThanOrEqual(2);
  expect(
    Math.min(...walks.map((walk) => walk.result.travelSeconds)),
  ).toBeCloseTo((onFoot as RouteResult).travelSeconds, 6);
});

test("the fastest trip is asked for even where the mode charges a ride", async () => {
  const graph = transitGraph(undefined, { detours: true });
  graph.transit = fixtureTimetable(departureReaching(ACCESS_SECONDS));
  const start = snapAtNode(graph, 0, WEST_SIDEWALK);
  const dest = snapAtNode(graph, 2, EAST_SIDEWALK);
  const fastest = findRoute(
    graph,
    start,
    dest,
    transitWeights({ transit: 0 }),
  ) as RouteResult;
  const asked: RouteWeights[] = [];
  const found: RouteResult[] = [];
  const plan = await planRoutes({
    weights: transitWeights({
      tree: MAX_TREE_WEIGHT,
      transit: MAX_TRANSIT_WEIGHT,
    }),
    search: (candidate) => {
      asked.push(candidate);
      const result = findRoute(graph, start, dest, candidate);
      if (result !== null) {
        found.push(result);
      }
      return result;
    },
    minMultiplier: (candidate) => minMultiplier(graph, candidate),
  });
  expect(
    asked.some((candidate) => candidate.transit === 0 && candidate.tree === 0),
  ).toBe(true);
  expect(Math.min(...found.map((route) => route.travelSeconds))).toBeCloseTo(
    fastest.travelSeconds,
    6,
  );
  expect(
    Math.min(...plan.routes.map((route) => route.result.travelSeconds)),
  ).toBeCloseTo(fastest.travelSeconds, 6);
});

test("dropping the transit penalty is what offers the ride", async () => {
  const graph = transitGraph();
  graph.transit = fixtureTimetable(departureReaching(ACCESS_SECONDS));
  const start = snapAtNode(graph, 0, WEST_SIDEWALK);
  const dest = snapAtNode(graph, 2, EAST_SIDEWALK);
  const asked: RouteWeights[] = [];
  const plan = await planRoutes({
    weights: transitWeights({ transit: MAX_TRANSIT_WEIGHT }),
    search: (candidate) => {
      asked.push(candidate);
      return findRoute(graph, start, dest, candidate);
    },
    minMultiplier: (candidate) => minMultiplier(graph, candidate),
  });
  expect(asked.some((candidate) => candidate.transit === 0)).toBe(true);
  const riding = plan.routes.filter((planned) =>
    planned.result.steps.some((step) => step.kind === "ride"),
  );
  expect(riding).toHaveLength(1);
  expect(riding[0].result.transitSeconds).toBeGreaterThan(0);
  expect(
    asked.every(
      (candidate) => candidate.allowFerries || candidate.allowTransit,
    ),
  ).toBe(true);
});

// Here the ride is quicker and the mode prices nothing the walk has, so the walk earns no card.
test("a mode that prices no ride is still offered the walk", async () => {
  const graph = transitGraph();
  graph.transit = fixtureTimetable(departureReaching(ACCESS_SECONDS));
  const start = snapAtNode(graph, 0, WEST_SIDEWALK);
  const dest = snapAtNode(graph, 2, EAST_SIDEWALK);
  const asked: RouteWeights[] = [];
  const found: RouteResult[] = [];
  const plan = await planRoutes({
    weights: transitWeights({ transit: 0 }),
    search: (candidate) => {
      asked.push(candidate);
      return findRoute(graph, start, dest, candidate);
    },
    minMultiplier: (candidate) => minMultiplier(graph, candidate),
    onCandidate: (result) => found.push(result),
  });
  expect(asked.some((candidate) => !candidate.allowTransit)).toBe(true);
  expect(
    found.some((result) => result.steps.every((step) => step.kind !== "ride")),
  ).toBe(true);
  const riding = plan.routes.filter((planned) =>
    planned.result.steps.some((step) => step.kind === "ride"),
  );
  expect(riding).toHaveLength(1);
});

test("the walking candidate is not asked for when nothing rides", async () => {
  const fixture = buildFixture();
  const asked: RouteWeights[] = [];
  planOn(fixture, weightsOf({ tree: MAX_TREE_WEIGHT }), asked);
  expect(asked.every((candidate) => candidate.allowTransit)).toBe(true);
});

test("a route that rides is offered the walk that stays on the surface", async () => {
  const graph = transitGraph();
  graph.transit = fixtureTimetable(departureReaching(ACCESS_SECONDS));
  const start = snapAtNode(graph, 0, WEST_SIDEWALK);
  const dest = snapAtNode(graph, 2, EAST_SIDEWALK);
  const asked: RouteWeights[] = [];
  const found: RouteResult[] = [];
  await planRoutes({
    weights: transitWeights({ transit: 0 }),
    search: (candidate) => {
      asked.push(candidate);
      return findRoute(graph, start, dest, candidate);
    },
    minMultiplier: (candidate) => minMultiplier(graph, candidate),
    onCandidate: (result) => found.push(result),
  });

  expect(
    asked.some(
      (candidate) => !candidate.allowFerries && !candidate.allowTransit,
    ),
  ).toBe(true);
  // Both switches are in the memo key, so the candidate is a search of its own.
  expect(
    new Set(asked.map((candidate) => JSON.stringify(candidate))).size,
  ).toBe(asked.length);
  expect(
    found.some((result) =>
      result.steps.every(
        (step) => step.kind !== "ride" && step.kind !== "ferry",
      ),
    ),
  ).toBe(true);
});

// Two routes run as far apart as the mean of their two gaps; all tree, so none is dominated.
function twoHalves(
  edge: number,
  travelSeconds: number,
  firstHalfNorth: number,
  secondHalfNorth: number,
): RouteResult {
  const degrees = (meters: number): number => meters / 111_320;
  const east = 0.02;
  return {
    path: {
      lats: new Float64Array([
        degrees(firstHalfNorth),
        degrees(firstHalfNorth),
        degrees(secondHalfNorth),
        degrees(secondHalfNorth),
      ]),
      lngs: new Float64Array([0, east / 2, east / 2, east]),
    },
    steps: [{ edge, kind: "sidewalk" }],
    travelSeconds,
    factors: { tree: 1 },
    factorSeconds: { tree: travelSeconds },
    rides: [],
    ferries: [],
  } as unknown as RouteResult;
}

// Line names are decoration: the planner counts legs, not lines.
function riding(route: RouteResult, ...lines: string[]): RouteResult {
  return {
    ...route,
    rides: lines.map((line) => ({ route: { id: line } })),
  } as unknown as RouteResult;
}

function treeWalk(
  edge: number,
  travelSeconds: number,
  treeSeconds: number,
  north: number,
): RouteResult {
  return {
    ...twoHalves(edge, travelSeconds, north, north),
    factors: { tree: treeSeconds / travelSeconds },
    factorSeconds: { tree: treeSeconds },
  } as unknown as RouteResult;
}

// Each search returns the next queued route, then repeats the last; the weights never matter.
function planOverPool(
  pool: RouteResult[],
  weights: RouteWeights = weightsOf({ tree: MAX_TREE_WEIGHT }),
): ReturnType<typeof planRoutes> {
  const queue = [...pool];
  return planRoutes({
    weights,
    search: () => (queue.length > 1 ? queue.shift()! : queue[0]),
    minMultiplier: () => 1,
  });
}

test("the score is the time spent on a factor, not the share of the trip", async () => {
  const wholly = treeWalk(1, 600, 600, 0);
  const longer = treeWalk(2, 1800, 900, 1000);
  const plan = await planOverPool([wholly, longer]);
  expect(edgesOf(plan)).toEqual([1, 2]);
  const scoreOf = (edge: number): number =>
    plan.routes.find((route) => route.result.steps[0].edge === edge)!
      .scenicScore;
  expect(scoreOf(2)).toBeGreaterThan(scoreOf(1));
  expect(wholly.factors.tree).toBeGreaterThan(longer.factors.tree);
  expect(plan.routes[0].result.steps[0].edge).toBe(2);
});

const edgesOf = (plan: Awaited<ReturnType<typeof planRoutes>>): number[] =>
  plan.routes.map((route) => route.result.steps[0].edge).sort();

// The far route is 1000 m out but only 39 m and 43 m from the pair that's 78 m apart.
test("the set of cards is the best one, not the one furthest-first builds", async () => {
  const maxScenic = twoHalves(1, 600, 0, 0);
  const far = twoHalves(2, 500, 1000, 1000);
  const pair = [twoHalves(3, 700, 920, 1000), twoHalves(4, 800, 1000, 912)];

  expect(routeDistanceMeters(far, maxScenic)).toBeGreaterThan(
    routeDistanceMeters(pair[0], maxScenic),
  );
  expect(routeDistanceMeters(far, pair[0])).toBeLessThan(DIFFERENT_METERS);
  expect(routeDistanceMeters(far, pair[1])).toBeLessThan(DIFFERENT_METERS);
  expect(routeDistanceMeters(pair[0], pair[1])).toBeGreaterThan(
    DIFFERENT_METERS,
  );

  const plan = await planOverPool([maxScenic, far, ...pair]);
  expect(edgesOf(plan)).toEqual([1, 3, 4]);
});

test("no set of cards is offered whose closest pair is under the floor", async () => {
  const maxScenic = twoHalves(1, 600, 0, 0);
  const far = twoHalves(2, 500, 1000, 1000);
  const near = [twoHalves(3, 700, 960, 1000), twoHalves(4, 800, 1000, 980)];

  expect(routeDistanceMeters(near[0], near[1])).toBeLessThan(DIFFERENT_METERS);

  const plan = await planOverPool([maxScenic, far, ...near]);
  expect(edgesOf(plan)).toEqual([1, 2]);
});

test("a route that rides is a different card from the walk beside it", async () => {
  const walk = twoHalves(1, 900, 0, 0);
  const rail = riding(twoHalves(2, 600, 10, 10), "A");
  expect(routeDistanceMeters(walk, rail)).toBeLessThan(DIFFERENT_METERS);

  const plan = await planOverPool([walk, rail]);
  expect(edgesOf(plan)).toEqual([1, 2]);
});

// Here the ground between them is the width of a street.
test("the 2 and the 3 over the same ground are one card", async () => {
  const express = riding(twoHalves(1, 600, 0, 0), "2");
  const local = riding(twoHalves(2, 700, 10, 10), "3");
  expect(routeDistanceMeters(express, local)).toBeLessThan(DIFFERENT_METERS);

  const plan = await planOverPool([express, local]);
  expect(edgesOf(plan)).toEqual([1]);
});

test("one ride is a different card from two", async () => {
  const through = riding(twoHalves(1, 600, 0, 0), "A");
  const connection = riding(twoHalves(2, 700, 10, 10), "A", "C");
  expect(routeDistanceMeters(through, connection)).toBeLessThan(
    DIFFERENT_METERS,
  );

  const plan = await planOverPool([through, connection]);
  expect(edgesOf(plan)).toEqual([1, 2]);
});

test("a trip another beats on both counts is no card at all", async () => {
  const walks = [
    treeWalk(1, 46 * 60, 25 * 60, 0),
    treeWalk(2, 49 * 60, 33 * 60, 200),
    treeWalk(3, 53 * 60, 37 * 60, 400),
  ];
  const ride = riding(treeWalk(4, 54 * 60, 6 * 60, 600), "A");

  const plan = await planOverPool([...walks, ride]);
  expect(edgesOf(plan)).toEqual([1, 2, 3]);
  expect(
    plan.routes.some((planned) =>
      planned.result.steps.some((step) => step.kind === "ride"),
    ),
  ).toBe(false);
});

test("the quickest trip is a card with nothing to its name", async () => {
  const walks = [
    treeWalk(1, 53 * 60, 37 * 60, 0),
    treeWalk(2, 49 * 60, 33 * 60, 200),
    treeWalk(3, 46 * 60, 25 * 60, 400),
  ];
  const ride = riding(treeWalk(4, 30 * 60, 0, 600), "A");

  const plan = await planOverPool([...walks, ride]);
  expect(edgesOf(plan)).toEqual([1, 2, 3, 4]);
});

// Rain prices shelter, which a ride has all of, so the ride leads on score.
test("a slower trip is a card when it is worth more", async () => {
  const sheltered = (
    edge: number,
    travelSeconds: number,
    shelterSeconds: number,
    north: number,
  ): RouteResult =>
    ({
      ...twoHalves(edge, travelSeconds, north, north),
      factors: { shelter: shelterSeconds / travelSeconds },
      factorSeconds: { shelter: shelterSeconds },
    }) as unknown as RouteResult;

  const ride = riding(sheltered(1, 1500, 1500, 400), "A");
  const walk = sheltered(2, 1200, 0, 0);

  const plan = await planOverPool(
    [ride, walk],
    weightsOf({ shelter: MAX_SHELTER_WEIGHT }),
  );
  expect(edgesOf(plan)).toEqual([1, 2]);
  expect(plan.routes[0].result.steps[0].edge).toBe(1);
});

test("nothing beats the most scenic trip or the quickest one", () => {
  const travelSeconds = [900, 600, 1200, 600, 900];
  const scenicScores = [30, 10, 40, 10, 5];
  const kept = undominated(travelSeconds, scenicScores);
  expect(kept).toEqual([0, 1, 2]);
  expect(Math.max(...kept.map((index) => scenicScores[index]))).toBe(
    Math.max(...scenicScores),
  );
  expect(Math.min(...kept.map((index) => travelSeconds[index]))).toBe(
    Math.min(...travelSeconds),
  );
});

// No floor test until the whole set is scored and no bound; ties fall as in the search.
function enumerateCards(
  separations: readonly Float64Array[],
  travelSeconds: readonly number[],
): number[] {
  let best: number[] = [];
  let bestSeparation = 0;
  let bestSeconds = 0;
  const picked: number[] = [];
  const walk = (from: number): void => {
    const members = [0, ...picked];
    let closest = Number.POSITIVE_INFINITY;
    let seconds = 0;
    for (const member of picked) {
      seconds += travelSeconds[member];
    }
    for (let left = 0; left < members.length; left++) {
      for (let right = left + 1; right < members.length; right++) {
        closest = Math.min(closest, separations[members[left]][members[right]]);
      }
    }
    const better =
      picked.length > 0 &&
      closest >= DIFFERENT_METERS &&
      (picked.length > best.length ||
        (picked.length === best.length &&
          (closest > bestSeparation ||
            (closest === bestSeparation && seconds < bestSeconds))));
    if (better) {
      best = [...picked];
      bestSeparation = closest;
      bestSeconds = seconds;
    }
    if (picked.length < 3) {
      for (let next = from; next < separations.length; next++) {
        picked.push(next);
        walk(next + 1);
        picked.pop();
      }
    }
  };
  walk(1);
  return [0, ...best];
}

function randomPool(seed: number): {
  separations: Float64Array[];
  travelSeconds: number[];
} {
  let state = seed;
  const random = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const count = 20;
  const east: number[] = [];
  const north: number[] = [];
  for (let route = 0; route < count; route++) {
    east.push(random() * 300);
    north.push(random() * 300);
  }
  const separations = east.map((_, left) => {
    const row = new Float64Array(count);
    for (let right = 0; right < count; right++) {
      row[right] = Math.hypot(
        east[left] - east[right],
        north[left] - north[right],
      );
    }
    return row;
  });
  const travelSeconds = east.map(() => 600 + random() * 600);
  return { separations, travelSeconds };
}

test("the search over sets finds what enumerating every set finds", async () => {
  let visited = 0;
  let enumerated = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const { separations, travelSeconds } = randomPool(seed);
    selectionDiagnostics.visited = 0;
    selectionDiagnostics.enumerated = 0;
    expect(selectCards(separations, travelSeconds)).toEqual(
      enumerateCards(separations, travelSeconds),
    );
    visited += selectionDiagnostics.visited;
    enumerated += selectionDiagnostics.enumerated;
  }
  expect(visited).toBeLessThan(enumerated / 2);
});

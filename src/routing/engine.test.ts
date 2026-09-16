// The oracle is `findRoute` itself, since the engine runs the same search: a weaker route out of
// the worker would otherwise be invisible, because the panel draws whatever comes back.

import { expect, test } from "bun:test";
import { type Plan, planRoutes } from "./alternatives";
import { minMultiplier } from "./cost";
import { createDispatch } from "./dispatch";
import { graphFactorMax, RoutingEngine } from "./engine";
import { buildGraph, snapAtNode, weights } from "./ferry.fixture";
import { clearEdgePathCache } from "./graph";
import type { RouterRequest, RouterResponse } from "./protocol";
import { findRoute, type RouteResult } from "./search";

// A real `City` must exist for this id: the engine reads the pier wait and the shade bins off one.
// Every weight vector below leaves the route-time fields off, so no artifact is ever fetched.
const CITY = "nyc";
const CLOCK = { tick: 0, dateMs: Date.UTC(2026, 5, 21, 16, 0, 0) };

// Two ways round: the direct middle street, and a leafier detour a high tree weight makes cheaper.
const graph = buildGraph(
  [
    { lat: 40.75, lng: -73.99 }, // 0 start
    { lat: 40.75, lng: -73.98 }, // 1 middle, bare
    { lat: 40.76, lng: -73.985 }, // 2 detour, leafy
    { lat: 40.75, lng: -73.97 }, // 3 dest
  ],
  [
    { a: 0, b: 1, ferry: false, cover: 0.05, durationSeconds: 0 },
    { a: 1, b: 3, ferry: false, cover: 0.05, durationSeconds: 0 },
    { a: 0, b: 2, ferry: false, cover: 0.95, durationSeconds: 0 },
    { a: 2, b: 3, ferry: false, cover: 0.95, durationSeconds: 0 },
  ],
);
const start = snapAtNode(graph, 0, 0);
const dest = snapAtNode(graph, 3, 1);

// The two paths swap over inside this range, so the sweep crosses a breakpoint.
const TREE_WEIGHTS = [0, 0.25, 0.5, 0.75, 1];

function signature(result: RouteResult | null): string {
  return result
    ? result.steps
        .map((step) => `${step.edge}${step.forward ? "f" : "b"}`)
        .join(";")
    : "∅";
}

async function preparedEngine(): Promise<RoutingEngine> {
  const engine = new RoutingEngine();
  engine.load(CITY, graph);
  await engine.prepare(CITY, CLOCK, weights(0, 0, false));
  return engine;
}

test("the engine's search is findRoute", async () => {
  const engine = await preparedEngine();
  for (const tree of TREE_WEIGHTS) {
    const routeWeights = weights(tree, 0, false);
    clearEdgePathCache();
    const expected = findRoute(graph, start, dest, routeWeights);
    clearEdgePathCache();
    expect(engine.search(start, dest, routeWeights)).toEqual(expected);
  }
});

test("the cached route is findRoute, and reports when the path moved", async () => {
  const engine = await preparedEngine();
  const seen: string[] = [];
  for (const tree of TREE_WEIGHTS) {
    const routeWeights = weights(tree, 0, false);
    const expected = findRoute(graph, start, dest, routeWeights);
    const cached = engine.route(start, dest, routeWeights);
    expect(cached.result).toEqual(expected);
    if (cached.changed) {
      seen.push(signature(cached.result));
    }
  }
  // Neither path is reported twice in a row: that is what stops the panel redrawing on a nudge.
  expect(seen.length).toBeGreaterThan(1);
  expect(new Set(seen).size).toBe(seen.length);
});

// The searcher the cache was handed, which is the only way to see that it kept the engine's own one:
// the bare `findRoute` answers the same routes, without the label reuse or the network estimate.
function cacheSearcher(engine: RoutingEngine): unknown {
  return (engine as unknown as { cache: { search: unknown } }).cache.search;
}

test("dropping the cache keeps the engine's own searcher", async () => {
  const engine = await preparedEngine();
  expect(cacheSearcher(engine)).not.toBe(findRoute);
  engine.resetCache();
  expect(cacheSearcher(engine)).not.toBe(findRoute);
  expect(typeof cacheSearcher(engine)).toBe("function");
});

test("a drag frame answers the moved endpoint", async () => {
  const engine = await preparedEngine();
  engine.dragStart("dest");
  const routeWeights = weights(0, 0, false);
  const moved = snapAtNode(graph, 2, 2);
  const dragged = engine.dragMove(start, moved, routeWeights, 0);
  expect(signature(dragged)).toBe(
    signature(findRoute(graph, start, moved, routeWeights)),
  );
});

function fakeWorker(): {
  receive: (request: RouterRequest) => Promise<void>;
  sent: RouterResponse[];
} {
  const sent: RouterResponse[] = [];
  const engine = new RoutingEngine();
  engine.load(CITY, graph);
  const dispatch = createDispatch(engine, (response) => sent.push(response));
  return { receive: (request) => dispatch.receive(request), sent };
}

function routeMessage(id: number): RouterRequest {
  return {
    type: "route",
    id,
    cityId: CITY,
    clock: CLOCK,
    weights: weights(0.8, 0, false),
    start,
    dest,
  };
}

function dragMessage(id: number, node: number, edge: number): RouterRequest {
  return {
    type: "drag:move",
    id,
    cityId: CITY,
    clock: CLOCK,
    weights: weights(0.8, 0, false),
    anchor: start,
    moving: snapAtNode(graph, node, edge),
    anchorSeconds: 0,
  };
}

test("a route request answers with the route", async () => {
  const worker = fakeWorker();
  await worker.receive(routeMessage(7));
  expect(worker.sent).toHaveLength(1);
  const [response] = worker.sent;
  expect(response.type).toBe("result");
  if (response.type === "result") {
    expect(response.id).toBe(7);
    expect(signature(response.result)).toBe(
      signature(findRoute(graph, start, dest, weights(0.8, 0, false))),
    );
  }
});

test("only the newest of several queued route requests is searched", async () => {
  const worker = fakeWorker();
  const inFlight = [
    worker.receive(routeMessage(1)),
    worker.receive(routeMessage(2)),
    worker.receive(routeMessage(3)),
  ];
  await Promise.all(inFlight);
  expect(worker.sent.map((response) => [response.type, response.id])).toEqual([
    ["stale", 1],
    ["stale", 2],
    ["result", 3],
  ]);
});

test("a drag coalesces to the frame the cursor is on", async () => {
  const worker = fakeWorker();
  const inFlight = [
    worker.receive({ type: "drag:start", which: "dest" }),
    worker.receive(dragMessage(1, 1, 0)),
    worker.receive(dragMessage(2, 2, 2)),
    worker.receive(dragMessage(3, 3, 1)),
  ];
  await Promise.all(inFlight);
  expect(worker.sent.map((response) => [response.type, response.id])).toEqual([
    ["stale", 1],
    ["stale", 2],
    ["result", 3],
  ]);
  const [, , solved] = worker.sent;
  // The last frame's endpoint, not one of the two it overtook.
  expect(solved.type === "result" && solved.result?.dest.edge).toBe(1);
});

// Strong enough that the detour wins at full weight and the street at zero: a breakpoint to find.
const PLAN_WEIGHTS = weights(1, 0, false);

function planMessage(id: number): RouterRequest {
  return {
    type: "plan",
    id,
    request: { cityId: CITY, clock: CLOCK, start, dest, weights: PLAN_WEIGHTS },
  };
}

// The same plan over a bare `findRoute`: the oracle for both the stream and the finished set.
async function expectedPlan(): Promise<{
  plan: Plan;
  candidates: RouteResult[];
}> {
  const candidates: RouteResult[] = [];
  clearEdgePathCache();
  const plan = await planRoutes({
    weights: PLAN_WEIGHTS,
    search: (candidate) => findRoute(graph, start, dest, candidate),
    minMultiplier: (candidate) => minMultiplier(graph, candidate),
    factorMax: graphFactorMax(graph),
    onCandidate: (result) => candidates.push(result),
  });
  clearEdgePathCache();
  return { plan, candidates };
}

test("a plan previews its max-scenic route and closes with the planned set", async () => {
  const { plan, candidates } = await expectedPlan();
  const worker = fakeWorker();
  await worker.receive(planMessage(4));

  // One preview, whatever the sweep searched: the map draws the max-scenic route while the rest is
  // still being found, and the alternatives ride back with the plan that settles which are cards.
  expect(worker.sent.map((response) => response.type)).toEqual([
    "preview",
    "done",
  ]);
  expect(worker.sent[0]).toEqual({
    type: "preview",
    id: 4,
    result: candidates[0],
  });
  expect(signature(candidates[0])).toBe(
    signature(findRoute(graph, start, dest, PLAN_WEIGHTS)),
  );
  expect(worker.sent.at(-1)).toEqual({ type: "done", id: 4, plan });
});

test("only the newest of several queued plans is planned", async () => {
  const worker = fakeWorker();
  const inFlight = [
    worker.receive(planMessage(1)),
    worker.receive(planMessage(2)),
  ];
  await Promise.all(inFlight);
  expect(worker.sent[0]).toEqual({ type: "stale", id: 1 });
  // Nothing of the superseded plan ran: every message after it belongs to the newer one.
  expect(worker.sent.slice(1).every((response) => response.id === 2)).toBe(
    true,
  );
  expect(worker.sent.at(-1)?.type).toBe("done");
});

// A plan already running when a newer one arrives. The dispatcher learns of the newer request only
// when the plan lets the event loop run, which it does between searches and no more often than its
// own breath — so the first search here has to outlast one.
test("a plan a newer one overtakes stops where it is", async () => {
  const sent: RouterResponse[] = [];
  let searches = 0;
  const engine = new (class extends RoutingEngine {
    search(...args: Parameters<RoutingEngine["search"]>) {
      searches += 1;
      if (searches === 1) {
        void dispatch.receive(planMessage(2));
        const until = performance.now() + 40;
        while (performance.now() < until) {
          // The plan's first search, long enough that the next one asks whether it is still wanted.
        }
      }
      return super.search(...args);
    }
  })();
  engine.load(CITY, graph);
  const dispatch = createDispatch(engine, (response) => sent.push(response));

  await dispatch.receive(planMessage(1));
  expect(
    sent.filter((response) => response.id === 1).map((one) => one.type),
  ).toEqual(["preview", "stale"]);
  expect(sent.at(-1)).toMatchObject({ type: "done", id: 2 });
  // The overtaken plan stopped at its second search; a whole one takes ten on this fixture.
  expect(searches).toBeLessThan(2 + 10);
});

// The same, for the frame the reader is actually watching: a dragged endpoint retires the plan of a
// walk they have already moved, rather than waiting out its sixteen searches behind it.
test("a plan a drag frame overtakes stops where it is", async () => {
  const sent: RouterResponse[] = [];
  let searches = 0;
  const engine = new (class extends RoutingEngine {
    search(...args: Parameters<RoutingEngine["search"]>) {
      searches += 1;
      if (searches === 1) {
        void dispatch.receive(dragMessage(2, 2, 2));
        const until = performance.now() + 40;
        while (performance.now() < until) {
          // Long enough that the plan's next search asks whether it is still wanted.
        }
      }
      return super.search(...args);
    }
  })();
  engine.load(CITY, graph);
  const dispatch = createDispatch(engine, (response) => sent.push(response));

  await dispatch.receive(planMessage(1));
  expect(
    sent.filter((response) => response.id === 1).map((one) => one.type),
  ).toEqual(["preview", "stale"]);
  expect(sent.at(-1)).toMatchObject({ type: "result", id: 2 });
  expect(searches).toBeLessThan(2 + 10);
});

test("a request for a city with no graph is an error, not a crash", async () => {
  const worker = fakeWorker();
  await worker.receive({ ...routeMessage(9), cityId: "sf" });
  expect(worker.sent.map((response) => response.type)).toEqual(["error"]);
});

// The load is the one request the page cannot see fail any other way. A worker that could not decode
// the bytes — out of memory on a phone — used to say nothing at all, and everything queued behind it
// waited on a city it had never loaded.
test("a graph the worker cannot decode is reported, and so is what queued behind it", async () => {
  const sent: RouterResponse[] = [];
  const dispatch = createDispatch(new RoutingEngine(), (response) =>
    sent.push(response),
  );
  await Promise.all([
    dispatch.receive({
      type: "load",
      id: 1,
      cityId: CITY,
      buffer: new ArrayBuffer(16),
      identity: { hash: "", keyHash: "" },
      base: "https://example.invalid/",
    }),
    dispatch.receive(routeMessage(2)),
  ]);
  expect(sent.map((response) => [response.type, response.id])).toEqual([
    ["error", 1],
    ["error", 2],
  ]);
});

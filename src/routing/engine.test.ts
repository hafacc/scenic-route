// The engine has to answer exactly what a bare `findRoute` on the same graph does — it is the same
// search, moved into the worker — so the oracle here is `findRoute` itself. A weaker route from the
// worker would be invisible: the panel draws whatever comes back.

import { expect, test } from "bun:test";
import { createDispatch } from "./dispatch";
import { RoutingEngine } from "./engine";
import { buildGraph, snapAtNode, weights } from "./ferry.fixture";
import { clearEdgePathCache } from "./graph";
import type { RouterRequest, RouterResponse } from "./protocol";
import { findRoute, type RouteResult } from "./search";

// A city id a real `City` exists for, because the engine reads the pier wait and the shade bins off
// one. Every weight vector below leaves the three route-time fields switched off, so no artifact is
// ever fetched and nothing in the test depends on which city this is.
const CITY = "nyc";
const CLOCK = { tick: 0, dateMs: Date.UTC(2026, 5, 21, 16, 0, 0) };

// A grid with two ways round: the direct middle street, and a leafier detour that a high tree weight
// makes cheaper. Walking edges only, so ferries are moot either way.
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

// The two paths above swap over somewhere in here, so the sweep crosses a breakpoint rather than
// asking the same question five times.
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
  // Both paths are reported, and neither is reported twice in a row: that is what stops the panel
  // redrawing an identical route on every slider nudge.
  expect(seen.length).toBeGreaterThan(1);
  expect(new Set(seen).size).toBe(seen.length);
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

// The protocol handler, driven as messages in and messages out with a fake postMessage.

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

test("the planner is not answered yet", async () => {
  const worker = fakeWorker();
  await worker.receive({
    type: "plan",
    id: 4,
    request: { cityId: CITY, clock: CLOCK, start, dest },
    weights: [weights(0.8, 0, false)],
    toggles: {},
  });
  expect(worker.sent).toEqual([
    { type: "error", id: 4, message: "the route planner is not built yet" },
  ]);
});

test("a request for a city with no graph is an error, not a crash", async () => {
  const worker = fakeWorker();
  await worker.receive({ ...routeMessage(9), cityId: "sf" });
  expect(worker.sent.map((response) => response.type)).toEqual(["error"]);
});

// The client driven over a fake port wired straight to the dispatcher: the same code the app runs,
// minus the Worker, so the streaming and the superseded-request contract are what is under test.

import { expect, test } from "bun:test";
import { planRoutes } from "./alternatives";
import { minMultiplier } from "./cost";
import { createDispatch } from "./dispatch";
import { graphFactorMax, RoutingEngine } from "./engine";
import { buildGraph, snapAtNode, weights } from "./ferry.fixture";
import { clearEdgePathCache } from "./graph";
import type { RouteRequest, RouterRequest, RouterResponse } from "./protocol";
import { RouterClient, type RouterPort } from "./router-client";
import { findRoute, type RouteResult } from "./search";

const CITY = "nyc";
const CLOCK = { tick: 0, dateMs: Date.UTC(2026, 5, 21, 16, 0, 0) };

// The engine test's grid: a bare middle street and a leafy detour that a full tree weight prefers.
const graph = buildGraph(
  [
    { lat: 40.75, lng: -73.99 },
    { lat: 40.75, lng: -73.98 },
    { lat: 40.76, lng: -73.985 },
    { lat: 40.75, lng: -73.97 },
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
const PLAN_WEIGHTS = weights(1, 0, false);

const routeRequest: RouteRequest = {
  cityId: CITY,
  clock: CLOCK,
  weights: PLAN_WEIGHTS,
  start,
  dest,
};

const request: RouteRequest = {
  cityId: CITY,
  clock: CLOCK,
  start,
  dest,
  weights: PLAN_WEIGHTS,
};

function client(): RouterClient {
  const engine = new RoutingEngine();
  engine.load(CITY, graph);
  const port: RouterPort = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: (message) => {
      void dispatch.receive(message);
    },
  };
  const dispatch = createDispatch(engine, (response: RouterResponse) => {
    port.onmessage?.({ data: response } as MessageEvent<RouterResponse>);
  });
  return new RouterClient(port);
}

test("a plan resolves with the planned set, having previewed its first route", async () => {
  clearEdgePathCache();
  const expected = planRoutes({
    weights: PLAN_WEIGHTS,
    search: (candidate) => findRoute(graph, start, dest, candidate),
    minMultiplier: (candidate) => minMultiplier(graph, candidate),
    factorMax: graphFactorMax(graph),
  });
  clearEdgePathCache();

  const previewed: RouteResult[] = [];
  const plan = await client().plan(request, (result) => previewed.push(result));
  expect(plan).toEqual(expected);
  // One route reaches the page before `done`, which is what lets the map draw without waiting.
  expect(previewed).toHaveLength(1);
  expect(previewed[0].steps.map((step) => step.edge)).toEqual(
    findRoute(graph, start, dest, PLAN_WEIGHTS)?.steps.map(
      (step) => step.edge,
    ) ?? [],
  );
});

test("a plan a newer one overtakes resolves null", async () => {
  const router = client();
  const overtaken = router.plan(request, () => {});
  const newest = router.plan(request, () => {});
  expect(await overtaken).toBeNull();
  expect(await newest).not.toBeNull();
});

test("a route request posts the protocol's fields and nothing a caller hung on it", () => {
  const posted: RouterRequest[] = [];
  const port: RouterPort = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: (message) => {
      posted.push(message);
    },
  };
  // A deck's own solver takes the graph; the whole decoded thing would be cloned across the thread.
  void new RouterClient(port).route({ ...routeRequest, graph } as RouteRequest);
  expect(posted).toHaveLength(1);
  expect(Object.keys(posted[0]).sort()).toEqual([
    "cityId",
    "clock",
    "dest",
    "id",
    "start",
    "type",
    "weights",
  ]);
});

// A worker whose chunk 404s after a deploy never runs a line of the code above: the only thing that
// happens is `onerror`. Before it was listened for, every promise here stayed pending forever and
// the panel spun with no error.
test("a failed worker rejects what is waiting and what is asked afterwards", async () => {
  const port: RouterPort = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: () => {},
  };
  const router = new RouterClient(port);
  const routing = router.route(routeRequest);
  const planning = router.plan(request, () => {});
  port.onerror?.(new Error("chunk load failed"));

  await expect(routing).rejects.toThrow(/routing worker/);
  await expect(planning).rejects.toThrow(/routing worker/);
  await expect(router.route(routeRequest)).rejects.toThrow(/routing worker/);
  await expect(router.plan(request, () => {})).rejects.toThrow(
    /routing worker/,
  );
  // A reply that cannot be cloned is the same dead end, and lands on its own handler.
  const otherPort: RouterPort = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: () => {},
  };
  const asked = new RouterClient(otherPort).dragMove({
    cityId: CITY,
    clock: CLOCK,
    weights: PLAN_WEIGHTS,
    anchor: start,
    moving: dest,
    anchorSeconds: 0,
  });
  otherPort.onmessageerror?.(new Error("uncloneable"));
  await expect(asked).rejects.toThrow(/routing worker/);
});

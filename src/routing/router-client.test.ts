// The client driven over a fake port wired straight to the dispatcher: the same code the app runs,
// minus the Worker, so the streaming and the superseded-request contract are what is under test.

import { expect, test } from "bun:test";
import { planRoutes } from "./alternatives";
import { minMultiplier } from "./cost";
import { createDispatch } from "./dispatch";
import { graphFactorMax, RoutingEngine } from "./engine";
import { buildGraph, snapAtNode, weights } from "./ferry.fixture";
import { clearEdgePathCache } from "./graph";
import type { PlanRequest, RouterResponse } from "./protocol";
import {
  type PlanCandidate,
  RouterClient,
  type RouterPort,
} from "./router-client";
import { findRoute } from "./search";

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

const request: PlanRequest = {
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
    postMessage: (message) => {
      void dispatch.receive(message);
    },
  };
  const dispatch = createDispatch(engine, (response: RouterResponse) => {
    port.onmessage?.({ data: response } as MessageEvent<RouterResponse>);
  });
  return new RouterClient(port);
}

test("a plan resolves with the planned set, having streamed every route", async () => {
  clearEdgePathCache();
  const expected = planRoutes({
    weights: PLAN_WEIGHTS,
    search: (candidate) => findRoute(graph, start, dest, candidate),
    minMultiplier: (candidate) => minMultiplier(graph, candidate),
    factorMax: graphFactorMax(graph),
  });
  clearEdgePathCache();

  const streamed: PlanCandidate[] = [];
  const plan = await client().plan(request, (candidate) =>
    streamed.push(candidate),
  );
  expect(plan).toEqual(expected);
  expect(streamed.map((candidate) => candidate.index)).toEqual(
    streamed.map((_, index) => index),
  );
  // Every card was streamed before `done`, which is what lets the map draw one without waiting.
  const streamedTimes = new Set(
    streamed.map((candidate) => candidate.result.travelSeconds),
  );
  for (const route of plan?.routes ?? []) {
    expect(streamedTimes.has(route.result.travelSeconds)).toBe(true);
  }
});

test("a plan a newer one overtakes resolves null", async () => {
  const router = client();
  const overtaken = router.plan(request, () => {});
  const newest = router.plan(request, () => {});
  expect(await overtaken).toBeNull();
  expect(await newest).not.toBeNull();
});

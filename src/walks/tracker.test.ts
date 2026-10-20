import { expect, test } from "bun:test";
import { familiarField } from "../routing/familiar";
import { weights } from "../routing/ferry.fixture";
import { edgeDurableKey, type RoutingGraph } from "../routing/graph";
import { findRoute } from "../routing/search";
import { buildSnapIndex, type SnapIndex } from "../routing/snap";
import { WalkHistory } from "./history";
import { type Fix, PASS_MS, WalkTracker } from "./tracker";
import { BOWED, ends, NODES, STRAIGHT, walkGraph } from "./walks.fixture";

const NOW = Date.UTC(2026, 9, 14);

function setup(): { graph: RoutingGraph; index: SnapIndex } {
  const graph = walkGraph();
  return { graph, index: buildSnapIndex(graph) };
}

// A point `share` of the way along an edge, nudged `offsetDegrees` north.
function along(
  graph: RoutingGraph,
  edge: number,
  share: number,
  offsetDegrees = 0,
): { lat: number; lng: number } {
  const a = NODES[graph.edgeNodeA[edge]];
  const b = NODES[graph.edgeNodeB[edge]];
  return {
    lat: a.lat + share * (b.lat - a.lat) + offsetDegrees,
    lng: a.lng + share * (b.lng - a.lng),
  };
}

const fix = (
  point: { lat: number; lng: number },
  over: Partial<Fix> = {},
): Fix => ({
  ...point,
  accuracy: 8,
  speed: 1.3,
  at: NOW,
  ...over,
});

test("a fix on a street counts that street's durable key", () => {
  const { graph, index } = setup();
  const tracker = new WalkTracker();
  expect(tracker.observe(fix(along(graph, 2, 0.5)), graph, index)).toBe(
    edgeDurableKey(graph, 2),
  );
  // 11 m south of the straight way, away from the bowed one, still lands on it.
  expect(
    tracker.observe(
      fix(along(graph, 1, 0.5, -0.0001), { at: NOW + 1000 }),
      graph,
      index,
    ),
  ).toBe(edgeDurableKey(graph, 1));
});

test("a vague, distant or fast fix counts nothing", () => {
  const { graph, index } = setup();
  const tracker = new WalkTracker();
  const point = along(graph, 0, 0.5);
  expect(
    tracker.observe(fix(point, { accuracy: 45 }), graph, index),
  ).toBeNull();
  expect(
    tracker.observe(fix(point, { accuracy: Number.NaN }), graph, index),
  ).toBeNull();
  expect(tracker.observe(fix(point, { speed: 9 }), graph, index)).toBeNull();
  // 100 m from any street.
  expect(
    tracker.observe(fix(along(graph, 0, 0.5, -0.0009)), graph, index),
  ).toBeNull();
});

test("with no reported speed, the pace between fixes rules out a ride", () => {
  const { graph, index } = setup();
  const tracker = new WalkTracker();
  expect(
    tracker.observe(fix(along(graph, 0, 0.1), { speed: null }), graph, index),
  ).not.toBeNull();
  // 180 m in ten seconds.
  expect(
    tracker.observe(
      fix(along(graph, 0, 0.9), { speed: null, at: NOW + 10_000 }),
      graph,
      index,
    ),
  ).toBeNull();
  // The same stretch at a walk.
  expect(
    tracker.observe(
      fix(along(graph, 1, 0.5), { speed: null, at: NOW + 200_000 }),
      graph,
      index,
    ),
  ).not.toBeNull();
});

test("fixes along one street, and jitter back onto it, count once per pass", () => {
  const { graph, index } = setup();
  const tracker = new WalkTracker();
  const counted = [0.1, 0.3, 0.5, 0.7].map((share, step) =>
    tracker.observe(
      fix(along(graph, 0, share), { at: NOW + step * 15_000 }),
      graph,
      index,
    ),
  );
  expect(counted.filter((key) => key !== null)).toEqual([
    edgeDurableKey(graph, 0),
  ]);
  // A later pass counts again.
  expect(
    tracker.observe(
      fix(along(graph, 0, 0.5), { at: NOW + PASS_MS + 60_000 }),
      graph,
      index,
    ),
  ).toBe(edgeDurableKey(graph, 0));
});

// Fixes every 15 s at walking pace along the given edges, recorded as the page would.
function walk(
  graph: RoutingGraph,
  index: SnapIndex,
  history: WalkHistory,
  edges: readonly number[],
): void {
  const tracker = new WalkTracker();
  let at = NOW;
  for (const edge of edges) {
    for (const share of [0.15, 0.35, 0.55, 0.75, 0.95]) {
      at += 15_000;
      const key = tracker.observe(
        fix(along(graph, edge, share), { at }),
        graph,
        index,
      );
      if (key !== null) {
        history.record("test", key, at);
      }
    }
  }
}

function routeEdges(graph: RoutingGraph, familiar: number): number[] {
  const { start, dest } = ends(graph);
  const result = findRoute(graph, start, dest, {
    ...weights(0, 0, false),
    familiar,
  });
  return (result?.steps ?? []).map((step) => step.edge);
}

const uses = (edges: number[], way: readonly number[]): boolean =>
  way.every((edge) => edges.includes(edge));

test("a walk along the longer way draws a familiar route onto it and a new one off it", () => {
  const { graph, index } = setup();
  const history = new WalkHistory(() => null);
  expect(uses(routeEdges(graph, 0), STRAIGHT)).toBe(true);

  walk(graph, index, history, BOWED);
  expect(history.records("test").size).toBe(2);
  graph.familiar = familiarField(
    graph,
    history.records("test"),
    NOW + 3600_000,
  );
  expect(uses(routeEdges(graph, 0), STRAIGHT)).toBe(true);
  expect(uses(routeEdges(graph, 1), BOWED)).toBe(true);
  expect(uses(routeEdges(graph, -1), STRAIGHT)).toBe(true);

  history.forget();
  walk(graph, index, history, STRAIGHT);
  graph.familiar = familiarField(
    graph,
    history.records("test"),
    NOW + 3600_000,
  );
  expect(uses(routeEdges(graph, 1), STRAIGHT)).toBe(true);
  expect(uses(routeEdges(graph, -1), BOWED)).toBe(true);
});

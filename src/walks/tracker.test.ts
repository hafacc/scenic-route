import { expect, test } from "bun:test";
import { familiarField } from "../routing/familiar";
import { weights } from "../routing/ferry.fixture";
import { edgeDurableKey, type RoutingGraph } from "../routing/graph";
import { findRoute } from "../routing/search";
import { buildSnapIndex, type SnapIndex } from "../routing/snap";
import { WalkHistory } from "./history";
import { type Fix, PASS_MS, WalkTracker } from "./tracker";
import {
  AVENUE,
  BOWED,
  CROSS_EAST,
  CROSS_FAR,
  CROSS_WEST,
  ends,
  GRID_NODES,
  gridGraph,
  NODES,
  SHORT_BLOCK,
  SIDE_STREET,
  STRAIGHT,
  STUB,
  walkGraph,
} from "./walks.fixture";

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

const METERS_PER_DEGREE = 111_195;

// Fixes every `stepMeters` at 1.3 m/s through the given grid nodes, the corners included; the keys counted.
function stroll(
  graph: RoutingGraph,
  index: SnapIndex,
  route: readonly number[],
  stepMeters: number,
  tracker = new WalkTracker(),
  startAt = NOW,
): number[] {
  const counted: number[] = [];
  let at = startAt;
  const observe = (point: { lat: number; lng: number }): void => {
    counted.push(...tracker.observe(fix(point, { at }), graph, index));
    at += (stepMeters / 1.3) * 1000;
  };
  for (let leg = 0; leg + 1 < route.length; leg++) {
    const a = GRID_NODES[route[leg]];
    const b = GRID_NODES[route[leg + 1]];
    const meters = Math.hypot(b.lat - a.lat, b.lng - a.lng) * METERS_PER_DEGREE;
    for (let step = 0; step * stepMeters < meters; step++) {
      const share = (step * stepMeters) / meters;
      observe({
        lat: a.lat + share * (b.lat - a.lat),
        lng: a.lng + share * (b.lng - a.lng),
      });
    }
  }
  observe(GRID_NODES[route[route.length - 1]]);
  return counted;
}

const keys = (graph: RoutingGraph, edges: readonly number[]): number[] =>
  edges.map((edge) => edgeDurableKey(graph, edge));

function gridSetup(): { graph: RoutingGraph; index: SnapIndex } {
  const graph = gridGraph();
  return { graph, index: buildSnapIndex(graph) };
}

test("a street counts once about half of it is walked, not on the first fix", () => {
  const { graph, index } = setup();
  const tracker = new WalkTracker();
  const counted = [0.1, 0.3, 0.5, 0.7].map((share, step) =>
    tracker.observe(
      fix(along(graph, 2, share), { at: NOW + step * 15_000 }),
      graph,
      index,
    ),
  );
  expect(counted).toEqual([[], [], [], [edgeDurableKey(graph, 2)]]);
  // 11 m south of the straight way, away from the bowed one, still lands on it.
  const south = new WalkTracker();
  expect(
    [0.2, 0.5, 0.8].flatMap((share, step) =>
      south.observe(
        fix(along(graph, 1, share, -0.0001), { at: NOW + step * 30_000 }),
        graph,
        index,
      ),
    ),
  ).toEqual([edgeDurableKey(graph, 1)]);
});

test("a vague, distant or fast fix covers nothing", () => {
  const { graph, index } = setup();
  const shares = [0, 0.25, 0.5, 0.75, 1];
  const walkWith = (over: Partial<Fix>, offsetDegrees = 0): number[] => {
    const tracker = new WalkTracker();
    return shares.flatMap((share, step) =>
      tracker.observe(
        fix(along(graph, 0, share, offsetDegrees), {
          at: NOW + step * 60_000,
          ...over,
        }),
        graph,
        index,
      ),
    );
  };
  expect(walkWith({})).toEqual([edgeDurableKey(graph, 0)]);
  expect(walkWith({ accuracy: 45 })).toEqual([]);
  expect(walkWith({ accuracy: Number.NaN })).toEqual([]);
  expect(walkWith({ speed: 9 })).toEqual([]);
  // 100 m from any street.
  expect(walkWith({}, -0.0009)).toEqual([]);
});

test("with no reported speed, the pace between fixes rules out a ride", () => {
  const { graph, index } = setup();
  const tracker = new WalkTracker();
  expect(
    tracker.observe(fix(along(graph, 0, 0.1), { speed: null }), graph, index),
  ).toEqual([]);
  // 180 m in ten seconds.
  expect(
    tracker.observe(
      fix(along(graph, 0, 0.9), { speed: null, at: NOW + 10_000 }),
      graph,
      index,
    ),
  ).toEqual([]);
  // The same stretch at a walk.
  expect(
    tracker.observe(
      fix(along(graph, 0, 0.9), { speed: null, at: NOW + 200_000 }),
      graph,
      index,
    ),
  ).toEqual([edgeDurableKey(graph, 0)]);
});

test("a street walked, then jittered back onto, counts once per pass", () => {
  const { graph, index } = setup();
  const tracker = new WalkTracker();
  const counted = [0.1, 0.3, 0.5, 0.7, 0.9, 0.2, 0.8].flatMap((share, step) =>
    tracker.observe(
      fix(along(graph, 0, share), { at: NOW + step * 15_000 }),
      graph,
      index,
    ),
  );
  expect(counted).toEqual([edgeDurableKey(graph, 0)]);
  // A later pass counts again.
  expect(
    [0.1, 0.4, 0.7].flatMap((share, step) =>
      tracker.observe(
        fix(along(graph, 0, share), {
          at: NOW + PASS_MS + 200_000 + step * 30_000,
        }),
        graph,
        index,
      ),
    ),
  ).toEqual([edgeDurableKey(graph, 0)]);
});

test("crossing an avenue counts the street, not the avenue", () => {
  const { graph, index } = gridSetup();
  const counted = stroll(graph, index, [4, 1, 5], 20);
  expect(counted.sort()).toEqual(keys(graph, [CROSS_WEST, CROSS_EAST]).sort());
});

test("walking past the end of a side street counts the avenue, not the side street", () => {
  const { graph, index } = gridSetup();
  const counted = stroll(graph, index, [0, 1, 2, 3], 20);
  expect(counted.sort()).toEqual(keys(graph, AVENUE).sort());
  expect(counted).not.toContain(edgeDurableKey(graph, SIDE_STREET));
});

test("half a block or more counts; a third doesn't", () => {
  const { graph, index } = gridSetup();
  const west = edgeDurableKey(graph, CROSS_WEST);
  const turnBack = (share: number): number[] => {
    const tracker = new WalkTracker();
    const counted: number[] = [];
    for (let step = 0; step <= 10; step++) {
      // Out from the west end and back, so the far point is the only reach.
      const reach = share * (1 - Math.abs(step / 5 - 1));
      counted.push(
        ...tracker.observe(
          fix(
            { lat: 0.002, lng: 0.001 + reach * 0.001 },
            { at: NOW + step * 30_000 },
          ),
          graph,
          index,
        ),
      );
    }
    return counted;
  };
  expect(turnBack(0.33)).toEqual([]);
  expect(turnBack(0.55)).toEqual([west]);
  expect(turnBack(0.9)).toEqual([west]);
});

test("a short block counts even with one fix on it; crossing a stub doesn't", () => {
  const { graph, index } = gridSetup();
  const short = edgeDurableKey(graph, SHORT_BLOCK);
  const stub = edgeDurableKey(graph, STUB);
  for (const step of [20, 30]) {
    const counted = stroll(graph, index, [1, 5, 6, 7], step);
    expect(counted.sort()).toEqual(
      keys(graph, [CROSS_EAST, SHORT_BLOCK, CROSS_FAR]).sort(),
    );
    expect(counted).not.toContain(stub);
  }
  // Walked end to end, the 12 m stub counts too.
  expect(stroll(graph, index, [1, 5, 9], 5)).toContain(stub);
  expect(stroll(graph, index, [6, 5], 5)).toContain(short);
});

test("jitter, however long it goes on, doesn't add up to coverage", () => {
  const { graph, index } = gridSetup();
  const linger = (
    point: (step: number) => { lat: number; lng: number },
  ): number[] => {
    const tracker = new WalkTracker();
    return Array.from({ length: 120 }, (_, step) =>
      tracker.observe(
        fix(point(step), { at: NOW + step * 5_000 }),
        graph,
        index,
      ),
    ).flat();
  };
  // 10 m either way along the cross street, a third of the way in, and a little across it.
  expect(
    linger((step) => ({
      lat: 0.002 + (step % 3) * 0.00002,
      lng: 0.00135 + (step % 2 === 0 ? 0.00009 : -0.00009),
    })),
  ).toEqual([]);
  // Waiting at the corner, wandering 9 m up the 12 m stub and back.
  expect(
    linger((step) => ({ lat: 0.002 + (step % 2) * 0.000081, lng: 0.003 })),
  ).toEqual([]);
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
      for (const key of tracker.observe(
        fix(along(graph, edge, share), { at }),
        graph,
        index,
      )) {
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

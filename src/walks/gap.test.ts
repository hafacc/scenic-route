import { expect, test } from "bun:test";
import {
  edgeDurableKey,
  NO_SOURCE_ID,
  type RoutingGraph,
} from "../routing/graph";
import { buildSnapIndex } from "../routing/snap";
import { crossed, WalkGaps } from "./gap";
import type { Fix } from "./tracker";
import { straightGraph } from "./walks.fixture";

const NOW = Date.UTC(2026, 9, 14);

// Halfway along `edge`, `seconds` after NOW, as a fix with no reported speed.
function midway(graph: RoutingGraph, edge: number, seconds: number): Fix {
  const a = graph.edgeNodeA[edge];
  const b = graph.edgeNodeB[edge];
  return {
    lat: ((graph.nodeQy[a] + graph.nodeQy[b]) / 2) * graph.scale,
    lng: ((graph.nodeQx[a] + graph.nodeQx[b]) / 2) * graph.scale,
    accuracy: 8,
    speed: null,
    at: NOW + seconds * 1000,
  };
}

// A gap from halfway along `first` to halfway along `last`, at `metersPerSecond` along `meters`.
function gap(
  graph: RoutingGraph,
  first: number,
  last: number,
  meters: number,
  metersPerSecond: number,
): number[] {
  return crossed(
    graph,
    buildSnapIndex(graph),
    midway(graph, first, 0),
    midway(graph, last, meters / metersPerSecond),
  );
}

const keys = (graph: RoutingGraph, edges: number[]): number[] =>
  edges.map((edge) => edgeDurableKey(graph, edge)).sort();

// One street, 222 m, between two blocks; a loop off the first is too long to be a way round.
function bridged(): RoutingGraph {
  return straightGraph(
    [
      { lat: 0.001, lng: 0.001 },
      { lat: 0.001, lng: 0.003 },
      { lat: 0.001, lng: 0.005 },
      { lat: 0.001, lng: 0.007 },
      { lat: 0.003, lng: 0.001 },
      { lat: 0.003, lng: 0.003 },
    ],
    [
      [0, 1],
      [1, 2],
      [2, 3],
      [0, 4],
      [4, 5],
      [5, 1],
    ],
  );
}

test("a single connecting street is credited", () => {
  const graph = bridged();
  expect(gap(graph, 0, 2, 445, 1.3)).toEqual(keys(graph, [1]));
});

// A block with a north and a south sidewalk joined by a crossing at each corner; `extra` adds ways round.
function sided(
  extra: { lat: number; lng: number }[],
  extraPairs: [number, number][],
): RoutingGraph {
  const graph = straightGraph(
    [
      { lat: 0.00091, lng: 0.001 },
      { lat: 0.00091, lng: 0.003 },
      { lat: 0.00109, lng: 0.003 },
      { lat: 0.00091, lng: 0.005 },
      { lat: 0.00109, lng: 0.005 },
      { lat: 0.00091, lng: 0.007 },
      ...extra,
    ],
    [[0, 1], [2, 4], [1, 3], [1, 2], [3, 4], [3, 5], ...extraPairs],
  );
  // North (1) and south (3) sides of one street record, in the side bits of kind+side.
  graph.edgeSourceId.set([5000, 5000], 1);
  graph.edgeKindSide.set([1 << 3, 3 << 3], 1);
  graph.edgeSourceId.set([NO_SOURCE_ID, NO_SOURCE_ID], 3);
  return graph;
}

test("a gap across a two-sided street credits both sides", () => {
  const graph = sided([], []);
  expect(gap(graph, 0, 5, 445, 1.3).sort()).toEqual(keys(graph, [1, 2]));
});

test("a street with a plausible parallel way round credits neither side", () => {
  const graph = sided(
    [{ lat: 0.0016, lng: 0.004 }],
    [
      [1, 6],
      [6, 3],
    ],
  );
  expect(gap(graph, 0, 5, 445, 1.3)).toEqual([]);
});

test("equally short ways credit only the stretches they all share", () => {
  const graph = straightGraph(
    [
      { lat: 0.001, lng: 0.001 },
      { lat: 0.001, lng: 0.002 },
      { lat: 0.001, lng: 0.003 },
      { lat: 0.002, lng: 0.004 },
      { lat: 0, lng: 0.004 },
      { lat: 0.001, lng: 0.005 },
      { lat: 0.001, lng: 0.006 },
      { lat: 0.001, lng: 0.007 },
    ],
    [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 5],
      [2, 4],
      [4, 5],
      [5, 6],
      [6, 7],
    ],
  );
  expect(gap(graph, 0, 7, 650, 1.3).sort()).toEqual(keys(graph, [1, 6]));
});

test("a gap longer than ten minutes is dropped", () => {
  const graph = straightGraph(
    [
      { lat: 0.001, lng: 0.001 },
      { lat: 0.001, lng: 0.003 },
      { lat: 0.001, lng: 0.0125 },
      { lat: 0.001, lng: 0.0145 },
    ],
    [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
  );
  expect(gap(graph, 0, 2, 1280, 1280 / 540)).toEqual(keys(graph, [1]));
  expect(gap(graph, 0, 2, 1280, 1280 / 660)).toEqual([]);
});

test("a gap crossed faster than a walk, or slower than one, is dropped", () => {
  const graph = bridged();
  expect(gap(graph, 0, 2, 445, 10)).toEqual([]);
  expect(gap(graph, 0, 2, 445, 0.2)).toEqual([]);
});

test("the gap runs from the last fix sharp enough to place", () => {
  const graph = bridged();
  const gaps = new WalkGaps();
  const index = buildSnapIndex(graph);
  expect(gaps.observe(midway(graph, 0, 0), graph, index)).toEqual([]);
  const vague = { ...midway(graph, 2, 100), accuracy: 45 };
  expect(gaps.observe(vague, graph, index)).toEqual([]);
  expect(gaps.observe(midway(graph, 2, 400), graph, index)).toEqual(
    keys(graph, [1]),
  );
});

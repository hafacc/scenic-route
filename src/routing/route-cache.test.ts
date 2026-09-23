import { expect, test } from "bun:test";
import { GATE_KEYS, type RouteWeights } from "./cost";
import type { RoutingGraph } from "./graph";
import { RouteCache } from "./route-cache";
import type { RouteResult } from "./search";
import type { Snap } from "./snap";

const weights = (
  tree: number,
  ferry: number,
  allowFerries: boolean,
): RouteWeights => ({
  tree,
  ferry,
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
  allowFerries,
  allowTransit: true,
  allowSheds: true,
  allowCrossings: false,
});

// The stub is piecewise-constant in each weight (thresholds at 0.5) and counts calls, so bracketing shows.
let calls = 0;
function chosenPath(tree: number, ferry: number, allow: boolean): number {
  if (!allow) {
    return 0; // ferries barred: the walking route, whatever the weights
  } else if (ferry > 0.5) {
    return 2; // ferry
  } else if (tree > 0.5) {
    return 1; // a shaded detour
  } else {
    return 0; // the direct walk
  }
}
function stubSearch(
  _graph: RoutingGraph,
  _start: Snap,
  _dest: Snap,
  routeWeights: RouteWeights,
): RouteResult {
  calls += 1;
  return {
    steps: [
      {
        edge: chosenPath(
          routeWeights.tree,
          routeWeights.ferry,
          routeWeights.allowFerries,
        ),
        forward: true,
      },
    ],
  } as unknown as RouteResult;
}

const GRAPH = {} as RoutingGraph;
const START = { edge: 0, metersFromA: 0 } as Snap;
const DEST = { edge: 1, metersFromA: 5 } as Snap;

function signature(
  result: { steps: { edge: number; forward: boolean }[] } | null,
): string {
  return result
    ? result.steps
        .map((step) => `${step.edge}${step.forward ? "f" : "b"}`)
        .join(",")
    : "∅";
}

test("the cache never returns a route that differs from a fresh search", () => {
  const cache = new RouteCache(stubSearch);
  const sequence: [number, number, boolean][] = [
    [0, 0.1, true],
    [0.2, 0.1, true],
    [0.6, 0.1, true],
    [1, 0.1, true],
    [1, 0.4, true],
    [1, 0.8, true],
    [0.6, 0.8, true],
    [0, 0.8, true],
    [0, 0.8, false],
    [0, 0.8, false],
    [0.6, 0.1, true],
    [0.6, 0.1, true],
    [1, 0.8, true],
    [0, 0.1, true],
  ];
  let previous: string | null = null;
  for (const [tree, ferry, allow] of sequence) {
    const cached = cache.route(GRAPH, START, DEST, weights(tree, ferry, allow));
    const expected = `${chosenPath(tree, ferry, allow)}f`;
    expect(signature(cached.result)).toBe(expected);
    if (previous !== null) {
      expect(cached.changed).toBe(expected !== previous);
    }
    previous = expected;
  }
});

test("bracketing the active slider skips the search on a settled interval", () => {
  calls = 0;
  const cache = new RouteCache(stubSearch);
  // The middle value is bracketed by two samples on one path, so it must not run the search.
  cache.route(GRAPH, START, DEST, weights(0.6, 0.1, true));
  cache.route(GRAPH, START, DEST, weights(1, 0.1, true));
  cache.route(GRAPH, START, DEST, weights(0.8, 0.1, true));
  expect(calls).toBe(2);
});

test("switching sliders drops the old range and rebrackets the new one", () => {
  calls = 0;
  const cache = new RouteCache(stubSearch);
  cache.route(GRAPH, START, DEST, weights(0.6, 0.1, true)); // tree axis
  cache.route(GRAPH, START, DEST, weights(1, 0.1, true)); // tree axis, two samples
  cache.route(GRAPH, START, DEST, weights(1, 0.8, true)); // switch to ferry: seed + compute
  cache.route(GRAPH, START, DEST, weights(1, 0.8, true)); // exact repeat: no search
  expect(calls).toBe(3);
  // The tree range was dropped, so an already-sampled tree weight runs again.
  cache.route(GRAPH, START, DEST, weights(0.6, 0.8, true));
  expect(calls).toBe(4);
});

// A weight missing from the axis list makes its slider look inert.
test("every weight a slider moves invalidates the cache", () => {
  const cache = new RouteCache(stubSearch);
  const base = weights(0.2, 0.1, true);
  cache.route(GRAPH, START, DEST, base);
  for (const axis of [
    "tree",
    "ferry",
    "landmark",
    "art",
    "highway",
    "hill",
    "commercial",
    "industrial",
    "historic",
    "shade",
    "shelter",
  ] as const) {
    calls = 0;
    cache.route(GRAPH, START, DEST, { ...base, [axis]: 0.7 });
    expect(`${axis}:${calls}`).toBe(`${axis}:1`);
    cache.route(GRAPH, START, DEST, base);
  }
});

// Walks GATE_KEYS rather than naming them, so the next gate added is covered too.
test("flipping any gate reaches the search, not just the two it was born with", () => {
  for (const gate of GATE_KEYS) {
    const cache = new RouteCache(stubSearch);
    const base = weights(0.2, 0.2, true);
    cache.route(GRAPH, START, DEST, base);
    const before = calls;
    cache.route(GRAPH, START, DEST, { ...base, [gate]: !base[gate] });
    expect(calls).toBeGreaterThan(before);
  }
});

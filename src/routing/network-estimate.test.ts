// A node just past the radius cap holds an upper bound, which must not leak into the estimate.

import { expect, test } from "bun:test";
import type { RoutingGraph } from "./graph";
import { networkMetersTo } from "./search";
import type { Snap } from "./snap";

// The far corner is 3 km direct but 2.05 km via the pair; lengths are stated, not measured.
const EDGES: readonly { a: number; b: number; meters: number }[] = [
  { a: 0, b: 1, meters: 2_000 },
  { a: 1, b: 2, meters: 50 },
  { a: 0, b: 2, meters: 3_000 },
];
const NODE_COUNT = 3;
// Far enough to settle the destination's own corner and nothing beyond it.
const RADIUS_METERS = 1_900;

const graph = {
  nodeCount: NODE_COUNT,
  csr: Uint32Array.from([0, 2, 4, 6]),
  adjacency: Uint32Array.from([0, 2, 0, 1, 1, 2]),
  edgeNodeA: Uint32Array.from(EDGES, (edge) => edge.a),
  edgeNodeB: Uint32Array.from(EDGES, (edge) => edge.b),
  edgeLength: Float32Array.from(EDGES, (edge) => edge.meters),
} as unknown as RoutingGraph;

const dest = { edge: 0, metersFromA: 0 } as Snap;

// Relaxed to a fixed point over the edge list, not through the heap under test.
function oracle(): number[] {
  const best = new Array<number>(NODE_COUNT).fill(Number.POSITIVE_INFINITY);
  best[0] = 0;
  for (let round = 0; round < NODE_COUNT; round += 1) {
    for (const { a, b, meters } of EDGES) {
      best[b] = Math.min(best[b], best[a] + meters);
      best[a] = Math.min(best[a], best[b] + meters);
    }
  }
  return best;
}

test("the whole network distance, with nothing capping it", () => {
  expect([...networkMetersTo(graph, dest)]).toEqual(oracle());
});

test("a node past the frontier is left to the straight line", () => {
  const truth = oracle();
  expect(truth[2]).toBe(2_050); // the pair of streets, not the 3 km one
  const capped = networkMetersTo(graph, dest, RADIUS_METERS);
  for (let node = 0; node < NODE_COUNT; node += 1) {
    if (Number.isFinite(capped[node])) {
      expect(capped[node]).toBeLessThanOrEqual(truth[node]);
    }
  }
  // Keeping the unsettled 3 km would claim 950 m of walking that isn't there.
  expect(capped[2]).toBe(Number.POSITIVE_INFINITY);
});

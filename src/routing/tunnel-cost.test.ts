// A tunnel claims both a roof and no sun; both must hold everywhere the cost model reads them.

import { expect, test } from "bun:test";
import {
  edgeMultiplier,
  maxShelter,
  minMultiplier,
  type RouteWeights,
  shadeAttrOf,
  shelterAttrOf,
  TUNNEL_SHELTER,
} from "./cost";
import {
  buildGraph,
  type EdgeSpec,
  type NodeSpec,
  snapAtNode,
} from "./ferry.fixture";
import type { RoutingGraph } from "./graph";
import { findRoute } from "./search";
import type { ShadeField } from "./shade";

// Several bins, so a tunnel must read dark at each, not just at departure.
const SUN_BY_BIN = [0.9, 0.7, 0.4, 0];
const BIN_SECONDS = 1800;
const PEAK_SUN = 0.9;

const TUNNEL_EDGE = 1;

const noPref = (over: Partial<RouteWeights> = {}): RouteWeights => ({
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
  allowCrossings: true,
  ...over,
});

// Every edge is baked fully sunlit, so a dark tunnel can only be the bit's doing.
function duskField(sunlit: Float32Array): ShadeField {
  const intensityAt = (elapsedSeconds: number): number =>
    SUN_BY_BIN[
      Math.min(SUN_BY_BIN.length - 1, Math.floor(elapsedSeconds / BIN_SECONDS))
    ];
  return {
    maxAbs: PEAK_SUN,
    intensityAt,
    attrAt: (edge: number, elapsedSeconds: number): number =>
      sunlit[edge] * intensityAt(elapsedSeconds),
  };
}

// Each edge is ~111 m, so the whole walk stays inside the first sun bin.
const NODES: NodeSpec[] = [
  { lat: 0, lng: 0 },
  { lat: 0.001, lng: 0 },
  { lat: 0.002, lng: 0 },
  { lat: 0.003, lng: 0 },
];

function tunnelGraph(tunnel = true): RoutingGraph {
  const edges: EdgeSpec[] = [
    { a: 0, b: 1, ferry: false, cover: 0, durationSeconds: 0 },
    { a: 1, b: 2, ferry: false, cover: 0, durationSeconds: 0, tunnel },
    { a: 2, b: 3, ferry: false, cover: 0, durationSeconds: 0 },
  ];
  const graph = buildGraph(NODES, edges);
  graph.shade = duskField(Float32Array.from([1, 1, 1]));
  return graph;
}

test("a tunnel is sheltered whole, in a city with no scaffolding feed at all", () => {
  const graph = tunnelGraph();
  expect(graph.sheds ?? null).toBeNull();
  expect(shelterAttrOf(graph, TUNNEL_EDGE, 0)).toBe(TUNNEL_SHELTER);
  expect(TUNNEL_SHELTER).toBeLessThan(1);
  expect(shelterAttrOf(graph, 0, 0)).toBe(0);
  expect(graph.edgeBridge[TUNNEL_EDGE]).toBe(0);
});

test("no sun reaches a tunnel at any point in the walk", () => {
  const graph = tunnelGraph();
  const shade = graph.shade as ShadeField;
  for (const elapsed of [0, BIN_SECONDS, 2 * BIN_SECONDS, 3 * BIN_SECONDS]) {
    const attr = shadeAttrOf(graph, TUNNEL_EDGE, elapsed, 0);
    expect(attr).toBe(-shade.intensityAt(elapsed));
    expect(Math.max(0, attr)).toBe(0); // the sun exposure the chip is a mean of
    // The pavement either side is baked identically, so the sign is the bit's alone.
    expect(shadeAttrOf(graph, 0, elapsed, 0)).toBe(shade.intensityAt(elapsed));
    expect(Math.abs(attr)).toBeLessThanOrEqual(shade.maxAbs);
  }
});

test("the shelter bound rises to meet a tunnel, and only where there is one", () => {
  expect(maxShelter(tunnelGraph())).toBe(TUNNEL_SHELTER);
  // Without the bit, the heuristic keeps the authority a raised bound would cost it.
  expect(maxShelter(tunnelGraph(false))).toBe(0);
});

test("the A* multiplier floor still bounds a tunnel from below", () => {
  const graph = tunnelGraph();
  for (const shelter of [0, 0.5, 1]) {
    for (const shade of [-1, 0, 1]) {
      const weights = noPref({ shelter, shade });
      const floor = minMultiplier(graph, weights);
      for (let edge = 0; edge < graph.edgeCount; edge++) {
        for (const elapsed of [0, BIN_SECONDS, 2 * BIN_SECONDS]) {
          expect(
            edgeMultiplier(graph, edge, weights, elapsed),
          ).toBeGreaterThanOrEqual(floor - 1e-12);
        }
      }
    }
  }
});

test("a trip through a tunnel reports it on the shelter and sun chips", () => {
  const graph = tunnelGraph();
  const route = findRoute(
    graph,
    snapAtNode(graph, 0, 0),
    snapAtNode(graph, 3, 2),
    noPref(),
  );
  expect(route).not.toBeNull();
  expect(route?.steps.map((step) => step.edge)).toEqual([0, 1, 2]);
  expect(route?.factors.shelter).toBeCloseTo(TUNNEL_SHELTER / 3, 6);
  expect(route?.factors.shade).toBeCloseTo(2 / 3, 6);
  expect(route?.factors.bridge).toBe(0);

  const bare = tunnelGraph(false);
  const sunlit = findRoute(
    bare,
    snapAtNode(bare, 0, 0),
    snapAtNode(bare, 3, 2),
    noPref(),
  );
  expect(sunlit?.factors.shelter).toBe(0);
  expect(sunlit?.factors.shade).toBeCloseTo(1, 6);
});

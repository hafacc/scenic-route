// Two ways between the same corners, close to even, so a walk history can tip which one wins.

import { buildGraph, snapAtNode } from "../routing/ferry.fixture";
import type { RoutingGraph } from "../routing/graph";
import type { Snap } from "../routing/snap";

// Near the equator, where the snap index's reference latitude is exact.
export const NODES = [
  { lat: 0.001, lng: 0.001 }, // 0: start
  { lat: 0.001, lng: 0.003 }, // 1: the straight way's midpoint
  { lat: 0.0013, lng: 0.003 }, // 2: the bowed way's midpoint, 33 m north
  { lat: 0.001, lng: 0.005 }, // 3: destination
];

// Edges 0 and 1 are the straight way, 2 and 3 the bowed one, about 2% longer.
export const STRAIGHT = [0, 1];
export const BOWED = [2, 3];

function zigzag(value: number, into: number[]): void {
  let encoded = value < 0 ? -2 * value - 1 : 2 * value;
  while (encoded >= 0x80) {
    into.push((encoded & 0x7f) | 0x80);
    encoded = Math.floor(encoded / 0x80);
  }
  into.push(encoded);
}

// Straight-line geometry and a source id per edge, which `buildGraph` leaves out.
export function straightGraph(
  nodes: readonly { lat: number; lng: number }[],
  pairs: readonly (readonly [number, number])[],
): RoutingGraph {
  const graph = buildGraph(
    [...nodes],
    pairs.map(([a, b]) => ({
      a,
      b,
      ferry: false,
      cover: 0,
      durationSeconds: 0,
    })),
  );
  const bytes: number[] = [];
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    const a = graph.edgeNodeA[edge];
    const b = graph.edgeNodeB[edge];
    graph.edgeGeomOffset[edge] = bytes.length;
    graph.edgeGeomCount[edge] = 2;
    zigzag(graph.nodeQx[a], bytes);
    zigzag(graph.nodeQy[a], bytes);
    zigzag(graph.nodeQx[b] - graph.nodeQx[a], bytes);
    zigzag(graph.nodeQy[b] - graph.nodeQy[a], bytes);
  }
  graph.geometry = Uint8Array.from(bytes);
  graph.edgeSourceId = Uint32Array.from(
    { length: graph.edgeCount },
    (_, edge) => 1000 + edge,
  );
  graph.edgeOrdinal = new Uint8Array(graph.edgeCount);
  graph.nodeComponent = new Uint16Array(graph.nodeCount);
  graph.familiar = null;
  return graph;
}

export function walkGraph(): RoutingGraph {
  return straightGraph(NODES, [
    [0, 1],
    [1, 3],
    [0, 2],
    [2, 3],
  ]);
}

// An avenue running north, crossed by a street, met by a dead-end side street, with a short block and a stub.
export const GRID_NODES = [
  { lat: 0.001, lng: 0.002 }, // 0: avenue, south end
  { lat: 0.002, lng: 0.002 }, // 1: avenue at the cross street
  { lat: 0.003, lng: 0.002 }, // 2: avenue at the side street
  { lat: 0.004, lng: 0.002 }, // 3: avenue, north end
  { lat: 0.002, lng: 0.001 }, // 4: cross street, west end
  { lat: 0.002, lng: 0.003 }, // 5: cross street at the stub
  { lat: 0.002, lng: 0.0033 }, // 6: the short block's east corner, 33 m on
  { lat: 0.002, lng: 0.0043 }, // 7: cross street, east end
  { lat: 0.003, lng: 0.001 }, // 8: side street, west end
  { lat: 0.002108, lng: 0.003 }, // 9: the stub's end, 12 m north
];

// Every edge but the short block and the stub is 111 m.
export const AVENUE = [0, 1, 2];
export const CROSS_WEST = 3;
export const CROSS_EAST = 4;
export const SHORT_BLOCK = 5;
export const CROSS_FAR = 6;
export const SIDE_STREET = 7;
export const STUB = 8;

export function gridGraph(): RoutingGraph {
  return straightGraph(GRID_NODES, [
    [0, 1],
    [1, 2],
    [2, 3],
    [4, 1],
    [1, 5],
    [5, 6],
    [6, 7],
    [8, 2],
    [5, 9],
  ]);
}

export function ends(graph: RoutingGraph): { start: Snap; dest: Snap } {
  return { start: snapAtNode(graph, 0, 0), dest: snapAtNode(graph, 3, 1) };
}

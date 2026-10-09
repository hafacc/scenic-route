import { beforeEach, expect, test } from "bun:test";
import {
  clearEdgePathCache,
  NO_GEOMETRY,
  type RoutingGraph,
} from "../routing/graph";
import type { Shed, ShedSpan } from "../routing/sheds";
import { projectX, projectY } from "./mercator";
import {
  CLOSED,
  HEAD_ROUND,
  type PathStrokes,
  TAIL_ROUND,
} from "./path-strokes";
import { pixelsPerMeter } from "./shed-decks";
import { CORNER_REACH_METERS, strokesOf, strokesPaused } from "./shed-strokes";

// A shed is one line through each corner it turns, though its spans stop short of the corner's node.

const SCALE = 1e-6;
const BLOCK = 0.001; // degrees

// A crossroads: node 0 in the middle, then its west, east, south and north arms' far ends.
const NODES = [
  { lat: 0, lng: 0 },
  { lat: 0, lng: -BLOCK },
  { lat: 0, lng: BLOCK },
  { lat: -BLOCK, lng: 0 },
  { lat: BLOCK, lng: 0 },
];
// West arm in, east and south arms out, north arm in, and the block's far side from east to south.
const EDGES: [number, number][] = [
  [1, 0],
  [0, 2],
  [0, 3],
  [4, 0],
  [2, 3],
];
const WEST = 0;
const EAST = 1;
const SOUTH = 2;
const NORTH = 3;
const FAR = 4;
const EDGE_METERS = 100;

// The edge-path cache is keyed on edge id alone, so fixtures would otherwise leak into each other.
beforeEach(clearEdgePathCache);

function crossroads(): RoutingGraph {
  const edgeCount = EDGES.length;
  return {
    nodeCount: NODES.length,
    edgeCount,
    originLng: 0,
    originLat: 0,
    scale: SCALE,
    nodeQx: Int32Array.from(NODES, (node) => Math.round(node.lng / SCALE)),
    nodeQy: Int32Array.from(NODES, (node) => Math.round(node.lat / SCALE)),
    edgeNodeA: Uint32Array.from(EDGES, ([from]) => from),
    edgeNodeB: Uint32Array.from(EDGES, ([, to]) => to),
    edgeLength: new Float32Array(edgeCount).fill(EDGE_METERS),
    edgeFlags: new Uint8Array(edgeCount),
    edgeGeomOffset: new Uint32Array(edgeCount).fill(NO_GEOMETRY),
    edgeGeomCount: new Uint16Array(edgeCount),
    geometry: new Uint8Array(0),
  } as unknown as RoutingGraph;
}

const shedOf = (spans: ShedSpan[]): Shed => ({
  first: 0,
  close: null,
  confidence: 1,
  spans,
});

const span = (edge: number, t0 = 0, t1 = 1): ShedSpan => ({
  edge,
  t0,
  t1,
  depth: 0,
});

// A span that stops `meters` short of the end of its edge the middle node is at.
const shortOf = (edge: number, meters: number): ShedSpan =>
  EDGES[edge][1] === 0
    ? span(edge, 0, 1 - meters / EDGE_METERS)
    : span(edge, meters / EDGE_METERS, 1);

interface Line {
  nodes: (number | null)[]; // each vertex's node, or null between nodes
  headRound: boolean;
  tailRound: boolean;
  closed: boolean;
}

function lines(strokes: PathStrokes): Line[] {
  const near = 0.01 * pixelsPerMeter(0);
  const out: Line[] = [];
  for (let stroke = 0; stroke + 1 < strokes.starts.length; stroke++) {
    const nodes: (number | null)[] = [];
    for (
      let vertex = strokes.starts[stroke];
      vertex < strokes.starts[stroke + 1];
      vertex++
    ) {
      const x = strokes.originX + strokes.points[vertex * 2];
      const y = strokes.originY + strokes.points[vertex * 2 + 1];
      const node = NODES.findIndex(
        ({ lat, lng }) =>
          Math.abs(projectX(lng, 0) - x) < near &&
          Math.abs(projectY(lat, 0) - y) < near,
      );
      nodes.push(node < 0 ? null : node);
    }
    out.push({
      nodes,
      headRound: (strokes.caps[stroke] & HEAD_ROUND) !== 0,
      tailRound: (strokes.caps[stroke] & TAIL_ROUND) !== 0,
      closed: (strokes.caps[stroke] & CLOSED) !== 0,
    });
  }
  return out;
}

const drawn = (...sheds: Shed[]): Line[] =>
  lines(strokesOf(crossroads(), sheds));

test("spans ending exactly on a corner's node are one line through it, round at both ends", () => {
  // Longest first, as the artifact stores them, so not in walk order.
  expect(drawn(shedOf([span(EAST), span(WEST)]))).toEqual([
    { nodes: [1, 0, 2], headRound: true, tailRound: true, closed: false },
  ]);
});

test("two ends that both stop short of the corner are drawn through its node", () => {
  const [line, ...rest] = drawn(
    shedOf([shortOf(WEST, 5), shortOf(EAST, CORNER_REACH_METERS)]),
  );
  expect(rest).toEqual([]);
  expect(line.nodes).toEqual([1, 0, 2]);
});

test("an end more than six meters short leaves both ends where their cover stops", () => {
  const far = drawn(shedOf([shortOf(WEST, 7), shortOf(EAST, 2)]));
  expect(far.map((line) => line.nodes)).toEqual([
    [1, null],
    [null, 2],
  ]);
  // The mid-block ends are cut square; the ones on the far nodes are round.
  expect(far.map((line) => [line.headRound, line.tailRound])).toEqual([
    [true, false],
    [false, true],
  ]);
});

test("three ends at one node are a fork, and none is drawn on to it", () => {
  const fork = drawn(
    shedOf([shortOf(WEST, 2), shortOf(EAST, 2), shortOf(SOUTH, 2)]),
  );
  expect(fork.map((line) => line.nodes)).toEqual([
    [1, null],
    [null, 2],
    [null, 3],
  ]);
  // On the node they stay three lines, each round where it stands on it.
  const meeting = drawn(shedOf([span(WEST), span(EAST), span(NORTH)]));
  expect(meeting.map((line) => line.nodes)).toEqual([
    [1, 0],
    [0, 2],
    [4, 0],
  ]);
  expect(meeting.every((line) => line.headRound && line.tailRound)).toBe(true);
});

test("two sheds meeting at a corner stay two lines, however close their ends", () => {
  const apart = drawn(shedOf([shortOf(WEST, 2)]), shedOf([shortOf(EAST, 2)]));
  expect(apart.map((line) => line.nodes)).toEqual([
    [1, null],
    [null, 2],
  ]);
  expect(drawn(shedOf([span(WEST)]), shedOf([span(EAST)])).length).toBe(2);
});

test("a shed that wraps its block closes on itself as one ring", () => {
  const ring = drawn(
    shedOf([shortOf(EAST, 3), span(FAR), span(SOUTH, 0.04, 1)]),
  );
  expect(ring.length).toBe(1);
  expect(ring[0].closed).toBe(true);
  expect([...ring[0].nodes].sort()).toEqual([0, 2, 3]);
});

test("a span this graph has no edge for, and one pinched to nothing, draw nothing", () => {
  expect(drawn(shedOf([span(-1), span(WEST, 0.4, 0.4)]))).toEqual([]);
});

// 198 of a day's spans cover an edge shorter than twice the reach, so each end faces its own node.
test("a span on a short edge is drawn on to both its nodes when each has its one other end", () => {
  const graph = crossroads();
  // The west arm is 10 m long here, and its span stops 2 m short at either end.
  graph.edgeLength[WEST] = 10;
  const short = span(WEST, 0.2, 0.8);
  const joined = lines(strokesOf(graph, [shedOf([short, shortOf(EAST, 3)])]));
  expect(joined.map((line) => line.nodes)).toEqual([[null, 0, 2]]);
  // Its far end has no partner at node 1, so it stays where the cover stops, cut square.
  expect([joined[0].headRound, joined[0].tailRound]).toEqual([false, true]);
});

test("a span alone on a short edge faces both nodes and is drawn on to neither", () => {
  const graph = crossroads();
  graph.edgeLength[WEST] = 10;
  const alone = lines(strokesOf(graph, [shedOf([span(WEST, 0.2, 0.8)])]));
  expect(alone).toEqual([
    { nodes: [null, null], headRound: false, tailRound: false, closed: false },
  ]);
});

// The placement gives a shed one span an edge; were there two, the ground between them is not covered.
test("two spans of one shed on one edge are not drawn across the gap between them", () => {
  const graph = crossroads();
  graph.edgeLength[WEST] = 10;
  const pair = lines(
    strokesOf(graph, [shedOf([span(WEST, 0.5, 0.6), span(WEST, 0.8, 0.9)])]),
  );
  expect(pair.map((line) => line.nodes)).toEqual([
    [null, null],
    [null, null],
  ]);
});

test("the paused build gives the same strokes, and gives up once a later day is wanted", async () => {
  const sheds = Array.from({ length: 600 }, () =>
    shedOf([span(WEST), span(EAST)]),
  );
  const graph = crossroads();
  const whole = strokesOf(graph, sheds);
  expect(whole.starts.length - 1).toBe(600);
  let pauses = 0;
  const pause = (): Promise<void> => {
    pauses += 1;
    return Promise.resolve();
  };
  const paused = await strokesPaused(graph, sheds, () => true, pause);
  expect(pauses).toBe(2);
  expect(paused?.points).toEqual(whole.points);
  expect(await strokesPaused(graph, sheds, () => false, pause)).toBeNull();
});

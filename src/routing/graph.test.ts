// The GRPH decoder over a file written by hand, which is the only way to ask whether it reads the
// layout the Rust writer lays down rather than the one it happens to write itself. v11's question is
// the transit topology: the three new kinds, their seconds where a walking edge keeps its cover, and
// the two side tables that say which lane a board edge departs against and which route it runs.

import { describe, expect, test } from "bun:test";
import {
  clearEdgePathCache,
  decodeGraph,
  EDGE_RECORD_BYTES,
  edgeKind,
  FORMAT_VERSION,
  HEADER_BYTES,
  isTransitEdge,
  isTunnel,
  laneOf,
  markMidRoadwayNodes,
  NO_GEOMETRY,
  NO_SOURCE_ID,
  routeOf,
  TUNNEL_FLAG,
} from "./graph";
import { buildSnapIndex, snapCandidates } from "./snap";

const SCALE = 1e-6;
const ORIGIN_LNG = -74;
const ORIGIN_LAT = 40.7;
const NAME_NONE = 0xffff;
const LANE_ONE = 0xdeadbeef;
const LANE_TWO = 0x0001_2345;

// Two walking nodes with a sidewalk and a ferry between them, two stations hung off them, and one
// pattern riding station to station: every kind the format has, in one file.
const NODES: readonly [number, number][] = [
  [0, 0], // 0 walking
  [2_000, 0], // 1 walking
  [10, 10], // 2 station A
  [1_990, 10], // 3 station B
  [10, 10], // 4 platform A, where its station stands
  [1_990, 10], // 5 platform B
  // The two ends of a footway under the ground, set well away from the rest so the snap index has
  // nothing to weigh it against.
  [0, 5_000], // 6
  [200, 5_000], // 7
];

interface EdgeSpec {
  a: number;
  b: number;
  kind: number;
  cover: number; // a walking edge's own byte
  seconds: number; // a ferry's or a transit edge's, in bytes 20-21
  geometry: boolean;
  bridge?: number; // record byte 38, the over-water share of a deck
  tunnel?: boolean; // record byte 23 bit 4
}

const EDGES: readonly EdgeSpec[] = [
  // The sidewalk carries a bridge byte: it is the walk that crosses the water here.
  { a: 0, b: 1, kind: 0, cover: 100, seconds: 0, geometry: true, bridge: 200 },
  { a: 0, b: 1, kind: 4, cover: 0, seconds: 600, geometry: false }, // ferry
  { a: 2, b: 0, kind: 5, cover: 0, seconds: 90, geometry: false }, // access, underground
  { a: 3, b: 1, kind: 5, cover: 0, seconds: 30, geometry: false }, // access, surface
  { a: 2, b: 4, kind: 6, cover: 0, seconds: 0, geometry: false }, // board
  { a: 4, b: 2, kind: 5, cover: 0, seconds: 30, geometry: false }, // alight
  { a: 4, b: 5, kind: 7, cover: 0, seconds: 300, geometry: false }, // ride
  { a: 3, b: 5, kind: 6, cover: 0, seconds: 0, geometry: false }, // board, the other end
  { a: 5, b: 3, kind: 5, cover: 0, seconds: 30, geometry: false }, // alight
  // A walking edge under the ground, appended last so every id above is where it was. It carries no
  // bridge share: a tunnel is the opposite of the thing that byte measures.
  { a: 6, b: 7, kind: 0, cover: 0, seconds: 0, geometry: false, tunnel: true },
];

const TUNNEL_EDGE = 9;

const BOARD_TABLE: readonly [number, number, number][] = [
  [4, LANE_ONE, 0],
  [7, LANE_TWO, 0],
];
const RIDE_TABLE: readonly [number, number][] = [[6, 0]];
const NAMES = ["Broadway", "A", "Eighth Avenue Express", "gtfs:A"];

function writeVarint(out: number[], value: number): void {
  let rest = (value << 1) ^ (value >> 31);
  do {
    const byte = rest & 0x7f;
    rest >>>= 7;
    out.push(rest === 0 ? byte : byte | 0x80);
  } while (rest !== 0);
}

// The blob as `assemble` lays it out: sections back to back from the header, each 4-byte aligned,
// then the geometry, the ferry side table and the transit tables.
// `bakedBridge` false stands in for a graph written before that column existed: byte 38 zero on
// every edge, which is what the decoder's gate has to read. `bakedTunnel` false does the same for the
// flags byte's tunnel bit.
function graphBytes(
  withTransit: boolean,
  bakedBridge = true,
  bakedTunnel = true,
): ArrayBuffer {
  const nodeCount = NODES.length;
  const edgeCount = EDGES.length;
  const align4 = (offset: number): number => (offset + 3) & ~3;

  const geometry: number[] = [];
  const geometryOffsets = new Map<number, number>();
  for (const [edge, spec] of EDGES.entries()) {
    if (!spec.geometry) {
      continue;
    }
    geometryOffsets.set(edge, geometry.length);
    let previousX = 0;
    let previousY = 0;
    for (const node of [spec.a, spec.b]) {
      writeVarint(geometry, NODES[node][0] - previousX);
      writeVarint(geometry, NODES[node][1] - previousY);
      [previousX, previousY] = NODES[node];
    }
  }

  const nameBlob = new TextEncoder().encode(NAMES.join(""));
  const nameTableBytes = 4 + 4 * (NAMES.length + 1) + nameBlob.length;

  const nodeLngAt = HEADER_BYTES;
  const nodeLatAt = nodeLngAt + 4 * nodeCount;
  const componentAt = nodeLatAt + 4 * nodeCount;
  const csrAt = componentAt + 2 * nodeCount + (nodeCount % 2 === 1 ? 2 : 0);
  const adjacencyAt = csrAt + 4 * (nodeCount + 1);
  const edgesAt = adjacencyAt + 8 * edgeCount;
  const nameAt = align4(edgesAt + EDGE_RECORD_BYTES * edgeCount);
  const geometryAt = align4(nameAt + nameTableBytes);
  const ferryAt = align4(geometryAt + geometry.length);
  const transitAt = ferryAt + 4;
  const routeBytes = withTransit ? 12 : 0;
  const total =
    transitAt +
    12 +
    routeBytes +
    12 * (withTransit ? BOARD_TABLE.length : 0) +
    8 * (withTransit ? RIDE_TABLE.length : 0);

  const buffer = new ArrayBuffer(total);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(new TextEncoder().encode("GRPH"));
  view.setUint16(4, FORMAT_VERSION, true);
  view.setUint16(6, HEADER_BYTES, true);
  view.setUint32(8, nodeCount, true);
  view.setUint32(12, edgeCount, true);
  view.setFloat64(16, ORIGIN_LNG, true);
  view.setFloat64(24, ORIGIN_LAT, true);
  view.setFloat64(32, SCALE, true);
  view.setUint32(40, 1, true);
  view.setUint32(44, nameAt, true);
  view.setUint32(48, nameTableBytes, true);
  view.setUint32(52, geometryAt, true);
  view.setUint32(56, geometry.length, true);
  view.setUint32(60, ferryAt, true);
  view.setUint32(64, withTransit ? transitAt : 0, true);

  for (const [node, [x, y]] of NODES.entries()) {
    view.setInt32(nodeLngAt + 4 * node, x, true);
    view.setInt32(nodeLatAt + 4 * node, y, true);
  }

  const incident: number[][] = NODES.map(() => []);
  for (const [edge, spec] of EDGES.entries()) {
    incident[spec.a].push(edge);
    incident[spec.b].push(edge);
  }
  let cursor = 0;
  for (const [node, edges] of incident.entries()) {
    view.setUint32(csrAt + 4 * node, cursor, true);
    for (const edge of edges) {
      view.setUint32(adjacencyAt + 4 * cursor, edge, true);
      cursor += 1;
    }
  }
  view.setUint32(csrAt + 4 * nodeCount, cursor, true);

  for (const [edge, spec] of EDGES.entries()) {
    const record = edgesAt + EDGE_RECORD_BYTES * edge;
    view.setUint32(record, spec.a, true);
    view.setUint32(record + 4, spec.b, true);
    view.setFloat32(record + 8, 100, true);
    const geometryOffset = geometryOffsets.get(edge);
    view.setUint32(record + 12, geometryOffset ?? NO_GEOMETRY, true);
    view.setUint16(record + 16, geometryOffset === undefined ? 0 : 2, true);
    view.setUint16(record + 18, NAME_NONE, true);
    view.setUint16(record + 20, spec.seconds, true);
    if (spec.cover !== 0) {
      bytes[record + 20] = spec.cover;
      bytes[record + 21] = 0;
    }
    bytes[record + 22] = spec.kind;
    bytes[record + 23] = bakedTunnel && spec.tunnel ? TUNNEL_FLAG : 0;
    view.setUint32(record + 29, NO_SOURCE_ID, true);
    bytes[record + 38] = bakedBridge ? (spec.bridge ?? 0) : 0;
  }

  view.setUint32(nameAt, NAMES.length, true);
  let nameCursor = 0;
  for (const [index, name] of NAMES.entries()) {
    view.setUint32(nameAt + 4 + 4 * index, nameCursor, true);
    nameCursor += name.length;
  }
  view.setUint32(nameAt + 4 + 4 * NAMES.length, nameCursor, true);
  bytes.set(nameBlob, nameAt + 4 + 4 * (NAMES.length + 1));
  bytes.set(Uint8Array.from(geometry), geometryAt);
  view.setUint32(ferryAt, 0, true); // no ferry endpoint names; the edge itself is still a ferry

  let at = transitAt;
  view.setUint32(at, withTransit ? 1 : 0, true);
  at += 4;
  if (withTransit) {
    bytes.set([0x00, 0x39, 0xa6, 0xff, 0xff, 0xff], at);
    view.setUint16(at + 6, 1, true); // "A"
    view.setUint16(at + 8, 2, true); // "Eighth Avenue Express"
    view.setUint16(at + 10, 3, true); // "gtfs:A"
    at += 12;
  }
  view.setUint32(at, withTransit ? BOARD_TABLE.length : 0, true);
  at += 4;
  if (withTransit) {
    for (const [edge, lane, route] of BOARD_TABLE) {
      view.setUint32(at, edge, true);
      view.setUint32(at + 4, lane, true);
      view.setUint16(at + 8, route, true);
      at += 12;
    }
  }
  view.setUint32(at, withTransit ? RIDE_TABLE.length : 0, true);
  at += 4;
  if (withTransit) {
    for (const [edge, route] of RIDE_TABLE) {
      view.setUint32(at, edge, true);
      view.setUint16(at + 4, route, true);
      at += 8;
    }
  }
  return buffer;
}

const identity = { hash: "0", keyHash: "0" };

describe("the v11 graph decoder", () => {
  const graph = decodeGraph(graphBytes(true), identity);

  test("reads every edge kind the format has", () => {
    expect(EDGES.map((_, edge) => edgeKind(graph, edge))).toEqual([
      "sidewalk",
      "ferry",
      "access",
      "access",
      "board",
      "access",
      "ride",
      "board",
      "access",
      "sidewalk",
    ]);
  });

  test("collects the transit edges and the board edges among them", () => {
    expect([...graph.transitEdges]).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect([...graph.boardEdges]).toEqual([4, 7]);
    expect([...graph.ferryEdges]).toEqual([1]);
    expect(graph.transitEdges.every((edge) => isTransitEdge(graph, edge))).toBe(
      true,
    );
    expect(isTransitEdge(graph, 0)).toBe(false);
    expect(isTransitEdge(graph, 1)).toBe(false);
  });

  test("reads a transit edge's seconds where a walking edge keeps its cover", () => {
    expect([...graph.edgeDurationSeconds]).toEqual([
      0, 600, 90, 30, 0, 30, 300, 0, 30, 0,
    ]);
    // The one walking edge is the only thing that may set the cover ceiling: a duration in bytes
    // 20-21 read as a cover would put maxCover at 1 and collapse the cost model's clip floor.
    expect(graph.edgeCover[0]).toBe(100);
    expect(graph.maxCover).toBeCloseTo(100 / 255, 10);
    expect(graph.edgeCover[6]).toBe(0);
  });

  test("reads the bridge byte, which a graph written before the bake leaves 0", () => {
    expect(graph.edgeBridge[0]).toBe(200);
    expect(graph.maxBridge).toBeCloseTo(200 / 255, 10);
    // The bake's own gate: a graph with the byte unwritten reads 0 everywhere, so the factor's max
    // is 0 and its slider takes itself off the panel rather than mispricing anything.
    expect(decodeGraph(graphBytes(true, false), identity).maxBridge).toBe(0);
  });

  test("reads the tunnel bit, which a graph written before it existed reads as 0", () => {
    expect(isTunnel(graph, TUNNEL_EDGE)).toBe(true);
    expect(graph.hasTunnels).toBe(true);
    expect(graph.edgeBridge[TUNNEL_EDGE]).toBe(0); // under the water is not over it

    expect(
      EDGES.every((_, edge) => edge === TUNNEL_EDGE || !isTunnel(graph, edge)),
    ).toBe(true);
    // The byte predates the bit, so an older graph simply has it clear, and the flag that lifts the
    // shelter bound stays down with it.
    const preTunnel = decodeGraph(graphBytes(true, true, false), identity);
    expect(isTunnel(preTunnel, TUNNEL_EDGE)).toBe(false);
    expect(preTunnel.hasTunnels).toBe(false);
  });

  test("says which lane a board edge departs against and which route it runs", () => {
    expect(laneOf(graph, 4)).toBe(LANE_ONE);
    expect(laneOf(graph, 7)).toBe(LANE_TWO);
    expect(laneOf(graph, 6)).toBe(-1); // a ride departs against nothing
    expect(laneOf(graph, 0)).toBe(-1);
    expect(routeOf(graph, 4)?.shortName).toBe("A");
    expect(routeOf(graph, 6)?.longName).toBe("Eighth Avenue Express");
    expect(routeOf(graph, 6)?.id).toBe("gtfs:A");
    expect(routeOf(graph, 6)?.color).toBe("#0039a6");
    expect(routeOf(graph, 6)?.textColor).toBe("#ffffff");
    expect(routeOf(graph, 2)).toBeNull(); // the walk into a station runs no line
    expect(routeOf(graph, 0)).toBeNull();
  });

  test("never snaps a walker onto a platform", () => {
    clearEdgePathCache(); // the polyline cache keys on the edge id alone, across graphs
    const index = buildSnapIndex(graph);
    // Right on top of station A, which is a metre off the sidewalk and shares its point with a
    // platform node: the only thing indexed is the pavement.
    const snaps = snapCandidates(graph, index, {
      lat: ORIGIN_LAT + 10 * SCALE,
      lng: ORIGIN_LNG + 10 * SCALE,
    });
    expect(snaps.length).toBeGreaterThan(0);
    expect(snaps.map((snap) => snap.edge)).toEqual([0]);
  });

  test("a station on a traffic island does not pave it", () => {
    // A crossing chained through an island (nodes 0-1-2), with a station node 3 hung off the island
    // by an access edge. The island is still mid-roadway — a walker standing there is part way
    // through one crossing — and the station, which has no walking edge at all, is not.
    const csr = Uint32Array.from([0, 1, 4, 5, 6]);
    const adjacency = Uint32Array.from([0, 0, 1, 2, 1, 2]);
    const kinds = Uint8Array.from([1, 1, 5]); // crossing, crossing, access
    expect([...markMidRoadwayNodes(4, csr, adjacency, kinds)]).toEqual([
      1, 1, 1, 0,
    ]);
  });

  test("a city with no transit source decodes to no transit at all", () => {
    const walkingOnly = decodeGraph(graphBytes(false), identity);
    expect(walkingOnly.transitRoutes).toEqual([]);
    expect(laneOf(walkingOnly, 4)).toBe(-1);
    expect(routeOf(walkingOnly, 6)).toBeNull();
    // The kinds are still in the records; only the side tables are gone.
    expect([...walkingOnly.transitEdges]).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });
});

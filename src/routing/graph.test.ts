// The GRPH decoder over a file written by hand, which is the only way to ask whether it reads the
// layout the Rust writer lays down rather than the one it happens to write itself. v12's question is
// the section directory: every column viewed in place at the offset the header names, the baked
// maxima and id lists read off the header rather than off a pass over the edges, and a column the
// file leaves out read as the zeros a graph written before that bake carried.

import { describe, expect, test } from "bun:test";
import {
  clearEdgePathCache,
  decodeGraph,
  edgeDurableKey,
  edgeKind,
  FORMAT_VERSION,
  isTransitEdge,
  isTunnel,
  laneOf,
  markMidRoadwayNodes,
  NO_SOURCE_ID,
  routeOf,
  TUNNEL_FLAG,
} from "./graph";
import {
  encodeGraph,
  type GraphSection,
  NAME_NONE,
} from "./graph-bytes.fixture";
import { buildSnapIndex, snapCandidates } from "./snap";

const SCALE = 1e-6;
const ORIGIN_LNG = -74;
const ORIGIN_LAT = 40.7;
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
  seconds: number; // a ferry's or a transit edge's duration
  geometry: boolean;
  bridge?: number; // the over-water share of a deck
  tunnel?: boolean; // the flags byte's bit 4
  source?: [number, number]; // the source id and the ordinal within it
}

const EDGES: readonly EdgeSpec[] = [
  // The sidewalk carries a bridge byte: it is the walk that crosses the water here.
  {
    a: 0,
    b: 1,
    kind: 0,
    cover: 100,
    seconds: 0,
    geometry: true,
    bridge: 200,
    source: [4_242, 3],
  },
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
  {
    a: 6,
    b: 7,
    kind: 0,
    cover: 0,
    seconds: 0,
    geometry: false,
    tunnel: true,
    source: [9_001, 0],
  },
];

const TUNNEL_EDGE = 9;

const BOARD_TABLE: readonly [number, number, number][] = [
  [4, LANE_ONE, 0],
  [7, LANE_TWO, 0],
];
const RIDE_TABLE: readonly [number, number][] = [[6, 0]];
const NAMES = ["Broadway", "A", "Eighth Avenue Express", "gtfs:A"];

// The blob as `assemble` lays it out. `bakedBridge` false stands in for a graph written before that
// column existed: the section is simply absent, which is what the decoder's gate has to read as
// zeros. `bakedTunnel` false does the same for the flags byte's tunnel bit, which came without a
// section of its own.
function graphBytes(
  withTransit: boolean,
  bakedBridge = true,
  bakedTunnel = true,
  swap?: readonly [GraphSection, GraphSection],
): ArrayBuffer {
  return encodeGraph({
    originLng: ORIGIN_LNG,
    originLat: ORIGIN_LAT,
    scale: SCALE,
    nodes: NODES.map(([qx, qy]) => ({ qx, qy })),
    edges: EDGES.map((spec) => ({
      a: spec.a,
      b: spec.b,
      kind: spec.kind,
      length: 100,
      geometry: spec.geometry
        ? ([NODES[spec.a], NODES[spec.b]] as const)
        : undefined,
      nameId: NAME_NONE,
      durationSeconds: spec.seconds,
      cover: spec.cover,
      bridge: spec.bridge,
      flags: bakedTunnel && spec.tunnel ? TUNNEL_FLAG : 0,
      sourceId: spec.source?.[0] ?? NO_SOURCE_ID,
      ordinal: spec.source?.[1] ?? 0,
    })),
    names: NAMES,
    transitRoutes: withTransit
      ? [
          {
            color: [0x00, 0x39, 0xa6],
            textColor: [0xff, 0xff, 0xff],
            shortName: 1, // "A"
            longName: 2, // "Eighth Avenue Express"
            id: 3, // "gtfs:A"
          },
        ]
      : [],
    board: withTransit
      ? BOARD_TABLE.map(([edge, lane, route]) => ({
          edge,
          lane,
          route,
          stop: 0,
        }))
      : [],
    ride: withTransit
      ? RIDE_TABLE.map(([edge, route]) => ({ edge, route }))
      : [],
    omit: bakedBridge ? [] : ["edgeBridge"],
    swap,
  });
}

const identity = { hash: "0", keyHash: "0" };

describe("the v12 graph decoder", () => {
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
    // The one walking edge is the only thing that may set the cover ceiling: a duration read as a
    // cover would put maxCover at 1 and collapse the cost model's clip floor.
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

  test("puts every section on an 8-byte boundary the directory names", () => {
    const buffer = graphBytes(true);
    const view = new DataView(buffer);
    const sections = view.getUint32(44, true);
    expect(sections).toBe(35);
    expect(view.getUint16(6, true)).toBe(640);
    expect(view.getUint16(4, true)).toBe(FORMAT_VERSION);
    for (let index = 0; index < sections; index++) {
      const offset = view.getUint32(64 + 12 * index, true);
      const byteLength = view.getUint32(64 + 12 * index + 4, true);
      expect(offset % 8).toBe(0);
      expect(offset + byteLength).toBeLessThanOrEqual(buffer.byteLength);
    }
  });

  test("refuses a file whose columns are not where the directory says", () => {
    // Two u8 columns of the same length, written in the other order: every byte of the file is a
    // byte the reader would accept, and the only thing that says they have traded places is the tag
    // each directory entry carries. Read positionally, this city's shade would be priced off its
    // landmarks.
    expect(() =>
      decodeGraph(
        graphBytes(true, true, true, ["edgeCover", "edgeLandmark"]),
        identity,
      ),
    ).toThrow(/edgeCover/);
  });

  test("reads a column the file leaves out as the zeros it never wrote", () => {
    // The directory entry stays in place, zeroed, so every later section is still where it was: a
    // column baked after this graph was written costs it nothing but that column.
    const older = decodeGraph(graphBytes(true, false), identity);
    expect(older.maxBridge).toBe(0);
    expect([...older.edgeBridge]).toEqual(EDGES.map(() => 0));
    expect(older.edgeBridge.length).toBe(EDGES.length);
    expect([...older.edgeCover]).toEqual([...graph.edgeCover]);
    expect([...older.transitEdges]).toEqual([...graph.transitEdges]);
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

  test("names an edge durably, which is what places the sheds", () => {
    // The shed artifact names a deck by (source id, side, ordinal) and the page is the thread that
    // draws it, so both threads decode these two columns — under v12 there is only one decode.
    expect(edgeDurableKey(graph, 0)).toBe(4_242 * 2048 + 3);
    expect(edgeDurableKey(graph, TUNNEL_EDGE)).toBe(9_001 * 2048);
    expect(edgeDurableKey(graph, 1)).toBe(-1); // a ferry has no source segment
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

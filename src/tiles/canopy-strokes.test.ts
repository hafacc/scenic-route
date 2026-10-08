import { beforeEach, expect, test } from "bun:test";
import { decodeCanopyRuns, edgeOrderHash } from "../routing/canopy-runs";
import { fixtureBuffer, GRAPH_KEY_HASH } from "../routing/canopy-runs.fixture";
import {
  clearEdgePathCache,
  NO_GEOMETRY,
  type RoutingGraph,
} from "../routing/graph";
import { canopyStrokes } from "./canopy-strokes";
import { projectX, projectY } from "./mercator";
import { HEAD_ROUND, type PathStrokes, TAIL_ROUND } from "./path-strokes";

// The fixture's four edges laid west to east, node n at n steps along the equator.

const SCALE = 1e-6;
const STEP = 0.0005; // degrees
const WORLD = { x: 0, y: 0, z: 0 };

beforeEach(clearEdgePathCache);

function lineGraph(keyHash: string): RoutingGraph {
  const edgeCount = 4;
  const nodes = [0, 1, 2, 3, 4];
  return {
    keyHash,
    nodeCount: nodes.length,
    edgeCount,
    originLng: 0,
    originLat: 0,
    scale: SCALE,
    nodeQx: Int32Array.from(nodes, (node) => Math.round((node * STEP) / SCALE)),
    nodeQy: new Int32Array(nodes.length),
    edgeNodeA: Uint32Array.from([0, 1, 2, 3]),
    edgeNodeB: Uint32Array.from([1, 2, 3, 4]),
    edgeLength: Float32Array.from([50, 50, 50, 300]),
    edgeFlags: new Uint8Array(edgeCount),
    edgeGeomOffset: new Uint32Array(edgeCount).fill(NO_GEOMETRY),
    edgeGeomCount: new Uint16Array(edgeCount),
    geometry: new Uint8Array(0),
  } as unknown as RoutingGraph;
}

interface Line {
  steps: number[]; // each vertex, in steps east of node 0
  headRound: boolean;
  tailRound: boolean;
}

function lines(sets: readonly PathStrokes[]): Line[] {
  const step = projectX(STEP, 0) - projectX(0, 0);
  const out: Line[] = [];
  for (const strokes of sets) {
    for (let stroke = 0; stroke + 1 < strokes.starts.length; stroke++) {
      const steps: number[] = [];
      for (
        let vertex = strokes.starts[stroke];
        vertex < strokes.starts[stroke + 1];
        vertex++
      ) {
        const x = strokes.originX + strokes.points[vertex * 2];
        steps.push(Math.round(((x - projectX(0, 0)) / step) * 100) / 100);
      }
      out.push({
        steps,
        headRound: (strokes.caps[stroke] & HEAD_ROUND) !== 0,
        tailRound: (strokes.caps[stroke] & TAIL_ROUND) !== 0,
      });
    }
  }
  return out.sort((left, right) => left.steps[0] - right.steps[0]);
}

test("the drawn stretches are lines on their edges, one through a node they are joined at", async () => {
  const strokes = await canopyStrokes(
    lineGraph(GRAPH_KEY_HASH),
    decodeCanopyRuns(fixtureBuffer()),
  );
  expect(lines(strokes.strokes(WORLD, 4))).toEqual([
    // Mid-block at both ends, with the bridged gap inside it.
    { steps: [0.2, 0.6], headRound: false, tailRound: false },
    // The end of edge 0 and the start of edge 1, with node 1 as the one vertex between them.
    { steps: [0.92, 1, 1.08], headRound: false, tailRound: false },
    // Edge 3's second half, round where it stands on node 4; edge 1's short crown is not drawn.
    { steps: [3.5, 4], headRound: false, tailRound: true },
  ]);
});

test("a tile is handed only the cells it reaches, each cut once", async () => {
  const strokes = await canopyStrokes(
    lineGraph(GRAPH_KEY_HASH),
    decodeCanopyRuns(fixtureBuffer()),
  );
  // Zoom 14's tile on the far side of the world from the fixture.
  expect(strokes.strokes({ x: 0, y: 0, z: 14 }, 4)).toEqual([]);
  const near = { x: 8192, y: 8191, z: 14 };
  // The one cell is cut by the first call, which leaves nothing for a second to do.
  expect(strokes.prepare(near, 4)).toBe(false);
  const [first] = strokes.strokes(near, 4);
  expect(strokes.strokes(near, 4)).toEqual([first]);
  expect(strokes.strokes(near, 4)[0]).toBe(first);
});

test("runs sampled along another graph draw nothing on this one", async () => {
  const strokes = await canopyStrokes(
    lineGraph("0123456789abcdef"),
    decodeCanopyRuns(fixtureBuffer()),
  );
  expect(strokes.prepare(WORLD, 4)).toBe(false);
  expect(strokes.strokes(WORLD, 4)).toEqual([]);
});

// Graphs with real geometry, and artifacts written for them here: the layout itself is pinned by the fixture.

const KEY = "00000000000000aa";

interface Shape {
  nodes: [number, number];
  vertices: [number, number][]; // quantized units; the first and last are the nodes' own
  runs: [gap: number, count: number][]; // of 100 samples, every one drawn
}

const zigzag = (value: number): number =>
  value < 0 ? -2 * value - 1 : 2 * value;

function varints(values: number[]): number[] {
  const bytes: number[] = [];
  for (let value of values) {
    while (value >= 0x80) {
      bytes.push((value & 0x7f) | 0x80);
      value = Math.floor(value / 128);
    }
    bytes.push(value);
  }
  return bytes;
}

function shaped(shapes: Shape[]): {
  graph: RoutingGraph;
  runs: ReturnType<typeof decodeCanopyRuns>;
} {
  const nodeCount = Math.max(...shapes.flatMap((shape) => shape.nodes)) + 1;
  const nodeQx = new Int32Array(nodeCount);
  const nodeQy = new Int32Array(nodeCount);
  const geometry: number[] = [];
  const offsets: number[] = [];
  for (const { nodes, vertices } of shapes) {
    [nodeQx[nodes[0]], nodeQy[nodes[0]]] = vertices[0];
    [nodeQx[nodes[1]], nodeQy[nodes[1]]] = vertices[vertices.length - 1];
    offsets.push(geometry.length);
    let [lastX, lastY] = [0, 0];
    for (const [x, y] of vertices) {
      geometry.push(...varints([zigzag(x - lastX), zigzag(y - lastY)]));
      [lastX, lastY] = [x, y];
    }
  }
  const graph = {
    keyHash: KEY,
    nodeCount,
    edgeCount: shapes.length,
    originLng: 0,
    originLat: 0,
    scale: SCALE,
    nodeQx,
    nodeQy,
    edgeNodeA: Uint32Array.from(shapes, (shape) => shape.nodes[0]),
    edgeNodeB: Uint32Array.from(shapes, (shape) => shape.nodes[1]),
    edgeLength: new Float32Array(shapes.length).fill(100),
    edgeFlags: new Uint8Array(shapes.length),
    edgeGeomOffset: Uint32Array.from(offsets),
    edgeGeomCount: Uint16Array.from(shapes, (shape) => shape.vertices.length),
    geometry: Uint8Array.from(geometry),
  } as unknown as RoutingGraph;

  const records: number[] = [];
  let runCount = 0;
  shapes.forEach((shape, edge) => {
    records.push(...varints([edge === 0 ? 0 : 1, 100, shape.runs.length << 1]));
    for (const [gap, count] of shape.runs) {
      records.push(...varints([gap, (count << 2) | 1]));
      runCount += 1;
    }
  });
  const bytes = new Uint8Array(36 + records.length);
  const view = new DataView(bytes.buffer);
  bytes.set([0x43, 0x52, 0x55, 0x4e]);
  view.setUint16(4, 2, true);
  view.setUint16(6, 36, true);
  view.setUint32(8, shapes.length, true);
  view.setUint32(12, shapes.length, true);
  view.setUint32(16, 0xaa, true);
  view.setUint32(24, runCount, true);
  view.setUint32(32, edgeOrderHash(graph), true);
  bytes.set(records, 36);
  return { graph, runs: decodeCanopyRuns(bytes.buffer) };
}

// Each stroke's vertices back in quantized units.
function quantized(sets: readonly PathStrokes[]): [number, number][][] {
  const perUnitX = projectX(SCALE, 0) - projectX(0, 0);
  const perUnitY = projectY(SCALE, 0) - projectY(0, 0);
  return sets.flatMap((strokes) =>
    Array.from({ length: strokes.starts.length - 1 }, (_, stroke) => {
      const line: [number, number][] = [];
      for (
        let vertex = strokes.starts[stroke];
        vertex < strokes.starts[stroke + 1];
        vertex++
      ) {
        line.push([
          Math.round(
            (strokes.originX + strokes.points[vertex * 2] - projectX(0, 0)) /
              perUnitX,
          ),
          Math.round(
            (strokes.originY +
              strokes.points[vertex * 2 + 1] -
              projectY(0, 0)) /
              perUnitY,
          ),
        ]);
      }
      return line;
    }),
  );
}

// The z14 tile a quantized point falls in.
function tileAt(x: number, y: number): { x: number; y: number; z: number } {
  return {
    x: Math.floor(projectX(x * SCALE, 14) / 256),
    y: Math.floor(projectY(y * SCALE, 14) / 256),
    z: 14,
  };
}

test("a stretch on a bent edge is cut along its vertices, the corner between its ends included", async () => {
  const { graph, runs } = shaped([
    {
      nodes: [0, 1],
      vertices: [
        [100, -200],
        [1100, -200],
        [1100, -1200],
      ],
      runs: [[25, 50]],
    },
  ]);
  const strokes = await canopyStrokes(graph, runs);
  // A quarter and three quarters of the way along 2,000 units, either side of the corner.
  expect(quantized(strokes.strokes(tileAt(100, -200), 4))).toEqual([
    [
      [600, -200],
      [1100, -200],
      [1100, -700],
    ],
  ]);
});

test("two stretches on one bent edge each keep only the vertices between their own ends", async () => {
  const { graph, runs } = shaped([
    {
      nodes: [0, 1],
      vertices: [
        [0, -100],
        [1000, -100],
        [1000, -1100],
        [2000, -1100],
      ],
      runs: [
        [0, 20],
        [30, 50],
      ],
    },
  ]);
  const strokes = await canopyStrokes(graph, runs);
  expect(quantized(strokes.strokes(tileAt(0, -100), 4))).toEqual([
    [
      [0, -100],
      [600, -100],
    ],
    [
      [1000, -600],
      [1000, -1100],
      [2000, -1100],
    ],
  ]);
});

test("an edge longer than a cell is found from every cell it crosses", async () => {
  // Cells are 4,500 units; this runs through three of them.
  const { graph, runs } = shaped([
    {
      nodes: [0, 1],
      vertices: [
        [200, -300],
        [12000, -300],
      ],
      runs: [[0, 100]],
    },
  ]);
  const strokes = await canopyStrokes(graph, runs);
  const whole: [number, number][][] = [
    [
      [200, -300],
      [12000, -300],
    ],
  ];
  const all = strokes.strokes(WORLD, 4);
  expect(all.length).toBe(3);
  for (const set of all) {
    expect(quantized([set])).toEqual(whole);
  }
});

test("past the cache's limit the cell read longest ago is cut again, to the same strokes", async () => {
  const far: Shape[] = [0, 1, 2].map((edge) => ({
    nodes: [edge * 2, edge * 2 + 1],
    vertices: [
      [edge * 100_000, -300],
      [edge * 100_000 + 800, -300],
    ],
    runs: [[0, 100]],
  }));
  const tiles = far.map((shape) => tileAt(shape.vertices[0][0] + 400, -300));

  const spacious = shaped(far);
  const roomy = await canopyStrokes(spacious.graph, spacious.runs);
  const kept = roomy.strokes(tiles[0], 4)[0];
  roomy.strokes(tiles[1], 4);
  roomy.strokes(tiles[2], 4);
  expect(roomy.strokes(tiles[0], 4)[0]).toBe(kept);

  const { graph, runs } = shaped(far);
  const tight = await canopyStrokes(graph, runs, () => Promise.resolve(), 2);
  const first = tight.strokes(tiles[0], 4)[0];
  tight.strokes(tiles[1], 4);
  // Read again, so it is the second cell that goes when the third arrives.
  expect(tight.strokes(tiles[0], 4)[0]).toBe(first);
  tight.strokes(tiles[2], 4);
  expect(tight.strokes(tiles[0], 4)[0]).toBe(first);
  const recut = tight.strokes(tiles[1], 4)[0];
  tight.strokes(tiles[2], 4);
  const again = tight.strokes(tiles[0], 4)[0];
  expect(again).not.toBe(first);
  expect(quantized([again])).toEqual(quantized([first]));
  expect(quantized([recut])).toEqual([
    [
      [100_000, -300],
      [100_800, -300],
    ],
  ]);
});

// Far from the equator a degree east is shorter than a degree north, and the tiler measured in meters.
test("a stretch's share is of the edge's length on the ground, as the tiler sampled it", async () => {
  const { graph, runs } = shaped([
    {
      nodes: [0, 1],
      vertices: [
        [0, 0],
        [1000, 0],
        [1000, 1000],
      ],
      runs: [[0, 50]],
    },
  ]);
  // At 60 degrees north the eastward leg is half the northward one's length: 500 of 1,500.
  (graph as { originLat: number }).originLat = 60;
  const strokes = await canopyStrokes(graph, runs);
  const perUnitX = projectX(SCALE, 0) - projectX(0, 0);
  const [stroke] = strokes.strokes(WORLD, 4);
  const xs: number[] = [];
  for (let vertex = 0; vertex < stroke.points.length / 2; vertex++) {
    xs.push(
      Math.round(
        (stroke.originX + stroke.points[vertex * 2] - projectX(0, 0)) /
          perUnitX,
      ),
    );
  }
  // Half the length is 750: the whole eastward leg and a quarter of the northward one.
  expect(xs).toEqual([0, 1000, 1000]);
  const top = projectY(60, 0);
  const quarter = projectY(60 + 250 * SCALE, 0);
  expect(stroke.originY + stroke.points[5]).toBeCloseTo(quarter, 7);
  expect(stroke.originY + stroke.points[1]).toBeCloseTo(top, 7);
});

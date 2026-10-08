import {
  type CanopyRuns,
  edgeRuns,
  edgeStretches,
  sameGraph,
} from "../routing/canopy-runs";
import { NO_GEOMETRY, type RoutingGraph } from "../routing/graph";
import { type BoxGrid, buildGridPaused, EMPTY_GRID } from "./box-grid";
import { chainPaths } from "./chain";
import { pixelsToDegrees, projectX, projectY, unproject } from "./mercator";
import {
  NO_STROKES,
  type PathStrokes,
  type Piece,
  packStrokes,
} from "./path-strokes";
import { type Cursor, readVarint } from "./varint";

// Tree cover as lines on the paths under it, cut a grid cell at a time as tiles first reach each.

const TILE_SIZE = 256;

// Degrees a cell spans: about 500 m north to south, and less east to west by the latitude's cosine.
const CELL_DEGREES = 0.0045;

// About a 1080p screen and its surround at the layer's lowest zoom, in under 20 MB; past it the cell read longest ago is cut again.
const CELL_CACHE_LIMIT = 1024;

// Edges boxed between pauses, so indexing a city never holds a frame.
const INDEX_BATCH = 8192;

// An edge's vertices in the graph's quantized units, into `xs` and `ys`; returns how many.
function edgeVertices(
  graph: RoutingGraph,
  edge: number,
  scratch: { xs: Float64Array; ys: Float64Array },
  cursor: Cursor,
): number {
  if (graph.edgeGeomOffset[edge] === NO_GEOMETRY) {
    const nodeA = graph.edgeNodeA[edge];
    const nodeB = graph.edgeNodeB[edge];
    scratch.xs[0] = graph.nodeQx[nodeA];
    scratch.ys[0] = graph.nodeQy[nodeA];
    scratch.xs[1] = graph.nodeQx[nodeB];
    scratch.ys[1] = graph.nodeQy[nodeB];
    return 2;
  }
  const count = graph.edgeGeomCount[edge];
  if (count > scratch.xs.length) {
    scratch.xs = new Float64Array(count);
    scratch.ys = new Float64Array(count);
  }
  // The first pair is from the graph origin; the rest are previous-vertex deltas.
  cursor.offset = graph.edgeGeomOffset[edge];
  let quantizedX = 0;
  let quantizedY = 0;
  for (let vertex = 0; vertex < count; vertex++) {
    quantizedX += readVarint(graph.geometry, cursor);
    quantizedY += readVarint(graph.geometry, cursor);
    scratch.xs[vertex] = quantizedX;
    scratch.ys[vertex] = quantizedY;
  }
  return count;
}

const newScratch = (): { xs: Float64Array; ys: Float64Array } => ({
  xs: new Float64Array(64),
  ys: new Float64Array(64),
});

// Every covered edge's box in the graph's quantized units, which need no projection to compare.
interface EdgeIndex {
  boxes: Int32Array;
  grid: BoxGrid;
}

const NO_INDEX: EdgeIndex = { boxes: new Int32Array(0), grid: EMPTY_GRID };

async function indexEdges(
  graph: RoutingGraph,
  runs: CanopyRuns,
  pause: () => Promise<void>,
): Promise<EdgeIndex> {
  const count = runs.edges.length;
  const boxes = new Int32Array(count * 4);
  const scratch = newScratch();
  const cursor: Cursor = { offset: 0 };
  for (let record = 0; record < count; record++) {
    if (record > 0 && record % INDEX_BATCH === 0) {
      await pause();
    }
    const vertices = edgeVertices(graph, runs.edges[record], scratch, cursor);
    let west = scratch.xs[0];
    let east = west;
    let south = scratch.ys[0];
    let north = south;
    for (let vertex = 1; vertex < vertices; vertex++) {
      const x = scratch.xs[vertex];
      const y = scratch.ys[vertex];
      west = x < west ? x : west;
      east = x > east ? x : east;
      south = y < south ? y : south;
      north = y > north ? y : north;
    }
    boxes[record * 4] = west;
    boxes[record * 4 + 1] = south;
    boxes[record * 4 + 2] = east;
    boxes[record * 4 + 3] = north;
  }
  const cellSize = CELL_DEGREES / graph.scale;
  return { boxes, grid: await buildGridPaused(boxes, cellSize, pause) };
}

// A stretch is a share of its edge's length as the tiler measured it: east-west scaled by the cosine of the graph's origin latitude.
function cellStrokes(
  graph: RoutingGraph,
  runs: CanopyRuns,
  { grid }: EdgeIndex,
  cell: number,
  scratch: { xs: Float64Array; ys: Float64Array },
): PathStrokes {
  const pieces: Piece[] = [];
  const cursor: Cursor = { offset: 0 };
  let along = new Float64Array(64);
  const eastScale = Math.cos((graph.originLat * Math.PI) / 180);
  for (let at = grid.starts[cell]; at < grid.starts[cell + 1]; at++) {
    const record = grid.boxes[at];
    const stretches = edgeStretches(edgeRuns(runs, record));
    if (stretches.length === 0) {
      continue;
    }
    const edge = runs.edges[record];
    const vertices = edgeVertices(graph, edge, scratch, cursor);
    if (vertices > along.length) {
      along = new Float64Array(vertices);
    }
    const { xs, ys } = scratch;
    for (let vertex = 0; vertex < vertices; vertex++) {
      // Before the vertices are projected, in the tiler's own measure (crates/tiler/src/sampling.rs).
      along[vertex] =
        vertex === 0
          ? 0
          : along[vertex - 1] +
            Math.hypot(
              (xs[vertex] - xs[vertex - 1]) * eastScale,
              ys[vertex] - ys[vertex - 1],
            );
    }
    for (let vertex = 0; vertex < vertices; vertex++) {
      xs[vertex] = projectX(graph.originLng + xs[vertex] * graph.scale, 0);
      ys[vertex] = projectY(graph.originLat + ys[vertex] * graph.scale, 0);
    }
    const total = along[vertices - 1];
    for (const { t0, t1 } of stretches) {
      const pieceXs: number[] = [];
      const pieceYs: number[] = [];
      // The point `distance` along, between the vertices either side of it.
      const cut = (distance: number): void => {
        let vertex = 1;
        while (vertex < vertices - 1 && along[vertex] < distance) {
          vertex += 1;
        }
        const span = along[vertex] - along[vertex - 1];
        const share = span > 0 ? (distance - along[vertex - 1]) / span : 0;
        pieceXs.push(xs[vertex - 1] + share * (xs[vertex] - xs[vertex - 1]));
        pieceYs.push(ys[vertex - 1] + share * (ys[vertex] - ys[vertex - 1]));
      };
      cut(t0 * total);
      for (let vertex = 1; vertex < vertices - 1; vertex++) {
        if (along[vertex] > t0 * total && along[vertex] < t1 * total) {
          pieceXs.push(xs[vertex]);
          pieceYs.push(ys[vertex]);
        }
      }
      cut(t1 * total);
      pieces.push({
        xs: pieceXs,
        ys: pieceYs,
        head: t0 === 0 ? graph.edgeNodeA[edge] : -1,
        tail: t1 === 1 ? graph.edgeNodeB[edge] : -1,
        headOnNode: t0 === 0,
        tailOnNode: t1 === 1,
      });
    }
  }
  return pieces.length === 0
    ? NO_STROKES
    : packStrokes(pieces, chainPaths(pieces));
}

interface TileCoords {
  x: number;
  y: number;
  z: number;
}

export interface CanopyStrokes {
  // Cuts one cell the tile reaches and has not got; false once it has them all.
  prepare(coords: TileCoords, width: number): boolean;
  // The stroke sets of every cell the tile's window reaches, `width` px of line included.
  strokes(coords: TileCoords, width: number): PathStrokes[];
}

const defaultPause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve);
  });

// Nothing on a graph the runs were not sampled along, as the shed layer blanks on a stale artifact.
export async function canopyStrokes(
  graph: RoutingGraph,
  runs: CanopyRuns,
  pause: () => Promise<void> = defaultPause,
  cellLimit = CELL_CACHE_LIMIT,
): Promise<CanopyStrokes> {
  const index = sameGraph(graph, runs)
    ? await indexEdges(graph, runs, pause)
    : NO_INDEX;
  const { grid } = index;
  const scratch = newScratch();
  // Insertion order is recency: a cell read again is moved to the back.
  const cells = new Map<number, PathStrokes>();

  // The tile's window in quantized units, grown by the line's half width, as a range of cells.
  const reach = (
    coords: TileCoords,
    width: number,
    visit: (cell: number) => boolean,
  ): void => {
    const margin = pixelsToDegrees(width / 2, coords.z);
    const northWest = unproject(
      coords.x * TILE_SIZE,
      coords.y * TILE_SIZE,
      coords.z,
    );
    const southEast = unproject(
      (coords.x + 1) * TILE_SIZE,
      (coords.y + 1) * TILE_SIZE,
      coords.z,
    );
    const quantized = (degrees: number, origin: number): number =>
      (degrees - origin) / graph.scale;
    const { cellSize, originX, originY, columns, rows, starts } = grid;
    const column = (lng: number): number =>
      Math.floor((quantized(lng, graph.originLng) - originX) / cellSize);
    const row = (lat: number): number =>
      Math.floor((quantized(lat, graph.originLat) - originY) / cellSize);
    const fromX = Math.max(0, column(northWest.lng - margin));
    const toX = Math.min(columns - 1, column(southEast.lng + margin));
    const fromY = Math.max(0, row(southEast.lat - margin));
    const toY = Math.min(rows - 1, row(northWest.lat + margin));
    for (let cellY = fromY; cellY <= toY; cellY++) {
      for (let cellX = fromX; cellX <= toX; cellX++) {
        const cell = cellY * columns + cellX;
        if (starts[cell + 1] > starts[cell] && !visit(cell)) {
          return;
        }
      }
    }
  };

  const cut = (cell: number): PathStrokes => {
    const strokes = cellStrokes(graph, runs, index, cell, scratch);
    if (cells.size >= cellLimit) {
      cells.delete(cells.keys().next().value as number);
    }
    cells.set(cell, strokes);
    return strokes;
  };

  return {
    prepare(coords, width) {
      let missing = 0;
      reach(coords, width, (cell) => {
        if (!cells.has(cell)) {
          missing += 1;
          if (missing === 1) {
            cut(cell);
          }
        }
        return missing < 2;
      });
      return missing > 1;
    },
    strokes(coords, width) {
      const found: PathStrokes[] = [];
      reach(coords, width, (cell) => {
        const held = cells.get(cell);
        if (held) {
          cells.delete(cell);
          cells.set(cell, held);
        }
        found.push(held ?? cut(cell));
        return true;
      });
      return found;
    },
  };
}

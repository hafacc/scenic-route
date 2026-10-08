import { type BoxGrid, buildGrid, forEachBoxIn } from "./box-grid";
import type { Chain, Ended } from "./chain";
import { gridCellSize } from "./shed-decks";

// Cover drawn on the paths themselves: one polyline per chain, at a pixel width set by the zoom.

const TILE_SIZE = 256;

// A piece's polyline in zoom-0 world pixels, and whether each end stands on a node.
export interface Piece extends Ended {
  xs: ArrayLike<number>;
  ys: ArrayLike<number>;
  headOnNode: boolean;
  tailOnNode: boolean;
}

// An end on a node is round, so lines meeting there close up; an end mid-block is cut square.
export const HEAD_ROUND = 0x1;
export const TAIL_ROUND = 0x2;
export const CLOSED = 0x4;

export interface PathStrokes {
  // Zoom-0 world pixels the points are measured from: a float32 offset holds a city to 0.01 px at z20.
  originX: number;
  originY: number;
  points: Float32Array; // x/y interleaved
  starts: Uint32Array; // one entry per stroke plus the end
  caps: Uint8Array; // per stroke, HEAD_ROUND | TAIL_ROUND | CLOSED
  boxes: Float32Array; // per stroke, minX, minY, maxX, maxY of its line, width excluded
  grid: BoxGrid;
}

export const NO_STROKES: PathStrokes = packStrokes([], []);

// Pieces chained through their nodes meet on the node's own coordinate, so a corner is one vertex.
export function packStrokes(
  pieces: readonly Piece[],
  chains: readonly Chain[],
): PathStrokes {
  let vertices = 0;
  for (const piece of pieces) {
    vertices += piece.xs.length;
  }
  const originX = pieces.length > 0 ? pieces[0].xs[0] : 0;
  const originY = pieces.length > 0 ? pieces[0].ys[0] : 0;
  const points = new Float32Array(vertices * 2);
  const starts = new Uint32Array(chains.length + 1);
  const caps = new Uint8Array(chains.length);
  const boxes = new Float32Array(chains.length * 4);
  let at = 0;
  for (let stroke = 0; stroke < chains.length; stroke++) {
    const { steps, closed } = chains[stroke];
    const from = at;
    for (const { path, reversed } of steps) {
      const { xs, ys } = pieces[path];
      // The first vertex of a later piece is the node the one before it ended on.
      for (let step = at === from ? 0 : 1; step < xs.length; step++) {
        const vertex = reversed ? xs.length - 1 - step : step;
        points[at * 2] = xs[vertex] - originX;
        points[at * 2 + 1] = ys[vertex] - originY;
        at += 1;
      }
    }
    // The stroke closes a ring itself.
    if (closed && at - from > 1) {
      at -= 1;
    }
    const head = steps[0];
    const tail = steps[steps.length - 1];
    const headOnNode = head.reversed
      ? pieces[head.path].tailOnNode
      : pieces[head.path].headOnNode;
    const tailOnNode = tail.reversed
      ? pieces[tail.path].headOnNode
      : pieces[tail.path].tailOnNode;
    caps[stroke] = closed
      ? CLOSED
      : (headOnNode ? HEAD_ROUND : 0) | (tailOnNode ? TAIL_ROUND : 0);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let vertex = from; vertex < at; vertex++) {
      minX = Math.min(minX, points[vertex * 2]);
      maxX = Math.max(maxX, points[vertex * 2]);
      minY = Math.min(minY, points[vertex * 2 + 1]);
      maxY = Math.max(maxY, points[vertex * 2 + 1]);
    }
    boxes.set([minX, minY, maxX, maxY], stroke * 4);
    starts[stroke + 1] = at;
  }
  return {
    originX,
    originY,
    points: points.subarray(0, at * 2),
    starts,
    caps,
    boxes,
    grid: buildGrid(boxes, gridCellSize()),
  };
}

export interface StrokeSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  arc(x: number, y: number, radius: number, from: number, to: number): void;
}

// Traces a tile's strokes into `lines` and their round ends into `ends`; returns how many it drew.
export function traceStrokes(
  lines: StrokeSink,
  ends: StrokeSink,
  strokes: PathStrokes,
  coords: { x: number; y: number; z: number },
  width: number,
): number {
  const { originX, originY, points, starts, caps, boxes, grid } = strokes;
  const scale = 2 ** coords.z;
  // Widened by the half width a line and its round end reach past their own box.
  const margin = width / 2 / scale;
  const left = (coords.x * TILE_SIZE) / scale - originX - margin;
  const top = (coords.y * TILE_SIZE) / scale - originY - margin;
  const span = TILE_SIZE / scale + 2 * margin;
  const shiftX = originX * scale - coords.x * TILE_SIZE;
  const shiftY = originY * scale - coords.y * TILE_SIZE;
  const round = (vertex: number): void => {
    const x = points[vertex * 2] * scale + shiftX;
    const y = points[vertex * 2 + 1] * scale + shiftY;
    ends.moveTo(x + width / 2, y);
    ends.arc(x, y, width / 2, 0, 2 * Math.PI);
  };
  let drawn = 0;
  forEachBoxIn(boxes, grid, left, top, left + span, top + span, (stroke) => {
    drawn += 1;
    const from = starts[stroke];
    const to = starts[stroke + 1];
    for (let vertex = from; vertex < to; vertex++) {
      const x = points[vertex * 2] * scale + shiftX;
      const y = points[vertex * 2 + 1] * scale + shiftY;
      if (vertex === from) {
        lines.moveTo(x, y);
      } else {
        lines.lineTo(x, y);
      }
    }
    if (caps[stroke] & CLOSED) {
      lines.closePath();
    }
    if (caps[stroke] & HEAD_ROUND) {
      round(from);
    }
    if (caps[stroke] & TAIL_ROUND) {
      round(to - 1);
    }
  });
  return drawn;
}

// A tile's strokes in its own pixels, flat so they can be handed to the tile worker without a copy.
export interface TileStrokes {
  lines: Float32Array; // per line: its vertex count, negative for a ring, then x/y pairs
  ends: Float32Array; // x/y of each end to round off
}

export function collectStrokes(
  sets: readonly PathStrokes[],
  coords: { x: number; y: number; z: number },
  width: number,
): TileStrokes {
  const lines: number[] = [];
  const ends: number[] = [];
  let count = 0; // where the line being traced keeps its vertex count
  const lineSink: StrokeSink = {
    moveTo(x, y) {
      count = lines.length;
      lines.push(1, x, y);
    },
    lineTo(x, y) {
      lines[count] += 1;
      lines.push(x, y);
    },
    closePath() {
      lines[count] = -lines[count];
    },
    arc() {},
  };
  const endSink: StrokeSink = {
    moveTo() {},
    lineTo() {},
    closePath() {},
    arc(x, y) {
      ends.push(x, y);
    },
  };
  for (const strokes of sets) {
    traceStrokes(lineSink, endSink, strokes, coords, width);
  }
  return { lines: Float32Array.from(lines), ends: Float32Array.from(ends) };
}

// What `collectStrokes` flattened, back into a path of lines and a path of round ends.
export function replayStrokes(
  { lines, ends }: TileStrokes,
  linePath: StrokeSink,
  endPath: StrokeSink,
  width: number,
): void {
  let at = 0;
  while (at < lines.length) {
    const vertices = Math.abs(lines[at]);
    const closed = lines[at] < 0;
    at += 1;
    for (let vertex = 0; vertex < vertices; vertex++) {
      if (vertex === 0) {
        linePath.moveTo(lines[at], lines[at + 1]);
      } else {
        linePath.lineTo(lines[at], lines[at + 1]);
      }
      at += 2;
    }
    if (closed) {
      linePath.closePath();
    }
  }
  for (let end = 0; end < ends.length; end += 2) {
    endPath.moveTo(ends[end] + width / 2, ends[end + 1]);
    endPath.arc(ends[end], ends[end + 1], width / 2, 0, 2 * Math.PI);
  }
}

// The street-score lines' curve (src/tiles/street-score.ts): 2.6 px at z15, 4.6 px at z17.
const WIDTH_ANCHOR_ZOOM = 13;
const BASE_WIDTH = 1.5;
const WIDTH_PER_ZOOM = 1.32;

// From here in a stroke follows the curve; the tree cover's strokes start here (./tree-cover.ts).
export const STROKE_MIN_ZOOM = 14;

// Further out a stroke keeps the ground it covers at that zoom, halving a level as the pyramid does.
export function strokeWidth(zoom: number): number {
  const curve = (level: number): number =>
    BASE_WIDTH * WIDTH_PER_ZOOM ** (level - WIDTH_ANCHOR_ZOOM);
  return zoom >= STROKE_MIN_ZOOM
    ? curve(zoom)
    : curve(STROKE_MIN_ZOOM) / 2 ** (STROKE_MIN_ZOOM - zoom);
}

import { activeCity } from "../cities";
import {
  edgeGeometryRight,
  type RoutingGraph,
  subEdgePath,
} from "../routing/graph";
import {
  deckDepth,
  measuredDepth,
  type Shed,
  type ShedHistory,
  shedsOn,
} from "../routing/sheds";
import { projectX, projectY } from "./mercator";
import type { PolygonSink } from "./sweep";

// Decks are polygons, not stroked lines, because a stroke has one width and depth varies per segment.

const EARTH_CIRCUMFERENCE_METERS = 40_075_016.686;
const TILE_SIZE = 256;

// The curb gap scripts/shed-map.ts measured the depth to.
const CURB_MARGIN_METERS = 0.3;

function sidewalkInset(): number {
  return activeCity().sidewalkInsetMeters;
}

// Each ring is building edge out, curb edge back, wound positively; vertex i mirrors from + to - 1 - i.
export interface ShedDecks {
  points: Float64Array; // x/y interleaved, zoom-0 world pixels
  rings: Uint32Array; // one entry per deck plus the end
  boxes: Float64Array; // per deck, its ring's own box: minX, minY, maxX, maxY
  grid: DeckGrid;
}

// Built per day rather than at build time, since which sheds stand depends on the picked date.
export interface DeckGrid {
  cellSize: number; // zoom-0 world pixels per cell
  originX: number; // world position of column 0, so cell coordinates are never negative
  originY: number;
  columns: number;
  rows: number;
  starts: Uint32Array; // columns * rows + 1 offsets into `decks`
  decks: Uint32Array; // deck ids grouped by cell; a deck sits in every cell its box touches
}

// Web Mercator's ground resolution at the city's latitude.
export function pixelsPerMeter(zoom: number): number {
  const cosLat = Math.cos((activeCity().center.lat * Math.PI) / 180);
  return (TILE_SIZE * 2 ** zoom) / (EARTH_CIRCUMFERENCE_METERS * cosLat);
}

const TARGET_CELL_METERS = 500;

const EMPTY_GRID: DeckGrid = {
  cellSize: 1,
  originX: 0,
  originY: 0,
  columns: 0,
  rows: 0,
  starts: Uint32Array.of(0),
  decks: new Uint32Array(0),
};

export const NO_DECKS: ShedDecks = {
  points: new Float64Array(0),
  rings: Uint32Array.of(0),
  boxes: new Float64Array(0),
  grid: EMPTY_GRID,
};

function buildGrid(boxes: Float64Array): DeckGrid {
  const count = boxes.length / 4;
  if (count === 0) {
    return EMPTY_GRID;
  }
  const cellSize = TARGET_CELL_METERS * pixelsPerMeter(0);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let deck = 0; deck < count; deck++) {
    minX = Math.min(minX, boxes[deck * 4]);
    minY = Math.min(minY, boxes[deck * 4 + 1]);
    maxX = Math.max(maxX, boxes[deck * 4 + 2]);
    maxY = Math.max(maxY, boxes[deck * 4 + 3]);
  }
  const originX = Math.floor(minX / cellSize) * cellSize;
  const originY = Math.floor(minY / cellSize) * cellSize;
  const columns = Math.floor((maxX - originX) / cellSize) + 1;
  const rows = Math.floor((maxY - originY) / cellSize) + 1;

  const starts = new Uint32Array(columns * rows + 1);
  for (let deck = 0; deck < count; deck++) {
    const fromX = Math.floor((boxes[deck * 4] - originX) / cellSize);
    const fromY = Math.floor((boxes[deck * 4 + 1] - originY) / cellSize);
    const toX = Math.floor((boxes[deck * 4 + 2] - originX) / cellSize);
    const toY = Math.floor((boxes[deck * 4 + 3] - originY) / cellSize);
    for (let cellY = fromY; cellY <= toY; cellY++) {
      for (let cellX = fromX; cellX <= toX; cellX++) {
        starts[cellY * columns + cellX + 1] += 1;
      }
    }
  }
  for (let cell = 0; cell < columns * rows; cell++) {
    starts[cell + 1] += starts[cell];
  }

  const decks = new Uint32Array(starts[columns * rows]);
  const cursors = starts.slice(0, columns * rows);
  for (let deck = 0; deck < count; deck++) {
    const fromX = Math.floor((boxes[deck * 4] - originX) / cellSize);
    const fromY = Math.floor((boxes[deck * 4 + 1] - originY) / cellSize);
    const toX = Math.floor((boxes[deck * 4 + 2] - originX) / cellSize);
    const toY = Math.floor((boxes[deck * 4 + 3] - originY) / cellSize);
    for (let cellY = fromY; cellY <= toY; cellY++) {
      for (let cellX = fromX; cellX <= toX; cellX++) {
        const cell = cellY * columns + cellX;
        decks[cursors[cell]] = deck;
        cursors[cell] += 1;
      }
    }
  }
  return { cellSize, originX, originY, columns, rows, starts, decks };
}

export function packDecks(
  points: Float64Array,
  rings: Uint32Array,
  boxes: Float64Array,
): ShedDecks {
  return { points, rings, boxes, grid: buildGrid(boxes) };
}

// Boxes bound the ring, width included.
export function packRuns(runs: readonly DeckRun[]): ShedDecks {
  const points: number[] = [];
  const rings: number[] = [0];
  const boxes: number[] = [];
  for (const run of runs) {
    const ring = deckRing(run);
    if (ring.length === 0) {
      continue;
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let vertex = 0; vertex * 2 < ring.length; vertex++) {
      const x = ring[vertex * 2];
      const y = ring[vertex * 2 + 1];
      points.push(x, y);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    rings.push(points.length / 2);
    boxes.push(minX, minY, maxX, maxY);
  }
  return packDecks(
    new Float64Array(points),
    new Uint32Array(rings),
    new Float64Array(boxes),
  );
}

// Each deck whose box touches the window, exactly once.
export function forEachDeckIn(
  { boxes, grid }: ShedDecks,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  visit: (deck: number) => void,
): void {
  const { cellSize, originX, originY, columns, rows, starts, decks } = grid;
  const fromX = Math.max(0, Math.floor((minX - originX) / cellSize));
  const fromY = Math.max(0, Math.floor((minY - originY) / cellSize));
  const toX = Math.min(columns - 1, Math.floor((maxX - originX) / cellSize));
  const toY = Math.min(rows - 1, Math.floor((maxY - originY) / cellSize));
  for (let cellY = fromY; cellY <= toY; cellY++) {
    for (let cellX = fromX; cellX <= toX; cellX++) {
      const cell = cellY * columns + cellX;
      for (let at = starts[cell]; at < starts[cell + 1]; at++) {
        const deck = decks[at];
        // A deck sits in every cell it spans, so visit it only from the first one this window reaches.
        const firstX = Math.max(
          fromX,
          Math.floor((boxes[deck * 4] - originX) / cellSize),
        );
        const firstY = Math.max(
          fromY,
          Math.floor((boxes[deck * 4 + 1] - originY) / cellSize),
        );
        if (cellX !== firstX || cellY !== firstY) {
          continue;
        }
        if (
          boxes[deck * 4 + 2] >= minX &&
          boxes[deck * 4] <= maxX &&
          boxes[deck * 4 + 3] >= minY &&
          boxes[deck * 4 + 1] <= maxY
        ) {
          visit(deck);
        }
      }
    }
  }
}

// Zoom-0 world pixels; edge offsets are per segment, signed along its geometry-left normal.
export interface DeckRun {
  xs: Float64Array;
  ys: Float64Array;
  building: Float64Array; // per segment, world pixels from the polyline to the building edge
  curb: Float64Array; // per segment, ditto to the curb edge
  closed: boolean;
}

// Head and tail are the nodes a span ending at t = 0 or 1 meets the next span at; -1 mid-edge.
interface SpanPath {
  xs: Float64Array;
  ys: Float64Array;
  depth: number; // meters across the pavement, floored at what can be built
  wall: number; // meters from the baked line to the building edge, as measured
  right: boolean; // the sidewalk was baked to its street's geometry-right, so the building is too
  head: number; // the node the polyline starts at
  tail: number; // the node it ends at
}

interface Step {
  span: number;
  reversed: boolean;
}

// Meters from the baked sidewalk line to the building; depth was measured from wall to near the curb.
function buildingEdgeMeters(depth: number): number {
  return measuredDepth(depth) + CURB_MARGIN_METERS - sidewalkInset();
}

function spanPaths(graph: RoutingGraph, shed: Shed): SpanPath[] {
  const paths: SpanPath[] = [];
  for (const { edge, t0, t1, depth } of shed.spans) {
    if (edge < 0 || t1 <= t0) {
      continue;
    }
    const length = graph.edgeLength[edge];
    const { lngs, lats } = subEdgePath(graph, edge, t0 * length, t1 * length);
    const xs = new Float64Array(lngs.length);
    const ys = new Float64Array(lats.length);
    for (let vertex = 0; vertex < lngs.length; vertex++) {
      xs[vertex] = projectX(lngs[vertex], 0);
      ys[vertex] = projectY(lats[vertex], 0);
    }
    paths.push({
      xs,
      ys,
      depth: deckDepth(depth),
      wall: buildingEdgeMeters(depth),
      // The building is on the side the sidewalk was baked to (geometry-left unless flagged right).
      right: edgeGeometryRight(graph, edge),
      head: t0 === 0 ? graph.edgeNodeA[edge] : -1,
      tail: t1 === 1 ? graph.edgeNodeB[edge] : -1,
    });
  }
  return paths;
}

// Null unless exactly two spans end at `node`; three is a fork with no single path through it.
function neighbor(
  ends: Map<number, number[]>,
  span: number,
  node: number,
): number | null {
  const meeting = ends.get(node);
  if (meeting?.length !== 2) {
    return null;
  } else {
    const other = meeting[0] === span ? meeting[1] : meeting[0];
    // A span whose two ends are the same node fills its own pair.
    return other === span ? null : other;
  }
}

interface Chain {
  steps: Step[];
  closed: boolean;
}

// The artifact stores spans longest first, not in walk order, so chains are walked out both ways.
function chainSpans(paths: readonly SpanPath[]): Chain[] {
  const ends = new Map<number, number[]>();
  for (let span = 0; span < paths.length; span++) {
    for (const node of [paths[span].head, paths[span].tail]) {
      if (node >= 0) {
        const meeting = ends.get(node);
        if (meeting) {
          meeting.push(span);
        } else {
          ends.set(node, [span]);
        }
      }
    }
  }

  const taken = new Uint8Array(paths.length);
  // Reaching a taken span can only mean the chain came back round on itself.
  const follow = (span: number, node: number): Chain => {
    const steps: Step[] = [];
    let current = span;
    let exit = node;
    for (;;) {
      const next = neighbor(ends, current, exit);
      if (next === null) {
        return { steps, closed: false };
      } else if (taken[next] === 1) {
        return { steps, closed: true };
      }
      taken[next] = 1;
      const forward = paths[next].head === exit;
      steps.push({ span: next, reversed: !forward });
      exit = forward ? paths[next].tail : paths[next].head;
      current = next;
    }
  };

  const chains: Chain[] = [];
  for (let span = 0; span < paths.length; span++) {
    if (taken[span] === 1) {
      continue;
    }
    taken[span] = 1;
    const before = follow(span, paths[span].head);
    const after = follow(span, paths[span].tail);
    chains.push({
      steps: [
        ...before.steps.reverse().map(({ span: step, reversed }) => ({
          span: step,
          reversed: !reversed,
        })),
        { span, reversed: false },
        ...after.steps,
      ],
      closed: before.closed || after.closed,
    });
  }
  return chains;
}

export function shedRuns(graph: RoutingGraph, shed: Shed): DeckRun[] {
  const paths = spanPaths(graph, shed);
  const scale = pixelsPerMeter(0);
  const runs: DeckRun[] = [];
  for (const { steps, closed } of chainSpans(paths)) {
    // Spans meet on the node's own coordinate, so a corner is one vertex.
    const xs: number[] = [];
    const ys: number[] = [];
    const building: number[] = [];
    const curb: number[] = [];
    for (const { span, reversed } of steps) {
      const path = paths[span];
      const side = (path.right ? -1 : 1) * (reversed ? -1 : 1);
      for (let step = 0; step < path.xs.length; step++) {
        const vertex = reversed ? path.xs.length - 1 - step : step;
        if (step > 0 || xs.length === 0) {
          xs.push(path.xs[vertex]);
          ys.push(path.ys[vertex]);
        }
        if (step > 0) {
          building.push(side * path.wall * scale);
          curb.push(side * (path.wall - path.depth) * scale);
        }
      }
    }
    // The ring repeats a closed run's first vertex itself.
    if (closed && xs.length > 1) {
      xs.pop();
      ys.pop();
    }
    runs.push({
      xs: Float64Array.from(xs),
      ys: Float64Array.from(ys),
      building: Float64Array.from(building),
      curb: Float64Array.from(curb),
      closed,
    });
  }
  return runs;
}

// Max corner reach in deck depths before it's cut square; 2 mitres every turn up to 120°.
const MITER_LIMIT = 2;

// A zero-length segment takes its neighbor's direction; null where the whole run is one point.
function runDirections({
  xs,
  ys,
  building,
}: DeckRun): { dirX: Float64Array; dirY: Float64Array } | null {
  const segments = building.length;
  const dirX = new Float64Array(segments);
  const dirY = new Float64Array(segments);
  let found = false;
  for (let segment = 0; segment < segments; segment++) {
    const next = segment + 1 === xs.length ? 0 : segment + 1;
    const runX = xs[next] - xs[segment];
    const runY = ys[next] - ys[segment];
    const length = Math.hypot(runX, runY);
    if (length > 0) {
      dirX[segment] = runX / length;
      dirY[segment] = runY / length;
      found = true;
    }
  }
  if (!found) {
    return null;
  }
  for (const step of [1, -1]) {
    for (
      let segment = step === 1 ? 1 : segments - 2;
      segment >= 0 && segment < segments;
      segment += step
    ) {
      if (dirX[segment] === 0 && dirY[segment] === 0) {
        dirX[segment] = dirX[segment - step];
        dirY[segment] = dirY[segment - step];
      }
    }
  }
  return { dirX, dirY };
}

// Where the two offset lines meet, or null past `reach` or when parallel at different offsets.
function edgeCorner(
  intoX: number,
  intoY: number,
  intoOffset: number,
  outX: number,
  outY: number,
  outOffset: number,
  reach: number,
): [number, number] | null {
  const cosine = intoX * outX + intoY * outY;
  const spread = 1 - cosine * cosine;
  if (spread < 1e-12) {
    return intoOffset === outOffset && cosine > 0
      ? [intoX * intoOffset, intoY * intoOffset]
      : null;
  }
  const alongInto = (intoOffset - cosine * outOffset) / spread;
  const alongOut = (outOffset - cosine * intoOffset) / spread;
  const x = alongInto * intoX + alongOut * outX;
  const y = alongInto * intoY + alongOut * outY;
  return Math.hypot(x, y) > reach ? null : [x, y];
}

// Inner-edge folds at sharp turns lie inside the band, so the nonzero fill doesn't punch holes.
export function deckRing(run: DeckRun): Float64Array {
  const { xs, ys, building, curb, closed } = run;
  const count = xs.length;
  if (count < 2 || building.length === 0) {
    return new Float64Array(0);
  }
  const directions = runDirections(run);
  if (!directions) {
    return new Float64Array(0);
  }
  const { dirX, dirY } = directions;
  const segments = dirX.length;

  const outer: number[] = [];
  const inner: number[] = [];
  for (let vertex = 0; vertex <= (closed ? count : count - 1); vertex++) {
    const at = vertex === count ? 0 : vertex;
    const into = closed ? (at + segments - 1) % segments : Math.max(at - 1, 0);
    const outOf = closed ? at : Math.min(at, segments - 1);
    // y runs south in world pixels, so the left normal of (dx, dy) is (dy, -dx).
    const intoX = dirY[into];
    const intoY = -dirX[into];
    const outX = dirY[outOf];
    const outY = -dirX[outOf];
    const reach =
      MITER_LIMIT *
      Math.max(
        Math.abs(building[into] - curb[into]),
        Math.abs(building[outOf] - curb[outOf]),
      );
    const buildingCorner = edgeCorner(
      intoX,
      intoY,
      building[into],
      outX,
      outY,
      building[outOf],
      reach,
    );
    const curbCorner = edgeCorner(
      intoX,
      intoY,
      curb[into],
      outX,
      outY,
      curb[outOf],
      reach,
    );
    // Both edges cut or neither, so every vertex keeps its mirror across the band.
    if (buildingCorner && curbCorner) {
      outer.push(xs[at] + buildingCorner[0], ys[at] + buildingCorner[1]);
      inner.push(xs[at] + curbCorner[0], ys[at] + curbCorner[1]);
    } else {
      outer.push(
        xs[at] + intoX * building[into],
        ys[at] + intoY * building[into],
        xs[at] + outX * building[outOf],
        ys[at] + outY * building[outOf],
      );
      inner.push(
        xs[at] + intoX * curb[into],
        ys[at] + intoY * curb[into],
        xs[at] + outX * curb[outOf],
        ys[at] + outY * curb[outOf],
      );
    }
  }

  const ring = new Float64Array(outer.length + inner.length);
  ring.set(outer);
  for (let vertex = 0; vertex * 2 < inner.length; vertex++) {
    const back = inner.length - 2 - vertex * 2;
    ring[outer.length + vertex * 2] = inner[back];
    ring[outer.length + vertex * 2 + 1] = inner[back + 1];
  }

  let area = 0;
  const vertices = ring.length / 2;
  for (let vertex = 0; vertex < vertices; vertex++) {
    const next = (vertex + 1) % vertices;
    area +=
      ring[vertex * 2] * ring[next * 2 + 1] -
      ring[next * 2] * ring[vertex * 2 + 1];
  }
  if (area < 0) {
    // Reversing the flat array also flips each x/y pair, hence the swap.
    ring.reverse();
    for (let vertex = 0; vertex < vertices; vertex++) {
      const swap = ring[vertex * 2];
      ring[vertex * 2] = ring[vertex * 2 + 1];
      ring[vertex * 2 + 1] = swap;
    }
  }
  return ring;
}

// Bands under `minWidth` px are opened about their middle to stay legible; 0 draws them as is.
export function traceDeck(
  sink: PolygonSink,
  { points, rings }: ShedDecks,
  deck: number,
  scale: number,
  originX: number,
  originY: number,
  minWidth: number,
): void {
  const from = rings[deck];
  const to = rings[deck + 1];
  for (let vertex = from; vertex < to; vertex++) {
    let x = points[vertex * 2] * scale - originX;
    let y = points[vertex * 2 + 1] * scale - originY;
    if (minWidth > 0) {
      const mirror = from + to - 1 - vertex;
      const acrossX = (points[vertex * 2] - points[mirror * 2]) * scale;
      const acrossY = (points[vertex * 2 + 1] - points[mirror * 2 + 1]) * scale;
      const spread = acrossX * acrossX + acrossY * acrossY;
      const across =
        spread < minWidth * minWidth ? Math.sqrt(spread) : minWidth;
      if (across > 0 && across < minWidth) {
        const open = (minWidth - across) / 2 / across;
        x += acrossX * open;
        y += acrossY * open;
      }
    }
    if (vertex === from) {
      sink.moveTo(x, y);
    } else {
      sink.lineTo(x, y);
    }
  }
  sink.closePath();
}

export function shedDecks(
  graph: RoutingGraph,
  history: ShedHistory,
  day: number,
): ShedDecks {
  const runs: DeckRun[] = [];
  for (const shed of shedsOn(graph, history, day)) {
    runs.push(...shedRuns(graph, shed));
  }
  return packRuns(runs);
}

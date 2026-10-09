// A uniform grid over boxes, so a tile visits the few that reach it rather than scanning them all.

type Boxes = ArrayLike<number>; // per box: minX, minY, maxX, maxY

export interface BoxGrid {
  cellSize: number; // the boxes' own units per cell
  originX: number; // position of column 0, so cell coordinates are never negative
  originY: number;
  columns: number;
  rows: number;
  starts: Uint32Array; // columns * rows + 1 offsets into `boxes`
  boxes: Uint32Array; // box ids grouped by cell; a box sits in every cell it touches
}

export const EMPTY_GRID: BoxGrid = {
  cellSize: 1,
  originX: 0,
  originY: 0,
  columns: 0,
  rows: 0,
  starts: Uint32Array.of(0),
  boxes: new Uint32Array(0),
};

// Boxes binned between yields, so a caller with a frame to keep can pause at each.
const BATCH = 16_384;

function* gridSteps(boxes: Boxes, cellSize: number): Generator<void, BoxGrid> {
  const count = boxes.length / 4;
  if (count === 0) {
    return EMPTY_GRID;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let box = 0; box < count; box++) {
    minX = Math.min(minX, boxes[box * 4]);
    minY = Math.min(minY, boxes[box * 4 + 1]);
    maxX = Math.max(maxX, boxes[box * 4 + 2]);
    maxY = Math.max(maxY, boxes[box * 4 + 3]);
  }
  const originX = Math.floor(minX / cellSize) * cellSize;
  const originY = Math.floor(minY / cellSize) * cellSize;
  const columns = Math.floor((maxX - originX) / cellSize) + 1;
  const rows = Math.floor((maxY - originY) / cellSize) + 1;

  const starts = new Uint32Array(columns * rows + 1);
  for (let box = 0; box < count; box++) {
    if (box % BATCH === 0) {
      yield;
    }
    const fromX = Math.floor((boxes[box * 4] - originX) / cellSize);
    const fromY = Math.floor((boxes[box * 4 + 1] - originY) / cellSize);
    const toX = Math.floor((boxes[box * 4 + 2] - originX) / cellSize);
    const toY = Math.floor((boxes[box * 4 + 3] - originY) / cellSize);
    for (let cellY = fromY; cellY <= toY; cellY++) {
      for (let cellX = fromX; cellX <= toX; cellX++) {
        starts[cellY * columns + cellX + 1] += 1;
      }
    }
  }
  for (let cell = 0; cell < columns * rows; cell++) {
    starts[cell + 1] += starts[cell];
  }

  const ids = new Uint32Array(starts[columns * rows]);
  const cursors = starts.slice(0, columns * rows);
  for (let box = 0; box < count; box++) {
    if (box % BATCH === 0) {
      yield;
    }
    const fromX = Math.floor((boxes[box * 4] - originX) / cellSize);
    const fromY = Math.floor((boxes[box * 4 + 1] - originY) / cellSize);
    const toX = Math.floor((boxes[box * 4 + 2] - originX) / cellSize);
    const toY = Math.floor((boxes[box * 4 + 3] - originY) / cellSize);
    for (let cellY = fromY; cellY <= toY; cellY++) {
      for (let cellX = fromX; cellX <= toX; cellX++) {
        const cell = cellY * columns + cellX;
        ids[cursors[cell]] = box;
        cursors[cell] += 1;
      }
    }
  }
  return { cellSize, originX, originY, columns, rows, starts, boxes: ids };
}

export function buildGrid(boxes: Boxes, cellSize: number): BoxGrid {
  const steps = gridSteps(boxes, cellSize);
  for (;;) {
    const step = steps.next();
    if (step.done) {
      return step.value;
    }
  }
}

// The same grid, built a batch at a time with `pause` between: a city's worth of boxes outlasts a frame.
export async function buildGridPaused(
  boxes: Boxes,
  cellSize: number,
  pause: () => Promise<void>,
): Promise<BoxGrid> {
  const steps = gridSteps(boxes, cellSize);
  for (;;) {
    const step = steps.next();
    if (step.done) {
      return step.value;
    }
    await pause();
  }
}

// Each box touching the window, exactly once.
export function forEachBoxIn(
  boxes: Boxes,
  grid: BoxGrid,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  visit: (box: number) => void,
): void {
  const { cellSize, originX, originY, columns, rows, starts } = grid;
  const fromX = Math.max(0, Math.floor((minX - originX) / cellSize));
  const fromY = Math.max(0, Math.floor((minY - originY) / cellSize));
  const toX = Math.min(columns - 1, Math.floor((maxX - originX) / cellSize));
  const toY = Math.min(rows - 1, Math.floor((maxY - originY) / cellSize));
  for (let cellY = fromY; cellY <= toY; cellY++) {
    for (let cellX = fromX; cellX <= toX; cellX++) {
      const cell = cellY * columns + cellX;
      for (let at = starts[cell]; at < starts[cell + 1]; at++) {
        const box = grid.boxes[at];
        // A box sits in every cell it spans, so visit it only from the first one this window reaches.
        const firstX = Math.max(
          fromX,
          Math.floor((boxes[box * 4] - originX) / cellSize),
        );
        const firstY = Math.max(
          fromY,
          Math.floor((boxes[box * 4 + 1] - originY) / cellSize),
        );
        if (cellX !== firstX || cellY !== firstY) {
          continue;
        }
        if (
          boxes[box * 4 + 2] >= minX &&
          boxes[box * 4] <= maxX &&
          boxes[box * 4 + 3] >= minY &&
          boxes[box * 4 + 1] <= maxY
        ) {
          visit(box);
        }
      }
    }
  }
}

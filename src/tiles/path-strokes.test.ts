import { expect, test } from "bun:test";
import { chainPaths } from "./chain";
import {
  collectStrokes,
  HEAD_ROUND,
  type PathStrokes,
  type Piece,
  packStrokes,
  replayStrokes,
  type StrokeSink,
  strokeWidth,
  TAIL_ROUND,
  traceStrokes,
} from "./path-strokes";

// Strokes are kept as float32 offsets from a city origin and traced into a tile's own pixels.

const piece = (
  points: [number, number][],
  head = -1,
  tail = -1,
  ends: { headOnNode?: boolean; tailOnNode?: boolean } = {},
): Piece => ({
  xs: points.map(([x]) => x),
  ys: points.map(([, y]) => y),
  head,
  tail,
  headOnNode: ends.headOnNode ?? head >= 0,
  tailOnNode: ends.tailOnNode ?? tail >= 0,
});

interface Traced {
  lines: string[];
  rounds: [number, number, number][];
  drawn: number;
}

function trace(
  strokes: PathStrokes,
  coords: { x: number; y: number; z: number },
  width: number,
): Traced {
  const lines: string[] = [];
  const rounds: [number, number, number][] = [];
  const at = (value: number): string => value.toFixed(1);
  const sink: StrokeSink = {
    moveTo: (x, y) => lines.push(`M${at(x)},${at(y)}`),
    lineTo: (x, y) => lines.push(`L${at(x)},${at(y)}`),
    closePath: () => lines.push("Z"),
    arc: () => {},
  };
  const ends: StrokeSink = {
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    arc: (x, y, radius) => rounds.push([x, y, radius]),
  };
  const drawn = traceStrokes(sink, ends, strokes, coords, width);
  return { lines, rounds, drawn };
}

// Zoom 10 puts tile (400, 400) at world pixel 100, where a world pixel is 1024 tile pixels.
const TILE = { x: 400, y: 400, z: 10 };

test("two pieces sharing a node trace as one line with the node as a single vertex", () => {
  const pieces = [
    piece(
      [
        [100.05, 100.1],
        [100.1, 100.1],
      ],
      -1,
      7,
    ),
    piece(
      [
        [100.1, 100.2],
        [100.1, 100.1],
      ],
      -1,
      7,
    ),
  ];
  const traced = trace(packStrokes(pieces, chainPaths(pieces)), TILE, 4);
  expect(traced.lines).toEqual(["M51.2,102.4", "L102.4,102.4", "L102.4,204.8"]);
  // Both far ends are mid-block, so neither is rounded off.
  expect(traced.rounds).toEqual([]);
  expect(traced.drawn).toBe(1);
});

test("an end standing on a node is rounded off at half the line's width", () => {
  const pieces = [
    piece(
      [
        [100.05, 100.1],
        [100.1, 100.1],
      ],
      -1,
      -1,
      { tailOnNode: true },
    ),
  ];
  const { rounds } = trace(packStrokes(pieces, chainPaths(pieces)), TILE, 4);
  expect(rounds.length).toBe(1);
  expect(rounds[0][0]).toBeCloseTo(102.4, 1);
  expect(rounds[0][1]).toBeCloseTo(102.4, 1);
  expect(rounds[0][2]).toBe(2);
});

test("a chain that comes back round on itself closes instead of repeating its first vertex", () => {
  const corners: [number, number][] = [
    [100.05, 100.05],
    [100.1, 100.05],
    [100.1, 100.1],
  ];
  const pieces = corners.map((corner, at) =>
    piece([corner, corners[(at + 1) % 3]], at, (at + 1) % 3),
  );
  const { lines, rounds } = trace(
    packStrokes(pieces, chainPaths(pieces)),
    TILE,
    4,
  );
  expect(lines.length).toBe(4);
  expect(lines[3]).toBe("Z");
  expect(rounds).toEqual([]);
});

test("a chain's ends take their caps from the far ends of its end pieces, whichever way those were laid", () => {
  // The middle piece is listed first; both outer pieces run toward it, so the first is walked backward.
  const pieces = [
    piece(
      [
        [100.1, 100.1],
        [100.2, 100.1],
      ],
      1,
      2,
    ),
    // From node 1 out to a node nothing else meets: round there.
    piece(
      [
        [100.1, 100.1],
        [100.05, 100.1],
      ],
      1,
      -1,
      { tailOnNode: true },
    ),
    // From mid-block in to node 2: cut square at its start.
    piece(
      [
        [100.3, 100.1],
        [100.2, 100.1],
      ],
      -1,
      2,
    ),
  ];
  const chains = chainPaths(pieces);
  expect(chains).toEqual([
    {
      steps: [
        { path: 1, reversed: true },
        { path: 0, reversed: false },
        { path: 2, reversed: true },
      ],
      closed: false,
    },
  ]);
  const strokes = packStrokes(pieces, chains);
  expect(strokes.caps[0] & HEAD_ROUND).toBe(HEAD_ROUND);
  expect(strokes.caps[0] & TAIL_ROUND).toBe(0);
  const traced = trace(strokes, TILE, 4);
  expect(traced.lines).toEqual([
    "M51.2,102.4",
    "L102.4,102.4",
    "L204.8,102.4",
    "L307.2,102.4",
  ]);
  expect(traced.rounds.length).toBe(1);
  expect(traced.rounds[0][0]).toBeCloseTo(51.2, 1);
});

test("a tile draws the strokes that reach it, its line's half width included, and no others", () => {
  const pieces = [
    piece([
      [100.05, 100.1],
      [100.1, 100.1],
    ]),
    // Three tiles east.
    piece([
      [100.8, 100.1],
      [100.9, 100.1],
    ]),
    // Just over the tile's western edge: 1 px out, inside a 4 px line's reach and outside a 1 px one's.
    piece([
      [100 - 1 / 1024, 100.1],
      [100 - 1 / 1024, 100.2],
    ]),
  ];
  const strokes = packStrokes(
    pieces,
    pieces.map((_, path) => ({
      steps: [{ path, reversed: false }],
      closed: false,
    })),
  );
  expect(trace(strokes, TILE, 4).drawn).toBe(2);
  expect(trace(strokes, TILE, 1).drawn).toBe(1);
  expect(trace(strokes, { x: 403, y: 400, z: 10 }, 4).drawn).toBe(1);
  expect(trace(strokes, { x: 500, y: 500, z: 10 }, 4).drawn).toBe(0);
});

test("a tile's strokes survive being flattened for the worker and replayed there", () => {
  const corners: [number, number][] = [
    [100.05, 100.05],
    [100.1, 100.05],
    [100.1, 100.1],
  ];
  const pieces = [
    ...corners.map((corner, at) =>
      piece([corner, corners[(at + 1) % 3]], at, (at + 1) % 3),
    ),
    piece(
      [
        [100.2, 100.1],
        [100.3, 100.1],
      ],
      -1,
      -1,
      { tailOnNode: true },
    ),
  ];
  const strokes = packStrokes(pieces, chainPaths(pieces));
  const direct = trace(strokes, TILE, 4);
  const flat = collectStrokes([strokes], TILE, 4);
  const lines: string[] = [];
  const rounds: [number, number, number][] = [];
  const at = (value: number): string => value.toFixed(1);
  replayStrokes(
    flat,
    {
      moveTo: (x, y) => lines.push(`M${at(x)},${at(y)}`),
      lineTo: (x, y) => lines.push(`L${at(x)},${at(y)}`),
      closePath: () => lines.push("Z"),
      arc: () => {},
    },
    {
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      arc: (x, y, radius) => rounds.push([x, y, radius]),
    },
    4,
  );
  expect(lines).toEqual(direct.lines);
  expect(lines.filter((command) => command === "Z").length).toBe(1);
  expect(rounds.length).toBe(1);
  expect(rounds[0][0]).toBeCloseTo(direct.rounds[0][0], 3);
  expect(rounds[0][2]).toBe(2);
});

test("a float32 offset from the first vertex holds a city to a hundredth of a pixel at z20", () => {
  // 0.2 world pixels is twice New York's width.
  const far = 100.2 + 1 / 3 / 2 ** 20;
  const pieces = [
    piece([
      [100, 100],
      [far, 100],
    ]),
  ];
  const strokes = packStrokes(pieces, chainPaths(pieces));
  const stored = strokes.originX + strokes.points[2];
  expect(Math.abs(stored - far) * 2 ** 20).toBeLessThan(0.01);
});

test("the line is as wide as the street-score lines are from z14 in, and one width on the ground further out", () => {
  expect(strokeWidth(15)).toBeCloseTo(2.61, 2);
  expect(strokeWidth(17)).toBeCloseTo(4.55, 2);
  expect(strokeWidth(14)).toBeCloseTo(1.98, 2);
  // Below the strokes' own zoom the width is the ground's, so it halves with each level out.
  expect(strokeWidth(13)).toBeCloseTo(0.99, 2);
  expect(strokeWidth(12)).toBe(strokeWidth(13) / 2);
  expect(strokeWidth(11)).toBe(strokeWidth(14) / 8);
});

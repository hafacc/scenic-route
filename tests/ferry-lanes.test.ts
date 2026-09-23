// Reads an LFS file that ordinary CI has only as a pointer, so it runs on the deploy path only.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decodeLines } from "../src/tiles/lines";
import { METERS_PER_DEGREE_LAT, metersPerLng } from "../src/tiles/polylines";

test("no two of New York's ferry routes swap lanes over the water they share", () => {
  const CELL_M = 60; // LANE_CELL_M, the grid ./lines counts a crossing's company over
  const file = readFileSync(`${import.meta.dirname}/../data/ferries/nyc.bin`);
  const data = decodeLines(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    "ferr",
  );
  // Must match the layer's grid exactly, or lanes get compared across a cell boundary.
  const midLat =
    data.polylines.reduce((sum, { lats }) => sum + lats[0], 0) /
    data.polylines.length;
  const cellLat = CELL_M / METERS_PER_DEGREE_LAT;
  const cellLng = CELL_M / metersPerLng(midLat);

  // Routes are told apart by color, which is unique per route in this file.
  const cells = new Map<string, Map<string, number[]>>();
  data.polylines.forEach(({ lngs, lats }, index) => {
    const ribbon = data.ribbons?.[index];
    const route = ribbon?.color;
    for (let vertex = 0; vertex < lngs.length && route && ribbon; vertex++) {
      const key = `${Math.floor(lngs[vertex] / cellLng)},${Math.floor(lats[vertex] / cellLat)}`;
      const cell = cells.get(key) ?? new Map<string, number[]>();
      cells.set(
        key,
        cell.set(route, [...(cell.get(route) ?? []), ribbon.lanes[vertex]]),
      );
    }
  });

  const sides = new Map<string, Set<number>>();
  let shared = 0;
  for (const cell of cells.values()) {
    const routes = [...cell].sort(([left], [right]) =>
      left.localeCompare(right),
    );
    for (const [first, [route, lanes]] of routes.entries()) {
      for (const [other, others] of routes.slice(first + 1)) {
        shared++;
        const gap = Math.min(...others) - Math.max(...lanes);
        const pair = `${route} ${other}`;
        sides.set(pair, (sides.get(pair) ?? new Set()).add(Math.sign(gap)));
        // A whole lane apart, less rounding: a lane is a windowed mean, so 1 can come back just under.
        expect(Math.abs(gap)).toBeGreaterThan(1 - 1e-9);
      }
    }
  }
  expect(shared).toBeGreaterThan(50); // 71 in the committed file; guards against a vacuous pass
  for (const [pair, taken] of sides) {
    expect([pair, taken.size]).toEqual([pair, 1]);
  }
});

import { expect, test } from "bun:test";
import { DEFAULT_CITY } from "../cities";
import { lensExtrasForCity } from "../lenses/lenses";
import { offeredOverlays } from "../overlays/registry";
import { familiarByte, familiarField } from "../routing/familiar";
import { edgeDurableKey } from "../routing/graph";
import { projectX, projectY } from "../tiles/mercator";
import { heatPoints, heatVersion } from "./heat";
import { HEAT_TILE_SIZE, heatAlpha } from "./heat-raster";
import { walkBand, walkStrokes } from "./strokes";
import { BOWED, NODES, walkGraph } from "./walks.fixture";

const NOW = Date.UTC(2026, 9, 14);

function walked(weight: number) {
  const graph = walkGraph();
  const records = new Map(
    BOWED.map((edge) => [edgeDurableKey(graph, edge), { weight, at: NOW }]),
  );
  const field = familiarField(graph, records, NOW);
  if (!field) {
    throw new Error("no field");
  }
  return { graph, field };
}

// The tile holding a node at `z`, and the pixel the node falls on inside it.
function tileOf(node: number, z: number) {
  const px = projectX(NODES[node].lng, z);
  const py = projectY(NODES[node].lat, z);
  const x = Math.floor(px / HEAT_TILE_SIZE);
  const y = Math.floor(py / HEAT_TILE_SIZE);
  return {
    x,
    y,
    column: Math.floor(px - x * HEAT_TILE_SIZE),
    row: Math.floor(py - y * HEAT_TILE_SIZE),
  };
}

test("points run only along walked edges, weighted by familiarity and length", () => {
  const { graph, field } = walked(1);
  const points = heatPoints(graph, field);
  expect(points.length % 3).toBe(0);
  let weight = 0;
  for (let at = 2; at < points.length; at += 3) {
    weight += points[at];
  }
  const length = BOWED.reduce((sum, edge) => {
    const a = graph.edgeNodeA[edge];
    const b = graph.edgeNodeB[edge];
    return (
      sum +
      Math.hypot(
        projectX(NODES[b].lng, 0) - projectX(NODES[a].lng, 0),
        projectY(NODES[b].lat, 0) - projectY(NODES[a].lat, 0),
      )
    );
  }, 0);
  expect(weight).toBeCloseTo((familiarByte(1) / 255) * length, 12);
});

test("a walked street is hot where it runs and cold away from it, at every pyramid zoom", () => {
  const { graph, field } = walked(1);
  const points = heatPoints(graph, field);
  const strengths: number[] = [];
  for (const z of [11, 13]) {
    // Node 2 is the bowed way's midpoint, which the walk passed through.
    const { x, y, column, row } = tileOf(2, z);
    const alpha = heatAlpha(points, z, x, y);
    strengths.push(alpha[row * HEAT_TILE_SIZE + column]);
    // The far corner of the tile is nowhere near the street.
    const far = (column + 128) % HEAT_TILE_SIZE;
    const away = (row + 128) % HEAT_TILE_SIZE;
    expect(alpha[away * HEAT_TILE_SIZE + far]).toBe(0);
  }
  for (const strength of strengths) {
    expect(strength).toBeGreaterThan(60);
  }
  // A line integral, so one street reads about as strong at either zoom.
  expect(Math.abs(strengths[0] - strengths[1])).toBeLessThan(60);
});

test("more walks read hotter, and no walks draw nothing", () => {
  const once = walked(1);
  const often = walked(6);
  const { x, y, column, row } = tileOf(2, 13);
  const at = row * HEAT_TILE_SIZE + column;
  const faint = heatAlpha(heatPoints(once.graph, once.field), 13, x, y)[at];
  const strong = heatAlpha(heatPoints(often.graph, often.field), 13, x, y)[at];
  expect(strong).toBeGreaterThan(faint);
  expect(heatAlpha(new Float64Array(0), 13, x, y).every((v) => v === 0)).toBe(
    true,
  );
});

test("the version follows the points, so unchanged history keeps its tiles", () => {
  const { graph, field } = walked(1);
  const again = walked(1);
  const more = walked(3);
  expect(heatVersion(heatPoints(graph, field))).toBe(
    heatVersion(heatPoints(again.graph, again.field)),
  );
  expect(heatVersion(heatPoints(graph, field))).not.toBe(
    heatVersion(heatPoints(more.graph, more.field)),
  );
  expect(heatVersion(heatPoints(graph, field))).toMatch(/^[0-9a-f]{8}$/);
});

test("strokes land walked edges in the band their familiarity reads", () => {
  expect(walkBand(familiarByte(1) / 255)).toBe(0);
  expect(walkBand(familiarByte(2) / 255)).toBe(1);
  expect(walkBand(familiarByte(5) / 255)).toBe(2);
  const { graph, field } = walked(1);
  const bands = walkStrokes(graph, field);
  // The bowed way's two edges join through its midpoint into one stroke.
  expect(bands[0].starts.length - 1).toBe(1);
  expect(bands[1].starts.length - 1).toBe(0);
  expect(bands[2].starts.length - 1).toBe(0);
});

test("the walks layer is offered only where the shell has found walks", () => {
  expect(offeredOverlays(DEFAULT_CITY, false)).not.toContain("walks");
  expect(offeredOverlays(DEFAULT_CITY, true)).toContain("walks");
  expect(lensExtrasForCity(DEFAULT_CITY, true)).toContain("walks");
  expect(lensExtrasForCity(DEFAULT_CITY, false)).not.toContain("walks");
});

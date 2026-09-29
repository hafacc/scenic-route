import { expect, test } from "bun:test";
import { placeLabels } from "./labels";
import { projectX, projectY, unproject } from "./mercator";

const TILE_SIZE = 256;
const ZOOM = 17;
const RADIUS = 4;
const GAP_PX = 3;
const CHAR_PX = 6;

function measuringContext(): OffscreenCanvasRenderingContext2D {
  return {
    font: "",
    measureText: (text: string) => ({ width: text.length * CHAR_PX }),
  } as unknown as OffscreenCanvasRenderingContext2D;
}

// A label whose text ends `short` px before a tile's east edge, placed right of its marker.
function placedNear(short: number) {
  const text = "Label";
  const edge = 1000 * TILE_SIZE;
  const markerX = edge - short - text.length * CHAR_PX - GAP_PX - RADIUS;
  const markerY = 1000 * TILE_SIZE + TILE_SIZE / 2;
  const { lng, lat } = unproject(markerX, markerY, ZOOM);
  const placed = placeLabels(
    measuringContext(),
    { lngs: [lng], lats: [lat], names: [text] },
    ZOOM,
    RADIUS,
    false,
  );
  const x1 = projectX(lng, ZOOM) + RADIUS + GAP_PX + text.length * CHAR_PX;
  expect(Math.floor(projectY(lat, ZOOM) / TILE_SIZE)).toBe(1000);
  return { placed, x1, edge };
}

test("a label whose halo crosses a tile edge is filed in both tiles", () => {
  const { placed, x1, edge } = placedNear(1);
  expect(x1).toBeLessThan(edge);
  expect(placed.get("999,1000")?.length).toBe(1);
  expect(placed.get("1000,1000")?.length).toBe(1);
});

test("a label clear of the edge by more than its halo stays in its own tile", () => {
  const { placed } = placedNear(10);
  expect(placed.get("999,1000")?.length).toBe(1);
  expect(placed.has("1000,1000")).toBe(false);
});

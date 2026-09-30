import { expect, test } from "bun:test";
import { FLAVORS } from "../basemap/flavor";
import {
  ART_COLOR,
  LANDMARK_TEXT_COLOR,
  LEGACY_TEXT_COLOR,
  STATION_LABEL_COLOR,
} from "../overlays/colors";
import { drawLabels, labelHalo, placeLabels } from "./labels";
import { projectX, projectY, unproject } from "./mercator";
import { setWorkerTheme } from "./theme";

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

function drawnStroke(): string {
  const context = {
    ...measuringContext(),
    strokeText: () => {},
    fillText: () => {},
  } as unknown as OffscreenCanvasRenderingContext2D;
  const { placed } = placedNear(10);
  drawLabels(context, placed, { x: 999, y: 1000, z: ZOOM }, "#000000", false);
  return context.strokeStyle as string;
}

// Red, green and blue of `#rrggbb` or `rgba(r, g, b, a)`.
function channels(color: string): number[] {
  if (color.startsWith("#")) {
    return [1, 3, 5].map((at) => Number.parseInt(color.slice(at, at + 2), 16));
  }
  return color
    .slice(color.indexOf("(") + 1)
    .split(",")
    .slice(0, 3)
    .map(Number);
}

// WCAG 2 contrast ratio.
function contrast(first: string, second: string): number {
  const luminance = (color: string) => {
    const [red, green, blue] = channels(color).map((channel) => {
      const value = channel / 255;
      return value <= 0.03928
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [light, dark] = [luminance(first), luminance(second)].sort(
    (a, b) => b - a,
  );
  return (light + 0.05) / (dark + 0.05);
}

test("the halo is the active theme's basemap background", () => {
  try {
    for (const theme of ["light", "dark"] as const) {
      setWorkerTheme(theme);
      const stroke = drawnStroke();
      expect(stroke).toBe(labelHalo(theme));
      expect(channels(stroke)).toEqual(
        channels(FLAVORS[theme].background as string),
      );
    }
  } finally {
    setWorkerTheme("light");
  }
});

// Every fill a label draws in; art has no text shade, so its dot colour labels it.
const LABEL_FILLS = {
  landmark: LANDMARK_TEXT_COLOR,
  legacy: LEGACY_TEXT_COLOR,
  art: ART_COLOR,
  station: STATION_LABEL_COLOR,
};

test("every label fill reaches 4.5:1 on its theme's halo", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const [layer, fill] of Object.entries(LABEL_FILLS)) {
      const ratio = contrast(fill[theme], labelHalo(theme));
      expect({ layer, theme, pass: ratio >= 4.5 }).toEqual({
        layer,
        theme,
        pass: true,
      });
    }
  }
});

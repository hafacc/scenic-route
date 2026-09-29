import { expect, test } from "bun:test";
import { encodePolygons } from "../../scripts/geometry";
import type { Polygon } from "../../scripts/overpass";
import { decodeHistoric, historicRenderer } from "./historic";
import { projectX, projectY } from "./mercator";
import type { HistoricParams } from "./protocol";

// Runs the real encoder (scripts/geometry.ts) into the real decoder, so a one-sided change fails.

const TILE_SIZE = 256;
const QUANTIZATION_DEG = 2e-6; // a coordinate survives the 1e-6 quantization to within a step

function square(west: number, south: number, size: number): Polygon {
  return [
    [
      { lng: west, lat: south },
      { lng: west + size, lat: south },
      { lng: west + size, lat: south + size },
      { lng: west, lat: south + size },
    ],
  ];
}

// Two districts straddling a bucket boundary, and a third north of both buckets.
const DISTRICTS: readonly Polygon[] = [
  square(-73.9825, 40.671, 0.002),
  square(-73.9795, 40.6715, 0.001),
  // Two rings: the second is a hole punched in the first by the even-odd fill.
  [...square(-74.005, 40.732, 0.005), ...square(-74.004, 40.733, 0.001)],
];

function encoded(districts: readonly Polygon[] = DISTRICTS): ArrayBuffer {
  const bytes = encodePolygons("HDST", 1, districts);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

test("every district comes back with its rings", () => {
  const { districts } = decodeHistoric(encoded());
  expect(districts.length).toBe(DISTRICTS.length);
  for (let index = 0; index < DISTRICTS.length; index++) {
    const source = DISTRICTS[index];
    const rings = districts[index];
    expect(rings.length).toBe(source.length);
    for (let ring = 0; ring < source.length; ring++) {
      const { lngs, lats } = rings[ring];
      expect(lngs.length).toBe(source[ring].length);
      for (let vertex = 0; vertex < lngs.length; vertex++) {
        const point = source[ring][vertex];
        expect(lngs[vertex]).toBeCloseTo(point.lng, 5);
        expect(lats[vertex]).toBeCloseTo(point.lat, 5);
        expect(Math.abs(lats[vertex] - point.lat)).toBeLessThan(
          QUANTIZATION_DEG,
        );
      }
    }
  }
});

interface Fill {
  color: string;
  alpha: number;
  rect: number[] | null; // the min-size square, for a district too small to fill as a path
}

// The soft-edge scratch drawn onto the tile: its wash opacity and blur.
interface Composite {
  alpha: number;
  filter: string;
}

interface Recording {
  fills: Fill[];
  composites: Composite[];
}

function recordingContext(
  recording: Recording,
): OffscreenCanvasRenderingContext2D {
  const noop = () => {};
  const context = {
    globalAlpha: 1,
    fillStyle: "",
    filter: "none",
    save: noop,
    restore: () => {
      context.globalAlpha = 1;
      context.filter = "none";
    },
    setTransform: noop,
    clearRect: noop,
    scale: noop,
    translate: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    closePath: noop,
    fill: () => {
      recording.fills.push({
        color: String(context.fillStyle),
        alpha: context.globalAlpha,
        rect: null,
      });
    },
    fillRect: (...rect: number[]) => {
      recording.fills.push({
        color: String(context.fillStyle),
        alpha: context.globalAlpha,
        rect,
      });
    },
    drawImage: () => {
      recording.composites.push({
        alpha: context.globalAlpha,
        filter: context.filter,
      });
    },
  };
  return context as unknown as OffscreenCanvasRenderingContext2D;
}

// Bun has no OffscreenCanvas; the soft-edge scratch it caches hands out the current test's recorder.
let scratchContext: OffscreenCanvasRenderingContext2D | null = null;

(globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas =
  class {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
    getContext() {
      return scratchContext;
    }
  };

function drawTile(
  districts: ReturnType<typeof decodeHistoric>,
  coords: { x: number; y: number; z: number },
  ratio = 1,
): Recording {
  const recording: Recording = { fills: [], composites: [] };
  scratchContext = recordingContext(recording);
  historicRenderer.draw(
    recordingContext(recording),
    districts,
    coords,
    PARAMS,
    ratio,
  );
  return recording;
}

function tileOf(lng: number, lat: number, zoom: number) {
  return {
    x: Math.floor(projectX(lng, zoom) / TILE_SIZE),
    y: Math.floor(projectY(lat, zoom) / TILE_SIZE),
    z: zoom,
  };
}

const PARAMS: HistoricParams = { kind: "historic", url: "historic.bin" };

test("a tile fills only the districts that reach it, then washes them in blurred", () => {
  const { fills, composites } = drawTile(
    decodeHistoric(encoded()),
    tileOf(-73.979, 40.671, 16),
  );
  // The parent district and its extension, not the one twelve buckets north.
  expect(fills.length).toBe(2);
  for (const { color, alpha, rect } of fills) {
    expect(color).toBe(fills[0].color);
    expect(alpha).toBe(1); // opaque, so overlapping districts don't darken
    expect(rect).toBeNull();
  }
  expect(composites.length).toBe(1);
  expect(composites[0].alpha).toBeLessThan(1);
  expect(composites[0].filter).toMatch(/^blur\([\d.]+px\)$/);
});

test("a tile with no district skips the blur", () => {
  const { fills, composites } = drawTile(
    decodeHistoric(encoded()),
    tileOf(-73.9, 40.9, 16),
  );
  expect(fills.length).toBe(0);
  expect(composites.length).toBe(0);
});

test("a district smaller than its blur is drawn as a square rather than fading out", () => {
  const { fills } = drawTile(
    decodeHistoric(encoded()),
    tileOf(-73.979, 40.671, 11),
  );
  // At z11 the ~220 m parent district still fills as a path; the ~110 m extension is under 3.5 px.
  expect(fills.filter(({ rect }) => rect !== null).length).toBe(1);
  expect(fills.length).toBe(2);
});

// About 20 m on a side, where z18's 12 m of feathering would outgrow it without the pixel cap.
const SMALL_DISTRICT = square(-73.97, 40.68, 0.0002);

test("a small district still fills as its path at high zoom", () => {
  const { fills } = drawTile(
    decodeHistoric(encoded([SMALL_DISTRICT])),
    tileOf(-73.9699, 40.6801, 18),
  );
  expect(fills.length).toBe(1);
  expect(fills[0].rect).toBeNull();
});

test("the capped blur scales to device pixels", () => {
  const { composites } = drawTile(
    decodeHistoric(encoded([SMALL_DISTRICT])),
    tileOf(-73.9699, 40.6801, 18),
    2,
  );
  expect(composites.length).toBe(1);
  expect(composites[0].filter).toBe("blur(10px)");
});

test("a district the query finds but the scratch doesn't reach skips the blur composite", () => {
  const districts = decodeHistoric(encoded());
  expect(
    drawTile(districts, tileOf(-73.981, 40.672, 18)).composites.length,
  ).toBe(1);
  // Same bucket as the parent district but ~170 m north of it, so nothing is painted.
  const { fills, composites } = drawTile(
    districts,
    tileOf(-73.9848, 40.6748, 18),
  );
  expect(fills.length).toBe(0);
  expect(composites.length).toBe(0);
});

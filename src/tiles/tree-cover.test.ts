import { expect, test } from "bun:test";
import {
  type CoverForm,
  coverRamp,
  RASTER_MAX_ZOOM,
  RASTER_MIN_ZOOM,
  STROKE_MIN_ZOOM,
  shownForm,
  treeCoverForm,
} from "./tree-cover";

// One layer in two forms, with no moment at which both show and none at which neither does.

test("the pyramid stops one level short of where the strokes start", () => {
  expect(STROKE_MIN_ZOOM).toBe(14);
  expect(RASTER_MAX_ZOOM).toBe(13);
  expect(RASTER_MIN_ZOOM).toBeLessThan(RASTER_MAX_ZOOM);
});

test("every zoom shows exactly one form, switching where Leaflet rounds up to the strokes' level", () => {
  expect(treeCoverForm(9)).toBe("raster");
  expect(treeCoverForm(12)).toBe("raster");
  expect(treeCoverForm(13)).toBe("raster");
  expect(treeCoverForm(13.49)).toBe("raster");
  expect(treeCoverForm(13.5)).toBe("strokes");
  expect(treeCoverForm(14)).toBe("strokes");
  expect(treeCoverForm(20)).toBe("strokes");
});

test("the pyramid is drawn in the layer's one color, its alpha the tile's and nothing else", () => {
  const ramp = coverRamp("#56705c");
  expect(ramp.stops).toEqual([{ red: 0x56, green: 0x70, blue: 0x5c }]);
  expect([ramp.value, ramp.alpha]).toEqual(["alpha", "alpha"]);
  expect([ramp.alphaFull, ramp.alphaCurve, ramp.maxAlpha]).toEqual([1, 1, 1]);
});

// A zoom in from 13 to 14 and back out, as the layer hears it: zoom events, and the strokes' tiles landing.
test("the pyramid holds until the strokes have painted, then gives way, and takes over at once on the way out", () => {
  let shown: CoverForm = "raster";
  const at = (zoom: number, painted: boolean): CoverForm => {
    shown = shownForm(shown, zoom, painted);
    return shown;
  };
  // Mid-pinch, past the rounding point, with the strokes' tiles still being cut.
  expect(at(13.2, false)).toBe("raster");
  expect(at(13.6, false)).toBe("raster");
  expect(at(14, false)).toBe("raster");
  // They land: the swap is a single step, with no state in which neither shows.
  expect(at(14, true)).toBe("strokes");
  // A pan at z14 loads new tiles; the strokes already up stay up.
  expect(at(14, false)).toBe("strokes");
  expect(at(16, false)).toBe("strokes");
  // Back out: the pyramid at once, whatever the strokes are doing.
  expect(at(13.4, true)).toBe("raster");
  expect(at(13, true)).toBe("raster");
  // And in again while the strokes' tiles from before are gone.
  expect(at(14, false)).toBe("raster");
});

test("strokes painted early, while the zoom still rounds to the pyramid's level, do not show early", () => {
  expect(shownForm("raster", 13.4, true)).toBe("raster");
  expect(shownForm("raster", 13.5, true)).toBe("strokes");
});

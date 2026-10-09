import { hexToRgb, type Ramp, type ThemeName } from "../theme/palette";
import { assemble, cutFor, type Patch } from "./magnify";
import { STROKE_MIN_ZOOM } from "./path-strokes";
import type { TileCoords, TreeCoverParams } from "./protocol";
import type { TileRenderer } from "./renderer";
import { themeName } from "./theme";
import { drawRamped } from "./theme-gl";

// Tree cover too far out to stroke: the tiler's pyramid of the same stretches (crates/tiler/src/cover_tiles.rs).

// From `STROKE_MIN_ZOOM` in the stretches are stroked along their paths; below it they are this pyramid.
export const RASTER_MAX_ZOOM = STROKE_MIN_ZOOM - 1;
// The tiler's coarsest level; Leaflet stretches it for anything further out.
export const RASTER_MIN_ZOOM = 9;

export { STROKE_MIN_ZOOM };

export type CoverForm = "raster" | "strokes";

// Which of the two a map zoom calls for; Leaflet rounds a fractional zoom to pick its tile level.
export function treeCoverForm(zoom: number): CoverForm {
  return Math.round(zoom) >= STROKE_MIN_ZOOM ? "strokes" : "raster";
}

// Which to show: the pyramid stays up, magnified, until the strokes have painted, and a pan never brings it back.
export function shownForm(
  shown: CoverForm,
  zoom: number,
  strokesPainted: boolean,
): CoverForm {
  if (treeCoverForm(zoom) === "raster") {
    return "raster";
  }
  return shown === "strokes" || strokesPainted ? "strokes" : "raster";
}

// One flat color; the tile's alpha is how much of the pixel the strokes would have covered.
export function coverRamp(color: string): Ramp {
  return {
    stops: [hexToRgb(color)],
    value: "alpha",
    valueFull: 1,
    alpha: "alpha",
    alphaFull: 1,
    alphaCurve: 1,
    maxAlpha: 1,
    relief: null,
    reliefScale: 1,
  };
}

const ramps = new Map<string, Ramp>();

function rampFor(color: Record<ThemeName, string>): Ramp {
  const hex = color[themeName()];
  let ramp = ramps.get(hex);
  if (!ramp) {
    ramp = coverRamp(hex);
    ramps.set(hex, ramp);
  }
  return ramp;
}

async function load(
  { url, maxNativeZoom }: TreeCoverParams,
  coords: TileCoords,
): Promise<Patch | null> {
  const cut = cutFor(maxNativeZoom, coords);
  const { patch, failed } = await assemble(url, cut);
  // Thrown so the layers menu can report it; the pyramid is sparse, so a 404 is only empty ground.
  if (!patch && failed) {
    throw new Error(`${url}: source tiles could not be fetched`);
  }
  return patch ? { patch, margin: cut.margin, scale: cut.scale } : null;
}

export const treeCoverRenderer: TileRenderer<TreeCoverParams, Patch | null> = {
  load,
  draw(context, patch, _coords, params, ratio) {
    drawRamped(context, patch, rampFor(params.color), ratio);
  },
};

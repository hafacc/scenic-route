import { assemble, cutFor, type Patch } from "./magnify";
import type { CanopyParams, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import { palette } from "./theme";
import { drawRamped } from "./theme-gl";

// A canopy tile carries tree-covered fraction in alpha and no color; the palette ramp adds it.

async function load(
  { url, maxNativeZoom }: CanopyParams,
  coords: TileCoords,
): Promise<Patch | null> {
  const cut = cutFor(maxNativeZoom, coords);
  const { patch, failed } = await assemble(url, cut);
  // Thrown so the layers menu can report it; a failed neighbor only costs the resample edge context.
  if (!patch && failed) {
    throw new Error(`${url}: source tiles could not be fetched`);
  }
  return patch ? { patch, margin: cut.margin, scale: cut.scale } : null;
}

export const canopyRenderer: TileRenderer<CanopyParams, Patch | null> = {
  load,
  draw(context, patch, _coords, _params, ratio) {
    drawRamped(context, patch, palette().canopy, ratio);
  },
};

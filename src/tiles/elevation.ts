import { assemble, cutFor, type Patch } from "./magnify";
import type { ElevationParams, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import { palette } from "./theme";
import { drawRamped } from "./theme-gl";

// Tiles carry no color: height across the city's range in R, relief shade in G, land fraction in A.
// Magnified here, not by an <img>, since stretched images seam the fractional shore at tile edges.

async function load(
  { url, maxNativeZoom }: ElevationParams,
  coords: TileCoords,
): Promise<Patch | null> {
  const cut = cutFor(maxNativeZoom, coords);
  const { patch, failed } = await assemble(url, cut);
  // Thrown so the layers menu can report it; a tile with no ground is never written, so 404 is empty.
  if (!patch && failed) {
    throw new Error(`${url}: source tiles could not be fetched`);
  }
  return patch ? { patch, margin: cut.margin, scale: cut.scale } : null;
}

export const elevationRenderer: TileRenderer<ElevationParams, Patch | null> = {
  load,
  draw(context, patch, _coords, _params, ratio) {
    drawRamped(context, patch, palette().elevation, ratio);
  },
};

import {
  acquire,
  assemble,
  type Cut,
  cutFor,
  type Patch,
  release,
  tileUrl,
} from "./magnify";
import type { ShadeParams, ShadePrefetchMessage, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import { drawSweep, type SweptGround, sweptGround } from "./sweep";
import { drawSweepGl } from "./sweep-gl";
import { palette } from "./theme";
import { drawRamped } from "./theme-gl";

// Building and tree pyramids are composited per pixel here, since two layers would source-over them.
// From `vectorZoom` the tile is swept from caster chunks instead; a deploy without them falls back here.

// Keep in sync with crates/tiler/src/shade.rs, which bakes alpha as this * intensity * fraction.
const MAX_SHADE_ALPHA = 190;

// Leaves the rest of the cache to the bins being drawn; a bin costs two tiles (buildings and trees).
const PREFETCH_LIMIT = 192;

function binTemplate(template: string, bin: number): string {
  return template.replace("{bin}", String(bin));
}

// Warmed entries have no users, so they stay evictable and the cache cap still bounds them.
export function warm({
  url,
  treeUrl,
  bins,
  coords,
}: ShadePrefetchMessage): void {
  const wanted = bins.flatMap((bin) => coords.map((coord) => ({ bin, coord })));
  for (const { bin, coord } of wanted.slice(0, PREFETCH_LIMIT / 2)) {
    const { x, y, z } = coord;
    for (const template of [url, treeUrl]) {
      release(acquire(tileUrl(binTemplate(template, bin), z, x, y)));
    }
  }
}

// `MAX * intensity * (1 - (1 - b)(1 - tau*t))` in baked alphas; source-over would be ~25% too dark.
export function compositeAlpha(
  buildings: number,
  trees: number,
  tau: number,
  intensity: number,
): number {
  const baked = MAX_SHADE_ALPHA * intensity;
  // A full shadow quantizes up past `baked`, so both are capped or the cross term over-subtracts.
  const both =
    baked > 0
      ? (tau * Math.min(buildings, baked) * Math.min(trees, baked)) / baked
      : 0;
  return Math.min(255, Math.round(buildings + tau * trees - both));
}

// Only alpha is read; the pyramids' color plane is dead weight.
function merge(
  buildings: OffscreenCanvas | null,
  trees: OffscreenCanvas | null,
  { size }: Cut,
  { tau, intensity }: ShadeParams,
): OffscreenCanvas | null {
  const treeContext = trees?.getContext("2d");
  if (!treeContext) {
    return buildings; // no canopy here, so the building patch is the composite
  }
  const target = buildings ?? new OffscreenCanvas(size, size);
  const context = target.getContext("2d");
  if (!context) {
    return buildings;
  }
  const merged = context.getImageData(0, 0, size, size);
  const canopy = treeContext.getImageData(0, 0, size, size);
  for (let pixel = 0; pixel < merged.data.length; pixel += 4) {
    merged.data[pixel + 3] = compositeAlpha(
      merged.data[pixel + 3],
      canopy.data[pixel + 3],
      tau,
      intensity,
    );
  }
  context.putImageData(merged, 0, 0);
  return target;
}

type ShadeSource = { swept: SweptGround } | { baked: Patch | null };

// Throws on an unreachable pyramid: a tile silently drawing no shade is the one wrong answer.
async function bakedPatch(
  params: ShadeParams,
  coords: TileCoords,
): Promise<Patch | null> {
  const cut = cutFor(params.maxNativeZoom, coords);
  const [buildings, trees] = await Promise.all([
    assemble(binTemplate(params.url, params.bin), cut),
    assemble(binTemplate(params.treeUrl, params.bin), cut),
  ]);
  // Either pyramid failing is fatal: tree shadows alone would show a sunlit street under a tower.
  if (
    (!buildings.patch && buildings.failed) ||
    (!trees.patch && trees.failed)
  ) {
    throw new Error(
      `shade bin ${params.bin}: source tiles could not be fetched`,
    );
  }
  const patch = merge(buildings.patch, trees.patch, cut, params);
  return patch ? { patch, margin: cut.margin, scale: cut.scale } : null;
}

async function load(
  params: ShadeParams,
  coords: TileCoords,
): Promise<ShadeSource> {
  if (coords.z >= params.vectorZoom) {
    const swept = await sweptGround(params, coords);
    if (swept) {
      return { swept };
    }
  }
  return { baked: await bakedPatch(params, coords) };
}

export const shadeRenderer: TileRenderer<ShadeParams, ShadeSource> = {
  load,
  draw(context, source, coords, params, ratio) {
    if ("swept" in source) {
      // The GPU sweep is ~10× cheaper; the Canvas2D sweep is its fallback and reference.
      if (!drawSweepGl(context, source.swept, coords, params, ratio)) {
        drawSweep(context, source.swept, coords, params, ratio);
      }
    } else {
      drawRamped(context, source.baked, palette().shade, ratio);
    }
  },
};

import { unproject } from "./mercator";
import type { TileCoords } from "./protocol";

// Soft-edged washes: painted opaque as one union, blurred, then composited translucent.

const TILE_SIZE = 256;
const EQUATOR_METERS_PER_PIXEL = 156_543.033_92; // web mercator, at the equator, at z0

// The pad (~3× max blur) lets geometry past the tile edge feed the blur, so neighbours seam.
export const MAX_BLUR_PX = 5;
export const BLUR_PAD = 15;

// Draws run one at a time and synchronously, so one scratch canvas serves every tile.
let scratch: OffscreenCanvas | null = null;

function sizedCanvas(
  canvas: OffscreenCanvas | null,
  width: number,
  height: number,
): OffscreenCanvas {
  const reused = canvas ?? new OffscreenCanvas(width, height);
  if (reused.width !== width || reused.height !== height) {
    reused.width = width; // resizing also clears the canvas
    reused.height = height;
  }
  return reused;
}

export function tileMetersPerPixel(coords: TileCoords): number {
  const center = unproject(
    coords.x * TILE_SIZE + TILE_SIZE / 2,
    coords.y * TILE_SIZE + TILE_SIZE / 2,
    coords.z,
  );
  return (
    (EQUATOR_METERS_PER_PIXEL * Math.cos((center.lat * Math.PI) / 180)) /
    2 ** coords.z
  );
}

// `paint` draws opaque in tile pixels, reaching up to BLUR_PAD past each edge, and says if it drew any.
export function compositeSoft(
  context: OffscreenCanvasRenderingContext2D,
  ratio: number,
  blur: number,
  opacity: number,
  paint: (scratchContext: OffscreenCanvasRenderingContext2D) => boolean,
): void {
  const padded = TILE_SIZE + 2 * BLUR_PAD;
  const size = Math.round(padded * ratio);
  scratch = sizedCanvas(scratch, size, size);
  const offscreen = scratch;
  const offContext = offscreen.getContext("2d");
  if (!offContext) {
    return;
  }
  // Reused across tiles, so undo the previous tile's state first.
  offContext.setTransform(1, 0, 0, 1, 0, 0);
  offContext.clearRect(0, 0, offscreen.width, offscreen.height);
  offContext.scale(ratio, ratio);
  offContext.translate(BLUR_PAD, BLUR_PAD);
  // Nothing painted, so skip the blur composite.
  if (!paint(offContext)) {
    return;
  }
  context.save();
  context.globalAlpha = opacity;
  // A filter's lengths ignore the transform, so scale to device pixels by hand.
  context.filter = `blur(${Math.min(MAX_BLUR_PX, blur) * ratio}px)`;
  context.drawImage(offscreen, -BLUR_PAD, -BLUR_PAD, padded, padded);
  context.restore();
}

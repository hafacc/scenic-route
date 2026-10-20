// Pure, so the service worker can draw a tile without the routing graph or the page.

export const HEAT_TILE_SIZE = 256;
// About a block's width at z13, the pyramid's deepest level.
export const HEAT_RADIUS_PX = 3;
// One street walked once lands near half strength; streets packed together saturate.
const HEAT_GAIN = 0.6;

// One alpha byte per pixel: a cone per point summed, so the heat is a line integral at every zoom.
export function heatAlpha(
  points: Float64Array,
  z: number,
  x: number,
  y: number,
): Uint8ClampedArray {
  const size = HEAT_TILE_SIZE;
  const scale = 2 ** z;
  const sums = new Float32Array(size * size);
  const radius = HEAT_RADIUS_PX;
  for (let at = 0; at + 2 < points.length; at += 3) {
    const px = points[at] * scale - x * size;
    const py = points[at + 1] * scale - y * size;
    if (
      px < -radius ||
      py < -radius ||
      px > size + radius ||
      py > size + radius
    ) {
      continue;
    }
    const weight = points[at + 2] * scale;
    const fromX = Math.max(0, Math.floor(px - radius));
    const toX = Math.min(size - 1, Math.ceil(px + radius));
    const fromY = Math.max(0, Math.floor(py - radius));
    const toY = Math.min(size - 1, Math.ceil(py + radius));
    for (let row = fromY; row <= toY; row++) {
      for (let column = fromX; column <= toX; column++) {
        const distance = Math.hypot(column + 0.5 - px, row + 0.5 - py);
        if (distance < radius) {
          sums[row * size + column] += weight * (1 - distance / radius);
        }
      }
    }
  }
  const alpha = new Uint8ClampedArray(size * size);
  for (let pixel = 0; pixel < alpha.length; pixel++) {
    alpha[pixel] = Math.round(255 * (1 - Math.exp(-HEAT_GAIN * sums[pixel])));
  }
  return alpha;
}

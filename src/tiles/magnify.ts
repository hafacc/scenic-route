import { resolveUrl } from "./base-url";
import type { TileCoords } from "./protocol";

// Stretched <img>s seam at tile edges, so a source tile is resampled with its eight neighbors around it.
// Resamples values, not colors: the palette ramp is applied afterward (./theme-gl.ts).

const TILE_SIZE = 256;

// Enough for a cubic kernel, and off-tile so a clamp at the cut's edge is never shown.
const MARGIN_PX = 4;

// Sixteen magnified tiles share a source tile; the cap also holds prefetched shade bins (~64 MB).
const CACHE_LIMIT = 256;

// Absent (sparse pyramid) and failed (network) differ, so a failed overlay doesn't look merely empty.
export type Source =
  | { bitmap: ImageBitmap }
  | { bitmap: null; failed: boolean };

// `users` counts draws still assembling, so an entry evicted mid-draw closes once they let go.
export interface CacheEntry {
  source: Promise<Source>;
  users: number;
  evicted: boolean;
}

const cache = new Map<string, CacheEntry>();

export function tileUrl(
  template: string,
  zoom: number,
  x: number,
  y: number,
): string {
  return resolveUrl(
    template
      .replace("{z}", String(zoom))
      .replace("{x}", String(x))
      .replace("{y}", String(y)),
  );
}

async function fetchBitmap(url: string): Promise<Source> {
  const response = await fetch(url);
  // The pyramids are sparse, so a 404 means "nothing here", not a failure.
  if (!response.ok) {
    return { bitmap: null, failed: false };
  } else {
    return { bitmap: await createImageBitmap(await response.blob()) };
  }
}

function dispose(entry: CacheEntry): void {
  if (entry.evicted && entry.users === 0) {
    void entry.source.then((source) => source.bitmap?.close());
  }
}

export function release(entry: CacheEntry): void {
  entry.users -= 1;
  dispose(entry);
}

function prune(): void {
  while (cache.size > CACHE_LIMIT) {
    const [oldest] = cache.keys();
    const entry = cache.get(oldest);
    cache.delete(oldest);
    if (entry) {
      entry.evicted = true;
      dispose(entry);
    }
  }
}

export function acquire(url: string): CacheEntry {
  const cached = cache.get(url);
  if (cached) {
    // Map iterates in insertion order, so re-inserting is what makes the eviction above an LRU.
    cache.delete(url);
    cache.set(url, cached);
    cached.users += 1;
    return cached;
  } else {
    const entry: CacheEntry = {
      users: 1,
      evicted: false,
      // Evicted rather than cached, so the next tile over the same ground retries.
      source: fetchBitmap(url).catch((): Source => {
        cache.delete(url);
        return { bitmap: null, failed: true };
      }),
    };
    cache.set(url, entry);
    prune();
    return entry;
  }
}

// `margin` source pixels on each side lie outside the tile; each covers `scale` tile pixels.
export interface Patch {
  patch: OffscreenCanvas;
  margin: number;
  scale: number;
}

// One cut serves any number of pyramids over the same ground.
export interface Cut {
  sourceZoom: number;
  sourceX: number;
  sourceY: number;
  originX: number;
  originY: number;
  size: number;
  ring: number;
  margin: number;
  scale: number;
}

export function cutFor(maxNativeZoom: number, { x, y, z }: TileCoords): Cut {
  const magnified = z > maxNativeZoom;
  const sourceZoom = magnified ? maxNativeZoom : z;
  const scale = 2 ** (z - sourceZoom);
  const margin = magnified ? MARGIN_PX : 0;
  const sourceX = Math.floor(x / scale);
  const sourceY = Math.floor(y / scale);
  const span = TILE_SIZE / scale;
  return {
    sourceZoom,
    sourceX,
    sourceY,
    // Where the tile lands inside its source tile, grown by the margin.
    originX: (x - sourceX * scale) * span - margin,
    originY: (y - sourceY * scale) * span - margin,
    size: span + 2 * margin,
    ring: magnified ? 1 : 0,
    margin,
    scale,
  };
}

// A null patch with `failed` false is empty ground; with `failed` true it could not be reached.
export interface Assembled {
  patch: OffscreenCanvas | null;
  failed: boolean;
}

export async function assemble(template: string, cut: Cut): Promise<Assembled> {
  const { sourceZoom, sourceX, sourceY, originX, originY, size, ring } = cut;
  const entries: CacheEntry[] = [];
  for (let row = -ring; row <= ring; row++) {
    for (let column = -ring; column <= ring; column++) {
      entries.push(
        acquire(tileUrl(template, sourceZoom, sourceX + column, sourceY + row)),
      );
    }
  }

  try {
    const sources = await Promise.all(entries.map((entry) => entry.source));
    const failed = sources.some(
      (source) => source.bitmap === null && source.failed,
    );
    const patch = new OffscreenCanvas(size, size);
    const context = patch.getContext("2d");
    if (!context || sources.every((source) => source.bitmap === null)) {
      return { patch: null, failed };
    } else {
      context.imageSmoothingEnabled = false; // integer 1:1 blits, nothing to interpolate
      for (const [index, { bitmap }] of sources.entries()) {
        if (bitmap) {
          const column = (index % (2 * ring + 1)) - ring;
          const row = Math.floor(index / (2 * ring + 1)) - ring;
          context.drawImage(
            bitmap,
            column * TILE_SIZE - originX,
            row * TILE_SIZE - originY,
          );
        }
      }
      return { patch, failed };
    }
  } finally {
    for (const entry of entries) {
      release(entry);
    }
  }
}

// The margin is drawn too, off the tile, where it only feeds the filter.
export function draw(
  context: OffscreenCanvasRenderingContext2D,
  source: Patch | null,
): void {
  if (source) {
    const { patch, margin, scale } = source;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const offset = -margin * scale;
    context.drawImage(
      patch,
      offset,
      offset,
      patch.width * scale,
      patch.height * scale,
    );
  }
}

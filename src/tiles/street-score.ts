import {
  decodeStreetChunk,
  type StreetSegment as Segment,
} from "../streets/chunk";
import {
  PALETTES,
  ROAD_OPACITY,
  rampCss,
  type ThemeName,
} from "../theme/palette";
import { resolveUrl } from "./base-url";
import { cachedLru } from "./lru";
import { projectX, projectY } from "./mercator";
import type { StreetScoreParams, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import { tileMetersPerPixel } from "./soft-edge";
import { themeName } from "./theme";

// One chunk per z12 tile (layout: scripts/README.md); relative to the page.
const CHUNK_URL = "streets/{x}/{y}.bin";
const CHUNK_ZOOM = 12;
const SIDES = 2;
// The most a chunk's one byte of decimeters can offset a sidewalk.
const MAX_OFFSET_METERS = 25.5;

const TILE_SIZE = 256;

// Lines read as street width: ~1.5 px at z13 (the layer's minZoom), 5 px at z17.
const WIDTH_ANCHOR_ZOOM = 13;
const BASE_WIDTH = 1.5;
const WIDTH_PER_ZOOM = 1.32;

// Quantized so same-level pieces share a stroke; 32 levels is finer than a 2 px line's alpha resolves.
const LEVEL_BITS = 3;
const LEVELS = 256 >> LEVEL_BITS;

// Built once per theme, since a theme flip redraws every tile.
const COLORS: Record<ThemeName, readonly string[]> = {
  light: levels("light"),
  dark: levels("dark"),
};

function levels(theme: ThemeName): readonly string[] {
  return Array.from({ length: LEVELS }, (_unused, level) =>
    rampCss(
      PALETTES[theme].canopy,
      ((level << LEVEL_BITS) + (1 << (LEVEL_BITS - 1))) / 255,
      ROAD_OPACITY[theme],
    ),
  );
}

// A z12 chunk covers a screen or more, so a few dozen hold any pan; older ones are refetched.
const CHUNK_CACHE_LIMIT = 48;
const chunks = new Map<string, Promise<Segment[]>>();
const missingChunks = new Set<string>();

// Left is CSCL's l_ side (the first density byte); canvas y runs south, so its normal is (ty, -tx).
// Tangents skip coincident neighbors, since vertices can sit closer than the 0.1 m quantum.
function leftNormals(
  xs: Float64Array,
  ys: Float64Array,
  count: number,
  normalXs: Float64Array,
  normalYs: Float64Array,
): void {
  const same = (left: number, right: number): boolean =>
    xs[left] === xs[right] && ys[left] === ys[right];
  for (let vertex = 0; vertex < count; vertex++) {
    let back = vertex;
    while (back > 0 && same(back, vertex)) {
      back -= 1;
    }
    let ahead = vertex;
    while (ahead + 1 < count && same(ahead, vertex)) {
      ahead += 1;
    }
    const tangentX = xs[ahead] - xs[back];
    const tangentY = ys[ahead] - ys[back];
    // A fully collapsed vertex gets no side rather than a NaN.
    const length = Math.hypot(tangentX, tangentY) || 1;
    normalXs[vertex] = tangentY / length;
    normalYs[vertex] = -tangentX / length;
  }
}

// Also commercial's; a 404 (all water) is remembered outside the LRU, and any other failure is retried.
export function loadStreetChunk(
  tileX: number,
  tileY: number,
): Promise<Segment[]> {
  const key = `${tileX}/${tileY}`;
  if (missingChunks.has(key)) {
    return Promise.resolve([]);
  }
  return cachedLru(chunks, key, CHUNK_CACHE_LIMIT, async () => {
    const url = resolveUrl(
      CHUNK_URL.replace("{x}", String(tileX)).replace("{y}", String(tileY)),
    );
    const response = await fetch(url);
    if (response.ok) {
      return decodeStreetChunk(await response.arrayBuffer());
    } else if (response.status === 404) {
      missingChunks.add(key);
      chunks.delete(key);
      return [];
    } else {
      throw new Error(`${url}: ${response.status} ${response.statusText}`);
    }
  });
}

// The z12 chunks under a tile grown by `margin` px; with no margin, just the ones it sits in.
export function chunksAround(
  coords: TileCoords,
  margin: number,
): { x: number; y: number }[] {
  const chunkPx = TILE_SIZE * 2 ** (coords.z - CHUNK_ZOOM);
  const first = (tile: number) =>
    Math.floor((tile * TILE_SIZE - margin) / chunkPx);
  const last = (tile: number) =>
    Math.ceil(((tile + 1) * TILE_SIZE + margin) / chunkPx) - 1;
  const found: { x: number; y: number }[] = [];
  for (let x = first(coords.x); x <= last(coords.x); x++) {
    for (let y = first(coords.y); y <= last(coords.y); y++) {
      found.push({ x, y });
    }
  }
  return found;
}

// The tile's own chunks must load; a neighbour only feeds the margin, so a failed one is left out.
export function loadAround<Loaded>(
  coords: TileCoords,
  margin: number,
  loadOne: (x: number, y: number) => Promise<Loaded>,
  missing: Loaded,
): Promise<Loaded[]> {
  const own = new Set(chunksAround(coords, 0).map(({ x, y }) => `${x}/${y}`));
  return Promise.all(
    chunksAround(coords, margin).map(({ x, y }) =>
      own.has(`${x}/${y}`)
        ? loadOne(x, y)
        : loadOne(x, y).catch((): Loaded => missing),
    ),
  );
}

function strokeWidth(zoom: number): number {
  return BASE_WIDTH * WIDTH_PER_ZOOM ** (zoom - WIDTH_ANCHOR_ZOOM);
}

// Also the genus wash's (./genus.ts), which strokes the same lines as a density mask.
export async function loadStreets(coords: TileCoords): Promise<Segment[]> {
  // Chunks are filed by bbox alone, so a neighbour's sidewalk reaches in by a width plus the widest offset.
  const width = strokeWidth(coords.z);
  const margin =
    width + Math.max(MAX_OFFSET_METERS / tileMetersPerPixel(coords), width);
  const loaded = await loadAround(coords, margin, loadStreetChunk, []);
  // Each chunk's copy of a shared segment is quantized from its own origin, so they differ by ~0.1 m at most.
  return loaded.length === 1 ? loaded[0] : loaded.flat();
}

// The stroke per density level that `strokeStreets` takes: a byte's level is `byte >> 3`.
export const STREET_LEVELS = LEVELS;

// One path per density level; runs meet butt to butt, since overlapping translucent strokes bead.
export function strokeStreets(
  context: OffscreenCanvasRenderingContext2D,
  segments: Segment[],
  coords: TileCoords,
  colors: readonly string[],
): void {
  const originX = coords.x * TILE_SIZE;
  const originY = coords.y * TILE_SIZE;
  const width = strokeWidth(coords.z);
  const metersPerPixel = tileMetersPerPixel(coords);

  context.lineCap = "butt";
  context.lineJoin = "round";
  context.lineWidth = width;

  const paths: (Path2D | undefined)[] = new Array(LEVELS);
  const longest = segments.reduce(
    (most, segment) => Math.max(most, segment.lngs.length),
    0,
  );
  const xs = new Float64Array(longest);
  const ys = new Float64Array(longest);
  const normalXs = new Float64Array(longest);
  const normalYs = new Float64Array(longest);

  for (const { lngs, lats, densities, offsetMeters, stranded } of segments) {
    // Skip paths the routing graph dropped: a green line is an offer to walk there.
    if (stranded) {
      continue;
    }
    // Sidewalks ~14 m apart are one pixel at z13, so the offset is floored at a stroke width.
    const offsetPx =
      offsetMeters > 0 ? Math.max(offsetMeters / metersPerPixel, width) : 0;
    const margin = width + offsetPx;
    let low = Number.POSITIVE_INFINITY;
    let left = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    for (let vertex = 0; vertex < lngs.length; vertex++) {
      xs[vertex] = projectX(lngs[vertex], coords.z) - originX;
      ys[vertex] = projectY(lats[vertex], coords.z) - originY;
      left = Math.min(left, xs[vertex]);
      right = Math.max(right, xs[vertex]);
      low = Math.min(low, ys[vertex]);
      high = Math.max(high, ys[vertex]);
    }
    // A segment can cross the tile between two outside vertices, so test its box.
    const overlaps =
      right >= -margin &&
      left <= TILE_SIZE + margin &&
      high >= -margin &&
      low <= TILE_SIZE + margin;
    if (!overlaps) {
      continue;
    }
    leftNormals(xs, ys, lngs.length, normalXs, normalYs);

    // A path or boardwalk has no offset, and its two densities are the same sample.
    const sides = offsetMeters > 0 ? SIDES : 1;
    for (let side = 0; side < sides; side++) {
      const away = side === 0 ? offsetPx : -offsetPx;
      let run = -1;
      for (let piece = 0; piece + 1 < lngs.length; piece++) {
        const level =
          (densities[SIDES * piece + side] +
            densities[SIDES * (piece + 1) + side]) >>
          (LEVEL_BITS + 1);
        if (level === 0) {
          run = -1;
          continue;
        }
        let path = paths[level];
        if (!path) {
          path = new Path2D();
          paths[level] = path;
        }
        if (level !== run) {
          path.moveTo(
            xs[piece] + away * normalXs[piece],
            ys[piece] + away * normalYs[piece],
          );
        }
        path.lineTo(
          xs[piece + 1] + away * normalXs[piece + 1],
          ys[piece + 1] + away * normalYs[piece + 1],
        );
        run = level;
      }
    }
  }

  for (let level = 1; level < LEVELS; level++) {
    const path = paths[level];
    if (path) {
      context.strokeStyle = colors[level];
      context.stroke(path);
    }
  }
}

export const streetScoreRenderer: TileRenderer<StreetScoreParams, Segment[]> = {
  load: (_params, coords) => loadStreets(coords),
  draw: (context, segments, coords) =>
    strokeStreets(context, segments, coords, COLORS[themeName()]),
};

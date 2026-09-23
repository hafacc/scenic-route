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
import { projectX, projectY, unproject } from "./mercator";
import type { StreetScoreParams, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import { themeName } from "./theme";

// One chunk per z12 tile (layout: scripts/README.md); relative, so it picks up the deploy's basePath.
const CHUNK_URL = "streets/{x}/{y}.bin";
const CHUNK_ZOOM = 12;
const SIDES = 2;

const TILE_SIZE = 256;
const EQUATOR_METERS_PER_PIXEL = 156_543.033_92; // web mercator, at the equator, at z0

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

const chunks = new Map<string, Promise<Segment[]>>();

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

// A 404 is an all-water tile and caches as empty; any other failure is evicted so it can be retried.
function loadChunk(tileX: number, tileY: number): Promise<Segment[]> {
  const key = `${tileX}/${tileY}`;
  const pending = chunks.get(key);
  if (pending) {
    return pending;
  } else {
    const url = resolveUrl(
      CHUNK_URL.replace("{x}", String(tileX)).replace("{y}", String(tileY)),
    );
    const request = fetch(url)
      .then(async (response) => {
        if (response.ok) {
          return decodeStreetChunk(await response.arrayBuffer());
        } else if (response.status === 404) {
          return [];
        } else {
          throw new Error(`${url}: ${response.status} ${response.statusText}`);
        }
      })
      .catch((error: unknown) => {
        chunks.delete(key);
        throw error;
      });
    chunks.set(key, request);
    return request;
  }
}

function load(
  _params: StreetScoreParams,
  coords: TileCoords,
): Promise<Segment[]> {
  const shift = coords.z - CHUNK_ZOOM;
  return loadChunk(coords.x >> shift, coords.y >> shift);
}

// One path per density level; runs meet butt to butt, since overlapping translucent strokes bead.
function draw(
  context: OffscreenCanvasRenderingContext2D,
  segments: Segment[],
  coords: TileCoords,
): void {
  const originX = coords.x * TILE_SIZE;
  const originY = coords.y * TILE_SIZE;
  const width = BASE_WIDTH * WIDTH_PER_ZOOM ** (coords.z - WIDTH_ANCHOR_ZOOM);
  const center = unproject(
    originX + TILE_SIZE / 2,
    originY + TILE_SIZE / 2,
    coords.z,
  );
  const metersPerPixel =
    (EQUATOR_METERS_PER_PIXEL * Math.cos((center.lat * Math.PI) / 180)) /
    2 ** coords.z;

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

  const colors = COLORS[themeName()];
  for (let level = 1; level < LEVELS; level++) {
    const path = paths[level];
    if (path) {
      context.strokeStyle = colors[level];
      context.stroke(path);
    }
  }
}

export const streetScoreRenderer: TileRenderer<StreetScoreParams, Segment[]> = {
  load,
  draw,
};

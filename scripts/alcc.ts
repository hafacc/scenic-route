// ALCC 1 m canopy height model, in feet; cover is it thresholded, so the county mask isn't fetched.
// Read via the lossless tile service: the zip is Deflate64, which Bun and libarchive can't read.
// License: Pacific Veg Map, which publishes it, states "All of the map data accessible via this
// site is in the public domain and is freely accessible to all" (read 2026-08-27).

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { decode, load } from "lerc";
import pRetry from "p-retry";
import { fetchEastBayLand } from "./alameda";
import { CACHE_DIR, cachedFile, writeAtomic } from "./cache";
import {
  encodeFloatTiff,
  forwardTmerc,
  type Grid,
  polygonsOfMask,
  ringToCoords,
  UTM_10N,
} from "./canopy-raster";
import { boxOf } from "./geometry";
import { fetchJson, retryLadder, USER_AGENT } from "./http";
import { buildLandTest } from "./land-filter";
import type { Polygon } from "./overpass";

const SERVICE =
  "https://tiledimageservices2.arcgis.com/Pw6oQMuXLspbq6zz/arcgis/rest/services/ALCC_UNIFIED_CHM_1M/ImageServer";
export const ALCC_ATTRIBUTION =
  "Canopy © EBRPD / CAL FIRE / Tukman Geospatial (ALCC 1 m LiDAR)";
export const ALCC_SOURCE_URL =
  "https://www.arcgis.com/home/item.html?id=7b57097b6b274419951ed51d0f6f20f4";
export const ALCC_HEIGHT_ATTRIBUTION =
  "Canopy heights © EBRPD / CAL FIRE / Tukman Geospatial (ALCC 1 m LiDAR CHM)";

// The service's tile grid, rechecked every run: a moved origin would silently shift every crown.
const LEVEL = 9;
const TILE = 256;
const CELL_METERS = 1;
const ORIGIN_X = 549_868;
const ORIGIN_Y = 4_218_438;

// The publisher's own cover threshold; it excludes shrubs and cars, and young street trees too.
const CANOPY_FLOOR_FEET = 15;
const METERS_PER_FOOT = 0.3048;

// Measured over the East Bay: cuts vertices by three quarters for 0.37% more area.
const SIMPLIFY_METERS = 0.75;
// Smaller is a lidar speck, most often a transmission line the publisher warns reads as vegetation.
const MINIMUM_SQUARE_METERS = 4;

const FETCH_WORKERS = 8;
const MAX_ATTEMPTS = 4;
const PROGRESS_TILES = 250;

const HEIGHT_DIR = join(CACHE_DIR, "alcc-chm");

interface ServiceInfo {
  tileInfo?: {
    rows?: number;
    cols?: number;
    origin?: { x?: number; y?: number };
    lods?: { level?: number; resolution?: number }[];
  };
  spatialReference?: { wkt?: string };
  pixelType?: string;
}

// Checks what a wrong assumption would silently corrupt rather than break.
async function checkService(): Promise<void> {
  const info = await fetchJson<ServiceInfo>(`${SERVICE}?f=json`, {
    attempts: MAX_ATTEMPTS,
  });
  const tiles = info.tileInfo;
  const lod = tiles?.lods?.find((entry) => entry.level === LEVEL);
  const problems: string[] = [];
  if (tiles?.rows !== TILE || tiles?.cols !== TILE) {
    problems.push(`${tiles?.cols} x ${tiles?.rows} tiles, not ${TILE}`);
  }
  if (tiles?.origin?.x !== ORIGIN_X || tiles?.origin?.y !== ORIGIN_Y) {
    problems.push(
      `tiles start at (${tiles?.origin?.x}, ${tiles?.origin?.y}), not (${ORIGIN_X}, ${ORIGIN_Y})`,
    );
  }
  if (lod?.resolution !== CELL_METERS) {
    problems.push(`level ${LEVEL} is ${lod?.resolution} m, not ${CELL_METERS}`);
  }
  if (info.pixelType !== "F32") {
    problems.push(`${info.pixelType} cells, not F32`);
  }
  if (!(info.spatialReference?.wkt ?? "").includes("UTM_Zone_10")) {
    problems.push("not published on UTM zone 10");
  }
  if (problems.length > 0) {
    throw new Error(
      `the ALCC canopy service has moved: ${problems.join("; ")}`,
    );
  }
}

// In feet; null outside the flown area. Inside it, all-zero is a real reading, not a missing tile.
async function fetchTile(
  row: number,
  column: number,
): Promise<Float32Array | null> {
  const url = `${SERVICE}/tile/${LEVEL}/${row}/${column}`;
  const path = await cachedFile(`alcc-chm-${LEVEL}`, url, async () =>
    pRetry(async () => {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
      });
      // Cached as empty, not an error, so a re-run doesn't ask again.
      if (response.status === 404) {
        return new Uint8Array(0);
      }
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    }, retryLadder(MAX_ATTEMPTS)),
  );
  const bytes = await readFile(path);
  if (bytes.byteLength === 0) {
    return null;
  }
  const image = decode(bytes);
  if (image.width !== TILE || image.height !== TILE) {
    throw new Error(
      `${url}: a ${image.width} x ${image.height} tile, not ${TILE} square`,
    );
  }
  return image.pixels[0] as Float32Array;
}

export interface AlccCanopy {
  polygons: Polygon[];
  fetched: number; // components traced, before specks were dropped
  dropped: number;
  tiles: number;
  covered: number; // tiles holding any canopy
  offLand: number;
  cutOnLand: number;
  canopyCells: number; // square meters of canopy
  droppedCells: number;
  vertices: number;
  heightTiles: string[];
}

interface CutBlock {
  pieces: Polygon[]; // empty where the block is wholly off the land
  cut: boolean;
}

// Clipped, not kept or dropped whole: a 256 m block kept whole drew the coast as a staircase.
// Deciding on the outer ring's vertices can miss an edge between two of them, costing a sliver.
function landCutter(land: Polygon[]): (polygon: Polygon) => Promise<CutBlock> {
  const onLand = buildLandTest(land);
  // polygon-clipping rings are [lng, lat] pairs.
  const toRings = (polygon: Polygon) =>
    polygon.map((ring) =>
      ring.map(({ lat, lng }): [number, number] => [lng, lat]),
    );
  const mask = land.map((polygon) => ({
    rings: toRings(polygon),
    box: boxOf([polygon]),
  }));
  return async (polygon: Polygon) => {
    const outer = polygon[0];
    let inside = 0;
    for (const vertex of outer) {
      inside += onLand(vertex) ? 1 : 0;
    }
    if (inside === outer.length) {
      return { pieces: [polygon], cut: false };
    } else if (inside === 0) {
      return { pieces: [], cut: false };
    }
    const box = boxOf([polygon]);
    const near = mask.filter(
      ({ box: land }) =>
        land.west <= box.east &&
        land.east >= box.west &&
        land.south <= box.north &&
        land.north >= box.south,
    );
    const { intersection } = await import("polygon-clipping");
    const cut = intersection(
      toRings(polygon) as Parameters<typeof intersection>[0],
      near.map(({ rings }) => rings) as Parameters<typeof intersection>[0],
    );
    return {
      pieces: cut.map((piece) =>
        piece.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))),
      ),
      cut: true,
    };
  };
}

// Traced per raster tile: hill canopy forms km-wide components every map tile would scan.
export async function fetchAlccCanopy(land: Polygon[]): Promise<AlccCanopy> {
  const started = performance.now();
  await checkService();
  await load();
  await mkdir(HEIGHT_DIR, { recursive: true });

  const box = boxOf(land);
  const cut = landCutter(land);

  // A lon/lat box isn't a grid rectangle, so take the projected corners' extremes.
  const corners = [
    forwardTmerc(UTM_10N, box.west, box.south),
    forwardTmerc(UTM_10N, box.east, box.south),
    forwardTmerc(UTM_10N, box.west, box.north),
    forwardTmerc(UTM_10N, box.east, box.north),
  ];
  const west = Math.min(...corners.map(({ x }) => x));
  const east = Math.max(...corners.map(({ x }) => x));
  const south = Math.min(...corners.map(({ y }) => y));
  const north = Math.max(...corners.map(({ y }) => y));
  const firstColumn = Math.floor((west - ORIGIN_X) / (TILE * CELL_METERS));
  const lastColumn = Math.floor((east - ORIGIN_X) / (TILE * CELL_METERS));
  const firstRow = Math.floor((ORIGIN_Y - north) / (TILE * CELL_METERS));
  const lastRow = Math.floor((ORIGIN_Y - south) / (TILE * CELL_METERS));
  const across = lastColumn - firstColumn + 1;
  const down = lastRow - firstRow + 1;
  const count = across * down;
  console.error(
    `  alcc: ${count} raster tiles (${across} x ${down}) over ${((east - west) / 1000).toFixed(1)} x ${((north - south) / 1000).toFixed(1)} km`,
  );

  const result: AlccCanopy = {
    polygons: [],
    fetched: 0,
    dropped: 0,
    tiles: count,
    covered: 0,
    offLand: 0,
    cutOnLand: 0,
    canopyCells: 0,
    droppedCells: 0,
    vertices: 0,
    heightTiles: [],
  };
  const floorMeters = CANOPY_FLOOR_FEET * METERS_PER_FOOT;
  const mask = new Uint8Array(TILE * TILE);
  const heights = new Float32Array(TILE * TILE);

  let next = 0;
  let done = 0;
  const pending = new Map<number, Promise<Float32Array | null>>();
  const queue = (): void => {
    while (pending.size < FETCH_WORKERS && next < count) {
      const index = next++;
      pending.set(
        index,
        fetchTile(
          firstRow + Math.floor(index / across),
          firstColumn + (index % across),
        ),
      );
    }
  };
  queue();
  for (let index = 0; index < count; index++) {
    const feet = await (pending.get(index) as Promise<Float32Array | null>);
    pending.delete(index);
    queue();
    done += 1;
    if (done % PROGRESS_TILES === 0 || done === count) {
      console.error(
        `  [${((performance.now() - started) / 1000).toFixed(1).padStart(6)}s] alcc: ${done}/${count} tiles, ${result.polygons.length} polygons`,
      );
    }
    if (feet === null) {
      continue;
    }
    const row = firstRow + Math.floor(index / across);
    const column = firstColumn + (index % across);
    let covered = 0;
    for (let cell = 0; cell < feet.length; cell++) {
      const meters = feet[cell] * METERS_PER_FOOT;
      heights[cell] = meters;
      const set = meters >= floorMeters ? 1 : 0;
      mask[cell] = set;
      covered += set;
    }
    if (covered === 0) {
      continue;
    }
    result.covered += 1;

    // Not thresholded, so a ring simplification nudged outside its cells still lands on a reading.
    const path = join(HEIGHT_DIR, `${row}-${column}.tif`);
    await writeAtomic(
      path,
      encodeFloatTiff(
        heights,
        TILE,
        TILE,
        ORIGIN_X + column * TILE * CELL_METERS,
        ORIGIN_Y - row * TILE * CELL_METERS,
        CELL_METERS,
      ),
    );
    result.heightTiles.push(path);

    const traced = polygonsOfMask(
      mask,
      TILE,
      TILE,
      SIMPLIFY_METERS / CELL_METERS,
      MINIMUM_SQUARE_METERS / (CELL_METERS * CELL_METERS),
    );
    const grid: Grid = {
      originX: ORIGIN_X,
      originY: ORIGIN_Y,
      width: TILE,
      height: TILE,
      cellMeters: CELL_METERS,
      projection: UTM_10N,
    };
    for (const rings of traced.polygons) {
      const polygon: Polygon = rings.map((ring) =>
        ringToCoords(ring, grid, column * TILE, row * TILE),
      );
      const { pieces, cut: onBoundary } = await cut(polygon);
      if (pieces.length === 0) {
        result.offLand += 1;
      } else if (onBoundary) {
        result.cutOnLand += 1;
      }
      for (const piece of pieces) {
        result.vertices += piece.reduce((sum, ring) => sum + ring.length, 0);
        result.polygons.push(piece);
      }
    }
    result.fetched += traced.polygons.length + traced.dropped;
    result.dropped += traced.dropped;
    result.canopyCells += traced.cells;
    result.droppedCells += traced.droppedCells;
  }
  console.error(
    `  alcc: ${result.polygons.length} polygons, ${result.vertices} vertices, ` +
      `${(result.canopyCells / 1e6).toFixed(2)} km2 of canopy over ${result.covered} of ${count} tiles ` +
      `(${result.dropped} specks under ${MINIMUM_SQUARE_METERS} m2 dropped, holding ${(result.droppedCells / 1e6).toFixed(3)} km2; ` +
      `${result.offLand} blocks off the land mask dropped, ${result.cutOnLand} cut on it)`,
  );
  return result;
}

// Memoized: two ingest steps ask for it, and tracing takes minutes the tile cache doesn't save.
let eastBay: Promise<AlccCanopy> | null = null;

export function eastBayCanopy(): Promise<AlccCanopy> {
  eastBay ??= (async () => fetchAlccCanopy(await fetchEastBayLand()))();
  return eastBay;
}

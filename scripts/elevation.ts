import { readFile } from "node:fs/promises";
import { fetchEastBayLand } from "./alameda";
import { cachedFile } from "./cache";
import { forwardTmerc, inverseTmerc } from "./canopy-raster";
import { boxOf } from "./geometry";
import { fetchBytes, fetchJson } from "./http";
import { buildLandTest } from "./land-filter";
import {
  ALAMEDA_LIDAR,
  DEM_SQUARE_METERS,
  demSquareName,
  demSquaresOf,
  fetchDemTiles,
  type LidarWindow,
  PROJECTIONS,
} from "./lidar";
import type { Polygon } from "./overpass";

const MAX_ATTEMPTS = 4;
const PROGRESS_TILES = 50;
const FETCH_WORKERS = 8;

export interface ElevationRaster {
  paths: string[];
  attribution: string;
  sourceUrl: string;
  band: number;
  // The tiler's projection name: a GeoTIFF names its CRS only by EPSG code.
  crs: string;
}

// Five-band float32 COGs (DTM, DSM, CHM, slope, aspect) on EPSG:7131, a transverse Mercator.
const WERK_COLLECTION =
  "https://nationaldataplatform.org/stac/collections/nasa-werk-dem-ca-sanfrancisco-1-b23";
const WERK_ATTRIBUTION = "Elevation © USGS 3DEP / NASA WERK (CC0)";
const DTM_BAND = 0;
// DSM minus DTM, not canopy (buildings read too), so only read within measured-canopy polygons.
export const SF_CANOPY_BAND = 2;

interface StacItem {
  id: string;
  assets?: Record<string, { href?: string }>;
}

interface StacPage {
  features?: StacItem[];
  links?: { rel?: string; href?: string }[];
}

// Also stops on an empty page, which would otherwise loop on the same `next` href forever.
async function tileHrefs(): Promise<string[]> {
  const hrefs: string[] = [];
  let url: string | null = `${WERK_COLLECTION}/items?limit=500`;
  while (url) {
    const page: StacPage = await fetchJson<StacPage>(url, {
      attempts: MAX_ATTEMPTS,
    });
    const features = page.features ?? [];
    for (const feature of features) {
      const href = feature.assets?.data?.href;
      if (href) {
        hrefs.push(href);
      }
    }
    const next = page.links?.find((link) => link.rel === "next")?.href;
    url = features.length > 0 && next ? next : null;
  }
  return hrefs;
}

// One cache entry per tile, so an interrupted run keeps what it already fetched.
async function fetchTiles(prefix: string, hrefs: string[]): Promise<string[]> {
  const paths: string[] = new Array(hrefs.length);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < hrefs.length) {
      const index = next++;
      const href = hrefs[index];
      const name = href.slice(href.lastIndexOf("/") + 1);
      paths[index] = await cachedFile(`${prefix}-${name}`, href, () =>
        fetchBytes(href, { attempts: MAX_ATTEMPTS }),
      );
      done += 1;
      if (done % PROGRESS_TILES === 0 || done === hrefs.length) {
        console.error(`  elevation: ${done}/${hrefs.length} tiles`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FETCH_WORKERS, hrefs.length) }, worker),
  );
  return paths;
}

export const SF_ELEVATION: () => Promise<ElevationRaster> = async () => {
  const hrefs = await tileHrefs();
  if (hrefs.length === 0) {
    throw new Error("the 3DEP collection listed no tiles");
  }
  console.error(`  elevation: ${hrefs.length} tiles in the 3DEP collection`);
  return {
    paths: await fetchTiles("werk", hrefs),
    attribution: WERK_ATTRIBUTION,
    sourceUrl: WERK_COLLECTION,
    band: DTM_BAND,
    crs: "sf-cs13",
  };
};

// Fetched via scripts/lidar.ts, which caches the same 1.57 GB of tiles for roof heights.
// S3 rather than the `rockyweb.usgs.gov` mirror, which is an order of magnitude slower.
const ALAMEDA_ATTRIBUTION = "Elevation © USGS 3DEP (public domain)";
const ALAMEDA_SOURCE_URL =
  "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/CA_AlamedaCounty_2021_B21/";

function demSquareOf(lng: number, lat: number): string {
  const { x, y } = forwardTmerc(PROJECTIONS[ALAMEDA_LIDAR.crs], lng, lat);
  return demSquareName(
    Math.floor(x / DEM_SQUARE_METERS),
    Math.floor(y / DEM_SQUARE_METERS),
  );
}

// A missing tile reads downstream as flat ground. Centers catch squares with no polygon vertex.
function landSquares(land: readonly Polygon[], box: LidarWindow): Set<string> {
  const squares = new Set<string>();
  for (const polygon of land) {
    for (const ring of polygon) {
      for (const { lat, lng } of ring) {
        squares.add(demSquareOf(lng, lat));
      }
    }
  }
  const onLand = buildLandTest(land);
  const projection = PROJECTIONS[ALAMEDA_LIDAR.crs];
  for (const { squareX, squareY, name } of demSquaresOf(
    box,
    ALAMEDA_LIDAR.crs,
  )) {
    const center = inverseTmerc(
      projection,
      (squareX + 0.5) * DEM_SQUARE_METERS,
      (squareY + 0.5) * DEM_SQUARE_METERS,
    );
    if (onLand(center)) {
      squares.add(name);
    }
  }
  return squares;
}

export const EAST_BAY_ELEVATION: () => Promise<ElevationRaster> = async () => {
  const land = await fetchEastBayLand();
  const box = boxOf(land);
  const { paths, missing } = await fetchDemTiles(ALAMEDA_LIDAR, box);
  const wanted = landSquares(land, box);
  const absent = missing.filter((square) => wanted.has(square));
  if (absent.length > 0) {
    throw new Error(
      `${ALAMEDA_LIDAR.demProject} stages no ground for ${absent.join(", ")}, which the East Bay has land in`,
    );
  }
  console.error(
    `  elevation: ${paths.length} tiles in ${ALAMEDA_LIDAR.demProject}, covering the ${wanted.size} squares the land falls in`,
  );
  return {
    paths,
    attribution: ALAMEDA_ATTRIBUTION,
    sourceUrl: ALAMEDA_SOURCE_URL,
    band: DTM_BAND,
    crs: ALAMEDA_LIDAR.crs,
  };
};

// Where surveys overlap, the first wins. No mosaic means flat ground and a grayed-out hill weight.
export async function fetchElevationMosaics(
  cityId: string,
): Promise<ElevationRaster[]> {
  if (cityId === "sf") {
    return [await SF_ELEVATION(), await EAST_BAY_ELEVATION()];
  } else {
    return [];
  }
}

if (import.meta.main) {
  const cityId = process.argv[2] ?? "sf";
  const mosaics = await fetchElevationMosaics(cityId);
  if (mosaics.length === 0) {
    console.error(`${cityId}: no elevation source`);
  }
  for (const mosaic of mosaics) {
    let bytes = 0;
    for (const path of mosaic.paths) {
      bytes += (await readFile(path)).byteLength;
    }
    console.error(
      `${cityId}: ${mosaic.crs}: ${mosaic.paths.length} tiles, ${(bytes / 1e9).toFixed(2)} GB cached`,
    );
  }
}

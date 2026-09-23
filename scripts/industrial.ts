// NYC lots come from MAPPLUTO on ArcGIS: Socrata's PLUTO (`64uk-42ks`) has a null `geom` column.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchEastBayIndustrial } from "./alameda";
import { fetchArcgis } from "./arcgis";
import { cached } from "./cache";
import { encodePolygons } from "./geometry";
import { type LandContext, loadLandContext } from "./land";
import type { SourceFile } from "./manifest";
import type { Polygon } from "./overpass";
import { fetchSfIndustrial } from "./sf";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const INDUSTRIAL_DIR = join(DATA_DIR, "industrial");
const INDUSTRIAL_MAGIC = "INDL";
const INDUSTRIAL_FORMAT = 1;

// `maxRecordCount` is 2000; native CRS is EPSG:2263, so every query asks for `outSR=4326`.
const SERVICE =
  "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query";
const WHERE = "LandUse = '06'";
const PAGE_SIZE = 2000;
const MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 5_000; // longer than the shared ladder's: this service rate-limits
// A floor (9,295 at the last probe) that catches a server-side page cut passing for the end.
const EXPECTED_LOTS = 9_000;

type GeoJsonGeometry =
  | { type: "Polygon"; coordinates: [number, number][][] }
  | { type: "MultiPolygon"; coordinates: [number, number][][][] };

interface LotFeature {
  geometry?: GeoJsonGeometry | null;
}

interface LotPage {
  features?: LotFeature[];
  properties?: { exceededTransferLimit?: boolean };
}

// Unordered, an ArcGIS layer may repeat or skip rows between `resultOffset` pages.
function pageUrl(offset: number): string {
  const url = new URL(SERVICE);
  url.searchParams.set("where", WHERE);
  url.searchParams.set("outFields", "OBJECTID");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("orderByFields", "OBJECTID");
  url.searchParams.set("f", "geojson");
  url.searchParams.set("resultOffset", String(offset));
  url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
  return url.toString();
}

async function fetchPage(url: string): Promise<LotPage> {
  try {
    return await fetchArcgis<LotPage>(
      url,
      {
        attempts: MAX_ATTEMPTS,
        minTimeoutMs: RETRY_BASE_MS,
        onFailedAttempt: ({ error, attemptNumber }) => {
          console.error(
            `  attempt ${attemptNumber}/${MAX_ATTEMPTS} failed: ${error}`,
          );
        },
      },
      ({ features }) => {
        if (!Array.isArray(features)) {
          throw new Error("no features in the response");
        }
      },
    );
  } catch (error) {
    throw new Error(`industrial page ${url} failed: ${error}`);
  }
}

function partsOf(geometry: GeoJsonGeometry): Polygon[] {
  const parts =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return parts
    .map((part) =>
      part
        .map((ring) => ring.map(([lng, lat]) => ({ lat, lng })))
        .filter((ring) => ring.length >= 4),
    )
    .filter((part) => part.length > 0);
}

// Any vertex, not the centroid: waterfront lots reach past the coastline the boundaries draw.
function touchesLand(part: Polygon, onLand: LandContext["onLand"]): boolean {
  return part.some((ring) => ring.some(onLand));
}

interface Lots {
  polygons: Polygon[];
  lots: number; // features, not polygon parts
  offLand: number; // features with no part on land
}

async function fetchLots(land: LandContext): Promise<Lots> {
  const polygons: Polygon[] = [];
  let fetched = 0;
  let lots = 0;
  let offLand = 0;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = pageUrl(offset);
    const page = await cached("arcgis-mappluto-industrial", url, () =>
      fetchPage(url),
    );
    const features = page.features ?? [];
    fetched += features.length;
    for (const feature of features) {
      if (!feature.geometry) {
        continue;
      }
      const parts = partsOf(feature.geometry).filter((part) =>
        touchesLand(part, land.onLand),
      );
      if (parts.length === 0) {
        offLand += 1;
        continue;
      }
      lots += 1;
      polygons.push(...parts);
    }
    console.error(
      `  industrial: ${fetched} lots fetched, ${polygons.length} parts kept`,
    );
    if (features.length < PAGE_SIZE) {
      break;
    }
  }
  if (fetched < EXPECTED_LOTS) {
    throw new Error(
      `industrial fetch returned ${fetched} lots, ${EXPECTED_LOTS} expected: the read was truncated`,
    );
  }
  return { polygons, lots, offLand };
}

// Throws: another city's lots clipped to this shoreline would write an empty artifact.
async function fetchCityLots(cityId: string, land: LandContext): Promise<Lots> {
  if (cityId === "nyc") {
    return await fetchLots(land);
  } else if (cityId === "sf") {
    const [city, eastBay] = await Promise.all([
      fetchSfIndustrial(land.onLand),
      fetchEastBayIndustrial(land),
    ]);
    console.error(
      `  industrial: ${city.dominant} PDR-dominant parcels, ${city.zoned} unbuilt in industrial zoning,` +
        ` ${eastBay.parcels - eastBay.publicParcels} East Bay parcels on an industrial use code` +
        ` and ${eastBay.publicParcels} tax-exempt`,
    );
    return {
      polygons: [...city.polygons, ...eastBay.polygons],
      lots: city.parcels + eastBay.parcels,
      offLand: city.offLand + eastBay.offLand,
    };
  } else {
    throw new Error(`no industrial land-use source for ${cityId}`);
  }
}

export async function ingestIndustrial(
  cityId: string,
  land: LandContext,
): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(INDUSTRIAL_DIR, { recursive: true });

  const { polygons, lots, offLand } = await fetchCityLots(cityId, land);
  const bytes = encodePolygons(INDUSTRIAL_MAGIC, INDUSTRIAL_FORMAT, polygons);
  const file = `${cityId}.bin`;
  await writeFile(join(INDUSTRIAL_DIR, file), bytes);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const mib = (bytes.length / 1024 / 1024).toFixed(2);
  console.error(
    `industrial: ${lots} lots kept (${offLand} off land), ` +
      `${polygons.length} polygon parts, ${mib} MiB in ${seconds}s`,
  );
  return {
    file,
    format: INDUSTRIAL_FORMAT,
    count: polygons.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  const cityId = process.argv[2] ?? "nyc";
  await ingestIndustrial(cityId, await loadLandContext(cityId));
}

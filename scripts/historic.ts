// NYC uses LPC's ArcGIS layer: Socrata's `xbvj-gfnw` reads back empty and misses 18 districts.
// SF's `y75h-nbt2` is the same decoy, and `knm6-5ej6` is stale and lacks Article 11.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchEastBayHistoric } from "./alameda";
import { fetchArcgis } from "./arcgis";
import { cached } from "./cache";
import { encodePolygons } from "./geometry";
import { type LandContext, loadLandContext } from "./land";
import type { SourceFile } from "./manifest";
import type { Polygon } from "./overpass";
import { DATA_SF } from "./socrata";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const HISTORIC_DIR = join(DATA_DIR, "historic");
const HISTORIC_MAGIC = "HDST";
const HISTORIC_FORMAT = 1;

// Designated-only, so `where` is `1=1`; native CRS is EPSG:3857, so queries ask for `outSR=4326`.
const SERVICE =
  "https://services5.arcgis.com/Oos4pNA2538iVFA1/arcgis/rest/services/Historic_Districts/FeatureServer/0/query";
const PAGE_SIZE = 500;
const MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 5_000; // longer than the shared ladder's: this service rate-limits
// A floor (159 at the last probe) that catches a server-side page cut passing for the end.
const EXPECTED_DISTRICTS = 150;

// Holds every register's districts; only Article 10/11 are local designations.
const SF_DATASET = "63x5-g3m4";
// The flag's value is the string "Listed"; `a10='Yes'` matches nothing.
const SF_WHERE = "a10='Listed' OR a11='Listed'";
// 16 Article 10 plus 7 Article 11; the reader tolerates 5% either way.
const SF_DISTRICTS = 23;

type GeoJsonGeometry =
  | { type: "Polygon"; coordinates: [number, number][][] }
  | { type: "MultiPolygon"; coordinates: [number, number][][][] };

interface DistrictFeature {
  geometry?: GeoJsonGeometry | null;
}

interface DistrictPage {
  features?: DistrictFeature[];
}

// Unordered, an ArcGIS layer may repeat or skip rows between `resultOffset` pages.
function pageUrl(offset: number): string {
  const url = new URL(SERVICE);
  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", "OBJECTID");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("orderByFields", "OBJECTID");
  url.searchParams.set("f", "geojson");
  url.searchParams.set("resultOffset", String(offset));
  url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
  return url.toString();
}

async function fetchPage(url: string): Promise<DistrictPage> {
  try {
    return await fetchArcgis<DistrictPage>(
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
    throw new Error(`historic page ${url} failed: ${error}`);
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

// Any vertex, not the centroid: harbor districts meet the drawn coastline only at the shore.
function touchesLand(part: Polygon, onLand: LandContext["onLand"]): boolean {
  return part.some((ring) => ring.some(onLand));
}

interface Districts {
  polygons: Polygon[];
  districts: number; // features, not polygon parts
  offLand: number; // features with no part on land
}

// Appends a feature's on-land parts to `polygons`; false when none is on land.
function keepDistrict(
  geometry: GeoJsonGeometry,
  onLand: LandContext["onLand"],
  polygons: Polygon[],
): boolean {
  const parts = partsOf(geometry).filter((part) => touchesLand(part, onLand));
  polygons.push(...parts);
  return parts.length > 0;
}

async function fetchNycDistricts(land: LandContext): Promise<Districts> {
  const polygons: Polygon[] = [];
  let fetched = 0;
  let districts = 0;
  let offLand = 0;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = pageUrl(offset);
    const page = await cached("arcgis-lpc-historic-districts", url, () =>
      fetchPage(url),
    );
    const features = page.features ?? [];
    fetched += features.length;
    for (const feature of features) {
      if (!feature.geometry) {
        continue;
      }
      if (keepDistrict(feature.geometry, land.onLand, polygons)) {
        districts += 1;
      } else {
        offLand += 1;
      }
    }
    console.error(
      `  historic: ${fetched} districts fetched, ${polygons.length} parts kept`,
    );
    if (features.length < PAGE_SIZE) {
      break;
    }
  }
  if (fetched < EXPECTED_DISTRICTS) {
    throw new Error(
      `historic fetch returned ${fetched} districts, ${EXPECTED_DISTRICTS} expected: the read was truncated`,
    );
  }
  return { polygons, districts, offLand };
}

interface SfDistrictRow {
  the_geom?: GeoJsonGeometry | null;
}

// `*` keeps the query, and so the disk cache key, stable when a new column is read.
async function fetchSfDistricts(land: LandContext): Promise<Districts> {
  const rows = await DATA_SF.dataset<SfDistrictRow>(
    SF_DATASET,
    { $select: "*", $where: SF_WHERE },
    SF_DISTRICTS,
  );
  const polygons: Polygon[] = [];
  let districts = 0;
  let offLand = 0;
  for (const row of rows) {
    if (!row.the_geom) {
      continue;
    }
    if (keepDistrict(row.the_geom, land.onLand, polygons)) {
      districts += 1;
    } else {
      offLand += 1;
    }
  }
  return { polygons, districts, offLand };
}

async function fetchCityDistricts(
  cityId: string,
  land: LandContext,
): Promise<Districts> {
  if (cityId === "nyc") {
    return await fetchNycDistricts(land);
  } else if (cityId === "sf") {
    const [city, eastBay] = await Promise.all([
      fetchSfDistricts(land),
      fetchEastBayHistoric(land),
    ]);
    return {
      polygons: [...city.polygons, ...eastBay.polygons],
      districts: city.districts + eastBay.districts,
      offLand: city.offLand + eastBay.offLand,
    };
  } else {
    // Another city's districts clipped to this shoreline would write an empty artifact.
    throw new Error(`no historic-district source for ${cityId}`);
  }
}

// Overlaps would composite darker under the overlay's alpha; the graph ORs them anyway.
async function dissolve(polygons: readonly Polygon[]): Promise<Polygon[]> {
  const { union } = await import("polygon-clipping");
  const rings = polygons.map((polygon) =>
    polygon.map((ring) =>
      ring.map(({ lat, lng }): [number, number] => [lng, lat]),
    ),
  );
  const merged = union(rings as Parameters<typeof union>[0]);
  return merged.map((polygon) =>
    polygon.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))),
  );
}

export async function ingestHistoric(
  cityId: string,
  land: LandContext,
): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(HISTORIC_DIR, { recursive: true });

  const { polygons, districts, offLand } = await fetchCityDistricts(
    cityId,
    land,
  );
  const dissolved = await dissolve(polygons);
  const bytes = encodePolygons(HISTORIC_MAGIC, HISTORIC_FORMAT, dissolved);
  const file = `${cityId}.bin`;
  await writeFile(join(HISTORIC_DIR, file), bytes);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const mib = (bytes.length / 1024 / 1024).toFixed(2);
  console.error(
    `historic: ${districts} districts kept (${offLand} off land), ` +
      `${polygons.length} polygon parts dissolved to ${dissolved.length}, ` +
      `${mib} MiB in ${seconds}s`,
  );
  return {
    file,
    format: HISTORIC_FORMAT,
    count: dissolved.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  const cityId = process.argv[2] ?? "nyc";
  await ingestHistoric(cityId, await loadLandContext(cityId));
}

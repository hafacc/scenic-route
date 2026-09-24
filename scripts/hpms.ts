// FHWA HPMS 2024 for New York: per-segment AADT, the same counts NYSDOT publishes.

import { envelopeQuery, featurePages } from "./arcgis";
import type { Bounds } from "./manifest";
import type { VolumeLine } from "./traffic";

const HPMS_NY_URL =
  "https://geo.dot.gov/server/rest/services/Hosted/HPMS_FULL_NY_2024/FeatureServer/0/query";
const PAGE_SIZE = 2_000;
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 4;
// Each county's default for an uncounted local street (Kings 986, Queens 739, New York 2157,
// Bronx 1066, Richmond 383, Nassau 337, Westchester 341): a placeholder, not a count.
export const HPMS_PLACEHOLDER_AADT: readonly number[] = [
  986, 739, 2157, 1066, 383, 337, 341,
];
// Fails a truncated read; the NYC box held ~76k counted segments on 2026-09-24.
const HPMS_SEGMENT_FLOOR = 50_000;

interface HpmsFeature {
  properties?: { aadt?: number | null; routename?: string | null };
  geometry?:
    | { type: "LineString"; coordinates: [number, number][] }
    | { type: "MultiLineString"; coordinates: [number, number][][] }
    | null;
}

function pageUrl(offset: number, box: Bounds): string {
  const url = new URL(HPMS_NY_URL);
  url.searchParams.set(
    "where",
    `aadt > 0 AND aadt NOT IN (${HPMS_PLACEHOLDER_AADT.join(",")})`,
  );
  url.searchParams.set("outFields", "aadt,routename");
  envelopeQuery(url, box);
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("orderByFields", "objectid");
  url.searchParams.set("f", "geojson");
  url.searchParams.set("resultOffset", String(offset));
  url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
  return url.toString();
}

// One VolumeLine per LineString part; the raw pages are dropped as they are read.
export async function fetchHpmsVolumes(box: Bounds): Promise<VolumeLine[]> {
  const lines: VolumeLine[] = [];
  let features = 0;
  for await (const page of featurePages<HpmsFeature>({
    pageUrl: (offset) => pageUrl(offset, box),
    pageSize: PAGE_SIZE,
    cacheName: "hpms-ny-2024",
    timeoutMs: REQUEST_TIMEOUT_MS,
    attempts: MAX_ATTEMPTS,
  })) {
    features += page.length;
    for (const { properties, geometry } of page) {
      const aadt = properties?.aadt;
      if (!aadt || !geometry) {
        continue;
      }
      const parts =
        geometry.type === "LineString"
          ? [geometry.coordinates]
          : geometry.coordinates;
      for (const part of parts) {
        if (part.length >= 2) {
          lines.push({
            aadt,
            name: properties?.routename?.trim() || null,
            points: part.map(([lng, lat]) => ({ lat, lng })),
          });
        }
      }
    }
  }
  if (features < HPMS_SEGMENT_FLOOR) {
    throw new Error(
      `HPMS answered ${features} counted segments over the box, too few to be the whole of it`,
    );
  }
  return lines;
}

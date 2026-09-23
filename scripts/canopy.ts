// NYC's measured 2017 LiDAR tree-canopy polygons, from NYC Parks' ArcGIS FeatureServer.

import { fetchArcgis } from "./arcgis";
import { cached } from "./cache";
import type { Polygon } from "./overpass";

const SERVICE =
  "https://services3.arcgis.com/xJHn8F2NTtwCMFtX/arcgis/rest/services/TreeCanopy2017_Simplified_1ft/FeatureServer/0/query";

const PAGE_SIZE = 2000; // the service's maxRecordCount
const MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 5_000; // longer than the shared ladder's: this service rate-limits
// A floor (~1.08M at last probe) that catches a server-side page cut passing for the layer's end.
const EXPECTED_POLYGONS = 1_000_000;

interface EsriResponse {
  features?: { geometry?: { rings?: [number, number][][] } }[];
  exceededTransferLimit?: boolean;
}

export interface CanopyPolygons {
  polygons: Polygon[];
  fetched: number;
  dropped: number; // features with no non-degenerate ring
}

// Ordered by OBJECTID: without an order an ArcGIS layer may repeat or skip rows between pages.
function pageUrl(offset: number): string {
  const url = new URL(SERVICE);
  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", "");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("orderByFields", "OBJECTID");
  url.searchParams.set("f", "json");
  url.searchParams.set("resultOffset", String(offset));
  url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
  return url.toString();
}

async function fetchPage(url: string): Promise<EsriResponse> {
  try {
    return await fetchArcgis<EsriResponse>(
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
    throw new Error(`canopy page ${url} failed: ${error}`);
  }
}

// Each page is cached by URL, so a resume after a transient failure skips completed pages.
export async function fetchCanopyPolygons(): Promise<CanopyPolygons> {
  const polygons: Polygon[] = [];
  let fetched = 0;
  let dropped = 0;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = pageUrl(offset);
    const page = await cached("arcgis-canopy-2017", url, () => fetchPage(url));
    const features = page.features ?? [];
    fetched += features.length;
    for (const feature of features) {
      const rings = (feature.geometry?.rings ?? [])
        .map((ring) => ring.map(([lng, lat]) => ({ lat, lng })))
        .filter((ring) => ring.length >= 4);
      if (rings.length > 0) {
        polygons.push(rings);
      } else {
        dropped += 1;
      }
    }
    console.error(`  canopy: ${fetched} features fetched`);
    // Both checked: some ArcGIS builds return a full final page with the transfer flag off.
    if (features.length < PAGE_SIZE || page.exceededTransferLimit === false) {
      break;
    }
  }
  if (fetched < EXPECTED_POLYGONS) {
    throw new Error(
      `canopy fetch returned ${fetched} features, ${EXPECTED_POLYGONS} expected: the read was truncated`,
    );
  }
  return { polygons, fetched, dropped };
}

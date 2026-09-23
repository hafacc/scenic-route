import { cached } from "./cache";
import { fetchJson, type JsonRequest } from "./http";
import type { Bounds } from "./manifest";

const REQUEST_TIMEOUT_MS = 120_000;

interface QueryResponse<Feature> {
  features?: Feature[];
}

// No retry by default: a single-request layer fails the build either way.
export type QueryOptions = Omit<JsonRequest<unknown>, "check">;

// ArcGIS reports query errors as a 200 with an `{ error }` body, which would cache as empty.
export async function fetchArcgis<Value>(
  url: string,
  { timeoutMs = REQUEST_TIMEOUT_MS, ...options }: QueryOptions = {},
  check?: (value: Value) => void,
): Promise<Value> {
  return await fetchJson<Value>(url, {
    ...options,
    timeoutMs,
    check: (value) => {
      const { error } = value as { error?: { code: number; message: string } };
      if (error) {
        throw new Error(`ArcGIS ${error.code}: ${error.message}`);
      }
      check?.(value);
    },
  });
}

export async function fetchFeatures<Feature>(
  url: string,
  options: QueryOptions = {},
): Promise<Feature[]> {
  const answer = await fetchArcgis<QueryResponse<Feature>>(
    url,
    options,
    ({ features }) => {
      if (!Array.isArray(features)) {
        throw new Error("no features in the response");
      }
    },
  );
  return answer.features as Feature[];
}

export function envelopeQuery(url: URL, box: Bounds): void {
  url.searchParams.set(
    "geometry",
    JSON.stringify({
      xmin: box.west,
      ymin: box.south,
      xmax: box.east,
      ymax: box.north,
      spatialReference: { wkid: 4326 },
    }),
  );
  url.searchParams.set("geometryType", "esriGeometryEnvelope");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
}

export interface PagedQuery extends QueryOptions {
  // Must set `orderByFields`: without an order ArcGIS may repeat or skip rows between pages.
  pageUrl: (offset: number) => string;
  pageSize: number;
  // Cached per page as `${cacheName}-${offset}`; `null` bypasses the disk cache.
  cacheName: string | null;
}

// A short page is the only end-of-layer signal a query gives.
export async function* featurePages<Feature>({
  pageUrl,
  pageSize,
  cacheName,
  ...options
}: PagedQuery): AsyncGenerator<Feature[]> {
  for (let offset = 0; ; offset += pageSize) {
    const url = pageUrl(offset);
    const read = (): Promise<Feature[]> => fetchFeatures<Feature>(url, options);
    const page =
      cacheName === null
        ? await read()
        : await cached(`${cacheName}-${offset}`, url, read, { quiet: true });
    yield page;
    if (page.length < pageSize) {
      return;
    }
  }
}

export async function allFeatures<Feature>(
  query: PagedQuery,
): Promise<Feature[]> {
  const features: Feature[] = [];
  for await (const page of featurePages<Feature>(query)) {
    features.push(...page);
  }
  return features;
}

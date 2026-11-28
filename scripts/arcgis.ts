import { cached } from "./cache";
import { fetchJson, type JsonRequest } from "./http";
import type { Bounds } from "./manifest";

const REQUEST_TIMEOUT_MS = 120_000;

interface QueryResponse<Feature> {
  features?: Feature[];
  // JSON sets it at the top level; GeoJSON from some servers only under `properties`.
  exceededTransferLimit?: boolean;
  properties?: { exceededTransferLimit?: boolean };
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

async function readFeatures<Feature>(
  url: string,
  options: QueryOptions,
  paged: boolean,
): Promise<Feature[]> {
  const answer = await fetchArcgis<QueryResponse<Feature>>(
    url,
    options,
    ({ features, exceededTransferLimit, properties }) => {
      if (!Array.isArray(features)) {
        throw new Error("no features in the response");
      }
      if (
        !paged &&
        (exceededTransferLimit || properties?.exceededTransferLimit)
      ) {
        throw new Error(
          `${url}: the server cut the answer at ${features.length} rows; page it instead`,
        );
      }
    },
  );
  return answer.features as Feature[];
}

// One request that must hold the whole answer: a response the server cut short throws.
export async function fetchFeatures<Feature>(
  url: string,
  options: QueryOptions = {},
): Promise<Feature[]> {
  return await readFeatures<Feature>(url, options, false);
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
    const read = (): Promise<Feature[]> =>
      readFeatures<Feature>(url, options, true);
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

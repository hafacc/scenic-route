// Curated registers, since license dates (DCWP, SLA) don't reach back and OSM rarely has start_date.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pRetry from "p-retry";
import { cached } from "./cache";
import { encodePoints, type NamedPoint } from "./geometry";
import { USER_AGENT } from "./http";
import { type LandContext, loadLandContext } from "./land";
import type { SourceFile } from "./manifest";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const LEGACY_DIR = join(DATA_DIR, "legacy");
const LEGACY_MAGIC = "LGCY";
const LEGACY_FORMAT = 1;

// New York's register floor, applied to SF's (20-30 years) so a dot means the same in both.
const MIN_AGE_YEARS = 50;

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 2_000;

// SF's Legacy Business Registry; not on DataSF's Socrata catalog, only this ArcGIS layer.
const SF_SERVICE =
  "https://services.arcgis.com/Zs2aNLFN00jrS4gG/arcgis/rest/services/legacy_biz/FeatureServer/0/query";
// NY State's Historic Business Preservation Registry (NYC has none); entry is by nomination only.
const NY_SERVICE =
  "https://services.arcgis.com/1xFZPtKn1wKC6POA/arcgis/rest/services/Historic_Businesses_(view)/FeatureServer/0/query";

interface Feature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface Page {
  features?: Feature[];
  exceededTransferLimit?: boolean;
  error?: { code: number; message: string };
}

function pageUrl(service: string, fields: string[], offset: number): string {
  const url = new URL(service);
  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", fields.join(","));
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  // Without an order an ArcGIS layer may repeat or skip rows between pages.
  url.searchParams.set("orderByFields", "OBJECTID");
  url.searchParams.set("f", "json");
  url.searchParams.set("resultOffset", String(offset));
  url.searchParams.set("resultRecordCount", "1000");
  return url.toString();
}

async function fetchPage(url: string): Promise<Page> {
  return await pRetry(
    async () => {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      const body = (await response.json()) as Page;
      // A 200 carrying an `error` body is how ArcGIS reports a failure.
      if (body.error) {
        throw new Error(`ArcGIS ${body.error.code}: ${body.error.message}`);
      } else if (!Array.isArray(body.features)) {
        throw new Error("no features in the response");
      }
      return body;
    },
    { retries: MAX_ATTEMPTS - 1, minTimeout: RETRY_BASE_MS },
  );
}

async function fetchAll(
  name: string,
  service: string,
  fields: string[],
): Promise<Feature[]> {
  const features: Feature[] = [];
  for (let offset = 0; ; offset += 1000) {
    const url = pageUrl(service, fields, offset);
    const page = await cached(name, url, () => fetchPage(url));
    features.push(...(page.features ?? []));
    if (!page.exceededTransferLimit || (page.features ?? []).length === 0) {
      return features;
    }
  }
}

// SF's field is free text ("1869", "Circa 1924", "1940s"), so the year is matched, not parsed.
function yearIn(value: unknown, thisYear: number): number | null {
  const found = String(value ?? "").match(/\b(1[6-9]\d\d|20[0-2]\d)\b/);
  if (!found) {
    return null;
  }
  const year = Number.parseInt(found[1], 10);
  return year <= thisYear ? year : null;
}

async function sfLegacy(
  land: LandContext,
  thisYear: number,
): Promise<NamedPoint[]> {
  const features = await fetchAll("arcgis-sf-legacy-business", SF_SERVICE, [
    "OBJECTID",
    "Business_Name",
    "Location_Business_Name",
    "Established_Date",
    "Status",
  ]);
  const points: NamedPoint[] = [];
  for (const { attributes, geometry } of features) {
    // One row per location, so a business with four shops is four dots.
    const name = String(
      attributes.Location_Business_Name || attributes.Business_Name || "",
    );
    const year = yearIn(attributes.Established_Date, thisYear);
    const lat = geometry?.y;
    const lng = geometry?.x;
    if (
      name.trim() === "" ||
      year === null ||
      thisYear - year < MIN_AGE_YEARS ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {
      continue;
    }
    const point = { lat: lat as number, lng: lng as number, name: name.trim() };
    if (land.onLand(point)) {
      points.push(point);
    }
  }
  return points;
}

async function nycLegacy(land: LandContext): Promise<NamedPoint[]> {
  const features = await fetchAll("arcgis-ny-historic-business", NY_SERVICE, [
    "OBJECTID",
    "Business_Name",
    "Year_Est_",
    "Municipality",
  ]);
  const points: NamedPoint[] = [];
  for (const { attributes, geometry } of features) {
    const name = String(attributes.Business_Name ?? "");
    const lat = geometry?.y;
    const lng = geometry?.x;
    if (name.trim() === "" || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }
    // Statewide, so the land mask (a bbox would take in Nassau) cuts it; every entry is 50+ years.
    const point = { lat: lat as number, lng: lng as number, name: name.trim() };
    if (land.onLand(point)) {
      points.push(point);
    }
  }
  return points;
}

export type LegacySource = (
  land: LandContext,
  thisYear: number,
) => Promise<NamedPoint[]>;

export const NYC_LEGACY: LegacySource = nycLegacy;
export const SF_LEGACY: LegacySource = sfLegacy;

export async function ingestLegacy(
  cityId: string,
  source: LegacySource | null,
  land: LandContext,
  thisYear = new Date().getUTCFullYear(),
): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(LEGACY_DIR, { recursive: true });
  const points = source ? await source(land, thisYear) : [];
  const bytes = encodePoints(LEGACY_MAGIC, LEGACY_FORMAT, points);
  const file = `${cityId}.bin`;
  await writeFile(join(LEGACY_DIR, file), bytes);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const kib = (bytes.length / 1024).toFixed(1);
  console.error(
    `legacy: ${points.length} businesses of ${MIN_AGE_YEARS}+ years, ${kib} KiB in ${seconds}s`,
  );
  return {
    file,
    format: LEGACY_FORMAT,
    count: points.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  const cityId = process.argv[2] ?? "nyc";
  await ingestLegacy(
    cityId,
    cityId === "sf" ? SF_LEGACY : NYC_LEGACY,
    await loadLandContext(cityId),
  );
}

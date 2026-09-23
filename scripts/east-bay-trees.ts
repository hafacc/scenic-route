// Only the genus overlay reads these; cover comes from the measured canopy (scripts/alcc.ts).
// Berkeley's only public copy is a stale `Trees_Test` layer, so a committed snapshot is read.
// Neither city states a license; both are credited in the About dialog as a courtesy.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { allFeatures, fetchArcgis } from "./arcgis";
import type { Coord, Tree } from "./socrata";

const OAKLAND_SERVICE =
  "https://services.arcgis.com/9tC74aDHuml0x5Yz/arcgis/rest/services/Oakland_Public_Tree_Inventory_/FeatureServer/0";
const BERKELEY_SERVICE =
  "https://services1.arcgis.com/IYiCpZoSIq9lAxi8/arcgis/rest/services/Trees_Test/FeatureServer/0";

export const OAKLAND_TREE_ATTRIBUTION = "Oakland Public Tree Inventory";
export const BERKELEY_TREE_ATTRIBUTION =
  "City of Berkeley street trees (Arborwell survey), frozen copy";

// Not in LFS (only data/trees/*.bin is); it's under a megabyte and written once.
const BERKELEY_SNAPSHOT = join(
  import.meta.dirname,
  "..",
  "data",
  "trees",
  "berkeley-trees.json.gz",
);

// Each layer's own page cap; asking for more is silently capped.
const OAKLAND_PAGE_SIZE = 1_000;
const BERKELEY_PAGE_SIZE = 2_000;
// Floors against a truncated layer; measured 2026-08-29 at 70,420 and 46,732 rows.
const OAKLAND_ROW_FLOOR = 65_000;
const BERKELEY_ROW_FLOOR = 45_000;

const MAX_ATTEMPTS = 6;
const REQUEST_TIMEOUT_MS = 120_000;

interface GeoJsonFeature<Properties> {
  properties?: Properties;
  geometry?: { type?: string; coordinates?: [number, number] } | null;
}

// Unordered, an ArcGIS layer may repeat or skip rows between pages. A snapshot must not read cache.
async function fetchLayer<Properties>(
  name: string,
  service: string,
  fields: string,
  order: string,
  pageSize: number,
  cache = true,
): Promise<GeoJsonFeature<Properties>[]> {
  return await allFeatures<GeoJsonFeature<Properties>>({
    pageUrl: (offset) => {
      const url = new URL(`${service}/query`);
      url.searchParams.set("where", "1=1");
      url.searchParams.set("outFields", fields);
      url.searchParams.set("returnGeometry", "true");
      url.searchParams.set("outSR", "4326");
      url.searchParams.set("orderByFields", order);
      url.searchParams.set("f", "geojson");
      url.searchParams.set("resultOffset", String(offset));
      url.searchParams.set("resultRecordCount", String(pageSize));
      return url.toString();
    },
    pageSize,
    cacheName: cache ? name : null,
    timeoutMs: REQUEST_TIMEOUT_MS,
    attempts: MAX_ATTEMPTS,
  });
}

// The survey's vintage; retried, since a blip after every page is read would waste the snapshot.
async function lastEditedOn(service: string): Promise<string> {
  const answer = await fetchArcgis<{
    editingInfo?: { lastEditDate?: number };
  }>(
    `${service}?f=json`,
    { timeoutMs: REQUEST_TIMEOUT_MS, attempts: MAX_ATTEMPTS },
    ({ editingInfo }) => {
      if (editingInfo?.lastEditDate === undefined) {
        throw new Error(`${service}: no last edit date in the response`);
      }
    },
  );
  const edited = answer.editingInfo?.lastEditDate as number;
  return new Date(edited).toISOString().slice(0, 10);
}

function pointOf(feature: GeoJsonFeature<unknown>): Coord | null {
  const point = feature.geometry?.coordinates;
  if (
    !point ||
    !Number.isFinite(point[0]) ||
    !Number.isFinite(point[1]) ||
    (point[0] === 0 && point[1] === 0)
  ) {
    return null;
  }
  return { lng: point[0], lat: point[1] };
}

interface OaklandRow {
  Species___genus?: string | null;
  DBH?: number | null;
}

// Non-genus values Oakland files under `Species___genus`: rows dropped, and trees of unknown genus.
const OAKLAND_NOT_A_TREE = new Set(["stump", "new planting"]);
const OAKLAND_UNIDENTIFIED = new Set(["unknown tree", "palm species"]);

export async function fetchOaklandTrees(): Promise<Tree[]> {
  const features = await fetchLayer<OaklandRow>(
    "oakland-trees",
    OAKLAND_SERVICE,
    "Species___genus,DBH",
    "ObjectId",
    OAKLAND_PAGE_SIZE,
  );
  if (features.length < OAKLAND_ROW_FLOOR) {
    throw new Error(
      `Oakland's tree inventory answered ${features.length} rows, fewer than the ${OAKLAND_ROW_FLOOR} it holds: the read was truncated`,
    );
  }
  const trees: Tree[] = [];
  let notTrees = 0;
  for (const feature of features) {
    const point = pointOf(feature);
    // Every value in this column carries a trailing space.
    const genus = (feature.properties?.Species___genus ?? "").trim();
    if (point === null) {
      continue;
    } else if (OAKLAND_NOT_A_TREE.has(genus.toLowerCase())) {
      notTrees += 1;
      continue;
    }
    const dbh = feature.properties?.DBH ?? 0;
    trees.push({
      ...point,
      dbhInches: Number.isFinite(dbh) && dbh > 0 ? dbh : 0,
      genus: OAKLAND_UNIDENTIFIED.has(genus.toLowerCase()) ? "" : genus,
    });
  }
  console.error(
    `  oakland: ${features.length} rows, ${trees.length} standing trees (${notTrees} stumps and empty plantings dropped)`,
  );
  return trees;
}

// [lng, lat, SPECIES, DSH]: an array, since keys would be most of the file.
type BerkeleyRow = [number, number, string, string];

interface BerkeleySnapshot {
  service: string;
  lastEdited: string; // the layer's own last edit, i.e. the survey's vintage
  copied: string;
  rows: BerkeleyRow[];
}

interface BerkeleyProperties {
  SPECIES?: string | null;
  DSH?: string | null;
}

// Berkeley's `GENUS` column is empty on every row, so the genus is parsed from `SPECIES`.
const BERKELEY_NOT_A_TREE = new Set(["planting site", "stump", "#value!"]);

function berkeleyGenusOf(species: string): string {
  // A hybrid genus is written "x Cupressocyparis leylandii"; the genus is the word after the marker.
  const words = species
    .replace(/^[x×]\s+/i, "")
    .trim()
    .split(/\s+/);
  const genus = words[0] ?? "";
  return /^[A-Z][a-z-]+$/.test(genus) ? genus : "";
}

function berkeleyTrees(snapshot: BerkeleySnapshot): Tree[] {
  const trees: Tree[] = [];
  let notTrees = 0;
  for (const [lng, lat, species, dsh] of snapshot.rows) {
    const name = species.trim();
    if (BERKELEY_NOT_A_TREE.has(name.toLowerCase())) {
      notTrees += 1;
      continue;
    }
    const dbh = Number.parseFloat(dsh);
    trees.push({
      lat,
      lng,
      dbhInches: Number.isFinite(dbh) && dbh > 0 ? dbh : 0,
      genus: berkeleyGenusOf(name),
    });
  }
  console.error(
    `  berkeley: ${snapshot.rows.length} rows last edited ${snapshot.lastEdited}, ${trees.length} standing trees (${notTrees} planting sites and stumps dropped)`,
  );
  return trees;
}

export async function fetchBerkeleyTrees(): Promise<Tree[]> {
  const snapshot = JSON.parse(
    gunzipSync(await readFile(BERKELEY_SNAPSHOT)).toString("utf-8"),
  ) as BerkeleySnapshot;
  return berkeleyTrees(snapshot);
}

// The other five East Bay municipalities publish no register.
export async function fetchEastBayTrees(): Promise<Tree[]> {
  return [...(await fetchOaklandTrees()), ...(await fetchBerkeleyTrees())];
}

// Run by hand, never by a build.
if (import.meta.main) {
  if (!process.argv.includes("--snapshot")) {
    throw new Error("pass --snapshot to rewrite the Berkeley copy");
  }
  const features = await fetchLayer<BerkeleyProperties>(
    "berkeley-trees",
    BERKELEY_SERVICE,
    "SPECIES,DSH",
    "OBJECTID",
    BERKELEY_PAGE_SIZE,
    false,
  );
  if (features.length < BERKELEY_ROW_FLOOR) {
    throw new Error(
      `Berkeley's tree layer answered ${features.length} rows, fewer than the ${BERKELEY_ROW_FLOOR} it holds: the read was truncated`,
    );
  }
  const rows: BerkeleyRow[] = [];
  for (const feature of features) {
    const point = pointOf(feature);
    if (point !== null) {
      rows.push([
        point.lng,
        point.lat,
        (feature.properties?.SPECIES ?? "").trim(),
        (feature.properties?.DSH ?? "").trim(),
      ]);
    }
  }
  const snapshot: BerkeleySnapshot = {
    service: BERKELEY_SERVICE,
    lastEdited: await lastEditedOn(BERKELEY_SERVICE),
    copied: new Date().toISOString().slice(0, 10),
    rows,
  };
  const bytes = gzipSync(JSON.stringify(snapshot), { level: 9 });
  await writeFile(BERKELEY_SNAPSHOT, bytes);
  console.error(
    `berkeley: ${rows.length} of ${features.length} rows carry a point; wrote ${BERKELEY_SNAPSHOT} (${(bytes.length / 1024).toFixed(0)} KiB)`,
  );
  // For its log line.
  berkeleyTrees(snapshot);
}

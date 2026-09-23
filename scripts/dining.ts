// NYC café licenses merged with OSM outdoor_seating=yes, which covers cafés the licenses miss.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodePoints, haversineMeters, type NamedPoint } from "./geometry";
import { type LandContext, loadLandContext } from "./land";
import type { SourceFile } from "./manifest";
import { fetchOutdoorSeating, type OsmSeating } from "./overpass";
import type { Coord } from "./socrata";
import { NYC_OPEN_DATA } from "./socrata";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const DINING_DIR = join(DATA_DIR, "dining");
const DINING_MAGIC = "DINE";
const DINING_FORMAT = 1;
const DINING_DATASET = "fpeh-f7ci"; // Dining Out NYC sidewalk/roadway café licenses
const DINING_COUNT = 1500; // a floor; ~1,549 licenses at the last refresh
// An OSM café this close to a licensed one is the same establishment; the license record wins.
const OSM_SEATING_DEDUP_METERS = 30;

interface DiningRow {
  latitude?: string;
  longitude?: string;
  assumed_name_s?: string; // the DBA
  business_legal_name?: string;
}

function toPoints(
  rows: DiningRow[],
  onLand: (coord: Coord) => boolean,
): NamedPoint[] {
  const points: NamedPoint[] = [];
  for (const row of rows) {
    const lat = Number.parseFloat(row.latitude ?? "");
    const lng = Number.parseFloat(row.longitude ?? "");
    // Some rows carry blank or 0/0 coordinates.
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat === 0 ||
      lng === 0
    ) {
      continue;
    }
    const name =
      row.assumed_name_s?.trim() || row.business_legal_name?.trim() || "";
    const point = { lat, lng, name };
    if (onLand(point)) {
      points.push(point);
    }
  }
  return points;
}

// Both sets are thousands of points, so a direct scan beats building an index.
function dedupOsm(osm: OsmSeating[], licensed: NamedPoint[]): NamedPoint[] {
  return osm
    .filter(
      (point) =>
        !licensed.some(
          (existing) =>
            haversineMeters(point, existing) <= OSM_SEATING_DEDUP_METERS,
        ),
    )
    .map((point) => ({ lat: point.lat, lng: point.lng, name: point.name }));
}

export async function ingestDining(
  cityId: string,
  land: LandContext,
): Promise<SourceFile> {
  // Another city would clip NYC rows to its own land and silently write an empty artifact.
  if (cityId !== "nyc") {
    throw new Error(`no outdoor dining source for ${cityId}`);
  }

  const started = performance.now();
  await mkdir(DINING_DIR, { recursive: true });

  // `*` because the disk cache keys on the query, so a narrower select would refetch per column.
  const licensedRows = await NYC_OPEN_DATA.dataset<DiningRow>(
    DINING_DATASET,
    { $select: "*" },
    DINING_COUNT,
  );
  const licensed = toPoints(licensedRows, land.onLand);

  const { south, west, north, east } = land.box;
  const osmRaw = await fetchOutdoorSeating(south, west, north, east);
  const osmOnLand = osmRaw.filter(land.onLand);
  const osm = dedupOsm(osmOnLand, licensed);
  const points = [...licensed, ...osm];

  const bytes = encodePoints(DINING_MAGIC, DINING_FORMAT, points);
  const file = `${cityId}.bin`;
  await writeFile(join(DINING_DIR, file), bytes);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const kib = (bytes.length / 1024).toFixed(1);
  console.error(
    `dining: licenses ${licensed.length} on land, OSM ${osmRaw.length} fetched / ${osmOnLand.length} on land / ${osm.length} kept after dedup, ${points.length} total, ${kib} KiB in ${seconds}s`,
  );
  return {
    file,
    format: DINING_FORMAT,
    count: points.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  const cityId = process.argv[2] ?? "nyc";
  await ingestDining(cityId, await loadLandContext(cityId));
}

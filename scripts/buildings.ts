// NYC footprints: `height_roof` and `ground_elevation` (AMSL) are in feet, stored as meters.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fetchEastBayBuildings,
  readEastBayHeights,
} from "./east-bay-buildings";
import { encodeBuildings, type HeightedBuilding } from "./geometry";
import { type LandContext, loadLandContext } from "./land";
import type { SourceFile } from "./manifest";
import type { Polygon } from "./overpass";
import { fetchSfBuildings } from "./sf";
import type { Coord } from "./socrata";
import { NYC_OPEN_DATA } from "./socrata";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const BUILDINGS_DIR = join(DATA_DIR, "buildings");
const BUILDINGS_FORMAT = 1;
const BUILDINGS_DATASET = "5zhs-2jue"; // NYC Building Footprints
const BUILDINGS_COUNT = 1_082_974; // a floor; every feature, not just the ones we keep
const BUILDING_FEATURE_CODE = "2100"; // a real building; 5110/2110/... are garages, skybridges, etc.
const FEET_TO_METERS = 0.3048;

interface BuildingRow {
  the_geom?: { type: string; coordinates: [number, number][][][] };
  height_roof?: string;
  ground_elevation?: string;
  feature_code?: string;
}

// Each part is an outer ring then holes.
function toParts(geom: BuildingRow["the_geom"]): Polygon[] {
  const parts: Polygon[] = [];
  for (const rings of geom?.coordinates ?? []) {
    parts.push(rings.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))));
  }
  return parts;
}

function toBuildings(
  rows: BuildingRow[],
  onLand: (coord: Coord) => boolean,
): HeightedBuilding[] {
  const buildings: HeightedBuilding[] = [];
  for (const row of rows) {
    if (row.feature_code !== BUILDING_FEATURE_CODE) {
      continue;
    }
    const heightFeet = Number.parseFloat(row.height_roof ?? "");
    if (!Number.isFinite(heightFeet) || heightFeet <= 0) {
      continue;
    }
    const heightMeters = heightFeet * FEET_TO_METERS;
    // A missing ground elevation falls back to sea level rather than dropping the building.
    const elevationFeet = Number.parseFloat(row.ground_elevation ?? "");
    const baseElevationMeters = Number.isFinite(elevationFeet)
      ? elevationFeet * FEET_TO_METERS
      : 0;
    for (const polygon of toParts(row.the_geom)) {
      // Any vertex on land, so a shoreline building poking past the coastline is kept.
      const outerRing = polygon[0] ?? [];
      if (outerRing.some(onLand)) {
        buildings.push({ polygon, heightMeters, baseElevationMeters });
      }
    }
  }
  return buildings;
}

async function nycBuildings(land: LandContext): Promise<HeightedBuilding[]> {
  // `*` keeps the query, and so the disk cache key, stable when a new column is read.
  const rows = await NYC_OPEN_DATA.dataset<BuildingRow>(
    BUILDINGS_DATASET,
    { $select: "*" },
    BUILDINGS_COUNT,
  );
  return toBuildings(rows, land.onLand);
}

// A city that passes null casts no building shade at all.
export type BuildingSource = (land: LandContext) => Promise<HeightedBuilding[]>;

export const NYC_BUILDINGS: BuildingSource = nycBuildings;

// East Bay heights come from `tiler ndsm`; reading them first throws before any download if unrun.
export const SF_BUILDINGS: BuildingSource = async (land) => {
  const readings = await readEastBayHeights();
  return [
    ...(await fetchSfBuildings(land.onLand)),
    ...(await fetchEastBayBuildings(readings)),
  ];
};

export async function ingestBuildings(
  cityId: string,
  source: BuildingSource | null,
  land: LandContext,
): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(BUILDINGS_DIR, { recursive: true });
  const buildings = source ? await source(land) : [];

  const bytes = encodeBuildings(BUILDINGS_FORMAT, buildings);
  const file = `${cityId}.bin`;
  await writeFile(join(BUILDINGS_DIR, file), bytes);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const mib = (bytes.length / (1024 * 1024)).toFixed(1);
  console.error(
    `buildings: ${buildings.length} polygons on land, ${mib} MiB in ${seconds}s`,
  );
  return {
    file,
    format: BUILDINGS_FORMAT,
    count: buildings.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  const cityId = process.argv[2] ?? "nyc";
  await ingestBuildings(
    cityId,
    cityId === "sf" ? SF_BUILDINGS : NYC_BUILDINGS,
    await loadLandContext(cityId),
  );
}

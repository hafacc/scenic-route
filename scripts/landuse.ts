// NYC PLUTO tax-lot points by land-use class, for the commercial overlay. Layout: scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ClassifiedPoint, encodeClassifiedPoints } from "./geometry";
import { type LandContext, loadLandContext } from "./land";
import type { SourceFile } from "./manifest";
import type { Coord } from "./socrata";
import { NYC_OPEN_DATA } from "./socrata";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const LANDUSE_DIR = join(DATA_DIR, "landuse");
const LANDUSE_MAGIC = "PLUT";
const LANDUSE_FORMAT = 1;
const LANDUSE_DATASET = "64uk-42ks"; // PLUTO Primary Land Use Tax Lot Output
const LANDUSE_COUNT = 860_000; // a floor, not an exact count
// 1-3 residential, 4 mixed, 5 commercial; 6..11 (industrial, open space, vacant...) never matter.
const MIN_CLASS = 1;
const MAX_CLASS = 5;

interface LandUseRow {
  landuse?: string; // "01".."11"
  latitude?: string;
  longitude?: string;
}

function toPoints(
  rows: LandUseRow[],
  onLand: (coord: Coord) => boolean,
): ClassifiedPoint[] {
  const points: ClassifiedPoint[] = [];
  for (const row of rows) {
    const klass = Number.parseInt(row.landuse ?? "", 10);
    if (!Number.isInteger(klass) || klass < MIN_CLASS || klass > MAX_CLASS) {
      continue;
    }
    const lat = Number.parseFloat(row.latitude ?? "");
    const lng = Number.parseFloat(row.longitude ?? "");
    // Some lots carry blank or 0/0 coordinates.
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat === 0 ||
      lng === 0
    ) {
      continue;
    }
    const point = { lat, lng, klass };
    if (onLand(point)) {
      points.push(point);
    }
  }
  return points;
}

export async function ingestLandUse(
  cityId: string,
  land: LandContext,
): Promise<SourceFile> {
  // Another city would clip NYC's rows to nothing and publish a silently empty artifact.
  if (cityId !== "nyc") {
    throw new Error(`no land use source for ${cityId}`);
  }

  const started = performance.now();
  await mkdir(LANDUSE_DIR, { recursive: true });

  const rows = await NYC_OPEN_DATA.dataset<LandUseRow>(
    LANDUSE_DATASET,
    { $select: "landuse, latitude, longitude" },
    LANDUSE_COUNT,
  );
  const points = toPoints(rows, land.onLand);

  const bytes = encodeClassifiedPoints(LANDUSE_MAGIC, LANDUSE_FORMAT, points);
  const file = `${cityId}.bin`;
  await writeFile(join(LANDUSE_DIR, file), bytes);

  let commercial = 0;
  for (const { klass } of points) {
    if (klass >= 4) {
      commercial += 1;
    }
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const kib = (bytes.length / 1024).toFixed(1);
  console.error(
    `landuse: ${rows.length} lots fetched, ${points.length} kept on land (1..5), ${commercial} commercial (4..5), ${kib} KiB in ${seconds}s`,
  );
  return {
    file,
    format: LANDUSE_FORMAT,
    count: points.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  const cityId = process.argv[2] ?? "nyc";
  await ingestLandUse(cityId, await loadLandContext(cityId));
}

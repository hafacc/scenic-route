// Many Open Streets are residential, so the overlay only uses them to extend a block with dining.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodePoints, haversineMeters, type NamedPoint } from "./geometry";
import { type LandContext, loadLandContext } from "./land";
import type { SourceFile } from "./manifest";
import type { Coord } from "./socrata";
import { NYC_OPEN_DATA } from "./socrata";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const OPEN_STREETS_DIR = join(DATA_DIR, "openstreets");
const OPEN_STREETS_MAGIC = "OSTR";
const OPEN_STREETS_FORMAT = 1;
const OPEN_STREETS_DATASET = "uiay-nctu";
const OPEN_STREETS_COUNT = 391; // a floor
// School-hour closures, not corridors.
const OPEN_STREETS_SCHOOLS_STATUS = "approvedFullSchools";
// Dense enough that samples snap onto every CSCL block segment the corridor covers.
const OPEN_STREET_SAMPLE_METERS = 10;

interface OpenStreetRow {
  the_geom?: { type?: string; coordinates?: [number, number][][] }; // MultiLineString, [lng, lat]
  reviewstat?: string;
  orgname?: string; // sponsoring organization
}

function sampleLine(line: [number, number][], name: string): NamedPoint[] {
  const points: NamedPoint[] = [];
  if (line.length === 0) {
    return points;
  }
  let [previousLng, previousLat] = line[0];
  points.push({ lat: previousLat, lng: previousLng, name });
  let sinceSample = 0; // meters past the last sample, at the previous vertex
  for (let index = 1; index < line.length; index++) {
    const [lng, lat] = line[index];
    const span = haversineMeters(
      { lat: previousLat, lng: previousLng },
      { lat, lng },
    );
    for (
      let along = OPEN_STREET_SAMPLE_METERS - sinceSample;
      along < span;
      along += OPEN_STREET_SAMPLE_METERS
    ) {
      const fraction = along / span;
      points.push({
        lat: previousLat + (lat - previousLat) * fraction,
        lng: previousLng + (lng - previousLng) * fraction,
        name,
      });
    }
    sinceSample =
      span > 0 ? (sinceSample + span) % OPEN_STREET_SAMPLE_METERS : sinceSample;
    previousLng = lng;
    previousLat = lat;
  }
  return points;
}

function toSamples(
  rows: OpenStreetRow[],
  onLand: (coord: Coord) => boolean,
): { samples: NamedPoint[]; corridors: number } {
  const samples: NamedPoint[] = [];
  let corridors = 0;
  for (const row of rows) {
    if (row.reviewstat === OPEN_STREETS_SCHOOLS_STATUS) {
      continue;
    }
    const lines = row.the_geom?.coordinates ?? [];
    if (lines.length === 0) {
      continue;
    }
    corridors += 1;
    const name = row.orgname?.trim() ?? "";
    for (const line of lines) {
      for (const sample of sampleLine(line, name)) {
        if (onLand(sample)) {
          samples.push(sample);
        }
      }
    }
  }
  return { samples, corridors };
}

export async function ingestOpenStreets(
  cityId: string,
  land: LandContext,
): Promise<SourceFile> {
  // Another city would clip NYC rows to its own land and silently write an empty artifact.
  if (cityId !== "nyc") {
    throw new Error(`no open streets source for ${cityId}`);
  }

  const started = performance.now();
  await mkdir(OPEN_STREETS_DIR, { recursive: true });

  // `*` because the disk cache keys on the query, so a narrower select would refetch per column.
  const rows = await NYC_OPEN_DATA.dataset<OpenStreetRow>(
    OPEN_STREETS_DATASET,
    { $select: "*" },
    OPEN_STREETS_COUNT,
  );
  const { samples, corridors } = toSamples(rows, land.onLand);

  const bytes = encodePoints(OPEN_STREETS_MAGIC, OPEN_STREETS_FORMAT, samples);
  const file = `${cityId}.bin`;
  await writeFile(join(OPEN_STREETS_DIR, file), bytes);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const kib = (bytes.length / 1024).toFixed(1);
  console.error(
    `openstreets: ${rows.length} rows fetched, ${corridors} corridors kept, ${samples.length} samples on land, ${kib} KiB in ${seconds}s`,
  );
  return {
    file,
    format: OPEN_STREETS_FORMAT,
    count: samples.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  const cityId = process.argv[2] ?? "nyc";
  await ingestOpenStreets(cityId, await loadLandContext(cityId));
}

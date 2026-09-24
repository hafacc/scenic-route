// Highways and elevated rail as raw polylines, not graph edges: their nuisance is areal.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeClassifiedPolygons } from "./geometry";
import { fetchHpmsVolumes } from "./hpms";
import { type LandContext, loadLandContext } from "./land";
import type { Bounds, SourceFile } from "./manifest";
import {
  fetchNuisanceLines,
  NUISANCE_CLASS,
  type NuisanceLine,
} from "./overpass";
import type { Coord } from "./socrata";
import {
  type Conflation,
  conflateVolumes,
  LOOSE_REACH,
  type VolumeLine,
  weightedMedian,
} from "./traffic";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const HIGHWAY_DIR = join(DATA_DIR, "highways");
const HIGHWAY_MAGIC = "HWAY";
const HIGHWAY_FORMAT = 3;

// Cities with traffic counts; a road there is weighted by its count, elsewhere by its class.
const VOLUME_SOURCES: Record<string, (box: Bounds) => Promise<VolumeLine[]>> = {
  nyc: fetchHpmsVolumes,
};

// Per class byte, the length-weighted median severity of New York's counted lines of that class,
// measured 2026-09-24; rail has no count and keeps full weight.
export const CLASS_SEVERITY: readonly number[] = [
  1, 0.582, 0.249, 0.133, 0.086, 1,
];

// Logged as a sanity check on the conflation.
const LANDMARK_ROADS = [
  "Atlantic Avenue",
  "Flatbush Avenue",
  "4th Avenue",
  "Eastern Parkway",
  "Ocean Parkway",
  "Myrtle Avenue",
  "DeKalb Avenue",
  "Brooklyn-Queens Expressway",
  "FDR Drive",
];

// Midpoint or either endpoint on land: drops out-of-state spill but keeps bridge decks.
function onLandLine(
  line: NuisanceLine,
  onLand: (coord: Coord) => boolean,
): boolean {
  const { points } = line;
  const midpoint = points[Math.floor(points.length / 2)];
  return (
    onLand(midpoint) || onLand(points[0]) || onLand(points[points.length - 1])
  );
}

function percent(part: number, whole: number): string {
  return `${((100 * part) / Math.max(whole, 1)).toFixed(1)}%`;
}

// The traffic that weighs as much as a highway; NYC's median counted motorway carries 80,860 (HPMS 2024).
const REFERENCE_AADT = 80_000;

function severityOf(aadt: number): number {
  return Math.min(aadt / REFERENCE_AADT, 1);
}

function kilometers(conflated: readonly Conflation[]): string {
  const meters = conflated.reduce((sum, { meters }) => sum + meters, 0);
  return (meters / 1000).toFixed(1);
}

// A road with no count gets none, except a highway: one the loose pass still misses is full weight.
async function volumeSeverities(
  kept: readonly NuisanceLine[],
  fetchVolumes: (box: Bounds) => Promise<VolumeLine[]>,
  box: Bounds,
): Promise<number[]> {
  const volumes = await fetchVolumes(box);
  // Rail has no count; its empty points leave it unmatched.
  const conflated = conflateVolumes(
    kept.map((line) =>
      line.klass === NUISANCE_CLASS.rail ? { name: null, points: [] } : line,
    ),
    volumes,
  );
  const isHighway = (klass: number) =>
    klass === NUISANCE_CLASS.motorway || klass === NUISANCE_CLASS.trunk;
  const missed = kept
    .map((_, index) => index)
    .filter(
      (index) => isHighway(kept[index].klass) && conflated[index].aadt === null,
    );
  const retried = conflateVolumes(
    missed.map((index) => kept[index]),
    volumes,
    LOOSE_REACH,
  );
  const recovered = missed.filter((_, at) => retried[at].aadt !== null);
  const defaulted = missed.filter((_, at) => retried[at].aadt === null);
  missed.forEach((index, at) => {
    if (retried[at].aadt !== null) {
      conflated[index] = retried[at];
    }
  });
  const severities = kept.map((line, index) => {
    const { aadt } = conflated[index];
    if (line.klass === NUISANCE_CLASS.rail) {
      return 1;
    }
    if (aadt !== null) {
      return severityOf(aadt);
    }
    return isHighway(line.klass) ? 1 : 0;
  });

  console.error(
    `highways: ${volumes.length} count lines, reference AADT ${REFERENCE_AADT}`,
  );
  console.error(
    `  motorway and trunk: ${kilometers(missed.map((index) => conflated[index]))} km uncounted by the strict pass, ${kilometers(recovered.map((index) => conflated[index]))} km recovered by the loose pass, ${kilometers(defaulted.map((index) => conflated[index]))} km left at full weight`,
  );
  for (const [name, klass] of Object.entries(NUISANCE_CLASS)) {
    if (klass === NUISANCE_CLASS.rail) {
      continue;
    }
    const lines = conflated.filter((_, index) => kept[index].klass === klass);
    const matched = lines.filter(({ aadt }) => aadt !== null);
    const meters = lines.reduce((sum, { meters }) => sum + meters, 0);
    const matchedMeters = matched.reduce((sum, { meters }) => sum + meters, 0);
    const indices = kept
      .map((_, index) => index)
      .filter(
        (index) =>
          kept[index].klass === klass && conflated[index].aadt !== null,
      );
    const median = weightedMedian(
      indices.map((index) => severities[index]),
      indices.map((index) => conflated[index].meters),
    );
    console.error(
      `  ${name}: ${matched.length}/${lines.length} lines (${percent(matchedMeters, meters)} of length) counted, median severity ${median?.toFixed(3) ?? "none"}`,
    );
  }
  for (const road of LANDMARK_ROADS) {
    const indices = kept
      .map((_, index) => index)
      .filter(
        (index) => kept[index].name === road && conflated[index].aadt !== null,
      );
    const aadt = weightedMedian(
      indices.map((index) => conflated[index].aadt as number),
      indices.map((index) => conflated[index].meters),
    );
    console.error(
      `  ${road}: AADT ${aadt ?? "none"}, severity ${aadt === null ? "none" : severityOf(aadt).toFixed(3)}`,
    );
  }
  return severities;
}

export async function ingestHighways(
  cityId: string,
  land: LandContext,
): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(HIGHWAY_DIR, { recursive: true });

  const { south, west, north, east } = land.box;
  const raw = await fetchNuisanceLines(south, west, north, east);
  const kept = raw.filter((line) => onLandLine(line, land.onLand));
  const fetchVolumes = VOLUME_SOURCES[cityId];
  const severities = fetchVolumes
    ? await volumeSeverities(kept, fetchVolumes, land.box)
    : kept.map((line) => CLASS_SEVERITY[line.klass]);

  // Each line is an open single-ring polygon, then a class byte and a severity byte per line.
  const bytes = encodeClassifiedPolygons(
    HIGHWAY_MAGIC,
    HIGHWAY_FORMAT,
    kept.map((line) => [line.points]),
    kept.map((line) => line.klass),
    severities.map((severity) => Math.round(severity * 255)),
  );
  const file = `${cityId}.bin`;
  await writeFile(join(HIGHWAY_DIR, file), bytes);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const kib = (bytes.length / 1024).toFixed(1);
  const breakdown = Object.entries(NUISANCE_CLASS)
    .map(([name, klass]) => {
      const lines = kept.filter((line) => line.klass === klass).length;
      return `${lines} ${name}`;
    })
    .join(", ");
  console.error(
    `highways: ${raw.length} fetched, ${kept.length} on land (${breakdown}), ${kib} KiB in ${seconds}s`,
  );
  return {
    file,
    format: HIGHWAY_FORMAT,
    count: kept.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  const cityId = process.argv[2] ?? "nyc";
  await ingestHighways(cityId, await loadLandContext(cityId));
}

// Highways and elevated rail as raw polylines, not graph edges: their nuisance is areal.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodePolygons } from "./geometry";
import { type LandContext, loadLandContext } from "./land";
import type { SourceFile } from "./manifest";
import { fetchNuisanceLines, type NuisanceLine } from "./overpass";
import type { Coord } from "./socrata";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const HIGHWAY_DIR = join(DATA_DIR, "highways");
const HIGHWAY_MAGIC = "HWAY";
const HIGHWAY_FORMAT = 1;

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

export async function ingestHighways(
  cityId: string,
  land: LandContext,
): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(HIGHWAY_DIR, { recursive: true });

  const { south, west, north, east } = land.box;
  const raw = await fetchNuisanceLines(south, west, north, east);
  const kept = raw.filter((line) => onLandLine(line, land.onLand));
  const highways = kept.filter((line) => line.kind === "highway").length;
  const railLines = kept.length - highways;

  // Each line is an open single-ring polygon, so the polygon blob format carries it unchanged.
  const bytes = encodePolygons(
    HIGHWAY_MAGIC,
    HIGHWAY_FORMAT,
    kept.map((line) => [line.points]),
  );
  const file = `${cityId}.bin`;
  await writeFile(join(HIGHWAY_DIR, file), bytes);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const kib = (bytes.length / 1024).toFixed(1);
  console.error(
    `highways: ${raw.length} fetched, ${kept.length} on land (${highways} highway, ${railLines} above-ground rail), ${kib} KiB in ${seconds}s`,
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

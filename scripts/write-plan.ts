// Writes the plan `tiler build` renders from; which passes rerun is the tiler's decision.

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import manifest from "../src/tree-cover/manifest.json";
import { fetchElevationMosaics } from "./elevation";
import {
  computeShadeBuckets,
  SHADE_MAX_SHADOW_METERS,
  SHADE_MAX_ZOOM,
} from "./shade-schedule";
import { tilerSources } from "./tiler";

type City = (typeof manifest.cities)[number];

const ROOT = join(import.meta.dirname, "..");
const DATA_DIR = join(ROOT, "data");
const PUBLIC_DIR = join(ROOT, "public");
const TILE_DIR = join(PUBLIC_DIR, "tiles");
const CANOPY_TILE_DIR = join(TILE_DIR, "canopy");
const GENUS_FIELD_TILE_DIR = join(TILE_DIR, "genus-field");
const CHUNK_DIR = join(PUBLIC_DIR, "streets");
// Shadow casters the client sweeps itself past the baked pyramid's deepest level.
const CASTER_DIR = join(PUBLIC_DIR, "casters");
const COMMERCIAL_DIR = join(PUBLIC_DIR, "commercial");
const COMMERCIAL_LINES_DIR = join(PUBLIC_DIR, "commercial-lines");
const ROUTING_DIR = join(PUBLIC_DIR, "routing");
const GRAPH_CACHE_DIR = join(ROOT, ".build", "graph-cache");
// `data/<kind>/<id>.bin`, outside the manifest: bumping its schema would break existing cities.
const CONVENTION_SOURCES = [
  "sidewalks",
  "ferries",
  "transit",
  "landmarks",
  "art",
  "highways",
  "industrial",
  "historic",
  "buildings",
] as const;
type ConventionSource = (typeof CONVENTION_SOURCES)[number];
const MANIFEST_PATH = join(ROOT, "src", "tree-cover", "manifest.json");
// The shed guard's plan skips the 1.77 GB DEM and lands in a separate file so no build renders it.
const KEY_SPACE = process.argv.includes("--key-space");
const PLAN_PATH = join(
  ROOT,
  ".build",
  KEY_SPACE ? "key-space-plan.json" : "plan.json",
);

interface PlanCity {
  id: string;
  alleys: boolean;
  existenceCeilings?: ExistenceCeilings;
  sources: ConventionSource[];
  shade?: {
    maxZoom: number;
    maxShadowMeters: number;
    buckets: ReturnType<typeof computeShadeBuckets>;
  };
  // Where two surveys overlap, the first wins.
  elevation?: { crs: string; band: number; tiles: string[] }[];
}

// crates/tiler/src/build.rs rejects unknown keys at every level.
interface Plan {
  code: Record<string, string>;
  manifest: string;
  data: string;
  chunks: string;
  casters: string;
  commercialSignals: string;
  commercialLines: string;
  tiles: string;
  canopyTiles: string;
  genusFieldTiles: string;
  routing: string;
  graphCache: string;
  cities: PlanCity[];
}

function sourcePath(directory: string, file: string): string {
  return join(DATA_DIR, directory, file);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Repo-relative path -> sha256 of content (not mtime), so a fresh CI checkout doesn't force a render.
async function codeFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const path of await tilerSources()) {
    files[relative(ROOT, path)] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }
  return files;
}

// Absent regions default to 0.30/0.30. SF has no sidewalk survey; set just above measured 0.357/0.84.
interface ExistenceCeilings {
  droppedSidewalkFraction: number;
  cellDemotedShare: number;
}

const EXISTENCE_CEILINGS: Record<string, ExistenceCeilings> = {
  sf: { droppedSidewalkFraction: 0.39, cellDemotedShare: 0.88 },
};

// The sun grid is computed here because the client inverts the same module.
async function planCity(city: City): Promise<PlanCity> {
  const present = await Promise.all(
    CONVENTION_SOURCES.map(async (kind) =>
      (await fileExists(sourcePath(kind, `${city.id}.bin`))) ? kind : null,
    ),
  );
  // Per city, since sun positions depend on latitude.
  const buckets = computeShadeBuckets(city.id);
  const mosaics = KEY_SPACE ? [] : await fetchElevationMosaics(city.id);
  return {
    id: city.id,
    // The alley invariants assert New York's meaning of an alley.
    alleys: city.streets.alleys ?? true,
    existenceCeilings: EXISTENCE_CEILINGS[city.id],
    sources: present.filter((kind): kind is ConventionSource => kind !== null),
    ...(buckets.length > 0
      ? {
          shade: {
            maxZoom: SHADE_MAX_ZOOM,
            maxShadowMeters: SHADE_MAX_SHADOW_METERS,
            buckets,
          },
        }
      : {}),
    ...(mosaics.length > 0
      ? {
          elevation: mosaics.map((mosaic) => ({
            crs: mosaic.crs,
            band: mosaic.band,
            tiles: mosaic.paths,
          })),
        }
      : {}),
  };
}

async function writePlan(): Promise<void> {
  const cities: City[] = manifest.cities;
  const plan: Plan = {
    code: await codeFiles(),
    manifest: MANIFEST_PATH,
    data: DATA_DIR,
    chunks: CHUNK_DIR,
    casters: CASTER_DIR,
    commercialSignals: COMMERCIAL_DIR,
    commercialLines: COMMERCIAL_LINES_DIR,
    tiles: TILE_DIR,
    canopyTiles: CANOPY_TILE_DIR,
    genusFieldTiles: GENUS_FIELD_TILE_DIR,
    routing: ROUTING_DIR,
    graphCache: GRAPH_CACHE_DIR,
    cities: await Promise.all(cities.map(planCity)),
  };
  await mkdir(join(ROOT, ".build"), { recursive: true });
  await writeFile(PLAN_PATH, JSON.stringify(plan));
}

await writePlan();

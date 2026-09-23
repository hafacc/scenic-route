// The shape of src/tree-cover/manifest.json.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export type Percentile =
  | "p1"
  | "p5"
  | "p10"
  | "p20"
  | "p30"
  | "p40"
  | "p50"
  | "p60"
  | "p70"
  | "p80"
  | "p90"
  | "p95"
  | "p97"
  | "p99";

export interface Distribution {
  min: number;
  max: number;
  mean: number;
  median: number;
  percentiles: Record<Percentile, number>;
}

export interface SourceFile {
  file: string;
  format: number;
  count: number; // points, or polygons
  bytes: number;
  sha256: string;
}

// Mirrors scripts/allometry.ts; the form is recorded since it differs between climate regions.
export type CrownAllometry =
  | {
      source: string;
      form: "loglog";
      a: number;
      b: number;
      logBiasCorrection: number;
    }
  | { source: string; form: "quad"; a: number; b: number; c: number };

// data/canopy/<id>.bin, magic `CNPY`; layout in scripts/README.md.
export interface CanopyLayer {
  file: string;
  format: number;
  polygons: number;
  vertices: number;
  bytes: number;
  sha256: string;
  squareKm: number; // canopy area on land, ~a fifth of the city's land
  measuredHeights: number; // polygons the height model covered; the rest read 0, unknown
  updated: string;
  attribution: string;
  sourceUrl: string;
  // Absent for a city with no height model: every height reads 0 and no tree shade is baked.
  heightAttribution?: string;
  heightSourceUrl?: string;
}

// Genus byte 0..10 indexes `table` (top 11 by count); 11 is the tail, unknown, and all OSM trees.
export interface GenusTable {
  table: { genus: string; common: string; count: number }[];
  otherCount: number; // trees with id 11
}

export interface FieldLayer {
  trees: SourceFile;
  land: SourceFile;
  canopy: CanopyLayer;
  fillSigmaMeters: number;
  tightSigmaAlongMeters: number;
  tightSigmaAcrossMeters: number; // tight, so the two sidewalks stay distinct
  crownAllometry: CrownAllometry;
  maxDbhInches: number; // clamp: the source has nonsense outliers
  imputedDbhInches: number; // the median, given to trees with no dbh
  clampedTrees: number;
  imputedTrees: number;
  osmTrees: number;
  osmTreeDedup: number; // OSM trees within 5 m of a ForMS trunk (ForMS wins on dbh)
  osmImputedCrowns: number; // kept OSM trees with no diameter_crown
  meanCoverOverLand: number; // sanity-checked against ~22% all-sources
  coverSamples: number;
  coverSeed: number;
  genus: GenusTable;
  density: Distribution;
  updated: string;
  attribution: string; // OSM paths and trees; ForMS is credited on the city
  sourceUrl: string;
}

// data/streets/<id>.bin; layout in scripts/README.md.
export interface StreetLayer {
  file: string;
  format: number;
  segments: number;
  vertices: number;
  bytes: number;
  sha256: string;
  densifyMeters: number;
  sidewalkInsetMeters: number; // curb to the center of the sidewalk
  // Has pavement-less service ways; SF's "alleys" are streets with sidewalks.
  alleys: boolean;
  density: Distribution;
  updated: string;
  attribution: string;
  sourceUrl: string;
}

// data/paths/<id>.bin, magic `PATH`: STRT's layout, offset 0 = OSM way id.
export interface PathLayer {
  file: string;
  format: number;
  ways: number;
  segments: number; // equal to ways: one way is one polyline
  vertices: number;
  bytes: number;
  sha256: string;
  km: number; // densified length on land
  density: Distribution; // one sample stands for both sides
  updated: string;
  attribution: string;
  sourceUrl: string;
}

export interface CityEntry {
  id: string;
  name: string;
  bounds: Bounds; // where the field can be non-zero
  trees: number;
  updated: string;
  attribution: string; // the tree inventory
  sourceUrl: string;
  field: FieldLayer;
  streets: StreetLayer;
  paths: PathLayer;
}

export interface Manifest {
  version: 5;
  cities: CityEntry[];
}

const MANIFEST_PATH = join(
  import.meta.dirname,
  "..",
  "src",
  "tree-cover",
  "manifest.json",
);
const MANIFEST_VERSION = 5;

export async function readManifest(): Promise<Manifest> {
  const existing = await readFile(MANIFEST_PATH, "utf-8").catch(() => null);
  if (existing === null) {
    return { version: MANIFEST_VERSION, cities: [] };
  } else {
    const parsed = JSON.parse(existing) as Manifest;
    // Not a fresh start: an ingest writes back what it read, so that would drop cities.
    if (parsed.version !== MANIFEST_VERSION) {
      throw new Error(
        `${MANIFEST_PATH} is v${parsed.version}, not v${MANIFEST_VERSION}: re-ingest every city, or delete it to start over`,
      );
    } else {
      return parsed;
    }
  }
}

// Chunk pyramids are keyed by x/y with no city, so cities must never share a chunk.
const CHUNK_ZOOM = 12;

function chunkRange(bounds: Bounds): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const scale = 2 ** CHUNK_ZOOM;
  const x = (lng: number): number => Math.floor(((lng + 180) / 360) * scale);
  const y = (lat: number): number => {
    const radians = (lat * Math.PI) / 180;
    const merc =
      (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
    return Math.floor(merc * scale);
  };
  return {
    minX: x(bounds.west),
    maxX: x(bounds.east),
    minY: y(bounds.north),
    maxY: y(bounds.south),
  };
}

export function overlappingCities(
  cities: CityEntry[],
): [string, string] | null {
  for (let first = 0; first < cities.length; first++) {
    for (let second = first + 1; second < cities.length; second++) {
      const one = chunkRange(cities[first].bounds);
      const other = chunkRange(cities[second].bounds);
      if (
        one.minX <= other.maxX &&
        other.minX <= one.maxX &&
        one.minY <= other.maxY &&
        other.minY <= one.maxY
      ) {
        return [cities[first].id, cities[second].id];
      }
    }
  }
  return null;
}

export async function writeManifest(manifest: Manifest): Promise<void> {
  const overlap = overlappingCities(manifest.cities);
  if (overlap) {
    throw new Error(
      `${overlap[0]} and ${overlap[1]} share a z${CHUNK_ZOOM} chunk: the street, caster and ` +
        "commercial pyramids are keyed by x/y with no city in the path, so their segments would " +
        "interleave in one file. Give those pyramids a city segment before adding this city.",
    );
  }
  const versioned: Manifest = { ...manifest, version: MANIFEST_VERSION };
  await writeFile(MANIFEST_PATH, `${JSON.stringify(versioned, null, 2)}\n`);
}

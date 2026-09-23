// The JSON handed between tree-data-fetch, `tiler ingest` and tree-data-manifest.

import { join } from "node:path";
import type {
  Bounds,
  CrownAllometry,
  Distribution,
  GenusTable,
  Percentile,
  SourceFile,
} from "./manifest";

const ROOT = join(import.meta.dirname, "..");

// In the repo: a package.json script can't name the machine's temporary directory.
export const INGEST_PARAMS_PATH = join(ROOT, ".build", "ingest.json");
export const INGEST_REPORT_PATH = join(ROOT, ".build", "ingest-report.json");
export const SIDECAR_PATH = join(ROOT, ".build", "tree-data.json");

export const PERCENTILES: readonly Percentile[] = [
  "p1",
  "p5",
  "p10",
  "p20",
  "p30",
  "p40",
  "p50",
  "p60",
  "p70",
  "p80",
  "p90",
  "p95",
  "p97",
  "p99",
];

export interface RawDistribution {
  min: number;
  max: number;
  mean: number;
  median: number;
  percentiles: Record<string, number>;
}

export interface IngestReport {
  // Absent without a `chm`; every polygon then keeps height 0, meaning unknown.
  heights?: {
    polygons: number;
    measured: number; // polygons the model had a cell for
    skippedTiles: number; // CHM tiles whose LZW stream would not decode
  };
  bounds: Bounds; // the sources grown by the kernel's reach
  draws: number;
  landDensity: RawDistribution;
  streetDensity: RawDistribution;
  pathDensity?: RawDistribution; // only when a paths file was passed
}

export interface TreeDataSidecar {
  city: {
    id: string;
    name: string;
    attribution: string;
    sourceUrl: string;
    streetAttribution: string;
    streetSourceUrl: string;
    fieldAttribution: string;
    fieldSourceUrl: string;
    pathAttribution: string;
    pathSourceUrl: string;
    canopyAttribution: string;
    canopySourceUrl: string;
    alleys: boolean;
  };
  heightSource: { attribution: string; sourceUrl: string } | null;
  trees: SourceFile;
  land: SourceFile;
  // No bytes or sha256: the ingest rewrites the blob afterward.
  canopy: {
    file: string;
    format: number;
    polygons: number;
    vertices: number;
    squareKm: number;
  };
  streets: {
    file: string;
    format: number;
    segments: number;
    vertices: number;
    densifyMeters: number;
  };
  paths: {
    file: string;
    format: number;
    ways: number;
    vertices: number;
    km: number;
  };
  field: {
    fillSigmaMeters: number;
    tightSigmaAlongMeters: number;
    tightSigmaAcrossMeters: number;
    sidewalkInsetMeters: number;
    crownAllometry: CrownAllometry;
    maxDbhInches: number;
    imputedDbhInches: number;
    clampedTrees: number;
    imputedTrees: number;
    osmTrees: number;
    osmTreeDedup: number;
    osmImputedCrowns: number;
    coverSamples: number;
    coverSeed: number;
    genus: GenusTable;
  };
  // After the land clip.
  cityTrees: number;
  sidewalks: SourceFile;
}

// Key order follows PERCENTILES, not the report map's iteration order.
export function distributionOf(raw: RawDistribution): Distribution {
  const percentiles = {} as Record<Percentile, number>;
  for (const percentile of PERCENTILES) {
    percentiles[percentile] = raw.percentiles[percentile];
  }
  return {
    min: raw.min,
    max: raw.max,
    mean: raw.mean,
    median: raw.median,
    percentiles,
  };
}

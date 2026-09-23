import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type CanopyLayer,
  type CityEntry,
  type FieldLayer,
  type PathLayer,
  readManifest,
  type StreetLayer,
  writeManifest,
} from "./manifest";
import {
  distributionOf,
  INGEST_REPORT_PATH,
  type IngestReport,
  SIDECAR_PATH,
  type TreeDataSidecar,
} from "./tree-data";

const DATA_DIR = join(import.meta.dirname, "..", "data");

// Re-read: the ingest rewrote these blobs in place after the fetch half encoded them.
async function readBlob(directory: string, file: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(DATA_DIR, directory, file)));
}

const started = performance.now();

// `bun run x -- args` hands flags to a chain's last command, i.e. here; `--city` is only checked.
const { values } = parseArgs({
  options: {
    city: { type: "string" },
    refresh: { type: "boolean" },
  },
});

const sidecar: TreeDataSidecar = JSON.parse(
  await readFile(SIDECAR_PATH, "utf-8"),
);
const report: IngestReport = JSON.parse(
  await readFile(INGEST_REPORT_PATH, "utf-8"),
);
const city = sidecar.city;
if (values.city !== undefined && values.city !== city.id) {
  throw new Error(
    `${SIDECAR_PATH} is ${city.id}, not ${values.city}: re-run the fetch half for ${values.city}`,
  );
}
if (!report.pathDensity) {
  throw new Error("tiler ingest was passed paths but reported no pathDensity");
}

const canopyBytes = await readBlob("canopy", sidecar.canopy.file);
const streetBytes = await readBlob("streets", sidecar.streets.file);
const pathBytes = await readBlob("paths", sidecar.paths.file);

const updated = new Date().toISOString().slice(0, 10);
const canopyLayer: CanopyLayer = {
  file: sidecar.canopy.file,
  format: sidecar.canopy.format,
  polygons: sidecar.canopy.polygons,
  vertices: sidecar.canopy.vertices,
  bytes: canopyBytes.length,
  sha256: createHash("sha256").update(canopyBytes).digest("hex"),
  squareKm: sidecar.canopy.squareKm,
  measuredHeights: report.heights?.measured ?? 0,
  updated,
  attribution: city.canopyAttribution,
  sourceUrl: city.canopySourceUrl,
  ...(sidecar.heightSource
    ? {
        heightAttribution: sidecar.heightSource.attribution,
        heightSourceUrl: sidecar.heightSource.sourceUrl,
      }
    : {}),
};
const field: FieldLayer = {
  trees: sidecar.trees,
  land: sidecar.land,
  canopy: canopyLayer,
  fillSigmaMeters: sidecar.field.fillSigmaMeters,
  tightSigmaAlongMeters: sidecar.field.tightSigmaAlongMeters,
  tightSigmaAcrossMeters: sidecar.field.tightSigmaAcrossMeters,
  crownAllometry: sidecar.field.crownAllometry,
  maxDbhInches: sidecar.field.maxDbhInches,
  imputedDbhInches: sidecar.field.imputedDbhInches,
  clampedTrees: sidecar.field.clampedTrees,
  imputedTrees: sidecar.field.imputedTrees,
  osmTrees: sidecar.field.osmTrees,
  osmTreeDedup: sidecar.field.osmTreeDedup,
  osmImputedCrowns: sidecar.field.osmImputedCrowns,
  meanCoverOverLand: report.landDensity.mean,
  coverSamples: sidecar.field.coverSamples,
  coverSeed: sidecar.field.coverSeed,
  genus: sidecar.field.genus,
  density: distributionOf(report.landDensity),
  updated,
  attribution: city.fieldAttribution,
  sourceUrl: city.fieldSourceUrl,
};
const streets: StreetLayer = {
  file: sidecar.streets.file,
  format: sidecar.streets.format,
  segments: sidecar.streets.segments,
  vertices: sidecar.streets.vertices,
  bytes: streetBytes.length,
  sha256: createHash("sha256").update(streetBytes).digest("hex"),
  densifyMeters: sidecar.streets.densifyMeters,
  sidewalkInsetMeters: sidecar.field.sidewalkInsetMeters,
  alleys: city.alleys,
  density: distributionOf(report.streetDensity),
  updated,
  attribution: city.streetAttribution,
  sourceUrl: city.streetSourceUrl,
};
const paths: PathLayer = {
  file: sidecar.paths.file,
  format: sidecar.paths.format,
  ways: sidecar.paths.ways,
  segments: sidecar.paths.ways, // one way is one record
  vertices: sidecar.paths.vertices,
  bytes: pathBytes.length,
  sha256: createHash("sha256").update(pathBytes).digest("hex"),
  km: sidecar.paths.km,
  density: distributionOf(report.pathDensity),
  updated,
  attribution: city.pathAttribution,
  sourceUrl: city.pathSourceUrl,
};
const entry: CityEntry = {
  id: city.id,
  name: city.name,
  bounds: report.bounds,
  trees: sidecar.cityTrees,
  updated,
  attribution: city.attribution,
  sourceUrl: city.sourceUrl,
  field,
  streets,
  paths,
};

const manifest = await readManifest();
const existing = manifest.cities.findIndex((other) => other.id === city.id);
if (existing === -1) {
  manifest.cities.push(entry);
} else {
  manifest.cities[existing] = entry;
}
await writeManifest(manifest);

console.error(
  report.heights
    ? `${city.id}: canopy heights measured for ${report.heights.measured} of ${report.heights.polygons} polygons (${report.heights.skippedTiles} CHM tiles skipped)`
    : `${city.id}: no canopy height model; every polygon keeps an unknown height`,
);
const megabytes = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);
const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.error(
  `${city.id}: wrote trees (${megabytes(sidecar.trees.bytes)} MiB), canopy (${sidecar.canopy.polygons} polygons, ${megabytes(canopyBytes.length)} MiB), land (${megabytes(sidecar.land.bytes)} MiB), streets (${sidecar.streets.segments} segments, ${sidecar.streets.vertices} vertices, ${megabytes(streetBytes.length)} MiB), paths (${sidecar.paths.ways} ways, ${sidecar.paths.vertices} vertices, ${megabytes(pathBytes.length)} MiB) and sidewalks (${sidecar.sidewalks.count} ways, ${megabytes(sidecar.sidewalks.bytes)} MiB) in ${seconds}s`,
);

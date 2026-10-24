// Re-places every job in sheds.tsv from its stored reading; --from-feed first walks the whole feed afresh.
// Reads public/routing/<city>.bin, so it runs after `bun run build-tiles`.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeGraph,
  type GraphIdentity,
  NO_SOURCE_ID,
  type RoutingGraph,
} from "../src/routing/graph";
import type { ShedCity } from "../src/routing/shed-cities";
import {
  CONFIDENCE_CEILING,
  DEPTH_CEILING,
  DEPTH_SCALE,
  FRACTION_SCALE,
  parseShedFile,
  type ShedFile,
  type ShedFileRecord,
  type ShedFileSpan,
  serializeShedFile,
} from "../src/routing/shed-file";
import { graphHashOf, graphKeyHashOf } from "./graph-hash";
import { shedDir, writeShedInputs } from "./graph-inputs";
import {
  buildSidewalkIndex,
  pickShedParts,
  placeShed,
  type ShedPlacement,
  type ShedRequest,
  type SidewalkIndex,
} from "./shed-map";
import {
  bblOf,
  fetchShedParcels,
  lotFor,
  quantizeRing,
  type Ring,
  type ShedParcels,
} from "./shed-parcels";
import {
  emptyShedFile,
  finishWalk,
  shedSnapshots,
  startWalk,
  walkSnapshots,
} from "./shed-permits";

const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const ROUTING_DIR = join(PUBLIC_DIR, "routing");
// The city the DOB permit feed covers; another city's sheds are another permit source.
export const DOB_CITY: ShedCity = "nyc";
const SIDE_BITS = 3; // the graph's kind-and-side byte keeps the side in bits 3-5
const SIDE_MASK = 0x7;
const METERS_PER_MILE = 1609.344;
const PROGRESS_EVERY = 5_000;

// Hashes recomputed, not read from version.json: on the live site that file may predate the graph.
export function loadGraphBytes(source: Uint8Array): RoutingGraph {
  // Copied: decodeGraph views the buffer, and a readFile Buffer can sit at an offset in a pool.
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  const graph = decodeGraph(bytes.buffer, {
    hash: graphHashOf(bytes),
    keyHash: "",
  });
  return { ...graph, keyHash: graphKeyHashOf(graph) };
}

async function loadGraph(city: ShedCity): Promise<RoutingGraph> {
  const graphPath = join(ROUTING_DIR, `${city}.bin`);
  const graph = loadGraphBytes(await readFile(graphPath));
  const version = (await readFile(
    join(ROUTING_DIR, `${city}.version.json`),
    "utf-8",
  ).catch(() => null)) as string | null;
  if (version !== null) {
    const declared = JSON.parse(version) as GraphIdentity;
    if (declared.hash !== graph.hash || declared.keyHash !== graph.keyHash) {
      throw new Error(
        `${graphPath} is ${graph.hash}/${graph.keyHash}, its version file says` +
          ` ${declared.hash}/${declared.keyHash}`,
      );
    }
  }
  return graph;
}

// Rings are on the repo's 1e-6 degree grid.
export interface ShedRecord {
  street: string;
  linearFeet: number; // NaN when the feed carries none
  lng: number | null;
  lat: number | null;
  lot: Ring | null;
  footprint: Ring | null; // anchors a permit shorter than its frontage
}

export function bblOfRecord(record: ShedFileRecord): string | null {
  const [borough, block, lot] = record.bbl.split("/");
  return record.bbl === "" ? null : bblOf(borough, block, lot);
}

export function toShedRecord(
  record: ShedFileRecord,
  parcels: ShedParcels,
): ShedRecord {
  const linearFeet = record.feet ?? Number.NaN;
  const parts = pickShedParts({
    street: record.street,
    linearFeet,
    lot: lotFor(parcels, bblOfRecord(record), record.bin),
    footprint: parcels.footprints.get(record.bin) ?? null,
    lng: record.lng,
    lat: record.lat,
  });
  return {
    street: record.street,
    linearFeet,
    lng: record.lng,
    lat: record.lat,
    lot: parts.lot === null ? null : quantizeRing(parts.lot),
    footprint: parts.footprint === null ? null : quantizeRing(parts.footprint),
  };
}

export function parcelRequestsOf(
  records: readonly ShedFileRecord[],
): { bin: string; bbl: string | null }[] {
  return records.map((record) => ({
    bin: record.bin,
    bbl: bblOfRecord(record),
  }));
}

export function shedRequestOf(record: ShedRecord): ShedRequest {
  return {
    street: record.street,
    linearFeet: record.linearFeet,
    lot: record.lot === null ? null : [record.lot],
    footprint: record.footprint === null ? null : [record.footprint],
    lng: record.lng,
    lat: record.lat,
  };
}

export function placeRecords(
  index: SidewalkIndex,
  records: readonly ShedRecord[],
): ShedPlacement[] {
  const started = performance.now();
  return records.map((record, order) => {
    if ((order + 1) % PROGRESS_EVERY === 0) {
      const elapsed = (performance.now() - started) / 1000;
      console.error(
        `  ${order + 1}/${records.length} placed, ${elapsed.toFixed(0)}s (${((elapsed / (order + 1)) * 1000).toFixed(1)} ms/shed)`,
      );
    }
    return placeShed(index, shedRequestOf(record));
  });
}

// Keyed by durable id, not edge id: the file outlives the graph it was snapped against.
export function toFileSpans(
  graph: RoutingGraph,
  placement: ShedPlacement,
): ShedFileSpan[] {
  return placement.spans.map((span) => {
    const sourceId = graph.edgeSourceId[span.edge];
    if (sourceId === NO_SOURCE_ID) {
      // Placement only lands on sidewalks, which all carry a source segment.
      throw new Error(`edge ${span.edge} has no durable id to key a shed on`);
    }
    const t0 = Math.min(
      FRACTION_SCALE,
      Math.max(0, Math.round(span.t0 * FRACTION_SCALE)),
    );
    return {
      sourceId,
      side: (graph.edgeKindSide[span.edge] >> SIDE_BITS) & SIDE_MASK,
      ordinal: graph.edgeOrdinal[span.edge],
      t0,
      t1: Math.min(
        FRACTION_SCALE,
        Math.max(t0, Math.round(span.t1 * FRACTION_SCALE)),
      ),
      // 0 for unmeasured: the client applies its one fallback depth.
      depth: Number.isFinite(span.depthMeters)
        ? Math.min(DEPTH_CEILING, Math.round(span.depthMeters * DEPTH_SCALE))
        : 0,
    };
  });
}

export function toConfidenceByte(placement: ShedPlacement): number {
  return Math.min(CONFIDENCE_CEILING, Math.round(placement.confidence * 255));
}

// Each record is placed from its own reading alone, so placing a few matches placing them all.
export async function placeSheds(
  graph: RoutingGraph,
  records: readonly ShedFileRecord[],
): Promise<ShedPlacement[]> {
  if (records.length === 0) {
    return [];
  }
  const parcels = await fetchShedParcels(parcelRequestsOf(records));
  const started = performance.now();
  const index = buildSidewalkIndex(graph);
  console.error(
    `  graph ${graph.hash}, key space ${graph.keyHash}, ${index.edges.length} sidewalk edges` +
      ` indexed in ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
  const placements = placeRecords(
    index,
    records.map((record) => toShedRecord(record, parcels)),
  );
  for (const [order, record] of records.entries()) {
    record.spans = toFileSpans(graph, placements[order]);
    record.confidence = toConfidenceByte(placements[order]);
  }
  return placements;
}

export function shedFilePath(city: ShedCity): string {
  return join(shedDir(city), "sheds.tsv");
}

export async function readShedFile(path: string): Promise<ShedFile> {
  return parseShedFile(await readFile(path, "utf-8"));
}

export async function writeShedFile(
  city: ShedCity,
  file: ShedFile,
): Promise<void> {
  // Committed under public/; the tile build neither renders nor clears it.
  await mkdir(shedDir(city), { recursive: true });
  const text = serializeShedFile(file);
  await writeFile(shedFilePath(city), text);
  console.error(
    `  sheds.tsv: ${file.records.length.toLocaleString()} permits, ${text.length.toLocaleString()} bytes`,
  );
}

function firstDayOf(file: ShedFile): string | null {
  let first: string | null = null;
  for (const record of file.records) {
    const day = record.runs[0].first;
    if (first === null || day < first) {
      first = day;
    }
  }
  return first;
}

// The file is the archive: a feed that has since forgotten days must not erase them unasked.
export function truncationOf(
  existing: ShedFile | null,
  rebuilt: ShedFile,
): string | null {
  const kept = existing === null ? null : firstDayOf(existing);
  const start = firstDayOf(rebuilt);
  if (kept === null || start === null || kept >= start) {
    return null;
  } else {
    return (
      `the shed file has runs from ${kept}, before the feed's first snapshot on ${start}:` +
      " rebuilding from the feed would drop them, so pass --force to mean that"
    );
  }
}

// `placements` in the order of `records`.
export function summarize(
  records: readonly ShedFileRecord[],
  placements: readonly ShedPlacement[],
  seen: string,
): void {
  const assigned = placements.filter((placement) => placement.spans.length > 0);
  const standing = placements.filter(
    (_, order) => records[order].runs.at(-1)?.last === null,
  );
  const coverage = (of: readonly ShedPlacement[]): number =>
    of.reduce((total, placement) => total + placement.coveredMeters, 0);
  const weighted =
    assigned.reduce(
      (total, placement) =>
        total + placement.confidence * placement.coveredMeters,
      0,
    ) / coverage(assigned);
  const status = new Map<string, number>();
  for (const placement of placements) {
    status.set(placement.status, (status.get(placement.status) ?? 0) + 1);
  }
  const standingAssigned = standing.filter(
    (placement) => placement.spans.length > 0,
  );
  console.error(
    `sheds: ${assigned.length}/${records.length} permits placed, ` +
      `${(coverage(assigned) / METERS_PER_MILE).toFixed(1)} mi of coverage, ` +
      `coverage-weighted confidence ${weighted.toFixed(3)}`,
  );
  console.error(
    `  standing on ${seen}: ${standingAssigned.length}/${standing.length} placed, ` +
      `${(coverage(standingAssigned) / METERS_PER_MILE).toFixed(1)} mi`,
  );
  console.error(
    `  status: ${[...status].map(([name, count]) => `${name} ${count}`).join(", ")}`,
  );
  const depths = placements
    .flatMap((placement) => placement.spans.map((span) => span.depthMeters))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const spans = placements.reduce(
    (total, placement) => total + placement.spans.length,
    0,
  );
  const measured = placements.reduce(
    (total, placement) => total + placement.measuredDepths,
    0,
  );
  const quantile = (share: number): string =>
    depths[
      Math.min(depths.length - 1, Math.floor(share * depths.length))
    ].toFixed(1);
  console.error(
    `  deck depth: ${measured}/${spans} spans measured on their own frontage,` +
      ` ${depths.length - measured} took their shed's median, ${spans - depths.length} none;` +
      ` min ${quantile(0)} p50 ${quantile(0.5)} p90 ${quantile(0.9)}` +
      ` max ${quantile(1)} m`,
  );
  // Declared length with no frontage to hold it; a large shortfall is usually a bad geocode.
  const declaredMeters = placements.reduce(
    (total, placement) =>
      total +
      (Number.isFinite(placement.shedMeters) ? placement.shedMeters : 0),
    0,
  );
  const declaring = assigned.filter((placement) =>
    Number.isFinite(placement.shedMeters),
  );
  const unplacedMeters = placements.reduce(
    (total, placement) => total + placement.unplacedMeters,
    0,
  );
  const shortfalls = declaring
    .map((placement) => placement.unplacedMeters)
    .sort((left, right) => left - right);
  const halved = declaring.filter(
    (placement) => placement.coveredMeters < placement.shedMeters / 2,
  ).length;
  const shortfall = (share: number): string =>
    shortfalls[
      Math.min(shortfalls.length - 1, Math.floor(share * shortfalls.length))
    ].toFixed(1);
  console.error(
    `  unplaced: ${(unplacedMeters / METERS_PER_MILE).toFixed(1)} of` +
      ` ${(declaredMeters / METERS_PER_MILE).toFixed(1)} declared mi had no frontage to stand on;` +
      ` per placed permit p50 ${shortfall(0.5)} p90 ${shortfall(0.9)}` +
      ` p99 ${shortfall(0.99)} max ${shortfall(1)} m,` +
      ` ${halved}/${declaring.length} placing under half what they declare`,
  );
}

export async function buildSheds(flags: readonly string[]): Promise<void> {
  const path = shedFilePath(DOB_CITY);
  const existing = await readShedFile(path).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    },
  );
  let file: ShedFile;
  if (flags.includes("--from-feed")) {
    const { sources, blobs } = await shedSnapshots("build-sheds-from-feed");
    const walk = startWalk(emptyShedFile(DOB_CITY));
    await walkSnapshots(walk, sources, blobs);
    file = finishWalk(walk);
    const truncation = truncationOf(existing, file);
    if (truncation !== null && !flags.includes("--force")) {
      throw new Error(truncation);
    }
  } else if (existing === null) {
    throw new Error(
      `${path} is missing: \`bun run build-sheds-from-feed\` lays it down from the DOB feed`,
    );
  } else {
    file = existing;
  }
  const graph = await loadGraph(DOB_CITY);
  const placements = await placeSheds(graph, file.records);
  file.keySpace = graph.keyHash;
  await writeShedFile(DOB_CITY, file);
  // Stamped only here: update-sheds re-stamping would launder an input change nobody re-placed.
  const inputs = await writeShedInputs(DOB_CITY);
  console.error(
    `  inputs.json: ${inputs.files} committed key-space inputs stamped ${inputs.stamp}, key probe` +
      ` ${inputs.keySpace}`,
  );
  summarize(file.records, placements, file.seen);
}

if (import.meta.main) {
  // argv[2] is the commit index when the feed pipeline runs this.
  await buildSheds(process.argv.slice(2));
}

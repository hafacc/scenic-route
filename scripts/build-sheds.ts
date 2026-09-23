// The artifact must be a function of the feed and its end date alone, so incremental runs match it.
// Reads public/routing/nyc.bin, so it runs after `bun run build-tiles`.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeGraph,
  type GraphIdentity,
  NO_SOURCE_ID,
  type RoutingGraph,
} from "../src/routing/graph";
import { writeShedInputs } from "./graph-inputs";
import {
  CONFIDENCE_CEILING,
  DEPTH_CEILING,
  DEPTH_SCALE,
  type EncodedShed,
  type EncodedSpan,
  encodeSheds,
  FRACTION_SCALE,
  graphHashOf,
  graphKeyHashOf,
  SIDE_BITS,
  shedDayOf,
} from "./shed-encode";
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
  MERGE_TOLERANCE_DAYS,
  readShedPermits,
  type ShedAttributes,
  type ShedInterval,
  type ShedPermit,
  shedSnapshots,
} from "./shed-permits";

const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const ROUTING_DIR = join(PUBLIC_DIR, "routing");
// The one committed directory under public/; the tile build neither renders nor clears it.
export const SHED_DIR = join(PUBLIC_DIR, "sheds");
const GRAPH_PATH = join(ROUTING_DIR, "nyc.bin");
const VERSION_PATH = join(ROUTING_DIR, "nyc.version.json");
const SIDE_MASK = 0x7; // the graph's kind-and-side byte, bits 3-5
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

async function loadGraph(): Promise<RoutingGraph> {
  const graph = loadGraphBytes(await readFile(GRAPH_PATH));
  const version = (await readFile(VERSION_PATH, "utf-8").catch(() => null)) as
    | string
    | null;
  if (version !== null) {
    const declared = JSON.parse(version) as GraphIdentity;
    if (declared.hash !== graph.hash || declared.keyHash !== graph.keyHash) {
      throw new Error(
        `${GRAPH_PATH} is ${graph.hash}/${graph.keyHash}, its version file says` +
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

export function toShedRecord(
  attributes: ShedAttributes,
  parcels: ShedParcels,
): ShedRecord {
  const bbl = bblOf(attributes.boroughDigit, attributes.block, attributes.lot);
  const parts = pickShedParts({
    street: attributes.street,
    linearFeet: attributes.linearFeet,
    lot: lotFor(parcels, bbl, attributes.bin),
    footprint: parcels.footprints.get(attributes.bin) ?? null,
    lng: attributes.lng,
    lat: attributes.lat,
  });
  return {
    street: attributes.street,
    linearFeet: attributes.linearFeet,
    lng: attributes.lng,
    lat: attributes.lat,
    lot: parts.lot === null ? null : quantizeRing(parts.lot),
    footprint: parts.footprint === null ? null : quantizeRing(parts.footprint),
  };
}

// Includes readings an interval ended under that the feed has since corrected.
export function placementAttributes(
  permits: readonly ShedPermit[],
): ShedAttributes[] {
  const distinct: ShedAttributes[] = [];
  const seen = new Set<ShedAttributes>();
  for (const permit of permits) {
    for (const interval of permit.intervals) {
      if (!seen.has(interval.attributes)) {
        seen.add(interval.attributes);
        distinct.push(interval.attributes);
      }
    }
  }
  return distinct;
}

export function parcelRequestsOf(
  attributes: readonly ShedAttributes[],
): { bin: string; bbl: string | null }[] {
  return attributes.map((reading) => ({
    bin: reading.bin,
    bbl: bblOf(reading.boroughDigit, reading.block, reading.lot),
  }));
}

// The artifact's record order: the only one the daily job can rebuild from the CSV alone.
export function byJobNumber(left: ShedPermit, right: ShedPermit): number {
  return left.job < right.job ? -1 : left.job > right.job ? 1 : 0;
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

// Keyed by durable id, not edge id: the artifact outlives the graph it was snapped against.
export function toEncodedSpans(
  graph: RoutingGraph,
  placement: ShedPlacement,
): EncodedSpan[] {
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

// Provisional (a reappearance could still extend it) goes in open.bin; the rest are final.
export function isProvisional(last: number, lastDay: number): boolean {
  return lastDay - last < MERGE_TOLERANCE_DAYS;
}

export interface ShedCoverage {
  spans: EncodedSpan[];
  confidence: number; // 0..254
}

// One record per (permit, interval); `permits` must already be in job order.
export function encodedShedsOf(
  permits: readonly ShedPermit[],
  coverageOf: (interval: ShedInterval, permit: ShedPermit) => ShedCoverage,
  lastDay: number,
): EncodedShed[] {
  const encoded: EncodedShed[] = [];
  for (const permit of permits) {
    for (const interval of permit.intervals) {
      const { spans, confidence } = coverageOf(interval, permit);
      const last = shedDayOf(interval.last);
      encoded.push({
        job: permit.job,
        first: shedDayOf(interval.first),
        close: isProvisional(last, lastDay) ? null : last,
        confidence,
        spans,
      });
    }
  }
  return encoded;
}

export async function writeShedArtifact(
  encoded: readonly EncodedShed[],
  graphKeyHash: string,
  lastDay: number,
  counts: readonly number[],
): Promise<void> {
  const artifact = encodeSheds(encoded, graphKeyHash, lastDay, counts);
  await mkdir(SHED_DIR, { recursive: true });
  for (const [name, bytes] of [
    ["open.bin", artifact.open],
    ["closed.bin", artifact.closed],
    ["index.bin", artifact.index],
  ] as const) {
    await writeFile(join(SHED_DIR, name), bytes);
    console.error(`  ${name}: ${bytes.length.toLocaleString()} bytes`);
  }
}

export function summarize(
  permits: readonly ShedPermit[],
  placementOf: (interval: ShedInterval) => ShedPlacement,
  lastDay: string,
): void {
  const day = shedDayOf(lastDay);
  const records = permits.flatMap((permit) =>
    permit.intervals.map((interval) => ({
      standing: isProvisional(shedDayOf(interval.last), day),
      placement: placementOf(interval),
    })),
  );
  const placements = records.map((record) => record.placement);
  const assigned = placements.filter((placement) => placement.spans.length > 0);
  const standing = records.filter((record) => record.standing);
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
  const standingAssigned = standing
    .map((record) => record.placement)
    .filter((placement) => placement.spans.length > 0);
  console.error(
    `sheds: ${assigned.length}/${records.length} records placed over ${permits.length} permits, ` +
      `${(coverage(assigned) / METERS_PER_MILE).toFixed(1)} mi of coverage, ` +
      `coverage-weighted confidence ${weighted.toFixed(3)}`,
  );
  console.error(
    `  standing on ${lastDay}: ${standingAssigned.length}/${standing.length} placed, ` +
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
      ` per placed record p50 ${shortfall(0.5)} p90 ${shortfall(0.9)}` +
      ` p99 ${shortfall(0.99)} max ${shortfall(1)} m,` +
      ` ${halved}/${declaring.length} placing under half what they declare`,
  );
}

export async function buildSheds(): Promise<void> {
  const { sources, blobs } = await shedSnapshots("build-sheds");
  const { permits, lastDay, counts } = await readShedPermits(sources, blobs);
  permits.sort(byJobNumber);
  const attributes = placementAttributes(permits);
  const parcels = await fetchShedParcels(parcelRequestsOf(attributes));
  const records = attributes.map((reading) => toShedRecord(reading, parcels));

  const graph = await loadGraph();
  const started = performance.now();
  const index = buildSidewalkIndex(graph);
  console.error(
    `  ${index.edges.length} sidewalk edges indexed in ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
  const placements = placeRecords(index, records);
  const placed = new Map(
    attributes.map((reading, order) => [reading, placements[order]]),
  );
  const placementOf = (interval: ShedInterval): ShedPlacement =>
    placed.get(interval.attributes)!;
  const day = shedDayOf(lastDay);
  await writeShedArtifact(
    encodedShedsOf(
      permits,
      (interval) => ({
        spans: toEncodedSpans(graph, placementOf(interval)),
        confidence: toConfidenceByte(placementOf(interval)),
      }),
      day,
    ),
    graph.keyHash,
    day,
    counts,
  );
  // Stamped only here: update-sheds re-stamping would launder an input change nobody re-placed.
  const inputs = await writeShedInputs();
  console.error(
    `  inputs.json: ${inputs.files} committed key-space inputs stamped ${inputs.stamp}, key probe` +
      ` ${inputs.keySpace}`,
  );
  summarize(permits, placementOf, lastDay);
}

if (import.meta.main) {
  await buildSheds();
}

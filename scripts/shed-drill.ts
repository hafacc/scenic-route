// Placing only new jobs matches a full re-place only if each depends on its own reading: drop one, compare.
// Re-runs the parcel fetch too, since dropping a key shifts Socrata's sorted batch boundaries.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { edgeName, type RoutingGraph } from "../src/routing/graph";
import type { ShedFileRecord } from "../src/routing/shed-file";
import {
  bblOfRecord,
  DOB_CITY,
  loadGraphBytes,
  parcelRequestsOf,
  placeRecords,
  readShedFile,
  type ShedRecord,
  shedFilePath,
  toConfidenceByte,
  toFileSpans,
  toShedRecord,
} from "./build-sheds";
import {
  buildSidewalkIndex,
  type ShedPlacement,
  type SidewalkIndex,
} from "./shed-map";
import { fetchShedParcels } from "./shed-parcels";

const GRAPH_PATH = join(
  import.meta.dirname,
  "..",
  "public",
  "routing",
  "nyc.bin",
);
const LONG_RUN_METERS = 120; // a superblock frontage on one street
const MIDBLOCK_MIN_METERS = 15;
const MIDBLOCK_MAX_METERS = 45;
const MIDBLOCK_SLACK_METERS = 3;
const SHAPES = ["corner", "midblock", "superblock", "overdeclared"] as const;
type Shape = (typeof SHAPES)[number];

// Everything the file stores for a job's placement.
function digestOf(placement: ShedPlacement, graph: RoutingGraph): string {
  const spans = toFileSpans(graph, placement)
    .map(
      (span) =>
        `${span.sourceId}/${span.side}/${span.ordinal}/${span.t0}-${span.t1}@${span.depth}`,
    )
    .join(" ");
  return `${toConfidenceByte(placement)} [${spans}]`;
}

interface RecordSet {
  digests: Map<string, string>;
  placements: Map<string, ShedPlacement>;
  inputs: Map<string, string>; // job -> what its placement read
}

function inputDigestOf(record: ShedRecord): string {
  const digest = createHash("sha256");
  for (const ring of [record.lot, record.footprint]) {
    digest.update(
      ring === null ? new Uint8Array(1) : new Uint8Array(ring.buffer),
    );
  }
  return `${record.street}|${record.linearFeet}|${record.lng},${record.lat}|${digest.digest("hex").slice(0, 16)}`;
}

async function recordSetOf(
  index: SidewalkIndex,
  graph: RoutingGraph,
  records: readonly ShedFileRecord[],
): Promise<RecordSet> {
  const requests = parcelRequestsOf(records);
  console.error(
    `  ${records.length} readings over ${new Set(requests.map((key) => key.bin)).size} BINs` +
      ` and ${new Set(requests.map((key) => key.bbl)).size} BBLs`,
  );
  const parcels = await fetchShedParcels(requests);
  const inputs = records.map((record) => toShedRecord(record, parcels));
  const placements = placeRecords(index, inputs);
  return {
    digests: new Map(
      records.map((record, order) => [
        record.job,
        digestOf(placements[order], graph),
      ]),
    ),
    placements: new Map(
      records.map((record, order) => [record.job, placements[order]]),
    ),
    inputs: new Map(
      records.map((record, order) => [
        record.job,
        inputDigestOf(inputs[order]),
      ]),
    ),
  };
}

// A shifted batch re-fetches, maybe from a newer tax map than the cached rest; that voids the run.
function driftedInputs(
  baseline: ReadonlyMap<string, string>,
  dropped: ReadonlyMap<string, string>,
): number {
  let drifted = 0;
  for (const [job, digest] of baseline) {
    const after = dropped.get(job);
    if (after !== undefined && after !== digest) {
      drifted += 1;
    }
  }
  return drifted;
}

export interface DrillResult {
  job: string;
  compared: number;
  changed: number;
  examples: string[];
}

const MAX_EXAMPLES = 5;

export function compareRecordSets(
  baseline: ReadonlyMap<string, string>,
  dropped: ReadonlyMap<string, string>,
  job: string,
): DrillResult {
  let compared = 0;
  let changed = 0;
  const examples: string[] = [];
  for (const [other, digest] of baseline) {
    if (other === job) {
      continue;
    }
    compared += 1;
    const after = dropped.get(other);
    if (after !== digest) {
      changed += 1;
      if (examples.length < MAX_EXAMPLES) {
        examples.push(
          `${other}\n    was ${digest}\n    now ${after ?? "(absent)"}`,
        );
      }
    }
  }
  return { job, compared, changed, examples };
}

function streetsOf(graph: RoutingGraph, placement: ShedPlacement): number {
  const names = new Set<string>();
  for (const span of placement.spans) {
    const name = edgeName(graph, span.edge);
    if (name !== null && name !== "") {
      names.add(name);
    }
  }
  return names.size;
}

function shapeOf(graph: RoutingGraph, placement: ShedPlacement): Shape | null {
  if (placement.spans.length === 0) {
    return null;
  }
  const streets = streetsOf(graph, placement);
  if (
    Number.isFinite(placement.shedMeters) &&
    placement.coveredMeters < placement.shedMeters / 2
  ) {
    return "overdeclared";
  } else if (streets > 1) {
    return "corner";
  } else if (placement.coveredMeters >= LONG_RUN_METERS) {
    return "superblock";
  } else if (
    placement.coveredMeters >= MIDBLOCK_MIN_METERS &&
    placement.coveredMeters <= MIDBLOCK_MAX_METERS &&
    placement.unplacedMeters <= MIDBLOCK_SLACK_METERS
  ) {
    return "midblock";
  } else {
    return null;
  }
}

// A job number's leading digit is its borough; the middle candidate is arbitrary but stable.
export function pickDrops(
  candidates: ReadonlyMap<Shape, readonly string[]>,
): Map<Shape, string> {
  const picked = new Map<Shape, string>();
  const boroughs = new Set<string>();
  for (const shape of SHAPES) {
    const jobs = [...(candidates.get(shape) ?? [])].sort();
    if (jobs.length === 0) {
      continue;
    }
    const middle = Math.floor(jobs.length / 2);
    const order = jobs
      .map((job, at) => ({ job, distance: Math.abs(at - middle) }))
      .sort((left, right) => left.distance - right.distance);
    const fresh = order.find(({ job }) => !boroughs.has(job[0]));
    const job = (fresh ?? order[0]).job;
    boroughs.add(job[0]);
    picked.set(shape, job);
  }
  return picked;
}

// Jobs whose BIN and BBL no other job names; only dropping these shifts the parcel batches.
export function isolatingJobs(records: readonly ShedFileRecord[]): Set<string> {
  const namers = new Map<string, number>();
  const keysOf = (record: ShedFileRecord): string[] => [
    `bin:${record.bin}`,
    `bbl:${bblOfRecord(record)}`,
  ];
  for (const record of records) {
    for (const key of keysOf(record)) {
      namers.set(key, (namers.get(key) ?? 0) + 1);
    }
  }
  return new Set(
    records
      .filter((record) => keysOf(record).every((key) => namers.get(key) === 1))
      .map((record) => record.job),
  );
}

function candidatesOf(
  graph: RoutingGraph,
  placements: ReadonlyMap<string, ShedPlacement>,
  isolating: ReadonlySet<string>,
): Map<Shape, string[]> {
  const candidates = new Map<Shape, string[]>(
    SHAPES.map((shape) => [shape, []]),
  );
  for (const [job, placement] of placements) {
    const shape = isolating.has(job) ? shapeOf(graph, placement) : null;
    if (shape !== null) {
      candidates.get(shape)!.push(job);
    }
  }
  return candidates;
}

function describe(
  graph: RoutingGraph,
  placement: ShedPlacement,
  record: ShedFileRecord,
): string {
  return (
    `${record.street}, ${streetsOf(graph, placement)} street(s),` +
    ` ${placement.coveredMeters.toFixed(0)} m covered of` +
    ` ${Number.isFinite(placement.shedMeters) ? placement.shedMeters.toFixed(0) : "?"} declared,` +
    ` ${placement.spans.length} spans, status ${placement.status}`
  );
}

export async function runDrill(chosen: readonly string[]): Promise<void> {
  const { records } = await readShedFile(shedFilePath(DOB_CITY));
  const graph = loadGraphBytes(await readFile(GRAPH_PATH));
  const index = buildSidewalkIndex(graph);
  console.error(
    `  graph ${graph.hash}, key space ${graph.keyHash}, ${index.edges.length} sidewalk edges,` +
      ` ${records.length} permits`,
  );

  const started = performance.now();
  const baseline = await recordSetOf(index, graph, records);
  console.error(
    `drill: baseline is ${baseline.digests.size.toLocaleString()} permits,` +
      ` ${((performance.now() - started) / 1000).toFixed(0)}s`,
  );

  const byJob = new Map(records.map((record) => [record.job, record]));
  const drops: [string, string][] =
    chosen.length > 0
      ? chosen.map((job) => ["given", job])
      : [
          ...pickDrops(
            candidatesOf(graph, baseline.placements, isolatingJobs(records)),
          ),
        ];
  for (const [shape, job] of drops) {
    const record = byJob.get(job);
    if (record === undefined) {
      throw new Error(`${job} is not a permit the shed file holds`);
    }
    console.error(
      `\ndropping ${job} (${shape}): ${describe(graph, baseline.placements.get(job)!, record)}`,
    );
    const dropped = await recordSetOf(
      index,
      graph,
      records.filter((other) => other.job !== job),
    );
    const result = compareRecordSets(baseline.digests, dropped.digests, job);
    const drifted = driftedInputs(baseline.inputs, dropped.inputs);
    console.error(
      `drill: ${job} (${shape}): ${result.changed} of ${result.compared.toLocaleString()} surviving permits changed`,
    );
    if (drifted > 0) {
      console.error(
        `  ${drifted} surviving readings were placed from DIFFERENT parcel geometry, so the two runs` +
          " did not read the same tax map and the count above means nothing." +
          " Re-run with REFRESH=1 to pin the source.",
      );
    }
    for (const example of result.examples) {
      console.error(`  ${example}`);
    }
  }
}

if (import.meta.main) {
  await runDrill(process.argv.slice(2));
}

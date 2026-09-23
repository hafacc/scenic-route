// Replays every snapshot since the artifact's own day, never assuming it ran yesterday: cron skips.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoutingGraph } from "../src/routing/graph";
import {
  byJobNumber,
  encodedShedsOf,
  loadGraphBytes,
  parcelRequestsOf,
  placementAttributes,
  placeRecords,
  SHED_DIR,
  type ShedCoverage,
  toConfidenceByte,
  toEncodedSpans,
  toShedRecord,
  writeShedArtifact,
} from "./build-sheds";
import {
  type DecodedShedArtifact,
  decodeShedArtifact,
  type EncodedShed,
  shedDayOf,
  shedGraphMismatch,
} from "./shed-encode";
import { buildSidewalkIndex } from "./shed-map";
import { fetchShedParcels } from "./shed-parcels";
import {
  daysBetween,
  MERGE_TOLERANCE_DAYS,
  mergeIntervals,
  readShedPermits,
  resumeFrom,
  type ShedAttributes,
  type ShedPermit,
  shedSnapshots,
} from "./shed-permits";

// New sheds must be placed on the deployed graph the client runs, not what a checkout would build.
const SITE = process.env.SHED_SITE ?? "https://hafa.cc/scenic-route";
const GRAPH_URL = `${SITE}/routing/nyc.bin`;
// A directory, or a URL to read the artifact over HTTP.
const ARTIFACT = process.env.SHED_ARTIFACT ?? SHED_DIR;
const SHALLOW_DAYS = 30;
const DAY_MS = 86_400_000;
const EPOCH_MS = Date.UTC(2017, 11, 28); // the first DOB snapshot; every day number counts from here

function isoDay(day: number): string {
  return new Date(EPOCH_MS + day * DAY_MS).toISOString().slice(0, 10);
}

async function readArtifact(name: string): Promise<Uint8Array> {
  if (ARTIFACT.startsWith("http")) {
    const url = `${ARTIFACT}/${name}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `${url}: ${response.status} ${response.statusText} —` +
          " `bun run build-sheds` has to have laid the artifact down and published it once",
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  } else {
    const file = await readFile(join(ARTIFACT, name));
    return new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
  }
}

// A month of slack: a commit's UTC stamp can fall after the New York day its CSV claims.
export function readCommitsFrom(applyFrom: string): string {
  return new Date(Date.parse(applyFrom) - SHALLOW_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

// From the artifact alone, so the clone depth is known before the pipeline runs.
export async function shedWindow(): Promise<string> {
  const [open, closed] = await Promise.all([
    readArtifact("open.bin"),
    readArtifact("closed.bin"),
  ]);
  return readCommitsFrom(
    resumeFrom(isoDay(decodeShedArtifact(open, closed).lastDay)),
  );
}

// Null when the site serves no usable graph yet, which is the deploy lagging, not an error.
export async function loadDeployedGraph(): Promise<RoutingGraph | null> {
  const local = process.env.SHED_GRAPH;
  if (local !== undefined) {
    console.error(`  graph: ${local}`);
    // An operator-named file that won't read is the wrong file, so throw rather than wait.
    return loadGraphBytes(await readFile(local));
  }
  console.error(`  graph: ${GRAPH_URL}`);
  const response = await fetch(GRAPH_URL);
  if (!response.ok) {
    console.error(
      `  ${GRAPH_URL}: ${response.status} ${response.statusText}, so the site is serving no graph` +
        " at all; leaving the artifact alone. This run will pick the day up once a deploy has put" +
        " one there.",
    );
    return null;
  }
  try {
    return loadGraphBytes(new Uint8Array(await response.arrayBuffer()));
  } catch (error) {
    // An unreadable deployed graph is a deploy behind a format change.
    console.error(
      `  ${GRAPH_URL} is not a graph this checkout can read (${String(error)});` +
        " leaving the artifact alone. Deploy the site, and this run will pick the day up once it" +
        " serves a graph this checkout can read.",
    );
    return null;
  }
}

function lastSeenBy(permit: ShedPermit, through: string): string | null {
  let latest: string | null = null;
  for (const run of permit.runs) {
    if (run.first <= through) {
      const day = run.last < through ? run.last : through;
      if (latest === null || day > latest) {
        latest = day;
      }
    }
  }
  return latest;
}

// What the feed says `open.bin` must hold, as a check on the mapping the artifact states.
export function standingOn(
  permits: readonly ShedPermit[],
  through: string,
): ShedPermit[] {
  return permits.filter((permit) => {
    const seen = lastSeenBy(permit, through);
    return seen !== null && daysBetween(seen, through) < MERGE_TOLERANCE_DAYS;
  });
}

// `closed.bin` is append-only: its records ended over a renewal ago, so nothing merges into them.
export function reconcileSheds(
  artifact: DecodedShedArtifact,
  permits: readonly ShedPermit[],
  lastDay: string,
  placed: ReadonlyMap<ShedAttributes, ShedCoverage>,
): EncodedShed[] {
  const through = isoDay(artifact.lastDay);
  const held = new Map<string, EncodedShed>(
    artifact.open.map((record) => [record.job, record]),
  );
  const standing = standingOn(permits, through);
  const missing = standing.find((permit) => !held.has(permit.job));
  if (standing.length !== held.size || missing !== undefined) {
    throw new Error(
      `the feed says ${standing.length} sheds were standing on ${through} and open.bin names` +
        ` ${held.size}${missing === undefined ? "" : `, not including ${missing.job}`}:` +
        " the two disagree, so rebuild with `bun run build-sheds`",
    );
  }
  // A held record keeps its first day: its run reaches back past the window.
  const rebuilt = encodedShedsOf(
    permits.map((permit) => {
      const record = held.get(permit.job);
      const intervals = mergeIntervals(permit.runs);
      if (record !== undefined) {
        intervals[0] = { ...intervals[0], first: isoDay(record.first) };
      }
      return { ...permit, intervals };
    }),
    (interval, permit) => {
      // A changed reading is always re-placed, so a record on file matches its reading.
      const coverage = placed.get(interval.attributes);
      if (coverage !== undefined) {
        return coverage;
      }
      const record = held.get(permit.job);
      if (record === undefined) {
        throw new Error(`${permit.job} is neither on record nor newly placed`);
      }
      return { spans: record.spans, confidence: record.confidence };
    },
    shedDayOf(lastDay),
  );
  return [...artifact.closed, ...rebuilt];
}

export async function updateSheds(): Promise<void> {
  const [openBytes, closedBytes] = await Promise.all([
    readArtifact("open.bin"),
    readArtifact("closed.bin"),
  ]);
  const artifact = decodeShedArtifact(openBytes, closedBytes);
  const through = isoDay(artifact.lastDay);
  console.error(
    `  the artifact reaches ${through}: ${artifact.open.length.toLocaleString()} standing,` +
      ` ${artifact.closed.length.toLocaleString()} come down`,
  );

  // Old keys re-stamped under a new key space would misplace every shed. Skips rather than fails,
  // since the daily job's timetable steps run after this.
  const graph = await loadDeployedGraph();
  if (graph === null) {
    return;
  }
  const mismatch = shedGraphMismatch(artifact, graph.keyHash);
  if (mismatch !== null) {
    console.error(
      `  ${mismatch}; leaving the artifact alone. A graph-input change lands as one deploy:` +
        " bun run build-sheds against the new graph, commit, then deploy. This run will pick the" +
        " day up once the site serves the graph the artifact names.",
    );
    return;
  }

  const applyFrom = resumeFrom(through);
  const { sources, blobs } = await shedSnapshots(
    "update-sheds",
    readCommitsFrom(applyFrom),
  );
  const { permits, lastDay, counts } = await readShedPermits(
    sources,
    blobs,
    applyFrom,
    artifact.counts,
  );
  permits.sort(byJobNumber);
  console.error(
    `  the feed now reaches ${lastDay}, ${permits.length.toLocaleString()} permits mentioned since ${applyFrom}`,
  );

  const held = new Set(artifact.open.map((record) => record.job));
  const fresh = permits.filter(
    (permit) => !held.has(permit.job) || permit.corrected,
  );
  // A corrected permit has two readings: the one its earlier interval ended under and today's.
  const attributes = placementAttributes(fresh);
  console.error(
    `  ${fresh.length} permits need a parcel read over ${attributes.length} readings,` +
      ` ${permits.length - fresh.length} carry their spans over`,
  );
  const parcels = await fetchShedParcels(parcelRequestsOf(attributes));

  const index = buildSidewalkIndex(graph);
  console.error(
    `  graph ${graph.hash}, key space ${graph.keyHash}, ${index.edges.length} sidewalk edges`,
  );
  const placements = placeRecords(
    index,
    attributes.map((reading) => toShedRecord(reading, parcels)),
  );
  const placed = new Map(
    attributes.map((reading, order) => [
      reading,
      {
        spans: toEncodedSpans(graph, placements[order]),
        confidence: toConfidenceByte(placements[order]),
      },
    ]),
  );

  const records = reconcileSheds(artifact, permits, lastDay, placed);
  await writeShedArtifact(records, graph.keyHash, shedDayOf(lastDay), counts);
  const stillUp = records.filter((record) => record.close === null).length;
  console.error(
    `sheds: ${stillUp} standing on ${lastDay}, ${records.length - stillUp} come down` +
      ` (${fresh.length} newly placed, ${placements.filter((placement) => placement.spans.length > 0).length} onto a sidewalk)`,
  );
}

if (import.meta.main) {
  await updateSheds();
}

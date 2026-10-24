// Advances sheds.tsv over every snapshot after its `through`, never assuming it ran yesterday: cron skips.

import { readFile } from "node:fs/promises";
import type { RoutingGraph } from "../src/routing/graph";
import { parseShedFile, type ShedFile } from "../src/routing/shed-file";
import {
  DOB_CITY,
  loadGraphBytes,
  placeSheds,
  shedFilePath,
  writeShedFile,
} from "./build-sheds";
import {
  finishWalk,
  listedCount,
  shedSnapshots,
  startWalk,
  walkSnapshots,
} from "./shed-permits";

// New sheds must be placed on the deployed graph the client runs, not what a checkout would build.
const SITE = process.env.SHED_SITE ?? "https://scenic.hafa.cc";
const GRAPH_URL = `${SITE}/routing/${DOB_CITY}.bin`;
// A path, or a URL to read the file over HTTP.
const SHED_FILE = process.env.SHED_FILE ?? shedFilePath(DOB_CITY);
const SHALLOW_DAYS = 30;
const DAY_MS = 86_400_000;

async function readCurrentFile(): Promise<ShedFile> {
  if (SHED_FILE.startsWith("http")) {
    const response = await fetch(SHED_FILE);
    if (!response.ok) {
      throw new Error(
        `${SHED_FILE}: ${response.status} ${response.statusText} —` +
          " `bun run build-sheds-from-feed` has to have laid the file down and published it once",
      );
    }
    return parseShedFile(await response.text());
  } else {
    return parseShedFile(await readFile(SHED_FILE, "utf-8"));
  }
}

// A month of slack: a commit's UTC stamp can fall after the New York day its CSV claims.
export function readCommitsFrom(through: string): string {
  return new Date(Date.parse(through) - SHALLOW_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

// From the file alone, so the clone depth is known before the pipeline runs.
export async function shedWindow(): Promise<string> {
  return readCommitsFrom((await readCurrentFile()).through);
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
        " at all; leaving the file alone. This run will pick the day up once a deploy has put" +
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
        " leaving the file alone. Deploy the site, and this run will pick the day up once it" +
        " serves a graph this checkout can read.",
    );
    return null;
  }
}

// Writers must stop on a mismatch, not re-stamp, or the client's blank map turns wrong.
export function shedGraphMismatch(
  file: ShedFile,
  graphKeyHash: string,
): string | null {
  if (file.keySpace === graphKeyHash) {
    return null;
  } else {
    return (
      `the shed file was placed against key space ${file.keySpace},` +
      ` this graph's is ${graphKeyHash}`
    );
  }
}

// Unread, the blob pipe dies of SIGPIPE upstream, which pipefail turns into a failed daily job.
async function drainStdin(): Promise<void> {
  if (process.stdin.isTTY === true) {
    return;
  }
  for await (const _ of process.stdin) {
  }
}

export async function updateSheds(): Promise<void> {
  const file = await readCurrentFile();
  console.error(
    `  the file reaches ${file.through}: ${listedCount(file).toLocaleString()} listed on` +
      ` ${file.seen}, ${file.records.length.toLocaleString()} permits`,
  );

  // Old keys re-stamped under a new key space would misplace every shed.
  const graph = await loadDeployedGraph();
  if (graph === null) {
    await drainStdin();
    return;
  }
  const mismatch = shedGraphMismatch(file, graph.keyHash);
  if (mismatch !== null) {
    console.error(
      `  ${mismatch}; leaving the file alone. A graph-input change lands as one deploy:` +
        " bun run build-sheds against the new graph, commit, then deploy. This run will pick the" +
        " day up once the site serves the graph the file names.",
    );
    await drainStdin();
    return;
  }

  const { sources, blobs } = await shedSnapshots(
    "update-sheds",
    readCommitsFrom(file.through),
  );
  const walk = startWalk(file);
  await walkSnapshots(walk, sources, blobs);
  const advanced = finishWalk(walk);
  const unplaced = advanced.records.filter((record) =>
    walk.unplaced.has(record.job),
  );
  console.error(
    `  ${unplaced.length} permits are new or re-read, ${advanced.records.length - unplaced.length}` +
      " keep their spans",
  );
  const placements = await placeSheds(graph, unplaced);
  await writeShedFile(DOB_CITY, advanced);
  console.error(
    `sheds: ${listedCount(advanced)} listed on ${advanced.seen} (${unplaced.length} placed,` +
      ` ${placements.filter((placement) => placement.spans.length > 0).length} onto a sidewalk)`,
  );
}

if (import.meta.main) {
  await updateSheds();
}

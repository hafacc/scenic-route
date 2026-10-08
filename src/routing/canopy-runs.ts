// Reads the CRUN artifact from crates/tiler/src/canopy_runs.rs; layout in scripts/README.md.

import { afterControl } from "../sw/control";
import { type Cursor, readUnsignedVarint } from "../tiles/varint";
import type { RoutingGraph } from "./graph";

const MAGIC = "CRUN";
const FORMAT_VERSION = 2;
const HEADER_BYTES = 36;
const DRAWN_FLAG = 0x1; // the run is part of a stretch long enough to draw
const JOINED_FLAG = 0x2; // the gap before the run is drawn too; on an edge's first run, back to its node
const FLAG_BITS = 2;

// Kept as bytes: the layer reads an edge's record when a tile first reaches it.
export interface CanopyRuns {
  graphKeyHash: string; // FNV-1a 64 of the graph's durable key space, as routing/version.json spells it
  edgeCount: number; // the graph's; every record's edge id is checked to be under it
  edgeOrderHash: number; // FNV-1a 32 over the graph's edges' node pairs in order (`edgeOrderHash`)
  bytes: Uint8Array;
  edges: Uint32Array; // each covered edge, ascending
  offsets: Uint32Array; // where its record's sample count starts
}

// Read as two halves so nothing needs BigInt.
function decodeGraphKeyHash(view: DataView): string {
  const low = view.getUint32(16, true);
  const high = view.getUint32(20, true);
  return `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
}

// Records walked between yields; New York's 290,000 would otherwise hold a frame.
const BATCH = 32_768;

const cutShort = (): Error => new Error("canopy-runs file ends mid-record");

// The shared reader runs off the end quietly; here a short file must fail rather than draw garbage.
function varint(bytes: Uint8Array, cursor: Cursor): number {
  if (cursor.offset >= bytes.length) {
    throw cutShort();
  }
  const value = readUnsignedVarint(bytes, cursor);
  if (cursor.offset > bytes.length) {
    throw cutShort();
  }
  return value;
}

// Every count is checked against the bytes: a truncated or stale-CDN file throws, and the layer says so.
function* decodeSteps(buffer: ArrayBuffer): Generator<void, CanopyRuns> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (
    bytes.length < HEADER_BYTES ||
    magic !== MAGIC ||
    view.getUint16(4, true) !== FORMAT_VERSION ||
    view.getUint16(6, true) !== HEADER_BYTES
  ) {
    throw new Error(`not a v${FORMAT_VERSION} canopy-runs file`);
  }
  const edgeCount = view.getUint32(8, true);
  const covered = view.getUint32(12, true);
  // A record is five bytes at the least, so a count the file cannot hold is refused before it allocates.
  if (covered > (bytes.length - HEADER_BYTES) / 5) {
    throw cutShort();
  }
  const edges = new Uint32Array(covered);
  const offsets = new Uint32Array(covered);
  const cursor: Cursor = { offset: HEADER_BYTES };
  let edge = 0;
  let runs = 0;
  for (let record = 0; record < covered; record++) {
    if (record > 0 && record % BATCH === 0) {
      yield;
    }
    const delta = varint(bytes, cursor);
    edge += delta;
    if (edge >= edgeCount || (record > 0 && delta === 0)) {
      throw new Error(`canopy-runs record ${record} names edge ${edge}`);
    }
    edges[record] = edge;
    offsets[record] = cursor.offset;
    const samples = varint(bytes, cursor);
    // Halved by division: a shift would wrap a count past 2^31 into a small or negative one.
    const count = Math.floor(varint(bytes, cursor) / 2);
    if (samples === 0 || count === 0 || count > samples) {
      throw new Error(
        `canopy-runs record ${record} has ${count} runs of ${samples} samples`,
      );
    }
    runs += count;
    // Each run is read, not skipped: one reaching past its edge's samples would draw past the edge.
    let end = 0;
    for (let run = 0; run < count; run++) {
      const start = end + varint(bytes, cursor);
      const length = Math.floor(varint(bytes, cursor) / (1 << FLAG_BITS));
      end = start + length;
      if (length === 0 || end > samples) {
        throw new Error(
          `canopy-runs record ${record} runs to sample ${end} of ${samples}`,
        );
      }
    }
  }
  if (cursor.offset !== bytes.length || runs !== view.getUint32(24, true)) {
    throw new Error(
      "canopy-runs records do not fill the file its header describes",
    );
  }
  return {
    graphKeyHash: decodeGraphKeyHash(view),
    edgeCount,
    edgeOrderHash: view.getUint32(32, true),
    bytes,
    edges,
    offsets,
  };
}

export function decodeCanopyRuns(buffer: ArrayBuffer): CanopyRuns {
  const steps = decodeSteps(buffer);
  for (;;) {
    const step = steps.next();
    if (step.done) {
      return step.value;
    }
  }
}

// The same decode with a macrotask between batches, for the page.
async function decodePaused(buffer: ArrayBuffer): Promise<CanopyRuns> {
  const steps = decodeSteps(buffer);
  for (;;) {
    const step = steps.next();
    if (step.done) {
      return step.value;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve);
    });
  }
}

// What a record's edge index stands on: the edges' node pairs, in order, as the tiler hashed them.
export function edgeOrderHash(
  graph: Pick<RoutingGraph, "edgeCount" | "edgeNodeA" | "edgeNodeB">,
): number {
  let hash = 0x811c9dc5;
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    hash = Math.imul(hash ^ graph.edgeNodeA[edge], 0x01000193);
    hash = Math.imul(hash ^ graph.edgeNodeB[edge], 0x01000193);
  }
  return hash >>> 0;
}

const orderHashes = new WeakMap<object, number>();

// Sampled along one graph's edges by index, so on any other order of them it would paint the wrong paths.
export function sameGraph(graph: RoutingGraph, runs: CanopyRuns): boolean {
  if (
    graph.keyHash !== runs.graphKeyHash ||
    graph.edgeCount !== runs.edgeCount
  ) {
    return false;
  }
  let hash = orderHashes.get(graph);
  if (hash === undefined) {
    hash = edgeOrderHash(graph);
    orderHashes.set(graph, hash);
  }
  return hash === runs.edgeOrderHash;
}

// One covered edge's samples; a run is `count` of them from `start`, under a crown.
export interface EdgeRuns {
  samples: number;
  tailJoined: boolean; // the last run's stretch is drawn on to the edge's end node
  starts: number[];
  counts: number[];
  drawn: boolean[];
  joined: boolean[];
}

export function edgeRuns(runs: CanopyRuns, record: number): EdgeRuns {
  const { bytes } = runs;
  const cursor: Cursor = { offset: runs.offsets[record] };
  const samples = readUnsignedVarint(bytes, cursor);
  const packed = readUnsignedVarint(bytes, cursor);
  const count = Math.floor(packed / 2);
  const edge: EdgeRuns = {
    samples,
    tailJoined: packed % 2 === 1,
    starts: new Array(count),
    counts: new Array(count),
    drawn: new Array(count),
    joined: new Array(count),
  };
  let end = 0;
  for (let run = 0; run < count; run++) {
    const start = end + readUnsignedVarint(bytes, cursor);
    const flagged = readUnsignedVarint(bytes, cursor);
    edge.starts[run] = start;
    edge.counts[run] = flagged >> FLAG_BITS;
    edge.drawn[run] = (flagged & DRAWN_FLAG) !== 0;
    edge.joined[run] = (flagged & JOINED_FLAG) !== 0;
    end = start + edge.counts[run];
  }
  return edge;
}

// What the router's direct-canopy byte is the share of: the samples under a crown.
export function coveredFraction(edge: EdgeRuns): number {
  let covered = 0;
  for (const count of edge.counts) {
    covered += count;
  }
  return covered / edge.samples;
}

// A stretch as a fraction of its edge; an end at 0 or 1 stands on the edge's node.
export interface Stretch {
  t0: number;
  t1: number;
}

// The drawn stretches of an edge: its runs with the gaps the tiler bridged, out to a node it joined through.
export function edgeStretches(edge: EdgeRuns): Stretch[] {
  const stretches: Stretch[] = [];
  const last = edge.starts.length - 1;
  for (let run = 0; run <= last; run++) {
    const opens = run === 0 || !edge.joined[run];
    if (opens && edge.drawn[run]) {
      const from = run === 0 && edge.joined[0] ? 0 : edge.starts[run];
      let end = run;
      while (end < last && edge.joined[end + 1]) {
        end += 1;
      }
      const to =
        end === last && edge.tailJoined
          ? edge.samples
          : edge.starts[end] + edge.counts[end];
      stretches.push({ t0: from / edge.samples, t1: to / edge.samples });
    }
  }
  return stretches;
}

export function canopyRunsUrl(cityId: string): string {
  return `routing/${cityId}.canopy.bin`;
}

const pending = new Map<string, Promise<CanopyRuns>>();

// For runs that turned out to be another graph's, so the next load asks the network again.
export function forgetCanopyRuns(cityId: string): void {
  pending.delete(cityId);
}

// Asked through the service worker like the graph it is keyed to, so both are there offline.
export function loadCanopyRuns(cityId: string): Promise<CanopyRuns> {
  let runs = pending.get(cityId);
  if (!runs) {
    const url = canopyRunsUrl(cityId);
    runs = new Promise<void>(afterControl)
      .then(() => fetch(url))
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`${url}: ${response.status} ${response.statusText}`);
        }
        return decodePaused(await response.arrayBuffer());
      })
      .catch((error: unknown) => {
        pending.delete(cityId); // a failed load must not be memoized
        throw error;
      });
    pending.set(cityId, runs);
  }
  return runs;
}

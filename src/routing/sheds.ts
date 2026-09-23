// Reads the SHED artifact from scripts/shed-encode.ts; layout in scripts/README.md, rationale in DESIGN.md.

import { activeCity, type City } from "../cities";
import { rainTau } from "../shade/phenology";
import { type Cursor, readUnsignedVarint, readVarint } from "../tiles/varint";
import { artifactUrl } from "./artifact-base";
import { durableKey, edgePath, NO_SOURCE_ID, type RoutingGraph } from "./graph";
import {
  SCHEDULE_BUCKETS,
  SCHEDULE_STEP_SECONDS,
  scheduleBucket,
  sunAt,
} from "./shade";

// Unmeasured; DOB requires 8 ft of clearance and typical decks run 12-15 ft.
export const DECK_HEIGHT_METERS = 4;

// The measured feed's median is 3.7 m.
export const DEFAULT_DECK_DEPTH_METERS = 4;

// BC 3307.6.2 and the standard 8 ft frame make this the narrowest buildable deck; less is mismeasured.
export const MIN_DECK_DEPTH_METERS = 2.4;

// The fallback sits at the building line, since the measurement ran from it.
export function measuredDepth(depth: number): number {
  return depth > 0 ? depth : DEFAULT_DECK_DEPTH_METERS;
}

// The extra goes outward, since the curb is only an inset off a centerline while the lot line is evidence.
export function deckDepth(depth: number): number {
  return Math.max(MIN_DECK_DEPTH_METERS, measuredDepth(depth));
}

const MAGIC = "SHED";
const FORMAT_VERSION = 3;
const CLOSED_FLAG = 0x1; // header byte 26, set in closed.bin
const INDEX_ENTRY_BYTES = 8; // u16 month, u32 offset, u16 close day
const FRACTION_SCALE = 255; // a span's t0/t1 are a fraction of its edge; 255 is exactly 1.0
const CONFIDENCE_SCALE = 255; // the byte is capped at 254, as the graph's cover and scenic bytes are
const DEPTH_SCALE = 10; // a span's depth byte is decimeters; 0 means the placement could not measure one
const SIDE_BITS = 3; // a span's packed side-and-ordinal varint, as the graph's kind-and-side byte packs it
const SIDE_MASK = 0x7;
const MILLISECONDS_PER_DAY = 86_400_000;
const EPOCH_MS = Date.UTC(2017, 11, 28); // the first DOB snapshot; every day number counts from here

// The earliest day the map has scaffolding for, as the date picker's "YYYY-MM-DD".
export const SHED_EPOCH_DAY = new Date(EPOCH_MS).toISOString().slice(0, 10);

// Read from `main` over raw.githubusercontent.com (DESIGN.md says why); local in development.
const SHED_MAIN_URL =
  "https://raw.githubusercontent.com/hafacc/scenic-route/main/public/sheds";
const SHED_BASE =
  process.env.NEXT_PUBLIC_SHED_BASE ??
  (process.env.NODE_ENV === "development" ? "sheds" : SHED_MAIN_URL);

export const SHED_URLS = {
  open: `${SHED_BASE}/open.bin`,
  closed: `${SHED_BASE}/closed.bin`,
  index: `${SHED_BASE}/index.bin`,
} as const;

// `edge` is -1 when this graph has no edge by the artifact's durable key.
export interface ShedSpan {
  edge: number;
  t0: number;
  t1: number;
  // Meters across the pavement; 0 where unmeasured, which readers turn into the fallback.
  depth: number;
}

// A permit that came down and went back up is two of these with disjoint intervals.
export interface Shed {
  first: number; // day number of the first day it stood
  close: number | null; // day number of the last, or null while it is still up
  confidence: number; // 0..1, how much to trust the placement (the prototype's confidence column)
  spans: ShedSpan[];
}

// Kept as bytes, since the suffix read walks records per query.
interface ShedFile {
  bytes: Uint8Array;
  count: number;
  spanCount: number;
  firstDay: number; // the day the file's delta chain starts from — the first record's own day
  // Both files end their headers with daily-job state the client skips.
  records: number;
}

export interface ShedHistory {
  graphKeyHash: string; // FNV-1a 64 of the graph's durable key space, as routing/version.json spells it
  lastDay: number; // the newest usable DOB snapshot the artifact was built through
  open: ShedFile;
  closed: ShedFile;
  // Per month with a record: its first day, the first record closing on or after it, and that close day.
  months: Uint16Array;
  offsets: Uint32Array;
  closeDays: Uint16Array;
}

// By local calendar date, since sheds' dates are New York calendar days.
export function shedDay(date: Date): number {
  const midnight = Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  return Math.round((midnight - EPOCH_MS) / MILLISECONDS_PER_DAY);
}

function decodeFile(buffer: ArrayBuffer, closed: boolean): ShedFile {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const version = view.getUint16(4, true);
  if (magic !== MAGIC || version !== FORMAT_VERSION) {
    throw new Error(`not a v${FORMAT_VERSION} shed file`);
  }
  if (((bytes[26] & CLOSED_FLAG) !== 0) !== closed) {
    throw new Error(
      `shed file is ${closed ? "the open" : "the closed"} half, the other was expected`,
    );
  }
  return {
    bytes,
    count: view.getUint32(8, true),
    spanCount: view.getUint32(12, true),
    firstDay: view.getUint16(24, true),
    records: view.getUint16(6, true),
  };
}

// Read as two halves so nothing needs BigInt.
function decodeGraphKeyHash(view: DataView): string {
  const low = view.getUint32(16, true);
  const high = view.getUint32(20, true);
  return `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
}

export function decodeSheds(
  openBuffer: ArrayBuffer,
  closedBuffer: ArrayBuffer,
  indexBuffer: ArrayBuffer,
): ShedHistory {
  const open = decodeFile(openBuffer, false);
  const closed = decodeFile(closedBuffer, true);
  const openHash = decodeGraphKeyHash(new DataView(openBuffer));
  const closedHash = decodeGraphKeyHash(new DataView(closedBuffer));
  if (openHash !== closedHash) {
    throw new Error(
      `shed halves were baked against different key spaces (${openHash}, ${closedHash})`,
    );
  }

  const entries = Math.floor(indexBuffer.byteLength / INDEX_ENTRY_BYTES);
  const view = new DataView(indexBuffer);
  const months = new Uint16Array(entries);
  const offsets = new Uint32Array(entries);
  const closeDays = new Uint16Array(entries);
  for (let entry = 0; entry < entries; entry++) {
    const at = entry * INDEX_ENTRY_BYTES;
    months[entry] = view.getUint16(at, true);
    offsets[entry] = view.getUint32(at + 2, true); // unaligned, which a DataView reads fine
    closeDays[entry] = view.getUint16(at + 6, true);
  }
  const lastDay = new DataView(openBuffer).getUint16(28, true);
  if (lastDay !== new DataView(closedBuffer).getUint16(28, true)) {
    throw new Error("the shed halves were built through different days");
  }
  return {
    graphKeyHash: openHash,
    lastDay,
    open,
    closed,
    months,
    offsets,
    closeDays,
  };
}

// The source-id delta chain restarts every record, or the suffix read would be impossible.
function readSpans(bytes: Uint8Array, cursor: Cursor): ShedSpan[] {
  const count = readUnsignedVarint(bytes, cursor);
  const spans: ShedSpan[] = new Array(count);
  let sourceId = 0;
  for (let span = 0; span < count; span++) {
    sourceId += readUnsignedVarint(bytes, cursor);
    const packed = readUnsignedVarint(bytes, cursor);
    const t0 = bytes[cursor.offset] / FRACTION_SCALE;
    const t1 = bytes[cursor.offset + 1] / FRACTION_SCALE;
    const depth = bytes[cursor.offset + 2] / DEPTH_SCALE;
    cursor.offset += 3;
    spans[span] = {
      edge: durableKey(sourceId, packed & SIDE_MASK, packed >> SIDE_BITS),
      t0,
      t1,
      depth,
    };
  }
  return spans;
}

// In job-number order, so the first-day deltas are signed and every record is walked.
function openOn(file: ShedFile, day: number): Shed[] {
  const standing: Shed[] = [];
  const cursor: Cursor = { offset: file.records };
  let first = file.firstDay;
  for (let record = 0; record < file.count; record++) {
    first += readVarint(file.bytes, cursor);
    const confidence = file.bytes[cursor.offset] / CONFIDENCE_SCALE;
    cursor.offset += 1;
    const spans = readSpans(file.bytes, cursor); // walked either way: it is how the next record is reached
    if (first <= day) {
      standing.push({ first, close: null, confidence, spans });
    }
  }
  return standing;
}

// The index states the close day to re-base from, so the file needn't be replayed.
function seek(
  history: ShedHistory,
  day: number,
): { offset: number; closeDay: number } {
  let low = 0;
  let high = history.months.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (history.months[middle] <= day) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (low === 0) {
    return {
      offset: history.closed.records,
      closeDay: history.closed.firstDay,
    };
  } else {
    return {
      offset: history.offsets[low - 1],
      closeDay: history.closeDays[low - 1],
    };
  }
}

// Records after the seek point are in close-day order, so only a suffix is walked.
function closedOn(history: ShedHistory, day: number): Shed[] {
  const { bytes } = history.closed;
  const start = seek(history, day);
  const cursor: Cursor = { offset: start.offset };
  const standing: Shed[] = [];
  // The record at the seek point has the index's absolute close day; later ones chain from it.
  let close = start.closeDay;
  let chained = false;
  while (cursor.offset < bytes.length) {
    const delta = readUnsignedVarint(bytes, cursor);
    if (chained) {
      close += delta;
    } else {
      chained = true;
    }
    const first = close - readUnsignedVarint(bytes, cursor);
    const confidence = bytes[cursor.offset] / CONFIDENCE_SCALE;
    cursor.offset += 1;
    const spans = readSpans(bytes, cursor); // walked either way: it is how the next record is reached
    if (close >= day && first <= day) {
      standing.push({ first, close, confidence, spans });
    }
  }
  return standing;
}

// An unknown key leaves the span at -1 rather than dropping it; every consumer skips negatives.
function resolveSpans(graph: RoutingGraph, sheds: readonly Shed[]): void {
  const wanted = new Map<number, number>();
  for (const shed of sheds) {
    for (const span of shed.spans) {
      wanted.set(span.edge, -1);
    }
  }
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    const sourceId = graph.edgeSourceId[edge];
    if (sourceId !== NO_SOURCE_ID) {
      const key = durableKey(
        sourceId,
        (graph.edgeKindSide[edge] >> SIDE_BITS) & SIDE_MASK,
        graph.edgeOrdinal[edge],
      );
      if (wanted.has(key)) {
        wanted.set(key, edge);
      }
    }
  }
  for (const shed of sheds) {
    for (const span of shed.spans) {
      span.edge = wanted.get(span.edge) as number;
    }
  }
}

// Gated on the whole key space: single keys can move (2,284 did) and f32 bytes differ by platform.
function sameGraph(graph: RoutingGraph, history: ShedHistory): boolean {
  return graph.keyHash === history.graphKeyHash;
}

// None when placed against a different graph.
export function shedsOn(
  graph: RoutingGraph,
  history: ShedHistory,
  day: number,
): Shed[] {
  if (!sameGraph(graph, history)) {
    return [];
  }
  const standing = [...openOn(history.open, day), ...closedOn(history, day)];
  resolveSpans(graph, standing);
  return standing;
}

export interface EdgeDeck {
  covered: number; // the share of the edge standing under a deck, 0..1
  depth: number; // how deep that deck runs across the pavement, meters; 0 where none was measured
}

// Covered share is clamped; depth is length-weighted over measured spans; confidence weights neither.
export function shedCoverage(
  graph: RoutingGraph,
  history: ShedHistory,
  day: number,
): Map<number, EdgeDeck> {
  const decks = new Map<number, EdgeDeck>();
  const measured = new Map<number, number>(); // the weight behind each depth sum
  for (const shed of shedsOn(graph, history, day)) {
    for (const { edge, t0, t1, depth } of shed.spans) {
      if (edge < 0) {
        continue; // this graph has no edge by that durable name
      }
      const along = t1 - t0;
      const deck = decks.get(edge) ?? { covered: 0, depth: 0 };
      deck.covered += along;
      if (depth > 0) {
        deck.depth += along * depth;
        measured.set(edge, (measured.get(edge) ?? 0) + along);
      }
      decks.set(edge, deck);
    }
  }
  for (const [edge, deck] of decks) {
    // Taken before the clamp so a doubly covered edge isn't thinned.
    const weight = measured.get(edge) ?? 0;
    deck.depth = weight > 0 ? deck.depth / weight : 0;
    deck.covered = Math.min(1, deck.covered);
  }
  return decks;
}

// Coverage stays under 1 or a decked meter could cost nothing and the search would wander.
export interface ShedField {
  coverage: Uint8Array; // per edge, 0-254: the share of it standing under a deck
  depth: Float32Array; // per decked edge, how deep its deck runs across the pavement, meters
  bearing: Float32Array; // per decked edge, the way it runs, in radians clockwise from north
  translate: Float64Array; // per shade-schedule bucket, meters the sun slides a deck's shadow along the ground
  sunAzimuth: Float64Array; // per shade-schedule bucket, where the sun comes from, radians clockwise from north
  rainTau: number; // the share of rain a crown directly overhead keeps off on the day
  maxCoverage: number; // the greatest per-edge coverage, 0..1; an input to the shelter clip floor
}

const COVERAGE_CEILING = 254;
const DEGREES = Math.PI / 180;

// At 0.5° the translate is already 458 m; clamping keeps a sun along the street at 0 instead of NaN.
const MIN_ELEVATION_DEG = 0.5;

// A real shed's fascia, posts and netting still cut oblique light; bites only at a low sun.
export const SHED_OBLIQUE_FLOOR = 0.15;

function quantizeCoverage(fraction: number): number {
  return Math.min(COVERAGE_CEILING, Math.round(fraction * 255));
}

// Length-weighted mean on doubled angles, since a street has no forward end.
function edgeBearing(graph: RoutingGraph, edge: number): number {
  const { lngs, lats } = edgePath(graph, edge);
  let sumSin = 0;
  let sumCos = 0;
  for (let segment = 0; segment + 1 < lngs.length; segment++) {
    const east =
      (lngs[segment + 1] - lngs[segment]) * Math.cos(lats[segment] * DEGREES);
    const north = lats[segment + 1] - lats[segment];
    const length = Math.hypot(east, north);
    const bearing = Math.atan2(east, north);
    sumSin += length * Math.sin(2 * bearing);
    sumCos += length * Math.cos(2 * bearing);
  }
  return Math.atan2(sumSin, sumCos) / 2;
}

// Separate so an hour-slider step re-aims the sun without ~10 ms of rebuilding coverage.
export function setShedSun(
  field: ShedField,
  date: Date,
  // Threaded because the worker never sets the active city.
  forCity: City = activeCity(),
): void {
  for (let bucket = 0; bucket < SCHEDULE_BUCKETS; bucket++) {
    const when = new Date(
      date.getTime() + bucket * SCHEDULE_STEP_SECONDS * 1000,
    );
    const sun = sunAt(when, forCity.center);
    field.translate[bucket] =
      DECK_HEIGHT_METERS /
      Math.tan(Math.max(sun.elevation, MIN_ELEVATION_DEG) * DEGREES);
    field.sunAzimuth[bucket] = sun.azimuth * DEGREES;
  }
}

export function shedField(
  graph: RoutingGraph,
  decks: ReadonlyMap<number, EdgeDeck>,
  date: Date,
  forCity: City = activeCity(),
): ShedField {
  const covered = new Uint8Array(graph.edgeCount);
  const depth = new Float32Array(graph.edgeCount);
  const bearing = new Float32Array(graph.edgeCount);
  let maxByte = 0;
  for (const [edge, deck] of decks) {
    if (edge < graph.edgeCount) {
      covered[edge] = quantizeCoverage(deck.covered);
      depth[edge] = deckDepth(deck.depth);
      bearing[edge] = edgeBearing(graph, edge);
      maxByte = Math.max(maxByte, covered[edge]);
    }
  }

  const field: ShedField = {
    coverage: covered,
    depth,
    bearing,
    translate: new Float64Array(SCHEDULE_BUCKETS),
    sunAzimuth: new Float64Array(SCHEDULE_BUCKETS),
    rainTau: rainTau(date),
    maxCoverage: maxByte / 255,
  };
  setShedSun(field, date, forCity);
  return field;
}

// Lit once the sun's across-street translate exceeds the deck's depth, so along-street sun keeps it shaded.
export function shedShade(
  field: ShedField,
  edge: number,
  elapsedSeconds: number,
): number {
  const covered = field.coverage[edge] / 255;
  if (covered === 0) {
    return 0;
  } else {
    const bucket = scheduleBucket(elapsedSeconds);
    const across =
      field.translate[bucket] *
      Math.abs(Math.sin(field.sunAzimuth[bucket] - field.bearing[edge]));
    return (
      covered * Math.max(SHED_OBLIQUE_FLOOR, 1 - across / field.depth[edge])
    );
  }
}

// Seeds the canopy half first so a failed fetch leaves shelter on trees alone; a stale artifact throws.
export async function computeEdgeSheds(
  graph: RoutingGraph,
  date: Date,
  forCity: City = activeCity(),
): Promise<void> {
  graph.sheds = shedField(graph, new Map(), date, forCity);
  const history = await loadSheds();
  if (!sameGraph(graph, history)) {
    throw new Error(
      `the shed artifact was placed against key space ${history.graphKeyHash}, this graph's is` +
        ` ${graph.keyHash || "unknown"}`,
    );
  }
  graph.sheds = shedField(
    graph,
    shedCoverage(graph, history, shedDay(date)),
    date,
    forCity,
  );
}

let historyPromise: Promise<ShedHistory> | null = null;

async function fetchBuffer(path: string): Promise<ArrayBuffer> {
  const url = artifactUrl(path);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: ${response.status} ${response.statusText}`);
  }
  return response.arrayBuffer();
}

export function loadSheds(): Promise<ShedHistory> {
  if (!historyPromise) {
    historyPromise = Promise.all([
      fetchBuffer(SHED_URLS.open),
      fetchBuffer(SHED_URLS.closed),
      fetchBuffer(SHED_URLS.index),
    ])
      .then(([open, closed, index]) => decodeSheds(open, closed, index))
      .catch((error: unknown) => {
        historyPromise = null; // a failed load must not be memoized
        throw error;
      });
  }
  return historyPromise;
}

// Reads the shed file (src/routing/shed-file.ts); layout in scripts/README.md, rationale in DESIGN.md.

import { activeCity, type City } from "../cities";
import { rainTau } from "../shade/phenology";
import { artifactUrl } from "./artifact-base";
import {
  durableKey,
  edgeDurableKey,
  edgePath,
  type RoutingGraph,
} from "./graph";
import {
  SCHEDULE_BUCKETS,
  SCHEDULE_STEP_SECONDS,
  scheduleBucket,
  sunAt,
} from "./shade";
import { hasSheds } from "./shed-cities";
import {
  CONFIDENCE_SCALE,
  DEPTH_SCALE,
  FRACTION_SCALE,
  parseShedFile,
} from "./shed-file";

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

// The feed drops permits for a few days around a renewal, so a gap this short is one shed.
export const MERGE_TOLERANCE_DAYS = 14;
const MILLISECONDS_PER_DAY = 86_400_000;
const EPOCH_MS = Date.UTC(2026, 2, 2); // the first day the file has, day 0

// The earliest day the map has scaffolding for, as the date picker's "YYYY-MM-DD".
export const SHED_EPOCH_DAY = new Date(EPOCH_MS).toISOString().slice(0, 10);

// Read from `main` over raw.githubusercontent.com (DESIGN.md says why); local in development.
const SHED_MAIN_URL =
  "https://raw.githubusercontent.com/hafacc/scenic-route/main/public/sheds";
const SHED_BASE =
  process.env.NEXT_PUBLIC_SHED_BASE ??
  (process.env.NODE_ENV === "development" ? "sheds" : SHED_MAIN_URL);

// Per city, placed against that city's graph alone.
export function shedUrl(cityId: string): string {
  return `${SHED_BASE}/${cityId}/sheds.tsv`;
}

// `edge` is -1 when this graph has no edge by the file's durable key.
export interface ShedSpan {
  edge: number;
  t0: number;
  t1: number;
  // Meters across the pavement; 0 where unmeasured, which readers turn into the fallback.
  depth: number;
}

// A permit's runs, merged across renewal gaps, as of the day asked about.
export interface Shed {
  first: number; // day number of the first day it stood
  close: number | null; // day number of the last, or null while it is still up
  confidence: number; // 0..1, how much to trust the placement (the prototype's confidence column)
  spans: ShedSpan[];
}

// Spans hold durable keys; a query copies them before resolving edges.
interface ShedJob {
  runs: number[]; // first and last day number of each run, ascending; an open run ends on `seen`
  confidence: number;
  spans: ShedSpan[];
}

export interface ShedHistory {
  graphKeyHash: string; // FNV-1a 64 of the graph's durable key space, as routing/version.json spells it
  seen: number; // the newest usable DOB snapshot the file was built through
  jobs: ShedJob[];
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

function dayOf(iso: string): number {
  return Math.round((Date.parse(iso) - EPOCH_MS) / MILLISECONDS_PER_DAY);
}

export function decodeSheds(text: string): ShedHistory {
  const file = parseShedFile(text);
  const seen = dayOf(file.seen);
  return {
    graphKeyHash: file.keySpace,
    seen,
    jobs: file.records.map((record) => ({
      runs: record.runs.flatMap((run) => [
        dayOf(run.first),
        run.last === null ? seen : dayOf(run.last),
      ]),
      confidence: record.confidence / CONFIDENCE_SCALE,
      spans: record.spans.map((span) => ({
        edge: durableKey(span.sourceId, span.side, span.ordinal),
        t0: span.t0 / FRACTION_SCALE,
        t1: span.t1 / FRACTION_SCALE,
        depth: span.depth / DEPTH_SCALE,
      })),
    })),
  };
}

// The merged stretch of runs holding `day`; the last stays open while a renewal could still extend it.
function standingOn(job: ShedJob, seen: number, day: number): Shed | null {
  const { runs } = job;
  let first = runs[0];
  let last = runs[1];
  for (let run = 2; run <= runs.length; run += 2) {
    if (run < runs.length && runs[run] - last <= MERGE_TOLERANCE_DAYS) {
      last = runs[run + 1];
      continue;
    }
    const close =
      run === runs.length && seen - last < MERGE_TOLERANCE_DAYS ? null : last;
    if (first <= day && (close === null || day <= close)) {
      return {
        first,
        close,
        confidence: job.confidence,
        spans: job.spans.map((span) => ({ ...span })),
      };
    }
    first = runs[run];
    last = runs[run + 1];
  }
  return null;
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
    const key = edgeDurableKey(graph, edge);
    if (wanted.has(key)) {
      wanted.set(key, edge);
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
  const standing: Shed[] = [];
  for (const job of history.jobs) {
    const shed = standingOn(job, history.seen, day);
    if (shed !== null) {
      standing.push(shed);
    }
  }
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
    rainTau: rainTau(date, forCity),
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
  if (!hasSheds(forCity.id)) {
    return;
  }
  const history = await loadSheds(forCity.id);
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

const historyPromises = new Map<string, Promise<ShedHistory>>();

async function fetchText(path: string): Promise<string> {
  const url = artifactUrl(path);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

// Placed against no graph, so every graph reads it as standing nothing.
const NO_SHEDS: ShedHistory = { graphKeyHash: "none", seen: 0, jobs: [] };

// A city with no shed file gets an empty history without a fetch, which would only 404.
export function loadSheds(cityId: string): Promise<ShedHistory> {
  if (!hasSheds(cityId)) {
    return Promise.resolve(NO_SHEDS);
  }
  let history = historyPromises.get(cityId);
  if (!history) {
    history = fetchText(shedUrl(cityId))
      .then(decodeSheds)
      .catch((error: unknown) => {
        historyPromises.delete(cityId); // a failed load must not be memoized
        throw error;
      });
    historyPromises.set(cityId, history);
  }
  return history;
}

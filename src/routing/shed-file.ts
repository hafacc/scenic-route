// The shed file: header lines, a column-name line, then one line per job; layout in scripts/README.md.
// TODO: a binary encoding, once the text's ~540 KB gzipped is worth shrinking.

import { durableKey } from "./graph";

const FORMAT_VERSION = 1;
const FIELD = "\t";
const LINE = "\n";
const RUN_DAYS = "..";

export const FRACTION_SCALE = 255; // a span's t0/t1 are a fraction of its edge; 255 is exactly 1.0
export const CONFIDENCE_SCALE = 255;
export const CONFIDENCE_CEILING = 254; // keeps a client attribute under 1, as the graph's bytes do
export const DEPTH_SCALE = 10; // decimeters; 0 means the placement could not measure one
export const DEPTH_CEILING = 255;

// Keyed by durable key, since a rebuild renumbers every edge id.
export interface ShedFileSpan {
  sourceId: number; // CSCL physicalid, or an OSM way id for a path
  side: number; // N/E/S/W label, 0-4
  ordinal: number; // 0-255
  t0: number; // 0..255
  t1: number; // 0..255
  depth: number; // decimeters, 0 unmeasured
}

export interface ShedRun {
  first: string; // ISO YYYY-MM-DD
  last: string | null; // null while still standing on the file's `seen`
}

// The address and reading are the job's latest; every run shares its one placement.
export interface ShedFileRecord {
  job: string;
  bin: string;
  house: string;
  street: string;
  firstPermit: string; // ISO, "" when the feed gave none
  bbl: string; // "borough/block/lot" from the last row carrying them, "" if none has
  lat: number | null;
  lng: number | null;
  feet: number | null;
  runs: ShedRun[]; // ascending and disjoint, never merged
  confidence: number; // 0..254
  spans: ShedFileSpan[]; // none for an unplaceable shed
}

export interface ShedFile {
  city: string;
  keySpace: string; // the graph key space hash the spans were placed against
  through: string; // the last day judged, kept or dropped as truncated
  seen: string; // the last day kept
  counts: number[]; // row counts of the last judged days, the truncation window
  records: ShedFileRecord[]; // in job order
}

const COLUMNS = [
  "job",
  "bin",
  "house",
  "street",
  "first_permit",
  "bbl",
  "lat",
  "lng",
  "feet",
  "runs",
  "confidence",
  "spans",
] as const;
type Column = (typeof COLUMNS)[number];

export function spanKey(span: ShedFileSpan): number {
  return durableKey(span.sourceId, span.side, span.ordinal);
}

export function byJob(left: { job: string }, right: { job: string }): number {
  return left.job < right.job ? -1 : left.job > right.job ? 1 : 0;
}

function cell(value: string): string {
  if (value.includes(FIELD) || value.includes(LINE)) {
    throw new Error(
      `${JSON.stringify(value)} would break the shed file's lines`,
    );
  }
  return value;
}

function numberCell(value: number | null): string {
  return value === null ? "" : String(value);
}

function numberOf(text: string): number | null {
  return text === "" ? null : Number(text);
}

function runsCell(runs: readonly ShedRun[]): string {
  return runs
    .map((run) => `${run.first}${RUN_DAYS}${run.last ?? ""}`)
    .join(",");
}

function spansCell(spans: readonly ShedFileSpan[]): string {
  return [...spans]
    .sort((left, right) => spanKey(left) - spanKey(right))
    .map(
      (span) =>
        `${span.sourceId}:${span.side}:${span.ordinal}:${span.t0}:${span.t1}:${span.depth}`,
    )
    .join(" ");
}

export function serializeShedFile(file: ShedFile): string {
  const lines = [
    `version${FIELD}${FORMAT_VERSION}`,
    `city${FIELD}${cell(file.city)}`,
    `keySpace${FIELD}${cell(file.keySpace)}`,
    `through${FIELD}${cell(file.through)}`,
    `seen${FIELD}${cell(file.seen)}`,
    `counts${FIELD}${file.counts.join(",")}`,
    COLUMNS.join(FIELD),
  ];
  for (const record of file.records) {
    const fields: Record<Column, string> = {
      job: cell(record.job),
      bin: cell(record.bin),
      house: cell(record.house),
      street: cell(record.street),
      first_permit: cell(record.firstPermit),
      bbl: cell(record.bbl),
      lat: numberCell(record.lat),
      lng: numberCell(record.lng),
      feet: numberCell(record.feet),
      runs: runsCell(record.runs),
      confidence: String(record.confidence),
      spans: spansCell(record.spans),
    };
    lines.push(COLUMNS.map((column) => fields[column]).join(FIELD));
  }
  return `${lines.join(LINE)}${LINE}`;
}

function parseRuns(text: string): ShedRun[] {
  return text.split(",").map((run) => {
    const [first, last] = run.split(RUN_DAYS);
    return { first, last: last === "" ? null : last };
  });
}

function parseSpans(text: string): ShedFileSpan[] {
  if (text === "") {
    return [];
  }
  return text.split(" ").map((span) => {
    const [sourceId, side, ordinal, t0, t1, depth] = span
      .split(":")
      .map(Number);
    return { sourceId, side, ordinal, t0, t1, depth };
  });
}

// Columns by name, so one can be added without breaking an older reader.
export function parseShedFile(text: string): ShedFile {
  const lines = text.split(LINE);
  const header = new Map<string, string>();
  let at = 0;
  // The column-name line is the first to name a job column; no header line does.
  while (at < lines.length && !lines[at].split(FIELD).includes("job")) {
    const [name, value] = lines[at].split(FIELD);
    header.set(name, value ?? "");
    at += 1;
  }
  if (header.get("version") !== String(FORMAT_VERSION)) {
    throw new Error(
      `not a v${FORMAT_VERSION} shed file (version ${header.get("version")})`,
    );
  }
  const names = (lines[at] ?? "").split(FIELD);
  const index = {} as Record<Column, number>;
  for (const column of COLUMNS) {
    index[column] = names.indexOf(column);
    if (index[column] < 0) {
      throw new Error(`the shed file has no ${column} column`);
    }
  }
  const records: ShedFileRecord[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line === "") {
      continue;
    }
    const fields = line.split(FIELD);
    const field = (column: Column): string => fields[index[column]];
    records.push({
      job: field("job"),
      bin: field("bin"),
      house: field("house"),
      street: field("street"),
      firstPermit: field("first_permit"),
      bbl: field("bbl"),
      lat: numberOf(field("lat")),
      lng: numberOf(field("lng")),
      feet: numberOf(field("feet")),
      runs: parseRuns(field("runs")),
      confidence: Number(field("confidence")),
      spans: parseSpans(field("spans")),
    });
  }
  const counts = header.get("counts") ?? "";
  return {
    city: header.get("city") ?? "",
    keySpace: header.get("keySpace") ?? "",
    through: header.get("through") ?? "",
    seen: header.get("seen") ?? "",
    counts: counts === "" ? [] : counts.split(",").map(Number),
    records,
  };
}

// NYCDOB/ActiveShedPermits commits one CSV snapshot of active shed permits most days since 2017.
// The git plumbing that streams the blobs in lives in package.json.

import { readFile } from "node:fs/promises";

// The DOB corrects geocodes for years after a shed is gone, so an interval keeps its final reading.
export interface ShedAttributes {
  bin: string;
  street: string;
  linearFeet: number; // NaN when the feed carries none
  lat: number | null;
  lng: number | null;
  boroughDigit: string; // Borough Digit / Block / Lot: the last non-blank ones given
  block: string;
  lot: string;
}

export interface ShedPermit extends ShedAttributes {
  job: string;
  houseNumber: string;
  runs: ShedInterval[]; // ascending and disjoint
  intervals: ShedInterval[]; // runs with renewal gaps merged
  // The daily job places only unseen permits, so this is how it hears of a corrected one.
  corrected: boolean;
}

export interface ShedInterval {
  first: string; // ISO YYYY-MM-DD
  last: string;
  open: boolean; // still standing in the newest snapshot
  attributes: ShedAttributes; // as of `last`
}

// The feed drops permits for a few days around a renewal.
export const MERGE_TOLERANCE_DAYS = 14;
// Degraded writes come in multi-week runs; backward-only, so a day's verdict is final once made.
// Also the reorder depth that collapses a day's several commits into one snapshot.
export const TRUNCATION_NEIGHBORS = 30;
const TRUNCATION_RATIO = 0.75;
// A run re-reads the last MERGE_TOLERANCE_DAYS, so its window must be seeded from further back.
const JUDGED_TAIL = TRUNCATION_NEIGHBORS + MERGE_TOLERANCE_DAYS;
const PROGRESS_INTERVAL = 500;
const DAY_MS = 86_400_000;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const QUOTE = 0x22;
const COMMA = 0x2c;

type Column =
  | "job"
  | "bin"
  | "street"
  | "houseNumber"
  | "linearFeet"
  | "lat"
  | "lng"
  | "boroughDigit"
  | "block"
  | "lot"
  | "currentDate";

// By name, not position: the feed has shipped seven headers, adding and reordering columns.
const COLUMNS: Record<Column, readonly string[]> = {
  job: ["job number", "job_number", "job #", "job"],
  bin: ["bin number", "bin_number", "bin"],
  street: ["street name", "street_name", "street"],
  houseNumber: ["house number", "house_number", "house #"],
  linearFeet: [
    "sidewalk shed/linear feet",
    "sidewalk shed linear feet",
    "linear feet",
  ],
  lat: ["latitude point", "latitude", "latitude_point"],
  lng: ["longitude point", "longitude", "longitude_point"],
  boroughDigit: ["borough digit", "borough_digit", "boro digit"],
  block: ["block"],
  lot: ["lot"],
  currentDate: ["current date", "current_date"],
};

type ColumnIndex = Record<Column, number>;

// Slices of their own line, so a kept row pins a few hundred bytes, not the whole snapshot.
export interface SnapshotRow {
  bin: string;
  street: string;
  houseNumber: string;
  linearFeet: string;
  lat: string;
  lng: string;
  boroughDigit: string;
  block: string;
  lot: string;
}

interface ParsedSnapshot {
  csvDate: string | null;
  rows: Map<string, SnapshotRow>;
}

export interface DatedSnapshot {
  date: string;
  rows: Map<string, SnapshotRow>;
}

function clean(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('"') && !trimmed.endsWith('"')) {
    return trimmed;
  } else {
    return trimmed.replace(/^"+|"+$/g, "").trim();
  }
}

// The feed started suffixing BIS job numbers with "(BIS)" in 2018; it is the same job.
function normalizeJob(job: string): string {
  return job.replace(/\(BIS\)$/i, "").trim();
}

function isoDate(year: number, month: number, day: number): string | null {
  const stamp = new Date(Date.UTC(year, month - 1, day));
  if (
    stamp.getUTCFullYear() !== year ||
    stamp.getUTCMonth() !== month - 1 ||
    stamp.getUTCDate() !== day
  ) {
    return null;
  } else {
    return stamp.toISOString().slice(0, 10);
  }
}

// The feed has written YYYY-MM-DD, M/D/YYYY and M/D/YY, sometimes with a trailing time.
function parseSnapshotDate(raw: string): string | null {
  const text = clean(raw);
  const dashed = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
  const shortYear = /^(\d{1,2})\/(\d{1,2})\/(\d{2})(?!\d)/.exec(text);
  if (dashed) {
    return isoDate(Number(dashed[1]), Number(dashed[2]), Number(dashed[3]));
  } else if (slashed) {
    return isoDate(Number(slashed[3]), Number(slashed[1]), Number(slashed[2]));
  } else if (shortYear) {
    const twoDigit = Number(shortYear[3]);
    const year = twoDigit < 69 ? 2000 + twoDigit : 1900 + twoDigit;
    return isoDate(year, Number(shortYear[1]), Number(shortYear[2]));
  } else {
    return null;
  }
}

export function daysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / DAY_MS;
}

function shiftDay(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

// A shed last seen before this can no longer be extended by anything the feed publishes next.
export function resumeFrom(lastDay: string): string {
  return shiftDay(lastDay, 1 - MERGE_TOLERANCE_DAYS);
}

// The feed may write thousands separators.
function toNumber(raw: string): number {
  if (raw === "") {
    return Number.NaN;
  } else {
    return Number(raw.replace(/,/g, ""));
  }
}

function toCoordinate(raw: string): number | null {
  const value = toNumber(raw);
  return Number.isNaN(value) ? null : value;
}

function resolveHeader(header: readonly string[]): ColumnIndex {
  const byName = new Map<string, number>();
  for (const [index, name] of header.entries()) {
    // trim() also drops the BOM off the first name.
    byName.set(name.trim().toLowerCase(), index);
  }
  const columns: ColumnIndex = {
    job: -1,
    bin: -1,
    street: -1,
    houseNumber: -1,
    linearFeet: -1,
    lat: -1,
    lng: -1,
    boroughDigit: -1,
    block: -1,
    lot: -1,
    currentDate: -1,
  };
  const wanted = Object.entries(COLUMNS) as [Column, readonly string[]][];
  for (const [column, candidates] of wanted) {
    for (const candidate of candidates) {
      const index = byName.get(candidate);
      if (index !== undefined) {
        columns[column] = index;
        break;
      }
    }
  }
  return columns;
}

// Reused per record; offsets so only the columns read become strings. Quoted lines arrive split.
interface CsvRecord {
  line: string;
  starts: number[]; // each field's offset, then one past the end of the line
  fields: string[] | null;
  next: number;
}

function field(record: CsvRecord, index: number): string {
  if (index < 0) {
    return "";
  } else if (record.fields !== null) {
    return index < record.fields.length ? clean(record.fields[index]) : "";
  } else if (index + 1 < record.starts.length) {
    const from = record.starts[index];
    return clean(record.line.slice(from, record.starts[index + 1] - 1));
  } else {
    return "";
  }
}

// Every field of a record, which only the header needs.
function recordFields(record: CsvRecord): string[] {
  if (record.fields !== null) {
    return record.fields;
  } else {
    return record.line.split(",");
  }
}

function splitQuotedRecord(text: string): string[] {
  const fields: string[] = [];
  let value = "";
  let quoted = false;
  let atFieldStart = true;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') {
        value += char;
      } else if (text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = false;
      }
    } else if (char === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
    } else if (char === ",") {
      fields.push(value);
      value = "";
      atFieldStart = true;
    } else {
      value += char;
      atFieldStart = false;
    }
  }
  fields.push(value);
  return fields;
}

function findRecordEnd(bytes: Uint8Array, start: number): number {
  let quoted = false;
  let atFieldStart = true;
  for (let index = start; index < bytes.length; index++) {
    const byte = bytes[index];
    if (quoted) {
      if (byte === QUOTE) {
        if (bytes[index + 1] === QUOTE) {
          index += 1;
        } else {
          quoted = false;
        }
      }
    } else if (byte === QUOTE && atFieldStart) {
      quoted = true;
      atFieldStart = false;
    } else if (byte === COMMA) {
      atFieldStart = true;
    } else if (byte === NEWLINE) {
      return index;
    } else {
      atFieldStart = false;
    }
  }
  return bytes.length;
}

// A line at a time, so a kept field views its ~200 byte line, not the 2 MB snapshot text.
function readRecord(
  bytes: Uint8Array,
  start: number,
  decoder: TextDecoder,
  record: CsvRecord,
): void {
  let stop = bytes.indexOf(NEWLINE, start);
  if (stop === -1) {
    stop = bytes.length;
  }
  const end =
    stop > start && bytes[stop - 1] === CARRIAGE_RETURN ? stop - 1 : stop;
  const line = decoder.decode(bytes.subarray(start, end));
  record.starts.length = 0;
  if (line.includes('"')) {
    const recordEnd = findRecordEnd(bytes, start);
    record.line = "";
    record.fields = splitQuotedRecord(
      decoder.decode(bytes.subarray(start, recordEnd)),
    );
    record.next = recordEnd + 1;
  } else {
    record.line = line;
    record.fields = null;
    record.next = stop + 1;
    for (let from = 0; ; ) {
      record.starts.push(from);
      const comma = line.indexOf(",", from);
      if (comma === -1) {
        break;
      }
      from = comma + 1;
    }
    record.starts.push(line.length + 1);
  }
}

// Dated by majority, so a handful of stale rows can't misfile the day.
function parseSnapshot(bytes: Uint8Array): ParsedSnapshot {
  const rows = new Map<string, SnapshotRow>();
  const decoder = new TextDecoder();
  if (bytes.length === 0) {
    return { csvDate: null, rows };
  }
  const record: CsvRecord = { line: "", starts: [], fields: null, next: 0 };
  readRecord(bytes, 0, decoder, record);
  const header = recordFields(record);
  const columns = resolveHeader(header);
  if (columns.job < 0) {
    throw new Error(`no job column in header: ${header.slice(0, 5).join(",")}`);
  }
  const votes = new Map<string, number>();
  // Nearly every row repeats the same Current Date.
  let lastRaw = "";
  let lastDate: string | null = null;
  let cursor = record.next;
  while (cursor < bytes.length) {
    readRecord(bytes, cursor, decoder, record);
    cursor = record.next;
    const job = normalizeJob(field(record, columns.job));
    if (job === "") {
      continue;
    }
    rows.set(job, {
      bin: field(record, columns.bin),
      street: field(record, columns.street),
      houseNumber: field(record, columns.houseNumber),
      linearFeet: field(record, columns.linearFeet),
      lat: field(record, columns.lat),
      lng: field(record, columns.lng),
      boroughDigit: field(record, columns.boroughDigit),
      block: field(record, columns.block),
      lot: field(record, columns.lot),
    });
    const raw = field(record, columns.currentDate);
    if (raw !== lastRaw) {
      lastRaw = raw;
      lastDate = parseSnapshotDate(raw);
    }
    if (lastDate !== null) {
      votes.set(lastDate, (votes.get(lastDate) ?? 0) + 1);
    }
  }
  let csvDate: string | null = null;
  let best = 0;
  for (const [stamp, count] of votes) {
    if (count > best) {
      csvDate = stamp;
      best = count;
    }
  }
  return { csvDate, rows };
}

export interface SnapshotSource {
  blob: string;
  commitDate: string; // UTC; the fallback when the CSV carries no date
}

// A commit is read from the first path it carries: 747 carry both the old and the new location.
// `readFrom` cuts at the first commit reaching the day, since commit stamps aren't monotonic.
export function readSnapshotIndex(
  text: string,
  readFrom?: string,
): SnapshotSource[] {
  const sources: SnapshotSource[] = [];
  let taken = "";
  for (const line of text.split("\n")) {
    const [blob, kind, commit, seconds] = line.split(" ");
    if (kind !== "blob") {
      // "missing" is a path the commit does not carry; the file ends with an empty line.
      if (kind !== "missing" && line !== "") {
        throw new Error(`git cat-file --batch-check answered "${line}"`);
      }
    } else if (commit !== taken) {
      const stamp = new Date(Number(seconds) * 1000);
      if (Number.isNaN(stamp.getTime())) {
        throw new Error(`git cat-file --batch-check answered "${line}"`);
      }
      taken = commit;
      sources.push({ blob, commitDate: stamp.toISOString().slice(0, 10) });
    }
  }
  if (readFrom === undefined) {
    return sources;
  }
  const pivot = sources.findIndex((source) => source.commitDate >= readFrom);
  return pivot === -1 ? [] : sources.slice(pivot);
}

export async function loadSnapshotIndex(
  path: string,
  readFrom?: string,
): Promise<SnapshotSource[]> {
  return readSnapshotIndex(await readFile(path, "utf-8"), readFrom);
}

// `readFrom` must match the day package.json handed scripts/shed-blobs.ts, or it waits on a blob.
export async function shedSnapshots(
  script: string,
  readFrom?: string,
): Promise<{
  sources: SnapshotSource[];
  blobs: AsyncIterable<Uint8Array>;
}> {
  const index = process.argv[2];
  if (index === undefined || process.stdin.isTTY === true) {
    throw new Error(
      `${script} reads the DOB snapshots off a git pipeline: run \`bun run ${script}\`, which is` +
        " where package.json clones the feed, resolves the commit index and streams the blobs",
    );
  }
  return {
    sources: await loadSnapshotIndex(index, readFrom),
    blobs: process.stdin,
  };
}

// Distinct: the feed often recommits an unchanged CSV, so this is 4.6 GB down the pipe, not 7.5.
export function distinctBlobs(sources: readonly SnapshotSource[]): string[] {
  const blobs: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!seen.has(source.blob)) {
      seen.add(source.blob);
      blobs.push(source.blob);
    }
  }
  return blobs;
}

// Each blob reuses one buffer, valid until the next. Shas are checked because a pipeline's status is
// its last command's, so git dying halfway would otherwise look like a history that just stopped.
async function* readBlobs(
  stream: AsyncIterable<Uint8Array>,
  blobs: readonly string[],
): AsyncGenerator<Uint8Array> {
  const chunks: AsyncIterator<Uint8Array> = stream[Symbol.asyncIterator]();
  const queue: Uint8Array[] = [];
  let queued = 0;
  let read = 0;

  async function pull(): Promise<void> {
    const next = await chunks.next();
    if (next.done === true) {
      throw new Error(
        `the snapshot stream ended after ${read}/${blobs.length} blobs:` +
          " `git cat-file --batch` did not write the history out",
      );
    }
    queue.push(next.value);
    queued += next.value.length;
  }

  // A null `into` discards.
  function take(size: number, into: Uint8Array | null): void {
    let filled = 0;
    while (filled < size) {
      const head = queue[0];
      const wanted = Math.min(head.length, size - filled);
      if (into !== null) {
        into.set(head.subarray(0, wanted), filled);
      }
      if (wanted === head.length) {
        queue.shift();
      } else {
        queue[0] = head.subarray(wanted);
      }
      filled += wanted;
    }
    queued -= size;
  }

  const decoder = new TextDecoder();
  let buffer = new Uint8Array(0);
  for (let index = 0; index < blobs.length; index++) {
    let lineEnd = -1;
    while (lineEnd === -1) {
      let scanned = 0;
      for (const chunk of queue) {
        const at = chunk.indexOf(NEWLINE);
        if (at !== -1) {
          lineEnd = scanned + at;
          break;
        }
        scanned += chunk.length;
      }
      if (lineEnd === -1) {
        await pull();
      }
    }
    const header = new Uint8Array(lineEnd);
    take(lineEnd, header);
    take(1, null);
    const line = decoder.decode(header);
    const [sha, kind, bytes] = line.split(" ");
    const size = Number(bytes);
    if (sha !== blobs[index] || kind !== "blob" || !Number.isFinite(size)) {
      throw new Error(
        `git cat-file --batch answered "${line}" where blob ${blobs[index]} was asked for`,
      );
    }
    while (queued < size + 1) {
      await pull();
    }
    if (buffer.length < size) {
      buffer = new Uint8Array(size);
    }
    take(size, buffer);
    take(1, null);
    read += 1;
    yield buffer.subarray(0, size);
  }
}

interface OpenRun {
  first: string;
  last: string;
}

interface RunTracker {
  order: string[]; // by first mention
  open: Map<string, OpenRun>;
  closed: Map<string, ShedInterval[]>;
  // Replaced only on change, so intervals share the object exactly when they place the same way.
  attributes: Map<string, ShedAttributes>;
  houseNumbers: Map<string, string>;
  located: Map<string, SnapshotRow>; // the last row that gave the job a block and lot
  corrected: Set<string>;
}

function closeRun(
  tracker: RunTracker,
  job: string,
  run: OpenRun,
  open: boolean,
): void {
  const intervals = tracker.closed.get(job);
  const interval: ShedInterval = {
    first: run.first,
    last: run.last,
    open,
    attributes: tracker.attributes.get(job)!,
  };
  if (intervals === undefined) {
    tracker.closed.set(job, [interval]);
  } else {
    intervals.push(interval);
  }
}

// Block and lot from the last row carrying them, so a blank day isn't a change of address.
function attributesOf(
  row: SnapshotRow,
  located: SnapshotRow | undefined,
): ShedAttributes {
  return {
    bin: row.bin,
    street: row.street,
    linearFeet: toNumber(row.linearFeet),
    lat: toCoordinate(row.lat),
    lng: toCoordinate(row.lng),
    boroughDigit: located?.boroughDigit ?? "",
    block: located?.block ?? "",
    lot: located?.lot ?? "",
  };
}

// `Object.is`, so a NaN length compares equal to itself.
function sameAttributes(left: ShedAttributes, right: ShedAttributes): boolean {
  return (
    left.bin === right.bin &&
    left.street === right.street &&
    Object.is(left.linearFeet, right.linearFeet) &&
    left.lat === right.lat &&
    left.lng === right.lng &&
    left.boroughDigit === right.boroughDigit &&
    left.block === right.block &&
    left.lot === right.lot
  );
}

function applySnapshot(tracker: RunTracker, snapshot: DatedSnapshot): void {
  for (const [job, row] of snapshot.rows) {
    if (row.block !== "" && row.lot !== "") {
      tracker.located.set(job, row);
    }
    tracker.houseNumbers.set(job, row.houseNumber);
    const attributes = attributesOf(row, tracker.located.get(job));
    const previous = tracker.attributes.get(job);
    if (previous === undefined) {
      tracker.order.push(job);
      tracker.attributes.set(job, attributes);
    } else if (!sameAttributes(previous, attributes)) {
      tracker.attributes.set(job, attributes);
      tracker.corrected.add(job);
    }
    const run = tracker.open.get(job);
    if (run === undefined) {
      tracker.open.set(job, { first: snapshot.date, last: snapshot.date });
    } else {
      run.last = snapshot.date;
    }
  }
  for (const [job, run] of tracker.open) {
    if (!snapshot.rows.has(job)) {
      tracker.open.delete(job);
      closeRun(tracker, job, run, false);
    }
  }
}

// The later run's attributes and open flag win.
export function mergeIntervals(
  intervals: readonly ShedInterval[],
): ShedInterval[] {
  if (intervals.length === 0) {
    // A kept permit whose only sighting a later walk judged a truncated snapshot.
    return [];
  }
  const merged: ShedInterval[] = [];
  let current = intervals[0];
  for (const next of intervals.slice(1)) {
    if (daysBetween(current.last, next.first) <= MERGE_TOLERANCE_DAYS) {
      current = {
        first: current.first,
        last: next.last,
        open: next.open,
        attributes: next.attributes,
      };
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  return merged;
}

interface SnapshotWindow {
  pending: DatedSnapshot[];
  before: number[]; // row counts of the most recently judged days
  judged: string; // a snapshot for this day or earlier is too late
  seed: readonly number[]; // the counts this walk was handed
  tail: DayCount[];
  kept: number;
  dropped: number;
  stale: number;
  firstDate: string;
  lastDate: string;
}

export interface DayCount {
  date: string;
  rows: number;
}

function judgeSnapshot(
  window: SnapshotWindow,
  emit: (snapshot: DatedSnapshot) => void,
): void {
  const snapshot = window.pending[0];
  const neighbors = window.before.slice();
  neighbors.sort((left, right) => left - right);
  const median =
    neighbors.length === 0 ? 0 : neighbors[Math.floor(neighbors.length / 2)];
  if (median !== 0 && snapshot.rows.size < TRUNCATION_RATIO * median) {
    window.dropped += 1;
  } else {
    if (window.kept === 0) {
      window.firstDate = snapshot.date;
    }
    window.lastDate = snapshot.date;
    window.kept += 1;
    emit(snapshot);
  }
  // Dropped days count too, or the window would depend on its own earlier verdicts.
  window.judged = snapshot.date;
  window.pending.shift();
  window.before.push(snapshot.rows.size);
  if (window.before.length > TRUNCATION_NEIGHBORS) {
    window.before.shift();
  }
  window.tail.push({ date: snapshot.date, rows: snapshot.rows.size });
  if (window.tail.length > JUDGED_TAIL) {
    window.tail.shift();
  }
}

// A later commit for a pending day replaces it.
function acceptSnapshot(
  window: SnapshotWindow,
  snapshot: DatedSnapshot,
  emit: (snapshot: DatedSnapshot) => void,
): void {
  if (snapshot.date <= window.judged) {
    window.stale += 1;
    return;
  }
  let index = window.pending.length - 1;
  while (index >= 0 && window.pending[index].date > snapshot.date) {
    index -= 1;
  }
  if (index >= 0 && window.pending[index].date === snapshot.date) {
    window.pending[index] = snapshot;
  } else {
    window.pending.splice(index + 1, 0, snapshot);
  }
  while (window.pending.length > TRUNCATION_NEIGHBORS) {
    judgeSnapshot(window, emit);
  }
}

export interface ShedWalk {
  permits: ShedPermit[];
  lastDay: string; // the newest usable snapshot
  counts: number[]; // the window seed for a walk resuming at `resumeFrom(lastDay)`
}

export interface ShedFold {
  tracker: RunTracker;
  window: SnapshotWindow;
  applyFrom: string; // "" reads the whole history
}

// `before` seeds the window so the first day sees the neighbors a full-history walk would.
export function startFold(
  applyFrom = "",
  before: readonly number[] = [],
): ShedFold {
  return {
    tracker: {
      order: [],
      open: new Map(),
      closed: new Map(),
      attributes: new Map(),
      houseNumbers: new Map(),
      located: new Map(),
      corrected: new Set(),
    },
    window: {
      pending: [],
      before: [...before],
      judged: "",
      seed: before,
      tail: [],
      kept: 0,
      dropped: 0,
      stale: 0,
      firstDate: "",
      lastDate: "",
    },
    applyFrom,
  };
}

// An earlier snapshot would push its count onto a window already seeded past it.
export function foldSnapshot(fold: ShedFold, snapshot: DatedSnapshot): void {
  if (snapshot.date < fold.applyFrom) {
    fold.window.stale += 1;
    return;
  }
  acceptSnapshot(fold.window, snapshot, (dated) => {
    applySnapshot(fold.tracker, dated);
  });
}

export function finishFold(fold: ShedFold): ShedWalk {
  const { tracker, window } = fold;
  while (window.pending.length > 0) {
    judgeSnapshot(window, (dated) => {
      applySnapshot(tracker, dated);
    });
  }
  for (const [job, run] of tracker.open) {
    closeRun(tracker, job, run, true);
  }
  const permits: ShedPermit[] = [];
  for (const job of tracker.order) {
    const runs = tracker.closed.get(job)!;
    permits.push({
      ...tracker.attributes.get(job)!,
      job,
      houseNumber: tracker.houseNumbers.get(job)!,
      runs,
      intervals: mergeIntervals(runs),
      corrected: tracker.corrected.has(job),
    });
  }
  // The counts from before the day the next walk starts, since it re-judges the overlap.
  const resume = window.lastDate === "" ? "" : resumeFrom(window.lastDate);
  const counts = [
    ...window.seed,
    ...window.tail
      .filter((judged) => judged.date < resume)
      .map((judged) => judged.rows),
  ].slice(-TRUNCATION_NEIGHBORS);
  // The snapshot's day, not the run's, so a quiet feed resumes from its last real day.
  return { permits, lastDay: window.lastDate, counts };
}

// The stream must answer `sources` in order, once per distinct blob.
export async function readShedPermits(
  sources: readonly SnapshotSource[],
  stream: AsyncIterable<Uint8Array>,
  applyFrom?: string,
  before: readonly number[] = [],
): Promise<ShedWalk> {
  if (sources.length === 0) {
    // A pipeline exits with its last command's status, so upstream failures surface here.
    throw new Error(
      "the commit index names no DOB snapshot at all: the git half of the pipeline resolved" +
        " nothing, so there is no history to walk",
    );
  }
  const blobOrder = distinctBlobs(sources);
  const lastUse = new Map<string, number>();
  for (const [position, source] of sources.entries()) {
    lastUse.set(source.blob, position);
  }
  console.error(
    `  ${sources.length} commits carry a snapshot, ${blobOrder.length} distinct blobs`,
  );

  const fold = startFold(applyFrom, before);
  // Held only while a later commit still points at it.
  const parsed = new Map<string, ParsedSnapshot>();
  const blobs = readBlobs(stream, blobOrder);
  for (const [position, source] of sources.entries()) {
    const cached = parsed.get(source.blob);
    let snapshot: ParsedSnapshot;
    if (cached !== undefined) {
      snapshot = cached;
      if (lastUse.get(source.blob) === position) {
        parsed.delete(source.blob);
      }
    } else {
      const next = await blobs.next();
      if (next.done === true) {
        throw new Error(`git cat-file --batch stopped at blob ${source.blob}`);
      }
      snapshot = parseSnapshot(next.value);
      if (lastUse.get(source.blob) !== position) {
        parsed.set(source.blob, snapshot);
      }
    }
    if (snapshot.rows.size > 0) {
      foldSnapshot(fold, {
        date: snapshot.csvDate ?? source.commitDate,
        rows: snapshot.rows,
      });
    }
    if ((position + 1) % PROGRESS_INTERVAL === 0) {
      console.error(
        `  read ${position + 1}/${sources.length} snapshots, ${fold.tracker.open.size} sheds standing on ${fold.window.lastDate}`,
      );
    }
  }
  const walk = finishFold(fold);
  const { window } = fold;
  console.error(
    `  ${window.kept} usable dated snapshots ${window.firstDate}..${window.lastDate}` +
      ` (${window.dropped} truncated dropped, ${window.stale} stale)`,
  );
  return walk;
}

if (import.meta.main) {
  const started = performance.now();
  const { sources, blobs } = await shedSnapshots("shed-walk");
  const { permits } = await readShedPermits(sources, blobs);
  let intervals = 0;
  let open = 0;
  for (const permit of permits) {
    intervals += permit.intervals.length;
    open += permit.intervals.filter((interval) => interval.open).length;
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.error(
    `sheds: ${permits.length} permits, ${intervals} intervals, ${open} standing today, in ${seconds}s`,
  );
}

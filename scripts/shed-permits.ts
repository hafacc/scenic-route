// NYCDOB/ActiveShedPermits commits one CSV snapshot of active shed permits most days.
// The git plumbing that streams the blobs in lives in package.json.

import { readFile } from "node:fs/promises";
import type { ShedFile, ShedFileRecord } from "../src/routing/shed-file";
import { byJob } from "../src/routing/shed-file";

// Degraded writes come in multi-week runs; backward-only, so a day's verdict is final once made.
export const TRUNCATION_NEIGHBORS = 30;
const TRUNCATION_RATIO = 0.75;
const PROGRESS_INTERVAL = 50;
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
  | "firstPermitDate"
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
  firstPermitDate: ["first permit date", "first_permit_date"],
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
  firstPermitDate: string;
}

// A row whose job number the feed overwrote with another column's value.
export interface GarbledRow {
  job: string;
  row: SnapshotRow;
}

interface ParsedSnapshot {
  csvDate: string | null;
  rows: Map<string, SnapshotRow>;
  garbled: GarbledRow[];
}

export interface DatedSnapshot {
  date: string;
  rows: Map<string, SnapshotRow>;
  garbled: readonly GarbledRow[];
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

// DOB job numbers come in two shapes: nine-digit BIS, and DOB NOW ("M12345678-I1").
const JOB_NUMBER = /^(\d{9}|[BMQSX]\d{8}-[A-Z]\d)$/;

// The feed may write thousands separators; blank or unreadable is null.
function toNumber(raw: string): number | null {
  const value = raw === "" ? Number.NaN : Number(raw.replace(/,/g, ""));
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
    firstPermitDate: -1,
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
  const garbled: GarbledRow[] = [];
  const decoder = new TextDecoder();
  if (bytes.length === 0) {
    return { csvDate: null, rows, garbled };
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
    const row: SnapshotRow = {
      bin: field(record, columns.bin),
      street: field(record, columns.street),
      houseNumber: field(record, columns.houseNumber),
      linearFeet: field(record, columns.linearFeet),
      lat: field(record, columns.lat),
      lng: field(record, columns.lng),
      boroughDigit: field(record, columns.boroughDigit),
      block: field(record, columns.block),
      lot: field(record, columns.lot),
      firstPermitDate: field(record, columns.firstPermitDate),
    };
    if (JOB_NUMBER.test(job)) {
      rows.set(job, row);
    } else {
      garbled.push({ job, row });
    }
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
  return { csvDate, rows, garbled };
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

// Distinct: the feed often recommits an unchanged CSV.
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

export function emptyShedFile(city: string): ShedFile {
  return {
    city,
    keySpace: "",
    through: "",
    seen: "",
    counts: [],
    records: [],
  };
}

export interface ShedWalk {
  file: ShedFile;
  records: Map<string, ShedFileRecord>;
  unplaced: Set<string>; // new, or re-read since their placement
  kept: number;
  dropped: number;
  skipped: number;
}

export function startWalk(file: ShedFile): ShedWalk {
  return {
    file,
    records: new Map(file.records.map((record) => [record.job, record])),
    unplaced: new Set(),
    kept: 0,
    dropped: 0,
    skipped: 0,
  };
}

function emptyRecord(job: string): ShedFileRecord {
  return {
    job,
    bin: "",
    house: "",
    street: "",
    firstPermit: "",
    bbl: "",
    lat: null,
    lng: null,
    feet: null,
    runs: [],
    confidence: 0,
    spans: [],
  };
}

// True when the placement's inputs moved; a house number or permit date alone doesn't move it.
function readRow(record: ShedFileRecord, row: SnapshotRow): boolean {
  // Block and lot from the last row carrying them, so a blank day isn't a change of address.
  const bbl =
    row.block !== "" && row.lot !== ""
      ? `${row.boroughDigit}/${row.block}/${row.lot}`
      : record.bbl;
  const lat = toNumber(row.lat);
  const lng = toNumber(row.lng);
  const feet = toNumber(row.linearFeet);
  const moved =
    record.bin !== row.bin ||
    record.street !== row.street ||
    record.bbl !== bbl ||
    record.lat !== lat ||
    record.lng !== lng ||
    record.feet !== feet;
  record.bin = row.bin;
  record.house = row.houseNumber;
  record.street = row.street;
  record.firstPermit = parseSnapshotDate(row.firstPermitDate) ?? "";
  record.bbl = bbl;
  record.lat = lat;
  record.lng = lng;
  record.feet = feet;
  return moved;
}

// A garbled row is the one permit at its address and first permit date that the day leaves out.
function recoverRows(
  walk: ShedWalk,
  snapshot: DatedSnapshot,
): Map<string, SnapshotRow> {
  if (snapshot.garbled.length === 0) {
    return snapshot.rows;
  }
  const rows = new Map(snapshot.rows);
  for (const { job, row } of snapshot.garbled) {
    const firstPermit = parseSnapshotDate(row.firstPermitDate) ?? "";
    const matches = [...walk.records.values()].filter(
      (record) =>
        !rows.has(record.job) &&
        record.bin === row.bin &&
        record.house === row.houseNumber &&
        record.street === row.street &&
        record.firstPermit === firstPermit,
    );
    if (matches.length === 1) {
      rows.set(matches[0].job, row);
    } else {
      console.error(
        `  ${snapshot.date}: dropped a row with job number ${JSON.stringify(job)}: ${matches.length}` +
          ` unlisted permits at BIN ${row.bin}, ${row.houseNumber} ${row.street}, first permit` +
          ` ${row.firstPermitDate}`,
      );
    }
  }
  return rows;
}

// Snapshots must come in commit order; one dated on or before `through` was already judged.
export function advanceSheds(walk: ShedWalk, snapshot: DatedSnapshot): void {
  const { file } = walk;
  if (snapshot.date <= file.through) {
    walk.skipped += 1;
    return;
  }
  const count = snapshot.rows.size + snapshot.garbled.length;
  const neighbors = [...file.counts].sort((left, right) => left - right);
  const median =
    neighbors.length === 0 ? 0 : neighbors[Math.floor(neighbors.length / 2)];
  // Dropped days count too, or the window would depend on its own earlier verdicts.
  file.counts = [...file.counts, count].slice(-TRUNCATION_NEIGHBORS);
  file.through = snapshot.date;
  if (median !== 0 && count < TRUNCATION_RATIO * median) {
    walk.dropped += 1;
    return;
  }
  walk.kept += 1;
  const rows = recoverRows(walk, snapshot);
  for (const [job, row] of rows) {
    let record = walk.records.get(job);
    if (record === undefined) {
      record = emptyRecord(job);
      walk.records.set(job, record);
    }
    if (readRow(record, row)) {
      walk.unplaced.add(job);
    }
    if (record.runs.at(-1)?.last !== null) {
      record.runs.push({ first: snapshot.date, last: null });
    }
  }
  for (const record of walk.records.values()) {
    const run = record.runs[record.runs.length - 1];
    if (run.last === null && !rows.has(record.job)) {
      run.last = file.seen;
    }
  }
  file.seen = snapshot.date;
}

export function finishWalk(walk: ShedWalk): ShedFile {
  walk.file.records = [...walk.records.values()].sort(byJob);
  return walk.file;
}

// The stream must answer `sources` in order, once per distinct blob.
export async function walkSnapshots(
  walk: ShedWalk,
  sources: readonly SnapshotSource[],
  stream: AsyncIterable<Uint8Array>,
): Promise<void> {
  if (sources.length === 0) {
    // A pipeline exits with its last command's status, so upstream failures surface here.
    throw new Error(
      "the commit index names no DOB snapshot at all: the git half of the pipeline resolved" +
        " nothing, so there is no history to walk",
    );
  }
  const blobOrder = distinctBlobs(sources);
  console.error(
    `  ${sources.length} commits carry a snapshot, ${blobOrder.length} distinct blobs`,
  );
  // A recommitted blob carries the day it carried before, which the walk has already judged.
  const read = new Set<string>();
  const blobs = readBlobs(stream, blobOrder);
  for (const [position, source] of sources.entries()) {
    if (read.has(source.blob)) {
      walk.skipped += 1;
      continue;
    }
    read.add(source.blob);
    const next = await blobs.next();
    if (next.done === true) {
      throw new Error(`git cat-file --batch stopped at blob ${source.blob}`);
    }
    const snapshot = parseSnapshot(next.value);
    if (snapshot.rows.size + snapshot.garbled.length > 0) {
      advanceSheds(walk, {
        date: snapshot.csvDate ?? source.commitDate,
        rows: snapshot.rows,
        garbled: snapshot.garbled,
      });
    }
    if ((position + 1) % PROGRESS_INTERVAL === 0) {
      console.error(
        `  read ${position + 1}/${sources.length} snapshots, through ${walk.file.through}`,
      );
    }
  }
  console.error(
    `  ${walk.kept} usable dated snapshots up to ${walk.file.seen}` +
      ` (${walk.dropped} truncated dropped, ${walk.skipped} already judged)`,
  );
}

export function listedCount(file: ShedFile): number {
  return file.records.filter((record) => record.runs.at(-1)?.last === null)
    .length;
}

if (import.meta.main) {
  const started = performance.now();
  const { sources, blobs } = await shedSnapshots("shed-walk");
  const walk = startWalk(emptyShedFile("nyc"));
  await walkSnapshots(walk, sources, blobs);
  const file = finishWalk(walk);
  const runs = file.records.reduce(
    (total, record) => total + record.runs.length,
    0,
  );
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.error(
    `sheds: ${file.records.length} permits, ${runs} runs, ${listedCount(file)} listed on` +
      ` ${file.seen}, in ${seconds}s`,
  );
}

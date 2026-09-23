// Must match src/routing/sheds.ts byte for byte; layout in scripts/README.md.
// One record per interval, not an interval list: a list would bloat open.bin, the hot file, by 30%.

import {
  durableKey,
  edgeDurableKey,
  type RoutingGraph,
} from "../src/routing/graph";

const MAGIC = "SHED";
const FORMAT_VERSION = 3;
const HEADER_BYTES = 32;
const CLOSED_FLAG = 0x1;
const MILLISECONDS_PER_DAY = 86_400_000;
const EPOCH_MS = Date.UTC(2017, 11, 28); // the first DOB snapshot, day 0

export const SIDE_BITS = 3;

function spanKey(span: EncodedSpan): number {
  return durableKey(span.sourceId, span.side, span.ordinal);
}

export const FRACTION_SCALE = 255; // 255 is exactly 1.0
export const CONFIDENCE_CEILING = 254; // keeps a client attribute under 1, as the graph's bytes do
// Decimeters; 0 means unmeasured, not zero depth.
export const DEPTH_SCALE = 10;
export const DEPTH_CEILING = 255;

// Keyed by durable key, since a rebuild renumbers every edge id.
export interface EncodedSpan {
  sourceId: number; // CSCL physicalid, or an OSM way id for a path
  side: number; // N/E/S/W label, 0-4
  ordinal: number; // 0-255
  t0: number; // 0..255
  t1: number; // 0..255
  depth: number; // decimeters, 0 unmeasured
}

// An unplaceable permit still gets its record, with no spans.
export interface EncodedShed {
  job: string; // "" when read back from closed.bin, which does not store it
  first: number; // day number
  close: number | null; // day number, null while provisional
  confidence: number; // 0..254
  spans: EncodedSpan[];
}

export interface ShedArtifact {
  open: Uint8Array;
  closed: Uint8Array;
  index: Uint8Array;
}

// FNV-1a 64, matching crates/tiler/src/graph.rs. 16-bit limbs: BigInt over 37 MB takes minutes.
export function graphHashOf(bytes: Uint8Array): string {
  const LOW = 0x01b3; // 0x100000001b3, as its two non-zero 16-bit limbs
  const HIGH = 0x0100;
  const limbs = [0x2325, 0x8422, 0x9ce4, 0xcbf2]; // 0xcbf29ce484222325, least significant first
  let [limb0, limb1, limb2, limb3] = limbs;
  for (const byte of bytes) {
    limb0 ^= byte;
    const product0 = limb0 * LOW;
    const product1 = limb1 * LOW + Math.floor(product0 / 0x10000);
    const product2 =
      limb2 * LOW + limb0 * HIGH + Math.floor(product1 / 0x10000);
    const product3 =
      limb3 * LOW + limb1 * HIGH + Math.floor(product2 / 0x10000);
    limb0 = product0 & 0xffff;
    limb1 = product1 & 0xffff;
    limb2 = product2 & 0xffff;
    limb3 = product3 & 0xffff;
  }
  return [limb3, limb2, limb1, limb0]
    .map((limb) => limb.toString(16).padStart(4, "0"))
    .join("");
}

// Must match `key_space_hash` in crates/tiler/src/graph.rs.
// The key set, not the bytes, which move on any rebuild (even an f32 ulp between Linux and macOS).
export function graphKeyHashOf(graph: RoutingGraph): string {
  const keys = new Float64Array(graph.edgeCount);
  let count = 0;
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    const key = edgeDurableKey(graph, edge);
    if (key >= 0) {
      keys[count] = key;
      count += 1;
    }
  }
  const durable = keys.subarray(0, count).sort();
  const bytes = new Uint8Array(8 * (count + 1));
  const view = new DataView(bytes.buffer);
  // Keys exceed a u32 but fit an exact double, so they're written as two u32 halves.
  const HALF = 0x1_0000_0000;
  view.setUint32(0, count, true);
  for (const [order, key] of durable.entries()) {
    view.setUint32(8 * order + 8, key % HALF, true);
    view.setUint32(8 * order + 12, Math.floor(key / HALF), true);
  }
  return graphHashOf(bytes);
}

export function shedDayOf(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  return Math.round(
    (Date.UTC(year, month - 1, day) - EPOCH_MS) / MILLISECONDS_PER_DAY,
  );
}

// Clamped at the epoch, which falls mid-month.
function monthStart(day: number): number {
  const date = new Date(EPOCH_MS + day * MILLISECONDS_PER_DAY);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  return Math.max(0, Math.round((start - EPOCH_MS) / MILLISECONDS_PER_DAY));
}

class ByteWriter {
  bytes: number[] = [];

  u8(value: number): void {
    this.bytes.push(value & 0xff);
  }

  unsignedVarint(value: number): void {
    let remaining = value;
    while (remaining >= 0x80) {
      this.bytes.push((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    this.bytes.push(remaining);
  }

  varint(value: number): void {
    this.unsignedVarint(value < 0 ? -2 * value - 1 : 2 * value);
  }
}

// `extension` is data for the daily job, covered by the header-bytes field so readers skip it.
function header(
  records: readonly EncodedShed[],
  firstDay: number,
  closed: boolean,
  graphKeyHash: string,
  lastDay: number,
  extension: Uint8Array,
): Uint8Array {
  if (HEADER_BYTES + extension.length > 0xffff) {
    // A u16 field: ~21,000 open records, against a standing set near 7,500.
    throw new Error(
      `a ${extension.length}-byte header does not fit the u16 that says where the records start`,
    );
  }
  const bytes = new Uint8Array(HEADER_BYTES + extension.length);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC.length; index++) {
    bytes[index] = MAGIC.charCodeAt(index);
  }
  view.setUint16(4, FORMAT_VERSION, true);
  view.setUint16(6, bytes.length, true);
  view.setUint32(8, records.length, true);
  view.setUint32(
    12,
    records.reduce((total, record) => total + record.spans.length, 0),
    true,
  );
  view.setUint32(16, Number.parseInt(graphKeyHash.slice(8), 16), true);
  view.setUint32(20, Number.parseInt(graphKeyHash.slice(0, 8), 16), true);
  view.setUint16(24, firstDay, true);
  bytes[26] = closed ? CLOSED_FLAG : 0;
  view.setUint16(28, lastDay, true);
  bytes.set(extension, HEADER_BYTES);
  return bytes;
}

function windowBytes(counts: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(2 * counts.length);
  const view = new DataView(bytes.buffer);
  for (const [order, count] of counts.entries()) {
    view.setUint16(2 * order, count, true);
  }
  return bytes;
}

// The source-id delta chain restarts per record, so a read from mid-file can't drift.
function writeSpans(writer: ByteWriter, record: EncodedShed): void {
  const spans = [...record.spans].sort(
    (left, right) => spanKey(left) - spanKey(right),
  );
  writer.unsignedVarint(spans.length);
  let previous = 0;
  for (const span of spans) {
    writer.unsignedVarint(span.sourceId - previous);
    previous = span.sourceId;
    writer.unsignedVarint(span.side | (span.ordinal << SIDE_BITS));
    writer.u8(span.t0);
    writer.u8(span.t1);
    writer.u8(span.depth);
  }
}

function join(head: Uint8Array, body: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(head.length + body.length);
  bytes.set(head);
  bytes.set(body, head.length);
  return bytes;
}

// DOB job numbers come in two shapes: nine-digit BIS, and DOB NOW ("M12345678-I1").
interface JobCode {
  key: number; // ascends with the job string
  suffix: number; // 0 for a BIS number, else 1 + 10*(type letter - "A") + the type digit
}

const BOROUGH_LETTERS = "BMQSX"; // sorted
const LETTER_A = "A".charCodeAt(0);
const SUFFIX_DIGITS = 10;
const BIS_JOB = /^(\d{9})$/;
const NOW_JOB = /^([A-Z])(\d{8})-([A-Z])(\d)$/;
// Above every nine-digit BIS number, since digits sort before letters.
const NOW_KEY_BASE = 1e9;
const NOW_DIGITS = 1e8;

function jobCodeOf(job: string): JobCode {
  const legacy = BIS_JOB.exec(job);
  const now = NOW_JOB.exec(job);
  const borough = now === null ? -1 : BOROUGH_LETTERS.indexOf(now[1]);
  if (legacy !== null) {
    return { key: Number(legacy[1]), suffix: 0 };
  } else if (now === null || borough < 0) {
    throw new Error(
      `"${job}" is neither a nine-digit BIS job number nor a DOB NOW one, so open.bin cannot name it`,
    );
  } else {
    return {
      key: NOW_KEY_BASE + borough * NOW_DIGITS + Number(now[2]),
      suffix:
        1 + (now[3].charCodeAt(0) - LETTER_A) * SUFFIX_DIGITS + Number(now[4]),
    };
  }
}

function jobOf({ key, suffix }: JobCode): string {
  if (suffix === 0) {
    return String(key).padStart(9, "0");
  } else {
    const digits = key - NOW_KEY_BASE;
    const letter = String.fromCharCode(
      LETTER_A + Math.floor((suffix - 1) / SUFFIX_DIGITS),
    );
    return (
      `${BOROUGH_LETTERS[Math.floor(digits / NOW_DIGITS)]}` +
      `${String(digits % NOW_DIGITS).padStart(8, "0")}-${letter}${(suffix - 1) % SUFFIX_DIGITS}`
    );
  }
}

function jobBlock(records: readonly EncodedShed[]): Uint8Array {
  const writer = new ByteWriter();
  let previous = 0;
  for (const record of records) {
    const { key, suffix } = jobCodeOf(record.job);
    if (key < previous) {
      throw new Error(`open.bin reaches ${record.job} out of job order`);
    }
    writer.unsignedVarint(key - previous);
    writer.unsignedVarint(suffix);
    previous = key;
  }
  return Uint8Array.from(writer.bytes);
}

// Kept in job order, not day order, because the job-number column is a delta chain over it.
function encodeOpen(
  records: readonly EncodedShed[],
  graphKeyHash: string,
  lastDay: number,
): Uint8Array {
  const anchor = records.length > 0 ? records[0].first : 0;
  const writer = new ByteWriter();
  let previous = anchor;
  for (const record of records) {
    writer.varint(record.first - previous);
    previous = record.first;
    writer.u8(record.confidence);
    writeSpans(writer, record);
  }
  return join(
    header(records, anchor, false, graphKeyHash, lastDay, jobBlock(records)),
    writer.bytes,
  );
}

// Stable sort on close day alone, so the daily job can append new closures without a rewrite.
function encodeClosed(
  records: readonly EncodedShed[],
  graphKeyHash: string,
  lastDay: number,
  counts: readonly number[],
): { closed: Uint8Array; index: Uint8Array } {
  const ordered = [...records].sort(
    (left, right) => (left.close ?? 0) - (right.close ?? 0),
  );
  const anchor = ordered.length > 0 ? (ordered[0].close ?? 0) : 0;
  const head = header(
    ordered,
    anchor,
    true,
    graphKeyHash,
    lastDay,
    windowBytes(counts),
  );
  const writer = new ByteWriter();
  const index = new ByteWriter();
  let month = -1;
  let previous = anchor;
  for (const record of ordered) {
    const close = record.close ?? 0;
    if (month < monthStart(close)) {
      // An empty month gets no entry; a reader skips forward from the one before.
      month = monthStart(close);
      const entry = new Uint8Array(8);
      const view = new DataView(entry.buffer);
      view.setUint16(0, month, true);
      view.setUint32(2, head.length + writer.bytes.length, true);
      view.setUint16(6, close, true);
      index.bytes.push(...entry);
    }
    writer.unsignedVarint(close - previous);
    previous = close;
    writer.unsignedVarint(close - record.first);
    writer.u8(record.confidence);
    writeSpans(writer, record);
  }
  return {
    closed: join(head, writer.bytes),
    index: Uint8Array.from(index.bytes),
  };
}

// `records` must be ascending by job number, then by first day.
export function encodeSheds(
  records: readonly EncodedShed[],
  graphKeyHash: string,
  lastDay: number,
  counts: readonly number[] = [],
): ShedArtifact {
  const { closed, index } = encodeClosed(
    records.filter((record) => record.close !== null),
    graphKeyHash,
    lastDay,
    counts,
  );
  return {
    open: encodeOpen(
      records.filter((record) => record.close === null),
      graphKeyHash,
      lastDay,
    ),
    closed,
    index,
  };
}

// Quantized bytes and file order, exactly as written, for the daily job to carry forward.
export interface DecodedShedArtifact {
  graphKeyHash: string;
  lastDay: number; // the newest usable DOB snapshot the artifact was built through
  counts: number[]; // the truncation window to seed a walk resuming from `lastDay`
  open: EncodedShed[];
  closed: EncodedShed[];
}

class ByteReader {
  offset: number;

  constructor(
    readonly bytes: Uint8Array,
    start: number,
  ) {
    this.offset = start;
  }

  u8(): number {
    const value = this.bytes[this.offset];
    this.offset += 1;
    return value;
  }

  unsignedVarint(): number {
    let value = 0;
    let scale = 1;
    let byte = 0;
    do {
      byte = this.bytes[this.offset];
      this.offset += 1;
      value += (byte & 0x7f) * scale;
      scale *= 128;
    } while (byte & 0x80);
    return value;
  }

  varint(): number {
    const value = this.unsignedVarint();
    return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
  }
}

function readHeader(bytes: Uint8Array, closed: boolean): DataView {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== MAGIC || view.getUint16(4, true) !== FORMAT_VERSION) {
    throw new Error(`not a v${FORMAT_VERSION} shed file`);
  }
  if (((bytes[26] & CLOSED_FLAG) !== 0) !== closed) {
    throw new Error(
      `shed file is ${closed ? "the open" : "the closed"} half, the other was expected`,
    );
  }
  return view;
}

function readSpans(reader: ByteReader): EncodedSpan[] {
  const count = reader.unsignedVarint();
  const spans: EncodedSpan[] = new Array(count);
  let sourceId = 0;
  for (let span = 0; span < count; span++) {
    sourceId += reader.unsignedVarint();
    const packed = reader.unsignedVarint();
    spans[span] = {
      sourceId,
      side: packed & ((1 << SIDE_BITS) - 1),
      ordinal: packed >> SIDE_BITS,
      t0: reader.u8(),
      t1: reader.u8(),
      depth: reader.u8(),
    };
  }
  return spans;
}

export function decodeShedArtifact(
  openBytes: Uint8Array,
  closedBytes: Uint8Array,
): DecodedShedArtifact {
  const openView = readHeader(openBytes, false);
  const closedView = readHeader(closedBytes, true);
  const graphKeyHash =
    closedView.getUint32(20, true).toString(16).padStart(8, "0") +
    closedView.getUint32(16, true).toString(16).padStart(8, "0");
  const lastDay = openView.getUint16(28, true);
  if (
    lastDay !== closedView.getUint16(28, true) ||
    graphKeyHash !==
      openView.getUint32(20, true).toString(16).padStart(8, "0") +
        openView.getUint32(16, true).toString(16).padStart(8, "0")
  ) {
    throw new Error("the two shed halves do not describe the same build");
  }

  const counts: number[] = [];
  for (let at = HEADER_BYTES; at + 1 < closedView.getUint16(6, true); at += 2) {
    counts.push(closedView.getUint16(at, true));
  }

  const openCount = openView.getUint32(8, true);
  const jobReader = new ByteReader(openBytes, HEADER_BYTES);
  const jobs: string[] = new Array(openCount);
  let key = 0;
  for (let record = 0; record < openCount; record++) {
    key += jobReader.unsignedVarint();
    jobs[record] = jobOf({ key, suffix: jobReader.unsignedVarint() });
  }

  const openReader = new ByteReader(openBytes, openView.getUint16(6, true));
  const open: EncodedShed[] = [];
  let first = openView.getUint16(24, true);
  for (let record = 0; record < openCount; record++) {
    first += openReader.varint();
    open.push({
      job: jobs[record],
      first,
      close: null,
      confidence: openReader.u8(),
      spans: readSpans(openReader),
    });
  }

  const closedReader = new ByteReader(
    closedBytes,
    closedView.getUint16(6, true),
  );
  const closed: EncodedShed[] = [];
  let close = closedView.getUint16(24, true);
  for (let record = 0; record < closedView.getUint32(8, true); record++) {
    close += closedReader.unsignedVarint();
    const duration = closedReader.unsignedVarint();
    closed.push({
      job: "", // closed.bin does not carry one
      first: close - duration,
      close,
      confidence: closedReader.u8(),
      spans: readSpans(closedReader),
    });
  }
  return { graphKeyHash, lastDay, counts, open, closed };
}

// Writers must stop on a mismatch, not re-stamp, or the client's blank map turns wrong.
export function shedGraphMismatch(
  artifact: DecodedShedArtifact,
  graphKeyHash: string,
): string | null {
  if (artifact.graphKeyHash === graphKeyHash) {
    return null;
  } else {
    return (
      `the shed artifact was placed against key space ${artifact.graphKeyHash},` +
      ` this graph's is ${graphKeyHash}`
    );
  }
}

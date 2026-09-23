import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import pRetry from "p-retry";
import { cached, cachedFile } from "./cache";
import { type CsvRow, parseCsv } from "./csv";

// NYC DOT's Akamai edge 403s a download that doesn't look like a browser.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAX_ATTEMPTS = 3;
// Feeds expire: an agency posts a new zip every few weeks and the old calendar runs out.
const FEED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 30_000;

export type GtfsRow = CsvRow;

// A table the feed omits parses to an empty array.
export interface GtfsFeed {
  routes: GtfsRow[];
  trips: GtfsRow[];
  stops: GtfsRow[];
  stopTimes: GtfsRow[];
  calendar: GtfsRow[];
  calendarDates: GtfsRow[];
  shapes: GtfsRow[];
  frequencies: GtfsRow[];
  // Absent from Muni's feed, so the station merge keeps a geometric fallback.
  transfers: GtfsRow[];
}

async function download(url: string): Promise<Uint8Array> {
  try {
    return await pRetry(
      async () => {
        const response = await fetch(url, {
          headers: { "user-agent": BROWSER_USER_AGENT, accept: "*/*" },
        });
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        return new Uint8Array(await response.arrayBuffer());
      },
      {
        retries: MAX_ATTEMPTS - 1,
        minTimeout: RETRY_BASE_MS,
        maxTimeout: RETRY_CAP_MS,
        randomize: true,
        onFailedAttempt: ({ error, attemptNumber }) => {
          console.error(
            `  attempt ${attemptNumber}/${MAX_ATTEMPTS} failed: ${error}`,
          );
        },
      },
    );
  } catch (error) {
    throw new Error(`failed to fetch ${url}: ${error}`);
  }
}

// Cached as base64 since the cache stores JSON; for a feed also frozen under data/.
export async function fetchGtfsZip(
  name: string,
  url: string,
): Promise<Uint8Array> {
  const base64 = await cached(
    name,
    url,
    async () => {
      console.error(`  ${name}: downloading ${url}`);
      return Buffer.from(await download(url)).toString("base64");
    },
    { maxAgeMs: FEED_MAX_AGE_MS },
  );
  return new Uint8Array(Buffer.from(base64, "base64"));
}

// Raw-bytes cache entry for a feed that is only read, skipping base64's size and parse cost.
export async function fetchGtfsZipFile(
  name: string,
  url: string,
): Promise<Uint8Array> {
  const path = await cachedFile(
    name,
    url,
    async () => {
      console.error(`  ${name}: downloading ${url}`);
      return await download(url);
    },
    { maxAgeMs: FEED_MAX_AGE_MS },
  );
  return new Uint8Array(await readFile(path));
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_BYTES = 30;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

// The EOCD record precedes an optional comment of up to 64 KiB, so scan back for its signature.
function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number {
  const earliest = Math.max(0, bytes.length - 0x10000 - 22);
  for (let offset = bytes.length - 22; offset >= earliest; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new Error("not a zip: no end-of-central-directory record");
}

// Sizes come from the central directory: a local header may defer them to a data descriptor.
function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(bytes, view);
  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);

  const files = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let entry = 0; entry < entryCount; entry++) {
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`corrupt central directory at entry ${entry}`);
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart =
      localOffset + LOCAL_HEADER_BYTES + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let contents: Uint8Array;
    if (method === METHOD_STORED) {
      contents = compressed;
    } else if (method === METHOD_DEFLATE) {
      contents = new Uint8Array(inflateRawSync(compressed));
    } else {
      throw new Error(`${name}: unsupported zip compression method ${method}`);
    }
    files.set(name, contents);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

// Matched by basename: the SI Ferry zip nests its tables under a folder.
function readTable(files: Map<string, Uint8Array>, table: string): GtfsRow[] {
  const decoder = new TextDecoder();
  for (const [name, contents] of files) {
    if (name === `${table}.txt` || name.endsWith(`/${table}.txt`)) {
      return parseCsv(decoder.decode(contents));
    }
  }
  return [];
}

export function parseGtfs(zip: Uint8Array): GtfsFeed {
  const files = unzip(zip);
  return {
    routes: readTable(files, "routes"),
    trips: readTable(files, "trips"),
    stops: readTable(files, "stops"),
    stopTimes: readTable(files, "stop_times"),
    calendar: readTable(files, "calendar"),
    calendarDates: readTable(files, "calendar_dates"),
    shapes: readTable(files, "shapes"),
    frequencies: readTable(files, "frequencies"),
    transfers: readTable(files, "transfers"),
  };
}

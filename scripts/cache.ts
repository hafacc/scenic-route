// A disk cache for the raw source reads: the network paging is the whole cost of a re-run,
// everything downstream of it is seconds. Entries live in .cache/ (gitignored) and by default never
// expire on their own — the sources move about once a year, so a re-run wants whatever it
// read last time, not a fresher copy it did not ask for. A caller whose source does move — the GTFS
// feeds, whose calendars run out — asks for a `maxAgeMs` and gets a re-read once its entry is older
// than that.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Also where a build input too big to hold in memory is cut up — see scripts/alcc.ts.
export const CACHE_DIR = join(import.meta.dirname, "..", ".cache");

const REFRESH =
  process.argv.includes("--refresh") || process.env.REFRESH === "1";
// The opposite of a refresh: whatever is in .cache/ is used whatever its age, and a source with no
// entry is an error rather than a download. For a run that must not touch the network.
const OFFLINE =
  process.argv.includes("--offline") || process.env.OFFLINE === "1";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CacheOptions {
  // How old an entry may be before the source is read again. Omitted, the entry never expires.
  maxAgeMs?: number | null;
}

export interface JsonCacheOptions extends CacheOptions {
  // Suppresses the hit notice, for a read split into hundreds of cached batches that reports its own
  // progress and would otherwise bury the build log.
  quiet?: boolean;
}

// "miss" covers both an absent entry and `--refresh`: read the source. "stale" is a usable entry the
// caller's max age has passed, which reads the source too but says so.
export type CacheVerdict = "hit" | "stale" | "miss" | "unavailable";

export interface CacheEntryAge {
  // When the entry was written, or null when there is no entry.
  writtenMs: number | null;
  nowMs: number;
  maxAgeMs: number | null;
  refresh: boolean;
  offline: boolean;
}

// The expiry decision on its own, so it can be tested without a cache directory.
export function cacheVerdict({
  writtenMs,
  nowMs,
  maxAgeMs,
  refresh,
  offline,
}: CacheEntryAge): CacheVerdict {
  if (offline) {
    return writtenMs === null ? "unavailable" : "hit";
  } else if (writtenMs === null || refresh) {
    return "miss";
  } else if (maxAgeMs !== null && nowMs - writtenMs > maxAgeMs) {
    return "stale";
  } else {
    return "hit";
  }
}

// The verdict on a real entry, with how old it is for the notice a stale one prints.
async function entryAge(
  path: string,
  maxAgeMs: number | null,
): Promise<{ verdict: CacheVerdict; ageMs: number }> {
  const info = await stat(path).catch(() => null);
  const nowMs = Date.now();
  const writtenMs = info === null ? null : info.mtimeMs;
  return {
    verdict: cacheVerdict({
      writtenMs,
      nowMs,
      maxAgeMs,
      refresh: REFRESH,
      offline: OFFLINE,
    }),
    ageMs: writtenMs === null ? 0 : nowMs - writtenMs,
  };
}

function staleNotice(name: string, ageMs: number): string {
  return `  ${name}: the cached copy is ${(ageMs / MS_PER_DAY).toFixed(1)} days old; reading the source again`;
}

function offlineError(name: string, path: string): Error {
  return new Error(
    `${name}: --offline, but .cache holds no usable entry (${path})`,
  );
}

// Wrapped, so a cached `null` is still told apart from a body that would not parse.
function parse<Value>(body: string): { value: Value } | null {
  try {
    return { value: JSON.parse(body) as Value };
  } catch {
    return null;
  }
}

function entryPath(name: string, key: string, extension: string): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return join(CACHE_DIR, `${name}.${digest}.${extension}`);
}

// Renamed on, so a file is either whole or absent: these run to hundreds of megabytes, and an
// interrupted write would otherwise leave a torn one behind. Exported because the build inputs cut
// up beside the cache (scripts/alcc.ts) want the same guarantee for the same reason — a truncated
// raster is read as a tile that would not decode rather than as an error.
export async function writeAtomic(
  path: string,
  contents: string | Uint8Array,
): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, path);
}

// The key is the request itself — dataset plus query, or the Overpass QL — so changing what
// is asked for lands on a different entry rather than silently reusing the old one.
export async function cached<Value>(
  name: string,
  key: string,
  read: () => Promise<Value>,
  { quiet = false, maxAgeMs = null }: JsonCacheOptions = {},
): Promise<Value> {
  const path = entryPath(name, key, "json");
  const { verdict, ageMs } = await entryAge(path, maxAgeMs);

  // An entry that will not parse is a miss even when it is young enough to use.
  const body =
    verdict === "hit" ? await readFile(path, "utf-8").catch(() => null) : null;
  const entry = body === null ? null : parse<Value>(body);

  if (entry !== null) {
    if (!quiet) {
      console.error(`  ${name}: from .cache`);
    }
    return entry.value;
  } else if (OFFLINE) {
    throw offlineError(name, path);
  } else {
    if (verdict === "stale") {
      console.error(staleNotice(name, ageMs));
    }
    const value = await read();
    await writeAtomic(path, JSON.stringify(value));
    return value;
  }
}

// The same cache for a source that is raw bytes rather than JSON — a raster the tiler reads off
// disk itself — so the caller is handed the entry's path instead of its contents.
export async function cachedFile(
  name: string,
  key: string,
  read: () => Promise<Uint8Array>,
  { maxAgeMs = null }: CacheOptions = {},
): Promise<string> {
  const path = entryPath(name, key, "bin");
  const { verdict, ageMs } = await entryAge(path, maxAgeMs);

  if (verdict === "hit") {
    console.error(`  ${name}: from .cache`);
    return path;
  } else if (verdict === "unavailable") {
    throw offlineError(name, path);
  } else {
    if (verdict === "stale") {
      console.error(staleNotice(name, ageMs));
    }
    await writeAtomic(path, await read());
    return path;
  }
}

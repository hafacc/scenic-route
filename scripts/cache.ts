// Disk cache for raw source reads in .cache/; entries never expire unless the caller sets `maxAgeMs`.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CACHE_DIR = join(import.meta.dirname, "..", ".cache");

const REFRESH =
  process.argv.includes("--refresh") || process.env.REFRESH === "1";
// Use any cached entry whatever its age; a missing entry is an error, not a download.
const OFFLINE =
  process.argv.includes("--offline") || process.env.OFFLINE === "1";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CacheOptions {
  // Omitted, the entry never expires.
  maxAgeMs?: number | null;
}

export interface JsonCacheOptions extends CacheOptions {
  quiet?: boolean;
}

// "miss" includes `--refresh`; "stale" is past the caller's max age.
export type CacheVerdict = "hit" | "stale" | "miss" | "unavailable";

export interface CacheEntryAge {
  // Null when there is no entry.
  writtenMs: number | null;
  nowMs: number;
  maxAgeMs: number | null;
  refresh: boolean;
  offline: boolean;
}

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

// Wrapped, so a cached `null` is told apart from a body that would not parse.
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

// Write then rename, so an interrupted write never leaves a torn file behind.
export async function writeAtomic(
  path: string,
  contents: string | Uint8Array,
): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, path);
}

// The key is the request itself, so changing the query lands on a different entry.
export async function cached<Value>(
  name: string,
  key: string,
  read: () => Promise<Value>,
  { quiet = false, maxAgeMs = null }: JsonCacheOptions = {},
): Promise<Value> {
  const path = entryPath(name, key, "json");
  const { verdict, ageMs } = await entryAge(path, maxAgeMs);

  // An entry that will not parse is a miss.
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

// For raw bytes: returns the entry's path, not its contents.
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

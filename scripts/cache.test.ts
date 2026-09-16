// When a cached entry is used and when the source is read again. The GTFS feeds are the reason this
// exists: an agency's zip carries a calendar that runs out, so a feed cached in August and still
// used in September builds a timetable nobody runs.

import { expect, test } from "bun:test";
import { type CacheEntryAge, cacheVerdict } from "./cache";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * MS_PER_DAY;
const NOW_MS = Date.UTC(2026, 8, 14);

function verdict(overrides: Partial<CacheEntryAge>): string {
  const inputs: CacheEntryAge = {
    writtenMs: NOW_MS - MS_PER_DAY,
    nowMs: NOW_MS,
    maxAgeMs: WEEK_MS,
    refresh: false,
    offline: false,
    ...overrides,
  };
  return cacheVerdict(inputs);
}

test("an entry inside its max age is used", () => {
  expect(verdict({ writtenMs: NOW_MS - 6 * MS_PER_DAY })).toBe("hit");
});

test("an entry exactly at its max age is still used", () => {
  expect(verdict({ writtenMs: NOW_MS - WEEK_MS })).toBe("hit");
});

test("an entry past its max age is read again", () => {
  expect(verdict({ writtenMs: NOW_MS - WEEK_MS - 1 })).toBe("stale");
  expect(verdict({ writtenMs: NOW_MS - 28 * MS_PER_DAY })).toBe("stale");
});

test("a caller that named no max age never expires", () => {
  expect(
    verdict({ maxAgeMs: null, writtenMs: NOW_MS - 400 * MS_PER_DAY }),
  ).toBe("hit");
});

test("no entry means the source is read", () => {
  expect(verdict({ writtenMs: null })).toBe("miss");
});

test("a refresh ignores an entry however fresh", () => {
  expect(verdict({ refresh: true, writtenMs: NOW_MS })).toBe("miss");
});

test("offline takes a stale entry, and beats a refresh", () => {
  expect(verdict({ offline: true, writtenMs: NOW_MS - 400 * MS_PER_DAY })).toBe(
    "hit",
  );
  expect(verdict({ offline: true, refresh: true })).toBe("hit");
});

test("offline with no entry is an error rather than a download", () => {
  expect(verdict({ offline: true, writtenMs: null })).toBe("unavailable");
});

// A clock that has gone backwards — a restored .cache/, a machine whose time was wrong — must not
// read the source on every call.
test("an entry written in the future is used", () => {
  expect(verdict({ writtenMs: NOW_MS + MS_PER_DAY })).toBe("hit");
});

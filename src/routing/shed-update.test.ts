// Cron skips and DOB feed gaps mean updates can't assume yesterday; any chain must match one walk.

import { expect, test } from "bun:test";
import { truncationOf } from "../../scripts/build-sheds";
import {
  advanceSheds,
  type DatedSnapshot,
  emptyShedFile,
  finishWalk,
  type GarbledRow,
  type SnapshotRow,
  startWalk,
  TRUNCATION_NEIGHBORS,
} from "../../scripts/shed-permits";
import {
  loadDeployedGraph,
  shedGraphMismatch,
} from "../../scripts/update-sheds";
import {
  parseShedFile,
  type ShedFile,
  type ShedFileRecord,
  serializeShedFile,
} from "./shed-file";

const DAY_MS = 86_400_000;
const START_MS = Date.UTC(2026, 2, 2);
const DAYS = 120;
const FILLERS = 20; // permits that are simply always there, so the row count has a stable median
const TRUNCATED_DAY = 85; // a partial write: two rows where there should be two dozen
const SILENT_DAY = 90; // the feed publishes nothing, which is not a day every shed came down
const CORRECTED_DAY = 40;
const GRAPH_HASH = "a362598948ca0eb3";

function isoDay(day: number): string {
  return new Date(START_MS + day * DAY_MS).toISOString().slice(0, 10);
}

// Job numbers shaped like the DOB's: a nine-digit BIS number first, then DOB NOW numbers.
const PERMITS = [
  "always",
  "brief",
  "ending",
  "flapping",
  "late",
  "returning",
  ...Array.from({ length: FILLERS }, (_, filler) => `filler${filler}`),
];

function jobFor(name: string): string {
  const order = PERMITS.indexOf(name);
  if (order < 0) {
    throw new Error(`${name} is not one of the feed's permits`);
  } else if (order === 0) {
    return "104416464";
  } else {
    return `M${String(1_000 + order).padStart(8, "0")}-I1`;
  }
}

function rowFor(job: string, feet: number): SnapshotRow {
  return {
    bin: `10000${job.length.toString().padStart(2, "0")}`,
    street: `${job.toUpperCase()} STREET`,
    houseNumber: "100",
    linearFeet: String(feet),
    lat: "40.712345",
    lng: "-74.005678",
    boroughDigit: "1",
    block: "01234",
    lot: "0001",
    firstPermitDate: "2/22/2019",
  };
}

function snapshotFor(day: number): DatedSnapshot | null {
  if (day === SILENT_DAY) {
    return null;
  }
  const names = day === TRUNCATED_DAY ? ["always", "filler0"] : ["always"];
  if (day !== TRUNCATED_DAY) {
    for (let filler = 0; filler < FILLERS; filler++) {
      names.push(`filler${filler}`);
    }
    if (day <= 20 || day >= 30) {
      names.push("flapping"); // nine days away, well inside the fortnight the client forgives
    }
    if (day <= 10) {
      names.push("brief"); // this one really did come down
    }
    if (day <= 60 || day >= 100) {
      names.push("returning"); // and this one came back, far too late to be the same shed
    }
    if (day <= 95) {
      names.push("ending");
    }
    if (day >= 118) {
      names.push("late");
    }
  }
  const rows = new Map<string, SnapshotRow>();
  for (const name of names) {
    const corrected = name === "always" && day >= CORRECTED_DAY;
    rows.set(jobFor(name), rowFor(jobFor(name), corrected ? 88 : 40));
  }
  return { date: isoDay(day), rows, garbled: [] };
}

const feed = Array.from({ length: DAYS }, (_, day) => snapshotFor(day));

// Two spans derived from street and length, so a re-read reading's placement is visible.
function placeFake(records: readonly ShedFileRecord[]): void {
  for (const record of records) {
    let hash = 0;
    for (const character of `${record.street}/${record.feet}`) {
      hash = (hash * 31 + character.charCodeAt(0)) % 100_000;
    }
    record.spans = [
      { sourceId: hash + 7, side: 3, ordinal: 1, t0: 0, t1: 255, depth: 18 },
      { sourceId: hash, side: 1, ordinal: 0, t0: 10, t1: 200, depth: 0 },
    ];
    record.confidence = 128 + (hash % 100);
  }
}

// What update-sheds does with a file and the feed so far: advance, place the unplaced, write.
function advance(
  text: string | null,
  through: number,
): { text: string; unplaced: Set<string> } {
  const file = text === null ? emptyShedFile("nyc") : parseShedFile(text);
  const walk = startWalk(file);
  for (const snapshot of feed.slice(0, through + 1)) {
    if (snapshot !== null) {
      advanceSheds(walk, snapshot);
    }
  }
  const advanced = finishWalk(walk);
  placeFake(advanced.records.filter((record) => walk.unplaced.has(record.job)));
  advanced.keySpace = GRAPH_HASH;
  return { text: serializeShedFile(advanced), unplaced: walk.unplaced };
}

function recordOf(text: string, name: string): ShedFileRecord | undefined {
  return parseShedFile(text).records.find(
    (record) => record.job === jobFor(name),
  );
}

test("the walk records the traps the synthetic feed carries", () => {
  const { text } = advance(null, DAYS - 1);
  const file = parseShedFile(text);

  expect(file.through).toBe(isoDay(DAYS - 1));
  expect(file.seen).toBe(isoDay(DAYS - 1));
  // Read literally, a silent day or a truncated write would close every standing permit.
  expect(recordOf(text, "always")?.runs).toEqual([
    { first: isoDay(0), last: null },
  ]);
  expect(recordOf(text, "filler1")?.runs).toHaveLength(1);
  // Runs are stored as seen; the client merges the nine-day gap.
  expect(recordOf(text, "flapping")?.runs).toEqual([
    { first: isoDay(0), last: isoDay(20) },
    { first: isoDay(30), last: null },
  ]);
  expect(recordOf(text, "brief")?.runs).toEqual([
    { first: isoDay(0), last: isoDay(10) },
  ]);
  expect(recordOf(text, "returning")?.runs).toEqual([
    { first: isoDay(0), last: isoDay(60) },
    { first: isoDay(100), last: null },
  ]);
  expect(recordOf(text, "always")?.feet).toBe(88);
  expect(recordOf(text, "always")?.bbl).toBe("1/01234/0001");
  expect(recordOf(text, "always")?.firstPermit).toBe("2019-02-22");
  expect(file.records.map((record) => record.job)).toEqual(
    PERMITS.map(jobFor).sort(),
  );
  expect(serializeShedFile(file)).toBe(text);
});

test("a day at a time, one jump and a walk from the start write the same file", () => {
  const whole = advance(null, DAYS - 1).text;
  for (const start of [DAYS - 5, DAYS - 20, DAYS - 45, DAYS - 80]) {
    let stepped = advance(null, start).text;
    for (let day = start + 1; day < DAYS; day++) {
      stepped = advance(stepped, day).text;
    }
    const jumped = advance(advance(null, start).text, DAYS - 1).text;
    expect({ start, stepped }).toEqual({ start, stepped: whole });
    expect({ start, jumped }).toEqual({ start, jumped: whole });
  }
});

test("running twice in one day writes the same bytes and places nothing", () => {
  const once = advance(null, DAYS - 1).text;
  const twice = advance(once, DAYS - 1);
  expect(twice.text).toBe(once);
  expect(twice.unplaced.size).toBe(0);
});

test("a truncated day moves `through` but not `seen`, and closes nothing", () => {
  const before = advance(null, TRUNCATED_DAY - 1).text;
  const file = parseShedFile(advance(before, TRUNCATED_DAY).text);
  expect(file.through).toBe(isoDay(TRUNCATED_DAY));
  expect(file.seen).toBe(isoDay(TRUNCATED_DAY - 1));
  expect(file.counts.at(-1)).toBe(2);
  expect(file.records.map((record) => record.runs)).toEqual(
    parseShedFile(before).records.map((record) => record.runs),
  );
});

test("the truncation window holds the last thirty judged days, dropped ones too", () => {
  const counts = parseShedFile(advance(null, TRUNCATED_DAY + 5).text).counts;
  expect(counts).toHaveLength(TRUNCATION_NEIGHBORS);
  expect(counts).toContain(2);
});

test("a snapshot dated on or before `through` is skipped", () => {
  const text = advance(null, 50).text;
  const walk = startWalk(parseShedFile(text));
  const sameDay = snapshotFor(50) as DatedSnapshot;
  sameDay.rows.delete(jobFor("always"));
  advanceSheds(walk, snapshotFor(10) as DatedSnapshot);
  advanceSheds(walk, sameDay);
  expect(walk.skipped).toBe(2);
  expect(serializeShedFile(finishWalk(walk))).toBe(text);
});

test("a correction re-places only its own job", () => {
  const before = advance(null, CORRECTED_DAY - 1).text;
  const { text, unplaced } = advance(before, CORRECTED_DAY);
  expect([...unplaced]).toEqual([jobFor("always")]);
  expect(recordOf(text, "always")?.spans).not.toEqual(
    recordOf(before, "always")?.spans,
  );
  expect(recordOf(text, "filler3")?.spans).toEqual(
    recordOf(before, "filler3")?.spans,
  );
  // A house number alone moves no placement.
  const walk = startWalk(parseShedFile(text));
  const renumbered = snapshotFor(CORRECTED_DAY + 1) as DatedSnapshot;
  const row = renumbered.rows.get(jobFor("filler3")) as SnapshotRow;
  renumbered.rows.set(jobFor("filler3"), { ...row, houseNumber: "102" });
  advanceSheds(walk, renumbered);
  expect(walk.unplaced.size).toBe(0);
  expect(walk.records.get(jobFor("filler3"))?.house).toBe("102");
});

// The day after `base`, with `garble`'s rows under a mangled job number and `extra` added.
function garbledDay(
  base: string,
  garble: readonly string[],
  extra: readonly GarbledRow[] = [],
): { file: ShedFile; snapshot: DatedSnapshot } {
  const file = parseShedFile(base);
  const day = feed.findIndex((snapshot) => snapshot?.date === file.through);
  const snapshot = snapshotFor(day + 1) as DatedSnapshot;
  const garbled = [...extra];
  for (const name of garble) {
    garbled.push({
      job: "METAL & WOOD",
      row: snapshot.rows.get(jobFor(name)) as SnapshotRow,
    });
    snapshot.rows.delete(jobFor(name));
  }
  return { file, snapshot: { ...snapshot, garbled } };
}

// Gives filler4 always's address, so a row at it has two permits to choose from.
function twinned(text: string): string {
  const file = parseShedFile(text);
  const byName = (name: string): ShedFileRecord =>
    file.records.find(
      (record) => record.job === jobFor(name),
    ) as ShedFileRecord;
  byName("filler4").bin = byName("always").bin;
  byName("filler4").street = byName("always").street;
  return serializeShedFile(file);
}

function lastRun(walk: ReturnType<typeof startWalk>, name: string) {
  return walk.records.get(jobFor(name))?.runs.at(-1);
}

test("a garbled row continues the one permit that matches it", () => {
  const { file, snapshot } = garbledDay(advance(null, 50).text, ["always"]);
  const walk = startWalk(file);
  advanceSheds(walk, snapshot);
  expect(walk.records.get(jobFor("always"))?.runs).toEqual([
    { first: isoDay(0), last: null },
  ]);
  expect(walk.records.has("METAL & WOOD")).toBe(false);
});

test("a garbled row matching no permit, several, or one listed that day is dropped", () => {
  const base = advance(null, 50).text;
  const stranger: GarbledRow = {
    job: "METAL & WOOD",
    row: { ...rowFor("nobody", 40), bin: "9999999" },
  };
  const listed: GarbledRow = {
    job: "METAL & WOOD",
    row: rowFor(jobFor("filler2"), 40),
  };
  for (const { file, snapshot } of [
    garbledDay(base, [], [stranger]),
    garbledDay(base, [], [listed]),
  ]) {
    const walk = startWalk(file);
    advanceSheds(walk, snapshot);
    expect(walk.records.size).toBe(file.records.length);
    expect(walk.records.get(jobFor("filler2"))?.runs).toHaveLength(1);
    expect(lastRun(walk, "filler2")?.last).toBeNull();
  }
  // Neither twin is listed, so the row can't say which it is, and both close.
  const { file, snapshot } = garbledDay(twinned(base), ["always"]);
  snapshot.rows.delete(jobFor("filler4"));
  const walk = startWalk(file);
  advanceSheds(walk, snapshot);
  expect(lastRun(walk, "always")?.last).toBe(isoDay(50));
  expect(lastRun(walk, "filler4")?.last).toBe(isoDay(50));
});

test("two garbled rows on one day each claim their own permit", () => {
  const { file, snapshot } = garbledDay(advance(null, 50).text, [
    "always",
    "filler7",
  ]);
  const walk = startWalk(file);
  advanceSheds(walk, snapshot);
  expect(lastRun(walk, "always")).toEqual({ first: isoDay(0), last: null });
  expect(lastRun(walk, "filler7")).toEqual({ first: isoDay(0), last: null });
  expect(walk.records.size).toBe(file.records.length);
});

test("a permit first seen garbled is dropped", () => {
  const { file, snapshot } = garbledDay(advance(null, 117).text, ["late"]);
  const walk = startWalk(file);
  advanceSheds(walk, snapshot);
  expect(walk.records.has(jobFor("late"))).toBe(false);
  expect(walk.records.size).toBe(file.records.length);
});

test("a rebuild from the feed refuses to drop days the file holds", () => {
  const whole = parseShedFile(advance(null, DAYS - 1).text);
  const late: ShedFile = {
    ...whole,
    records: whole.records.map((record) => ({
      ...record,
      runs: [{ first: isoDay(5), last: null }],
    })),
  };
  expect(truncationOf(null, whole)).toBeNull();
  expect(truncationOf(whole, whole)).toBeNull();
  expect(truncationOf(late, whole)).toBeNull();
  expect(truncationOf(whole, late)).toContain(isoDay(0));
  expect(truncationOf(whole, late)).toContain("--force");
});

test("a file is only extended against the graph it names", () => {
  const file = parseShedFile(advance(null, DAYS - 1).text);

  expect(shedGraphMismatch(file, GRAPH_HASH)).toBeNull();
  // Carrying records forward under a new hash would put them on whatever edge their keys now name.
  const other = shedGraphMismatch(file, "0123456789abcdef");
  expect(other).toContain(GRAPH_HASH);
  expect(other).toContain("0123456789abcdef");
});

test("a deployed graph this checkout cannot read skips the day", async () => {
  // The daily job commits the timetables too, so a format lag must cost sheds, not departures.
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const logged: string[] = [];
  console.error = (...parts: unknown[]) => {
    logged.push(parts.map(String).join(" "));
  };
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3, 4])),
      )) as typeof fetch;
    expect(await loadDeployedGraph()).toBeNull();
    globalThis.fetch = (() =>
      Promise.resolve(new Response(null, { status: 404 }))) as typeof fetch;
    expect(await loadDeployedGraph()).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
  expect(logged[1]).toContain("not a graph this checkout can read");
  expect(logged[1]).toContain("leaving the file alone");
  expect(logged[3]).toContain("404");
  expect(logged[3]).toContain("leaving the file alone");
});

// Cron skips and DOB feed gaps mean updates can't assume yesterday; any start must match a full rebuild.

import { expect, test } from "bun:test";
import {
  byJobNumber,
  encodedShedsOf,
  isProvisional,
  placementAttributes,
} from "../../scripts/build-sheds";
import {
  decodeShedArtifact,
  type EncodedShed,
  encodeSheds,
  shedDayOf,
  shedGraphMismatch,
} from "../../scripts/shed-encode";
import {
  type DatedSnapshot,
  finishFold,
  foldSnapshot,
  MERGE_TOLERANCE_DAYS,
  mergeIntervals,
  resumeFrom,
  type ShedAttributes,
  type ShedInterval,
  type ShedPermit,
  type ShedWalk,
  type SnapshotRow,
  startFold,
  TRUNCATION_NEIGHBORS,
} from "../../scripts/shed-permits";
import {
  loadDeployedGraph,
  reconcileSheds,
  standingOn,
} from "../../scripts/update-sheds";

const DAY_MS = 86_400_000;
const START_MS = Date.UTC(2020, 0, 1);
const DAYS = 120;
const FILLERS = 20; // permits that are simply always there, so the row count has a stable median
const TRUNCATED_DAY = 85; // a partial write: two rows where there should be two dozen
const SILENT_DAY = 90; // the feed publishes nothing, which is not a day every shed came down
const GRAPH_HASH = "a362598948ca0eb3";

function isoDay(day: number): string {
  return new Date(START_MS + day * DAY_MS).toISOString().slice(0, 10);
}

// The feed's day 0 is 2020-01-01 but the artifact's is 2017-12-28.
function feedDay(shedDay: number): number {
  return shedDay - shedDayOf(isoDay(0));
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
      names.push("flapping"); // nine days away, well inside the fortnight the merge forgives
    }
    if (day <= 10) {
      names.push("brief"); // this one really did come down
    }
    if (day <= 60 || day >= 100) {
      names.push("returning"); // and this one came back, far too late to be the same shed
    }
    if (day <= 95) {
      names.push("ending"); // still up when a rewound artifact was written, down by the time it updates
    }
    if (day >= 118) {
      names.push("late"); // first seen inside the window the update re-derives
    }
  }
  const rows = new Map<string, SnapshotRow>();
  for (const name of names) {
    // A correction must carry forward into a standing permit, but not into an already-closed stint.
    const corrected =
      (name === "always" && day >= 40) || (name === "returning" && day >= 100);
    rows.set(jobFor(name), rowFor(jobFor(name), corrected ? 88 : 40));
  }
  return { date: isoDay(day), rows };
}

const feed = Array.from({ length: DAYS }, (_, day) => snapshotFor(day));

// `from` is "" for the whole feed; `before` is the window the updated artifact handed over.
function walk(through: number, from = "", before: number[] = []): ShedWalk {
  const fold = startFold(from, before);
  for (const snapshot of feed.slice(0, through + 1)) {
    if (snapshot !== null) {
      foldSnapshot(fold, snapshot);
    }
  }
  const walked = finishFold(fold);
  walked.permits.sort(byJobNumber);
  return walked;
}

// Two spans per record, derived from street and length, so a corrected reading's placement is visible.
function coverageOf(attributes: ShedAttributes): {
  spans: {
    sourceId: number;
    side: number;
    ordinal: number;
    t0: number;
    t1: number;
    depth: number;
  }[];
  confidence: number;
} {
  let hash = 0;
  for (const character of `${attributes.street}/${attributes.linearFeet}`) {
    hash = (hash * 31 + character.charCodeAt(0)) % 100_000;
  }
  return {
    spans: [
      { sourceId: hash, side: 1, ordinal: 0, t0: 10, t1: 200, depth: 0 },
      {
        sourceId: hash + 7,
        side: 3,
        ordinal: 1,
        t0: 0,
        t1: 255,
        depth: 18 + (hash % 62),
      },
    ],
    confidence: 128 + (hash % 100),
  };
}

function build(through: number) {
  const { permits, counts } = walk(through);
  const day = shedDayOf(isoDay(through));
  return encodeSheds(
    encodedShedsOf(permits, (interval) => coverageOf(interval.attributes), day),
    GRAPH_HASH,
    day,
    counts,
  );
}

function update(from: ReturnType<typeof build>, through: number) {
  const artifact = decodeShedArtifact(from.open, from.closed);
  const reached = feedDay(artifact.lastDay);
  const { permits, counts } = walk(
    through,
    resumeFrom(isoDay(reached)),
    artifact.counts,
  );
  const standing = new Set(
    standingOn(permits, isoDay(reached)).map((permit) => permit.job),
  );
  const fresh = permits.filter(
    (permit) => !standing.has(permit.job) || permit.corrected,
  );
  const placed = new Map(
    placementAttributes(fresh).map((reading) => [reading, coverageOf(reading)]),
  );
  const day = shedDayOf(isoDay(through));
  return encodeSheds(
    reconcileSheds(artifact, permits, isoDay(through), placed),
    GRAPH_HASH,
    day,
    counts,
  );
}

function days(intervals: readonly ShedInterval[]) {
  return intervals.map(({ first, last, open }) => ({ first, last, open }));
}

test("the synthetic feed carries the traps it is meant to", () => {
  const byJob = new Map(
    walk(DAYS - 1).permits.map((permit) => [permit.job, permit]),
  );

  // Read literally, a silent day or a truncated write would close every standing permit.
  expect(days(byJob.get(jobFor("always"))?.runs ?? [])).toEqual([
    { first: isoDay(0), last: isoDay(DAYS - 1), open: true },
  ]);
  expect(byJob.get(jobFor("filler1"))?.runs).toHaveLength(1);

  // A nine-day disappearance is two runs on record but one standing shed to a query.
  expect(byJob.get(jobFor("flapping"))?.runs).toHaveLength(2);
  expect(
    days(mergeIntervals(byJob.get(jobFor("flapping"))?.runs ?? [])),
  ).toEqual([{ first: isoDay(0), last: isoDay(DAYS - 1), open: true }]);
  expect(days(mergeIntervals(byJob.get(jobFor("brief"))?.runs ?? []))).toEqual([
    { first: isoDay(0), last: isoDay(10), open: false },
  ]);
  const returning = mergeIntervals(byJob.get(jobFor("returning"))?.runs ?? []);
  expect(returning).toHaveLength(2);
  expect(byJob.get(jobFor("always"))?.linearFeet).toBe(88);
  expect(byJob.get(jobFor("returning"))?.linearFeet).toBe(88);
  expect(returning.map((interval) => interval.attributes.linearFeet)).toEqual([
    40, 88,
  ]);
});

test("open.bin names every standing permit, in job order", () => {
  // The update reads record ownership from the file; the feed only has to agree.
  const through = DAYS - 1;
  const { permits } = walk(through);
  const day = shedDayOf(isoDay(through));
  const standing = standingOn(permits, isoDay(through));
  const artifact = decodeShedArtifact(
    build(through).open,
    build(through).closed,
  );

  expect(standing.map((permit) => permit.job)).toEqual(
    [...standing].map((permit) => permit.job).sort(),
  );
  expect(artifact.open).toHaveLength(standing.length);
  for (const [order, permit] of standing.entries()) {
    const { spans, confidence } = coverageOf(permit);
    // Both job-number shapes survive the header's delta chain.
    expect(artifact.open[order].job).toBe(permit.job);
    expect(artifact.open[order].spans).toEqual(spans);
    expect(artifact.open[order].confidence).toBe(confidence);
  }
  expect(artifact.open.map((record) => record.job)).toContain("104416464");
  for (const permit of permits) {
    const provisional = mergeIntervals(permit.runs).filter((interval) =>
      isProvisional(shedDayOf(interval.last), day),
    );
    expect(provisional.length).toBe(standing.includes(permit) ? 1 : 0);
  }
});

test("a standing permit open.bin does not name stops the run", () => {
  // A record missing from the file would otherwise be re-placed as new, with the wrong first day.
  const artifact = decodeShedArtifact(
    build(DAYS - 1).open,
    build(DAYS - 1).closed,
  );
  const short = {
    ...artifact,
    open: artifact.open.filter((record) => record.job !== jobFor("flapping")),
  };

  expect(() =>
    reconcileSheds(short, walk(DAYS - 1).permits, isoDay(DAYS - 1), new Map()),
  ).toThrow(jobFor("flapping"));
});

// The real feed agrees (300-, 177-, 60- and 29-day chains), but that takes a 370 MB clone.
test("an update lands on a full rebuild wherever the replay started", () => {
  const rebuilt = build(DAYS - 1);

  for (const start of [DAYS - 5, DAYS - 20, DAYS - 45, DAYS - 80]) {
    let replayed = build(start);
    for (let day = start + 1; day < DAYS; day++) {
      replayed = update(replayed, day);
    }
    expect({ start, ...replayed }).toEqual({ start, ...rebuilt });
  }
});

test("the truncation window travels in the artifact", () => {
  // The truncated write is dropped against its thirty neighbors but believed against none.
  const artifact = decodeShedArtifact(
    build(TRUNCATED_DAY + MERGE_TOLERANCE_DAYS - 1).open,
    build(TRUNCATED_DAY + MERGE_TOLERANCE_DAYS - 1).closed,
  );
  expect(artifact.counts).toHaveLength(TRUNCATION_NEIGHBORS);
  expect(resumeFrom(isoDay(TRUNCATED_DAY + MERGE_TOLERANCE_DAYS - 1))).toBe(
    isoDay(TRUNCATED_DAY),
  );

  const seeded = startFold(isoDay(TRUNCATED_DAY), artifact.counts);
  const blind = startFold(isoDay(TRUNCATED_DAY));
  for (const fold of [seeded, blind]) {
    for (const snapshot of feed) {
      if (snapshot !== null) {
        foldSnapshot(fold, snapshot);
      }
    }
    finishFold(fold);
  }
  expect(seeded.window.dropped).toBe(1);
  expect(blind.window.dropped).toBe(0);
});

test("catching up after a month idle lands where running daily would have", () => {
  const daily = build(DAYS - 1);
  const caughtUp = update(build(DAYS - 31), DAYS - 1);

  expect(caughtUp.open).toEqual(daily.open);
  expect(caughtUp.closed).toEqual(daily.closed);
  expect(caughtUp.index).toEqual(daily.index);
});

test("an update applied a day at a time agrees with one that jumped", () => {
  let stepped = build(DAYS - 31);
  for (let day = DAYS - 30; day < DAYS; day++) {
    stepped = update(stepped, day);
  }
  const jumped = update(build(DAYS - 31), DAYS - 1);

  expect(stepped.open).toEqual(jumped.open);
  expect(stepped.closed).toEqual(jumped.closed);
  expect(stepped.index).toEqual(jumped.index);
});

test("running twice in one day is a no-op", () => {
  const once = update(build(DAYS - 31), DAYS - 1);
  const twice = update(once, DAYS - 1);

  expect(twice.open).toEqual(once.open);
  expect(twice.closed).toEqual(once.closed);
  expect(twice.index).toEqual(once.index);
});

test("closed.bin is only ever appended to", () => {
  const before = decodeShedArtifact(
    build(DAYS - 31).open,
    build(DAYS - 31).closed,
  );
  const after = update(build(DAYS - 31), DAYS - 1);
  const grown = decodeShedArtifact(after.open, after.closed);

  expect(grown.closed.length).toBeGreaterThan(before.closed.length);
  expect(grown.closed.slice(0, before.closed.length)).toEqual(before.closed);
  // Sound only because nothing already down can close again later.
  const oldest = before.closed.map((record) => record.close as number);
  for (const record of grown.closed.slice(before.closed.length)) {
    expect(record.close as number).toBeGreaterThan(Math.max(...oldest));
  }
});

test("a permit that comes back long after it came down is a second record", () => {
  const artifact = decodeShedArtifact(
    build(DAYS - 1).open,
    build(DAYS - 1).closed,
  );
  const returning = walk(DAYS - 1).permits.find(
    (permit) => permit.job === jobFor("returning"),
  ) as ShedPermit;
  const intervals = mergeIntervals(returning.runs);

  expect(intervals).toHaveLength(2);
  const records = [...artifact.open, ...artifact.closed];
  for (const interval of intervals) {
    const { spans } = coverageOf(interval.attributes);
    const found = records.filter(
      (record: EncodedShed) =>
        JSON.stringify(record.spans) === JSON.stringify(spans),
    );
    expect(found).toHaveLength(1);
    expect(found[0].first).toBe(shedDayOf(interval.first));
  }
});

test("an artifact is only extended against the graph it names", () => {
  const artifact = decodeShedArtifact(
    build(DAYS - 1).open,
    build(DAYS - 1).closed,
  );

  expect(shedGraphMismatch(artifact, GRAPH_HASH)).toBeNull();
  // Carrying records forward under a new hash would put them on whatever edge their keys now name.
  const other = shedGraphMismatch(artifact, "0123456789abcdef");
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
  expect(logged[1]).toContain("leaving the artifact alone");
  expect(logged[3]).toContain("404");
  expect(logged[3]).toContain("leaving the artifact alone");
});

import { afterAll, beforeEach, expect, test } from "bun:test";
import { encodeSheds, graphHashOf } from "../../scripts/shed-encode";
import { cityById } from "../cities";
import {
  clearEdgePathCache,
  NO_GEOMETRY,
  NO_SOURCE_ID,
  type RoutingGraph,
} from "./graph";
import { sunAt } from "./shade";
import {
  computeEdgeSheds,
  DECK_HEIGHT_METERS,
  DEFAULT_DECK_DEPTH_METERS,
  decodeSheds,
  type EdgeDeck,
  MIN_DECK_DEPTH_METERS,
  SHED_OBLIQUE_FLOOR,
  SHED_URLS,
  type Shed,
  type ShedField,
  type ShedHistory,
  setShedSun,
  shedCoverage,
  shedDay,
  shedField,
  shedShade,
  shedsOn,
} from "./sheds";
import {
  CLOSED_BASE64,
  COVERAGE,
  FIXTURE_EDGES,
  type FixtureShed,
  fixtureDepth,
  fixtureDurable,
  fixtureJob,
  GRAPH_KEY_HASH,
  INDEX_BASE64,
  LAST_DAY,
  OPEN_BASE64,
  SHEDS,
} from "./sheds.fixture";

// Expected records come from the prototype's CSV, not an encoder; the blobs are only regression pins.

function buffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

const history = decodeSheds(
  buffer(OPEN_BASE64),
  buffer(CLOSED_BASE64),
  buffer(INDEX_BASE64),
);

const DURABLE_SHEDS = SHEDS.map((shed, order) => ({
  job: fixtureJob(order),
  first: shed.first,
  close: shed.close,
  confidence: shed.confidence,
  spans: shed.spans.map((span) => ({
    ...fixtureDurable(span.edge),
    t0: span.t0,
    t1: span.t1,
    depth: fixtureDepth(span.edge),
  })),
}));

const DEGREES = Math.PI / 180;
const MIDTOWN = { lat: 40.75, lng: -73.98 };
const QUANTUM = 1e-6;
const SIDE_SHIFT = 3; // the graph's kind-and-side byte, bits 3-5

// Geometry-less straight edges named with the fixture's key space, or nothing would resolve onto it.
function straightGraph(edgeCount: number, ...bearings: number[]): RoutingGraph {
  const nodeQx = new Int32Array(edgeCount + 1);
  const nodeQy = new Int32Array(edgeCount + 1);
  const edgeNodeA = new Uint32Array(edgeCount);
  const edgeNodeB = new Uint32Array(edgeCount);
  const span = 0.001; // degrees of latitude
  for (let edge = 0; edge < edgeCount; edge++) {
    const bearing = bearings[edge % bearings.length] * DEGREES;
    nodeQx[edge + 1] = Math.round(
      (span * Math.sin(bearing)) / Math.cos(MIDTOWN.lat * DEGREES) / QUANTUM,
    );
    nodeQy[edge + 1] = Math.round((span * Math.cos(bearing)) / QUANTUM);
    edgeNodeA[edge] = 0;
    edgeNodeB[edge] = edge + 1;
  }
  return {
    keyHash: GRAPH_KEY_HASH,
    edgeCount,
    nodeCount: edgeCount + 1,
    originLat: MIDTOWN.lat,
    originLng: MIDTOWN.lng,
    scale: QUANTUM,
    nodeQx,
    nodeQy,
    edgeNodeA,
    edgeNodeB,
    edgeGeomOffset: new Uint32Array(edgeCount).fill(NO_GEOMETRY),
    edgeGeomCount: new Uint16Array(edgeCount),
  } as unknown as RoutingGraph;
}

// A key placed outside the graph exercises a span with no edge.
function movedGraph(
  edgeCount: number,
  place: (edge: number) => number,
): RoutingGraph {
  const graph = straightGraph(edgeCount, 0);
  graph.edgeSourceId = new Uint32Array(edgeCount).fill(NO_SOURCE_ID);
  graph.edgeOrdinal = new Uint8Array(edgeCount);
  graph.edgeKindSide = new Uint8Array(edgeCount);
  for (const edge of FIXTURE_EDGES) {
    const at = place(edge);
    if (at >= 0 && at < edgeCount) {
      const { sourceId, side, ordinal } = fixtureDurable(edge);
      graph.edgeSourceId[at] = sourceId;
      graph.edgeOrdinal[at] = ordinal;
      graph.edgeKindSide[at] = side << SIDE_SHIFT;
    }
  }
  return graph;
}

function namedGraph(edgeCount: number): RoutingGraph {
  return movedGraph(edgeCount, (edge) => edge);
}

const EDGE_COUNT = Math.max(...FIXTURE_EDGES) + 1;
const graph = namedGraph(EDGE_COUNT);

// The oracle the seek-and-suffix decode is checked against.
function standingOn(day: number): FixtureShed[] {
  return SHEDS.filter(
    (shed) => shed.first <= day && (shed.close === null || shed.close >= day),
  );
}

// Spans sorted by edge on both sides; the stored durable-key order isn't asserted.
function normalize(sheds: readonly Shed[]): string {
  return JSON.stringify(
    sheds
      .map((shed) => ({
        ...shed,
        spans: [...shed.spans].sort((left, right) => left.edge - right.edge),
      }))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
  );
}

function fromFixture(sheds: FixtureShed[]): string {
  return normalize(
    sheds.map((shed) => ({
      first: shed.first,
      close: shed.close,
      confidence: shed.confidence / 255,
      spans: shed.spans.map(({ edge, t0, t1 }) => ({
        edge,
        t0: t0 / 255,
        t1: t1 / 255,
        depth: fixtureDepth(edge) / 10,
      })),
    })),
  );
}

function fromReader(sheds: Shed[]): string {
  return normalize(sheds);
}

test("the header describes the two halves it was written with", () => {
  expect(history.graphKeyHash).toBe(GRAPH_KEY_HASH);
  const open = SHEDS.filter((shed) => shed.close === null);
  const closed = SHEDS.filter((shed) => shed.close !== null);
  expect(history.open.count).toBe(open.length);
  expect(history.closed.count).toBe(closed.length);
  expect(history.open.spanCount).toBe(
    open.reduce((total, shed) => total + shed.spans.length, 0),
  );
  expect(history.closed.spanCount).toBe(
    closed.reduce((total, shed) => total + shed.spans.length, 0),
  );
});

test("the encoder writes the bytes checked in beside the records", () => {
  const rebuilt = encodeSheds(DURABLE_SHEDS, GRAPH_KEY_HASH, LAST_DAY);
  expect(rebuilt.open).toEqual(new Uint8Array(buffer(OPEN_BASE64)));
  expect(rebuilt.closed).toEqual(new Uint8Array(buffer(CLOSED_BASE64)));
  expect(rebuilt.index).toEqual(new Uint8Array(buffer(INDEX_BASE64)));
});

test("the daily job's window in the header moves the records, not the answers", () => {
  // 60 bytes of daily-job state in closed.bin's header must shift every index.bin offset.
  const counts = Array.from({ length: 30 }, (_, order) => 8_900 + order);
  const withWindow = encodeSheds(
    DURABLE_SHEDS,
    GRAPH_KEY_HASH,
    LAST_DAY,
    counts,
  );
  const bare = encodeSheds(DURABLE_SHEDS, GRAPH_KEY_HASH, LAST_DAY);

  expect(withWindow.closed.length).toBe(bare.closed.length + 2 * counts.length);
  expect(withWindow.open).toEqual(bare.open);
  const offsetsOf = (index: Uint8Array): number[] => {
    const view = new DataView(index.buffer as ArrayBuffer);
    return Array.from({ length: index.length / 8 }, (_, entry) =>
      view.getUint32(entry * 8 + 2, true),
    );
  };
  expect(offsetsOf(withWindow.index)).toEqual(
    offsetsOf(bare.index).map((offset) => offset + 2 * counts.length),
  );
  const shifted = decodeSheds(
    withWindow.open.buffer as ArrayBuffer,
    withWindow.closed.buffer as ArrayBuffer,
    withWindow.index.buffer as ArrayBuffer,
  );
  for (const day of COVERAGE.map((entry) => entry.day)) {
    expect(fromReader(shedsOn(graph, shifted, day))).toBe(
      fromFixture(standingOn(day)),
    );
  }
});

test("the two halves are rejected in the wrong order", () => {
  expect(() =>
    decodeSheds(
      buffer(CLOSED_BASE64),
      buffer(OPEN_BASE64),
      buffer(INDEX_BASE64),
    ),
  ).toThrow();
});

test("a shed decodes on the first and last day it stood, and not around them", () => {
  for (const shed of SHEDS) {
    for (const day of [shed.first, shed.close ?? shed.first + 1]) {
      expect(fromReader(shedsOn(graph, history, day))).toBe(
        fromFixture(standingOn(day)),
      );
    }
    expect(
      shedsOn(graph, history, shed.first - 1).map((decoded) => decoded.first),
    ).not.toContain(shed.first);
  }
});

function probeDays(): Set<number> {
  const days = new Set<number>();
  for (const shed of SHEDS) {
    for (const day of [shed.first - 1, shed.first, shed.first + 1]) {
      days.add(day);
    }
    if (shed.close !== null) {
      for (const day of [shed.close - 1, shed.close, shed.close + 1]) {
        days.add(day);
      }
    }
  }
  for (const month of history.months) {
    days.add(month);
    days.add(month - 1);
  }
  return days;
}

// Seeking must re-base the close-day chain from the index and restart each record's edge deltas.
test("seeking to a past day decodes the records the file was built from", () => {
  expect(history.months.length).toBeGreaterThan(1); // or the seek is never exercised
  for (const day of probeDays()) {
    expect(fromReader(shedsOn(graph, history, day))).toBe(
      fromFixture(standingOn(day)),
    );
  }
});

// Reversing the edge order is as thorough a renumbering as there is.
test("a shed lands on the same street after a rebuild renumbers every edge", () => {
  const rebuilt = movedGraph(EDGE_COUNT, (edge) => EDGE_COUNT - 1 - edge);
  let moved = 0;
  for (const day of probeDays()) {
    const before = shedsOn(graph, history, day);
    const after = shedsOn(rebuilt, history, day);
    expect(after.length).toBe(before.length);
    for (let record = 0; record < before.length; record++) {
      const positions = after[record].spans.map((span) => span.edge);
      expect(positions).toEqual(
        before[record].spans.map((span) => {
          moved += 1;
          return EDGE_COUNT - 1 - span.edge;
        }),
      );
      expect(positions).not.toContain(-1);
    }
  }
  expect(moved).toBeGreaterThan(0); // or the renumbering was never exercised
});

// Wrong-but-invisible scaffolding is worse than a blank map.
test("an artifact placed against another key space resolves no span at all", () => {
  const stale: ShedHistory = { ...history, graphKeyHash: "0000000000000000" };
  let resolved = 0;
  for (const day of probeDays()) {
    expect(shedsOn(graph, stale, day)).toEqual([]);
    expect(shedCoverage(graph, stale, day).size).toBe(0);
    for (const shed of shedsOn(graph, history, day)) {
      resolved += shed.spans.length;
    }
  }
  expect(resolved).toBeGreaterThan(0); // or the matching graph resolves nothing either
});

test("the index seek agrees with a full linear scan", () => {
  // No index, so every seek starts at the head; a disagreement is the seek's.
  const scanned: ShedHistory = {
    ...history,
    months: new Uint16Array(0),
    offsets: new Uint32Array(0),
    closeDays: new Uint16Array(0),
  };
  for (const day of probeDays()) {
    expect(fromReader(shedsOn(graph, history, day))).toBe(
      fromReader(shedsOn(graph, scanned, day)),
    );
  }
});

test("coverage per edge matches the encoder's own day scan", () => {
  for (const { day, edges } of COVERAGE) {
    const decks = shedCoverage(graph, history, day);
    expect([...decks.keys()].sort((left, right) => left - right)).toEqual(
      edges.map(([edge]) => edge),
    );
    for (const [edge, fraction] of edges) {
      expect(decks.get(edge)?.covered).toBeCloseTo(fraction, 10);
    }
  }
});

test("an edge's depth is its spans' own, weighted by the length they cover", () => {
  let shared = 0;
  for (const { day } of COVERAGE) {
    const decks = shedCoverage(graph, history, day);
    const weight = new Map<number, number>();
    const total = new Map<number, number>();
    for (const shed of standingOn(day)) {
      for (const span of shed.spans) {
        const along = (span.t1 - span.t0) / 255;
        if (fixtureDepth(span.edge) > 0) {
          weight.set(span.edge, (weight.get(span.edge) ?? 0) + along);
          total.set(
            span.edge,
            (total.get(span.edge) ?? 0) +
              (along * fixtureDepth(span.edge)) / 10,
          );
        }
      }
    }
    for (const [edge, covered] of weight) {
      shared += covered > 1 ? 1 : 0;
      expect(decks.get(edge)?.depth).toBeCloseTo(
        (total.get(edge) as number) / covered,
        10,
      );
    }
  }
  expect(shared).toBeGreaterThan(0); // or no edge ever carried two sheds' depths at once
});

test("concurrent sheds on one edge clamp at full coverage", () => {
  // Two permits on one edge sum past its length on this day.
  let clamped = 0;
  for (const { day } of COVERAGE) {
    const raw = new Map<number, number>();
    for (const shed of standingOn(day)) {
      for (const span of shed.spans) {
        raw.set(
          span.edge,
          (raw.get(span.edge) ?? 0) + (span.t1 - span.t0) / 255,
        );
      }
    }
    const coverage = shedCoverage(graph, history, day);
    for (const [edge, covered] of raw) {
      if (covered > 1) {
        expect(coverage.get(edge)?.covered).toBe(1);
        clamped += 1;
      }
    }
  }
  expect(clamped).toBeGreaterThan(0);
});

test("a doubtful placement covers its edge like any other", () => {
  // Confidence is diagnostic, not a weight: 0.23-confidence spans land whole.
  let doubted = 0;
  for (const { day } of COVERAGE) {
    const coverage = shedCoverage(graph, history, day);
    for (const shed of standingOn(day)) {
      if (shed.confidence / 255 < 0.4) {
        doubted += 1;
        for (const span of shed.spans) {
          expect(coverage.get(span.edge)?.covered).toBeGreaterThanOrEqual(
            Math.min(1, (span.t1 - span.t0) / 255) - 1e-12,
          );
        }
      }
    }
  }
  expect(doubted).toBeGreaterThan(0); // or the fixture has nothing doubtful in it
});

const SERVED: Record<string, string> = {
  [SHED_URLS.open]: OPEN_BASE64,
  [SHED_URLS.closed]: CLOSED_BASE64,
  [SHED_URLS.index]: INDEX_BASE64,
};
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

function serveFixture(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const base64 = SERVED[String(input)];
    if (base64 === undefined) {
      throw new Error(`unexpected fetch of ${String(input)}`);
    }
    return new Response(buffer(base64));
  }) as typeof fetch;
}

test("computeEdgeSheds fills the graph with the day's coverage, capped below 1", async () => {
  serveFixture();

  // The graph is cut short of its highest edge so the drop is exercised.
  const { day, edges } = COVERAGE[COVERAGE.length - 1];
  const highest = edges[edges.length - 1][0];
  const cut = namedGraph(highest);
  await computeEdgeSheds(cut, new Date(2017, 11, 28 + day));

  const sheds = cut.sheds as NonNullable<RoutingGraph["sheds"]>;
  expect(sheds.coverage.length).toBe(highest);
  expect(sheds.maxCoverage).toBeLessThan(1);
  const expected = shedCoverage(graph, history, day);
  for (const [edge, deck] of expected) {
    if (edge < highest) {
      expect(sheds.coverage[edge]).toBe(
        Math.min(254, Math.round(deck.covered * 255)),
      );
      // Unmeasured reads the fallback, and measured-under-buildable reads the floor.
      expect(sheds.depth[edge]).toBeCloseTo(
        Math.max(
          MIN_DECK_DEPTH_METERS,
          deck.depth > 0 ? deck.depth : DEFAULT_DECK_DEPTH_METERS,
        ),
        5,
      );
    }
  }
  // The 254 ceiling keeps a discount factor positive.
  const full = [...expected].filter(
    ([edge, deck]) => edge < highest && deck.covered === 1,
  );
  expect(full.length).toBeGreaterThan(0);
  for (const [edge] of full) {
    expect(sheds.coverage[edge]).toBe(254);
  }
});

test("a graph the artifact was not placed against costs no scaffolding", async () => {
  serveFixture();
  const { day } = COVERAGE[COVERAGE.length - 1];
  const other = namedGraph(EDGE_COUNT);
  other.keyHash = "0000000000000000";
  await expect(
    computeEdgeSheds(other, new Date(2017, 11, 28 + day)),
  ).rejects.toThrow(GRAPH_KEY_HASH);

  const sheds = other.sheds as NonNullable<RoutingGraph["sheds"]>;
  expect(sheds.maxCoverage).toBe(0);
  expect(sheds.coverage.every((byte) => byte === 0)).toBe(true);
});

test("a Date maps to its own local calendar day", () => {
  expect(shedDay(new Date(2017, 11, 28, 23, 59))).toBe(0);
  expect(shedDay(new Date(2018, 0, 1, 0, 0))).toBe(4);
  expect(shedDay(new Date(2026, 6, 29, 12, 0))).toBe(3135);
});

// Synthetic straight streets vary the sun's angle to the street independently of its elevation.

const NORTH_SOUTH = 0;
const EAST_WEST = 1;

beforeEach(clearEdgePathCache);

const NARROW_METERS = 2.5;
const WIDE_METERS = 6;

function twoStreets(date: Date, depth = DEFAULT_DECK_DEPTH_METERS): ShedField {
  const graph = straightGraph(2, 0, 90);
  const decks = new Map<number, EdgeDeck>([
    [NORTH_SOUTH, { covered: 1, depth }],
    [EAST_WEST, { covered: 1, depth }],
  ]);
  return shedField(graph, decks, date);
}

// Times the byte's coverage, since a fully decked edge quantizes to 254/255.
function expectedShare(
  date: Date,
  bearingDeg: number,
  covered = 1,
  depth = DEFAULT_DECK_DEPTH_METERS,
): number {
  const { elevation, azimuth } = sunAt(date);
  const translate = DECK_HEIGHT_METERS / Math.tan(elevation * DEGREES);
  const across =
    translate * Math.abs(Math.sin((azimuth - bearingDeg) * DEGREES));
  const share = Math.max(SHED_OBLIQUE_FLOOR, 1 - across / depth);
  return (Math.min(254, Math.round(covered * 255)) / 255) * share;
}

test("at one sun, a street the light runs along stays shaded and one it crosses does not", () => {
  // 09:00 EDT in July: a 36° sun almost due east, along one street and across the other.
  const date = new Date(Date.UTC(2026, 6, 15, 13));
  const field = twoStreets(date);
  const along = shedShade(field, EAST_WEST, 0);
  const across = shedShade(field, NORTH_SOUTH, 0);
  expect(along).toBeCloseTo(expectedShare(date, 90), 6);
  expect(across).toBeCloseTo(expectedShare(date, 0), 6);
  expect(along).toBeGreaterThan(0.9); // the shadow has slid along the shed's own length
  expect(across).toBeCloseTo(SHED_OBLIQUE_FLOOR, 2); // and clean off a 4 m depth
});

test("the sun's angle to the street outranks its elevation", () => {
  // Solar noon, a 71° sun due south: higher, yet the east-west street is less shaded than at 36°.
  const noon = new Date(Date.UTC(2026, 6, 15, 17));
  const highSun = twoStreets(noon);
  expect(shedShade(highSun, NORTH_SOUTH, 0)).toBeGreaterThan(0.98);
  expect(shedShade(highSun, EAST_WEST, 0)).toBeCloseTo(
    expectedShare(noon, 90),
    6,
  );
  expect(shedShade(highSun, EAST_WEST, 0)).toBeLessThan(
    shedShade(twoStreets(new Date(Date.UTC(2026, 6, 15, 13))), EAST_WEST, 0),
  );
});

test("the shaded share follows the sun down and never exceeds the coverage", () => {
  const bearings = [0, 90];
  for (const edge of [NORTH_SOUTH, EAST_WEST]) {
    let previous = Number.POSITIVE_INFINITY;
    for (const hourUtc of [17, 18, 19, 20, 21, 22, 23]) {
      const date = new Date(Date.UTC(2026, 6, 15, hourUtc));
      const share = shedShade(twoStreets(date), edge, 0);
      expect(share).toBeCloseTo(expectedShare(date, bearings[edge]), 6);
      expect(share).toBeLessThan(1); // the coverage byte's ceiling holds through the damping
      expect(share).toBeGreaterThan(0.9 * SHED_OBLIQUE_FLOOR);
      if (bearings[edge] === 0) {
        expect(share).toBeLessThanOrEqual(previous + 1e-12);
        previous = share;
      }
    }
  }
});

test("a deeper deck holds its shade to a lower sun than a shallow one", () => {
  const noon = new Date(Date.UTC(2026, 6, 15, 17));
  const narrow = shedShade(twoStreets(noon, NARROW_METERS), EAST_WEST, 0);
  const wide = shedShade(twoStreets(noon, WIDE_METERS), EAST_WEST, 0);
  expect(narrow).toBeCloseTo(expectedShare(noon, 90, 1, NARROW_METERS), 6);
  expect(wide).toBeCloseTo(expectedShare(noon, 90, 1, WIDE_METERS), 6);
  expect(wide).toBeGreaterThan(narrow + 0.2);
});

test("a half-decked edge shades half as much, and a bare one none", () => {
  const graph = straightGraph(2, 0, 90);
  const date = new Date(Date.UTC(2026, 6, 15, 17));
  const field = shedField(
    graph,
    new Map<number, EdgeDeck>([
      [NORTH_SOUTH, { covered: 0.5, depth: DEFAULT_DECK_DEPTH_METERS }],
    ]),
    date,
  );
  expect(shedShade(field, NORTH_SOUTH, 0)).toBeCloseTo(
    expectedShare(date, 0, 0.5),
    6,
  );
  expect(shedShade(field, EAST_WEST, 0)).toBe(0);
});

test("the sun keeps moving as the walk does", () => {
  const date = new Date(Date.UTC(2026, 6, 15, 13)); // 09:00 EDT, the sun still climbing
  const field = twoStreets(date);
  const later = new Date(date.getTime() + 3 * 3600 * 1000);
  expect(shedShade(field, EAST_WEST, 3 * 3600)).toBeCloseTo(
    expectedShare(later, 90),
    2,
  );
  expect(shedShade(field, EAST_WEST, 3 * 3600)).toBeLessThan(
    shedShade(field, EAST_WEST, 0),
  );
});

test("re-aiming the sun moves the shade without rebuilding the coverage", () => {
  const morning = new Date(Date.UTC(2026, 6, 15, 13));
  const noon = new Date(Date.UTC(2026, 6, 15, 17));
  const field = twoStreets(morning);
  const coverage = Uint8Array.from(field.coverage);
  const bearing = Float32Array.from(field.bearing);
  setShedSun(field, noon);
  expect(field.coverage).toEqual(coverage);
  expect(field.bearing).toEqual(bearing);
  expect(shedShade(field, NORTH_SOUTH, 0)).toBeCloseTo(
    expectedShare(noon, 0),
    6,
  );
  expect(shedShade(field, EAST_WEST, 0)).toBeCloseTo(
    expectedShare(noon, 90),
    6,
  );
});

test("the sun is aimed over the city the field was built for", () => {
  const sanFrancisco = cityById("sf");
  const newYork = cityById("nyc");
  if (!sanFrancisco || !newYork) {
    throw new Error("the two cities this test is about are gone");
  }
  const noon = new Date(Date.UTC(2026, 6, 15, 19));
  const field = twoStreets(noon);
  setShedSun(field, noon, sanFrancisco);
  const west = shedShade(field, NORTH_SOUTH, 0);
  setShedSun(field, noon, newYork);
  expect(shedShade(field, NORTH_SOUTH, 0)).not.toBeCloseTo(west, 3);
});

// Pinned to the FNV-1a 64 reference vectors, not the graph pass's output, to keep them independent.
test("the graph hash is FNV-1a 64", () => {
  const of = (text: string): string =>
    graphHashOf(new TextEncoder().encode(text));
  expect(of("")).toBe("cbf29ce484222325");
  expect(of("a")).toBe("af63dc4c8601ec8c");
  expect(of("foobar")).toBe("85944171f73967e8");
});

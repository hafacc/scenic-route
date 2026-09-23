// The real encoder and the client's decoder, checked against what the router asks.

import { expect, test } from "bun:test";
import { buildTimetable, encodeTimetable } from "../../scripts/ferry-schedule";
import type { GtfsFeed, GtfsRow } from "../../scripts/gtfs";
import { effSeconds, type RouteWeights, rawSeconds } from "./cost";
import { decodeSchedule, resolveTimetable } from "./ferry-schedule";
import type { RoutingGraph } from "./graph";

// Instants use the local Date constructor, so timetables are read in the runner's own zone.
const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const KIND_FERRY = 4;
const NORTH = "North Terminal";
const SOUTH = "South Terminal";

const weights = (ferry: number): RouteWeights => ({
  tree: 0,
  ferry,
  landmark: 0,
  art: 0,
  highway: 0,
  hill: 0,
  commercial: 0,
  industrial: 0,
  historic: 0,
  bridge: 0,
  shade: 0,
  shelter: 0,
  transit: 0,
  allowFerries: true,
  allowSheds: true,
  // Stated because omitting it would read as "avoid crossings".
  allowTransit: false,
  allowCrossings: true,
});

// Deliberately asymmetric, so the reverse leg must read its own list.
function feedOf(
  outbound: string[],
  inbound: string[],
  crossingMinutes = 25,
): GtfsFeed {
  const trips: GtfsRow[] = [];
  const stopTimes: GtfsRow[] = [];
  const add = (
    from: string,
    to: string,
    clock: string,
    index: number,
  ): void => {
    const tripId = `${from}-${clock}-${index}`;
    trips.push({ trip_id: tripId, route_id: "r", service_id: "weekday" });
    const [hour, minute] = clock.split(":").map(Number);
    const departure = hour * 3600 + minute * 60;
    const arrival = departure + crossingMinutes * 60;
    const clockOf = (seconds: number): string =>
      [seconds / 3600, (seconds / 60) % 60, seconds % 60]
        .map((part) => String(Math.floor(part)).padStart(2, "0"))
        .join(":");
    stopTimes.push({
      trip_id: tripId,
      stop_id: from,
      stop_sequence: "1",
      departure_time: clockOf(departure),
      arrival_time: clockOf(departure),
    });
    stopTimes.push({
      trip_id: tripId,
      stop_id: to,
      stop_sequence: "2",
      departure_time: clockOf(arrival),
      arrival_time: clockOf(arrival),
    });
  };
  outbound.forEach((clock, index) => {
    add("north", "south", clock, index);
  });
  inbound.forEach((clock, index) => {
    add("south", "north", clock, index);
  });

  return {
    routes: [
      { route_id: "r", route_type: "4", route_long_name: "Harbor Line" },
    ],
    trips,
    stops: [
      { stop_id: "north", stop_name: NORTH },
      { stop_id: "south", stop_name: SOUTH },
    ],
    stopTimes,
    calendar: [
      {
        service_id: "weekday",
        monday: "1",
        tuesday: "1",
        wednesday: "1",
        thursday: "1",
        friday: "1",
        saturday: "0",
        sunday: "0",
        start_date: "20260101",
        end_date: "20271231",
      },
    ],
    calendarDates: [],
    shapes: [],
    frequencies: [],
    transfers: [],
  };
}

function graphOf(bakedSeconds: number): RoutingGraph {
  return {
    edgeCount: 1,
    edgeNodeA: Uint32Array.from([0]),
    edgeNodeB: Uint32Array.from([1]),
    edgeLength: Float32Array.from([8000]),
    edgeKindSide: Uint8Array.from([KIND_FERRY]),
    edgeDurationSeconds: Uint16Array.from([bakedSeconds]),
    ferryEdges: Uint32Array.from([0]),
    ferryEndpointNames: new Map([[0, { a: NORTH, b: SOUTH }]]),
    nodeMidRoadway: new Uint8Array(2),
    ferries: null,
    shade: null,
    sheds: null,
  } as unknown as RoutingGraph;
}

function timetableAt(
  graph: RoutingGraph,
  feed: GtfsFeed,
  clock: string,
): RoutingGraph {
  const built = buildTimetable([{ source: { id: "t" } as never, feed }]);
  const encoded = encodeTimetable(built, 20260101, 0);
  const { record } = decodeSchedule(encoded);
  const [hour, minute] = clock.split(":").map(Number);
  // 2026-08-12 is a Wednesday, inside the fixture's Monday-to-Friday service.
  const date = new Date(2026, 7, 12, hour, minute);
  graph.ferries = resolveTimetable(graph, record, date, LOCAL_ZONE);
  return graph;
}

const HOUR = 3600;

test("the wait is the wait for the next sailing, not half a headway", () => {
  const graph = timetableAt(
    graphOf(9999),
    feedOf(["08:00", "09:00", "10:00"], ["08:30"]),
    "08:10",
  );
  // Arriving at 08:10 misses the 08:00 and waits 50 minutes for the 09:00, then crosses 25.
  expect(rawSeconds(graph, 0, 0, 0)).toBeCloseTo(50 * 60 + 25 * 60, 6);
  expect(rawSeconds(graph, 0, 0, HOUR)).toBeCloseTo(50 * 60 + 25 * 60, 6);
});

test("the two directions read their own timetables", () => {
  const graph = timetableAt(
    graphOf(9999),
    feedOf(["08:00", "09:00"], ["08:15", "08:45"]),
    "08:05",
  );
  // A symmetric per-edge figure could not tell these two waits apart.
  expect(rawSeconds(graph, 0, 0, 0)).toBeCloseTo(55 * 60 + 25 * 60, 6);
  expect(rawSeconds(graph, 0, 1, 0)).toBeCloseTo(10 * 60 + 25 * 60, 6);
});

test("after the last boat the ferry is unusable rather than cheap", () => {
  const graph = timetableAt(
    graphOf(600),
    feedOf(["08:00"], ["08:30"]),
    "23:30",
  );
  // Infinity drops the edge so the search walks instead of pricing a wait until morning.
  expect(rawSeconds(graph, 0, 0, 0)).toBe(Number.POSITIVE_INFINITY);
  expect(effSeconds(graph, 0, weights(0.5), 0, 0)).toBe(
    Number.POSITIVE_INFINITY,
  );
});

test("a sailing on the next service day is reachable across midnight", () => {
  const graph = timetableAt(
    graphOf(600),
    feedOf(["00:30", "08:00"], ["00:45"]),
    "23:50",
  );
  // The 00:30 is Thursday's service day; only the three-day window sees it at 23:50 Wednesday.
  expect(rawSeconds(graph, 0, 0, 0)).toBeCloseTo(40 * 60 + 25 * 60, 6);
});

test("a wait past the cap is unusable even though a boat exists", () => {
  const graph = timetableAt(
    graphOf(600),
    feedOf(["08:00"], ["08:30"]),
    "05:00",
  );
  // Three hours to the 08:00 — a real sailing, but not a way to get anywhere now.
  expect(rawSeconds(graph, 0, 0, 0)).toBe(Number.POSITIVE_INFINITY);
});

test("the ferry weight discounts the crossing and never the wait", () => {
  const graph = timetableAt(
    graphOf(600),
    feedOf(["08:30"], ["08:30"]),
    "08:00",
  );
  const wait = 30 * 60;
  const crossing = 25 * 60;
  expect(effSeconds(graph, 0, weights(0), 0, 0)).toBeCloseTo(
    wait + crossing,
    6,
  );
  // Half weight halves the crossing alone, not the pier wait.
  expect(effSeconds(graph, 0, weights(0.5), 0, 0)).toBeCloseTo(
    wait + crossing / 2,
    6,
  );
});

test("a day the service does not run falls back to no sailings", () => {
  const graph = graphOf(600);
  const built = buildTimetable([
    {
      source: { id: "t" } as never,
      feed: feedOf(["08:00", "09:00"], ["08:30"]),
    },
  ]);
  const { record } = decodeSchedule(encodeTimetable(built, 20260101, 0));
  // 2026-08-15 is a Saturday; the fixture's only service is Monday to Friday.
  graph.ferries = resolveTimetable(
    graph,
    record,
    new Date(2026, 7, 15, 8, 0),
    LOCAL_ZONE,
  );
  expect(rawSeconds(graph, 0, 0, 0)).toBe(Number.POSITIVE_INFINITY);
});

test("the departure instant is continuous, not snapped to the clock slider's step", () => {
  const built = buildTimetable([
    { source: { id: "t" } as never, feed: feedOf(["09:07"], ["09:07"]) },
  ]);
  const { record } = decodeSchedule(encodeTimetable(built, 20260101, 0));
  const graph = graphOf(600);
  // Within one 15-minute clock step, so the wait must track real seconds, not a bucketed figure.
  const waits = [
    new Date(2026, 7, 12, 9, 0, 0),
    new Date(2026, 7, 12, 9, 3, 20),
    new Date(2026, 7, 12, 9, 4, 0),
  ].map((departure) => {
    graph.ferries = resolveTimetable(graph, record, departure, LOCAL_ZONE);
    return rawSeconds(graph, 0, 0, 0) - 25 * 60; // less the crossing, leaving the wait
  });
  expect(waits).toEqual([7 * 60, 3 * 60 + 40, 3 * 60]);
});

test("a run that only sails at weekends is unavailable on a weekday, not averaged", () => {
  const feed = feedOf(["08:00", "09:00"], ["08:30"]);
  for (const row of feed.calendar) {
    // Weekends only, as the South Brooklyn and Governors Island runs are.
    for (const day of [
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
    ]) {
      row[day] = "0";
    }
    row.saturday = "1";
    row.sunday = "1";
  }
  const built = buildTimetable([{ source: { id: "t" } as never, feed }]);
  const { record } = decodeSchedule(encodeTimetable(built, 20260101, 0));

  const graph = graphOf(600);
  // Covered but not sailing, so no boat rather than the baked 600 s from a Saturday ferry.
  graph.ferries = resolveTimetable(
    graph,
    record,
    new Date(2026, 7, 12, 8, 0),
    LOCAL_ZONE,
  );
  expect(graph.ferries.covers(0)).toBe(true);
  expect(rawSeconds(graph, 0, 0, 0)).toBe(Number.POSITIVE_INFINITY);

  graph.ferries = resolveTimetable(
    graph,
    record,
    new Date(2026, 7, 15, 8, 0),
    LOCAL_ZONE,
  );
  expect(rawSeconds(graph, 0, 0, 0)).toBeCloseTo(25 * 60, 6);
});

test("an edge whose terminals name no lane keeps the graph's baked figure", () => {
  const built = buildTimetable([
    { source: { id: "t" } as never, feed: feedOf(["08:00"], ["08:30"]) },
  ]);
  const { record } = decodeSchedule(encodeTimetable(built, 20260101, 0));
  const graph = graphOf(600);
  // A renamed terminal matches no lane, so the timetable declines to speak for this edge.
  graph.ferryEndpointNames.set(0, { a: "Old Pier", b: SOUTH });
  graph.ferries = resolveTimetable(
    graph,
    record,
    new Date(2026, 7, 12, 8, 0),
    LOCAL_ZONE,
  );
  expect(graph.ferries.covers(0)).toBe(false);
  expect(rawSeconds(graph, 0, 0, 0)).toBe(600);
});

test("staying on the same boat costs nothing at the piers it calls at", () => {
  // One trip through three piers: riding through must charge the wait once, at boarding.
  const feed = feedOf([], [], 20);
  feed.stops.push({ stop_id: "middle", stop_name: "Middle Terminal" });
  feed.trips.push({ trip_id: "through", route_id: "r", service_id: "weekday" });
  feed.stopTimes.push(
    {
      trip_id: "through",
      stop_id: "north",
      stop_sequence: "1",
      departure_time: "09:00:00",
      arrival_time: "09:00:00",
    },
    {
      trip_id: "through",
      stop_id: "middle",
      stop_sequence: "2",
      departure_time: "09:20:00",
      arrival_time: "09:20:00",
    },
    {
      trip_id: "through",
      stop_id: "south",
      stop_sequence: "3",
      departure_time: "09:40:00",
      arrival_time: "09:40:00",
    },
  );
  const built = buildTimetable([{ source: { id: "t" } as never, feed }]);
  const { record } = decodeSchedule(encodeTimetable(built, 20260101, 0));

  const graph = graphOf(600);
  (graph.edgeNodeA as Uint32Array) = Uint32Array.from([0, 1]);
  (graph.edgeNodeB as Uint32Array) = Uint32Array.from([1, 2]);
  (graph.edgeLength as Float32Array) = Float32Array.from([8000, 8000]);
  (graph.edgeKindSide as Uint8Array) = Uint8Array.from([
    KIND_FERRY,
    KIND_FERRY,
  ]);
  (graph.edgeDurationSeconds as Uint16Array) = Uint16Array.from([600, 600]);
  (graph.ferryEdges as Uint32Array) = Uint32Array.from([0, 1]);
  graph.ferryEndpointNames.set(0, { a: NORTH, b: "Middle Terminal" });
  graph.ferryEndpointNames.set(1, { a: "Middle Terminal", b: SOUTH });
  graph.ferries = resolveTimetable(
    graph,
    record,
    new Date(2026, 7, 12, 8, 50),
    LOCAL_ZONE,
  );

  const first = rawSeconds(graph, 0, 0, 0); // 10 min wait + 20 min crossing
  expect(first).toBeCloseTo(10 * 60 + 20 * 60, 6);
  // The walker never got off, so the onward leg owes only its crossing.
  expect(rawSeconds(graph, 1, 1, first)).toBeCloseTo(20 * 60, 6);
});

test("the record round-trips through the encoder unchanged", () => {
  const built = buildTimetable([
    {
      source: { id: "t" } as never,
      feed: feedOf(["08:00", "09:00", "10:15"], ["08:30", "11:45"]),
    },
  ]);
  const encoded = encodeTimetable(built, 20260101, 20260630);
  const { record, nextOffset } = decodeSchedule(encoded);
  expect(nextOffset).toBe(encoded.length);
  expect(record.firstDay).toBe(20260101);
  expect(record.lastDay).toBe(20260630);
  expect(record.lanes.length).toBe(2); // one per direction
  const outbound = record.lanes.find((lane) => lane.fromName === NORTH);
  expect(outbound?.route).toBe("Harbor Line");
  expect(outbound?.sailings.map((sailing) => sailing.at)).toEqual([
    8 * HOUR,
    9 * HOUR,
    10 * HOUR + 15 * 60,
  ]);
  expect(
    outbound?.sailings.every((sailing) => sailing.crossing === 25 * 60),
  ).toBe(true);
});

test("the encoded body ignores the day range, so an unchanged feed is unchanged bytes", () => {
  const built = buildTimetable([
    { source: { id: "t" } as never, feed: feedOf(["08:00"], ["08:30"]) },
  ]);
  // The daily job diffs everything past the header, so two builds on different days must match there.
  const first = encodeTimetable(built, 20260101, 0).subarray(40);
  const second = encodeTimetable(built, 20270615, 0).subarray(40);
  expect([...first]).toEqual([...second]);
});

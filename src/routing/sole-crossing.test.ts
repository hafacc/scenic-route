// In the Bay every ferry edge is a cut edge, so the ferry credit and the boat's hours decide routing.

import { expect, test } from "bun:test";
import { buildTimetable, encodeTimetable } from "../../scripts/ferry-schedule";
import type { GtfsFeed, GtfsRow } from "../../scripts/gtfs";
import { buildGraph, snapAtNode, weights } from "./ferry.fixture";
import { decodeSchedule, resolveTimetable } from "./ferry-schedule";
import type { RoutingGraph } from "./graph";
import { findRoute, type RouteResult } from "./search";

// Instants use the local Date constructor, so timetables are read in the runner's own zone.
const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const WEST_TERMINAL = "West Ferry Building";
const EAST_TERMINAL = "East Ferry Terminal";

// The only edge between the chains is the ferry 2 -> 3, roughly Ferry Building to Jack London Square.
const WEST_END = 0;
const EAST_END = 5;
const FERRY_EDGE = 2;
const WEST_WALK = 0; // walking edge 0 -> 1, for a snap at node 0
const EAST_WALK = 4; // walking edge 4 -> 5, for a snap at node 5
const CROSSING_SECONDS = 25 * 60;

const graph = buildGraph(
  [
    { lat: 37.7749, lng: -122.4394 }, // 0 west, a long walk in from the far side
    { lat: 37.7855, lng: -122.4058 }, // 1
    { lat: 37.7955, lng: -122.3937 }, // 2 west pier
    { lat: 37.7955, lng: -122.2777 }, // 3 east pier
    { lat: 37.8044, lng: -122.2712 }, // 4
    { lat: 37.8272, lng: -122.2513 }, // 5 east, a long walk out the far side
  ],
  [
    { a: 0, b: 1, ferry: false, cover: 0.3, durationSeconds: 0 },
    { a: 1, b: 2, ferry: false, cover: 0.3, durationSeconds: 0 },
    { a: 2, b: 3, ferry: true, cover: 0, durationSeconds: CROSSING_SECONDS },
    { a: 3, b: 4, ferry: false, cover: 0.3, durationSeconds: 0 },
    { a: 4, b: 5, ferry: false, cover: 0.3, durationSeconds: 0 },
  ],
);
graph.ferryEndpointNames = new Map([
  [FERRY_EDGE, { a: WEST_TERMINAL, b: EAST_TERMINAL }],
]);

const start = snapAtNode(graph, WEST_END, WEST_WALK);
const dest = snapAtNode(graph, EAST_END, EAST_WALK);

// SF Bay Ferry's real weekday Oakland sailings: 07:05 to 21:20, nothing overnight.
const SAILINGS = [
  "07:05",
  "08:20",
  "09:35",
  "11:20",
  "14:10",
  "16:00",
  "17:20",
  "18:30",
  "20:00",
  "21:20",
];

function feedOf(sailings: readonly string[]): GtfsFeed {
  const trips: GtfsRow[] = [];
  const stopTimes: GtfsRow[] = [];
  const clockOf = (seconds: number): string =>
    [seconds / 3600, (seconds / 60) % 60, seconds % 60]
      .map((part) => String(Math.floor(part)).padStart(2, "0"))
      .join(":");
  sailings.forEach((clock, index) => {
    for (const [from, to] of [
      ["west", "east"],
      ["east", "west"],
    ]) {
      const tripId = `${from}-${index}`;
      trips.push({ trip_id: tripId, route_id: "r", service_id: "daily" });
      const [hour, minute] = clock.split(":").map(Number);
      const departure = hour * 3600 + minute * 60;
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
        departure_time: clockOf(departure + CROSSING_SECONDS),
        arrival_time: clockOf(departure + CROSSING_SECONDS),
      });
    }
  });
  return {
    routes: [{ route_id: "r", route_type: "4", route_long_name: "Bay Line" }],
    trips,
    stops: [
      { stop_id: "west", stop_name: WEST_TERMINAL },
      { stop_id: "east", stop_name: EAST_TERMINAL },
    ],
    stopTimes,
    calendar: [
      {
        service_id: "daily",
        monday: "1",
        tuesday: "1",
        wednesday: "1",
        thursday: "1",
        friday: "1",
        saturday: "1",
        sunday: "1",
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

function departingAt(clock: string): RoutingGraph {
  const built = buildTimetable([
    { source: { id: "t" } as never, feed: feedOf(SAILINGS) },
  ]);
  const { record } = decodeSchedule(encodeTimetable(built, 20260101, 0));
  const [hour, minute] = clock.split(":").map(Number);
  graph.ferries = resolveTimetable(
    graph,
    record,
    new Date(2026, 7, 12, hour, minute),
    LOCAL_ZONE,
  );
  return graph;
}

const routeWeights = weights(0.8, 0.1, true);

test("a crossing solves in service hours, walk then boat then walk", () => {
  const result = findRoute(departingAt("09:00"), start, dest, routeWeights);
  expect(result).not.toBeNull();
  const kinds = (result?.steps ?? []).map((step) => step.kind);
  expect(kinds.filter((kind) => kind === "ferry")).toHaveLength(1);
  // Walking on both sides makes the boat a crossing, not a pier the route ends at.
  const boat = kinds.indexOf("ferry");
  expect(boat).toBeGreaterThan(0);
  expect(boat).toBeLessThan(kinds.length - 1);
});

test("the wait for the boat is in the reported time", () => {
  // The walk to the pier is about an hour; 06:00 catches the 07:05, 09:00 just misses the 09:35.
  const early = findRoute(departingAt("06:00"), start, dest, routeWeights);
  const late = findRoute(departingAt("09:00"), start, dest, routeWeights);
  expect(early).not.toBeNull();
  expect(late).not.toBeNull();
  const walked = (result: RouteResult): number =>
    result.steps
      .filter((step) => step.kind !== "ferry")
      .reduce((sum, step) => sum + step.lengthMeters, 0);
  expect(walked(late as RouteResult)).toBeCloseTo(
    walked(early as RouteResult),
    0,
  );
  const extra =
    (late as RouteResult).travelSeconds - (early as RouteResult).travelSeconds;
  expect(extra).toBeGreaterThan(60 * 60);
});

test("after the last boat there is no route at all rather than a walk over the water", () => {
  const result = findRoute(departingAt("22:30"), start, dest, routeWeights);
  expect(result).toBeNull();
});

test("the wait cap is measured at the pier, not at the front door", () => {
  // The wait cap runs from arrival at the pier, so leaving 15 minutes later brings the 07:05 within it.
  expect(findRoute(departingAt("04:30"), start, dest, routeWeights)).toBeNull();
  expect(
    findRoute(departingAt("04:45"), start, dest, routeWeights),
  ).not.toBeNull();
});

test("barring ferries leaves the two halves unreachable rather than walkable", () => {
  const barred = findRoute(
    departingAt("09:00"),
    start,
    dest,
    weights(0.8, 0.1, false),
  );
  expect(barred).toBeNull();
});

test("the search terminates on an unreachable destination without exploring for ever", () => {
  // The zero-wait ferry credit still promises a shortcut, so this pins that the search settles promptly.
  const started = performance.now();
  expect(findRoute(departingAt("02:00"), start, dest, routeWeights)).toBeNull();
  expect(performance.now() - started).toBeLessThan(1000);
});

test("the pier wait a region will bear is the region's own", () => {
  // New York's default cap is set by an all-night ferry beside a bridge; here the region sets its own.
  const bay = departingAt("04:30");
  expect(findRoute(bay, start, dest, routeWeights)).toBeNull();

  bay.maxFerryWaitSeconds = 150 * 60;
  expect(findRoute(bay, start, dest, routeWeights)).not.toBeNull();

  bay.maxFerryWaitSeconds = 60 * 60;
  expect(findRoute(bay, start, dest, routeWeights)).toBeNull();
});

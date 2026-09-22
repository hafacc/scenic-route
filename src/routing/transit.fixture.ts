// A hand-written rail feed for the transit artifacts to be built from. Small enough to reason about
// by hand and shaped like the things that go wrong: a route with a branch and a one-off pattern, two
// curbs of one station under one name, an underground stop, a second route timetabled by frequency
// rather than by trip, a Saturday service, and a holiday that swaps the two.
//
// Both the topology (scripts/transit.ts) and the timetable (scripts/transit-schedule.ts) are built
// from this one feed, which is the point: the lane ids they hand each other have to agree.

import type { GtfsFeed, GtfsRow } from "../../scripts/gtfs";
import type { LoadedFeed, TransitFeedSource } from "../../scripts/transit";

export const FIXTURE_SOURCE: TransitFeedSource = {
  id: "test",
  name: "Test Rail",
  url: "",
  cacheKey: "",
  routeTypes: new Set(["1"]),
  routePrefix: "t:",
  groupKey: (row) => row.route_id,
  underground: new Set(["Deep"]),
};

// The stops, all without a parent_station, so the ingest merges the two curbs of "Bay" the way it
// merges Muni's.
const STOPS: readonly { id: string; name: string; lat: number; lng: number }[] =
  [
    { id: "A", name: "Alpha", lat: 40.7, lng: -74.0 },
    { id: "B", name: "Bay", lat: 40.71, lng: -74.0 },
    { id: "B2", name: "Bay", lat: 40.7102, lng: -74.0001 },
    { id: "C", name: "Deep", lat: 40.72, lng: -74.0 },
    { id: "D", name: "Delta", lat: 40.73, lng: -74.0 },
    { id: "E", name: "Echo", lat: 40.715, lng: -73.99 },
    { id: "F", name: "Fox", lat: 40.6, lng: -74.05 },
    { id: "G", name: "Gulf", lat: 40.61, lng: -74.05 },
  ];

// The three patterns of route L1: the trunk, the branch that turns at Echo off the other curb of
// Bay, and a single working that goes no further than Bay.
const TRUNK: readonly [string, number][] = [
  ["A", 0],
  ["B", 120],
  ["C", 300],
  ["D", 540],
];
const BRANCH: readonly [string, number][] = [
  ["A", 0],
  ["B2", 120],
  ["E", 420],
];
const ONE_OFF: readonly [string, number][] = [
  ["A", 0],
  ["B", 120],
];
// Route L2, timetabled by frequencies.txt: its one trip is a template, and the frequency rows are
// the service.
const SHUTTLE: readonly [string, number][] = [
  ["F", 0],
  ["G", 240],
];

export const TRUNK_STATIONS = ["Alpha", "Bay", "Deep", "Delta"] as const;
export const TRUNK_OFFSETS = [0, 120, 300, 540] as const;
export const FIRST_TRUNK_DEPARTURE = 6 * 3600; // 06:00, the first weekday trunk train
export const TRUNK_HEADWAY = 300;
export const TRUNK_TRIPS = 49; // 06:00 to 10:00 every five minutes
export const SATURDAY_TRUNK_DEPARTURE = 8 * 3600;
export const SATURDAY_TRUNK_HEADWAY = 1800;
export const SATURDAY_TRUNK_TRIPS = 5;
export const SHUTTLE_HEADWAY = 600;
export const SHUTTLE_BAND_START = 6 * 3600;
export const SHUTTLE_BAND_END = 9 * 3600;
// The Friday the feed turns into a Saturday: calendar_dates removes the weekday service and adds the
// Saturday one.
export const HOLIDAY = 20260904;

function clock(seconds: number): string {
  const parts = [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ];
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

function trip(
  trips: GtfsRow[],
  stopTimes: GtfsRow[],
  options: {
    tripId: string;
    routeId: string;
    serviceId: string;
    direction: string;
    pattern: readonly (readonly [string, number])[];
    departure: number;
  },
): void {
  trips.push({
    trip_id: options.tripId,
    route_id: options.routeId,
    service_id: options.serviceId,
    direction_id: options.direction,
  });
  options.pattern.forEach(([stopId, offset], index) => {
    const at = clock(options.departure + offset);
    stopTimes.push({
      trip_id: options.tripId,
      stop_id: stopId,
      stop_sequence: String(index + 1),
      arrival_time: at,
      departure_time: at,
    });
  });
}

export function fixtureFeed(): GtfsFeed {
  const trips: GtfsRow[] = [];
  const stopTimes: GtfsRow[] = [];

  for (let index = 0; index < TRUNK_TRIPS; index++) {
    trip(trips, stopTimes, {
      tripId: `trunk-${index}`,
      routeId: "L1",
      serviceId: "weekday",
      direction: "0",
      pattern: TRUNK,
      departure: FIRST_TRUNK_DEPARTURE + index * TRUNK_HEADWAY,
    });
  }
  for (let index = 0; index < 13; index++) {
    trip(trips, stopTimes, {
      tripId: `branch-${index}`,
      routeId: "L1",
      serviceId: "weekday",
      direction: "0",
      pattern: BRANCH,
      departure: 6 * 3600 + 300 + index * 1200,
    });
  }
  trip(trips, stopTimes, {
    tripId: "one-off",
    routeId: "L1",
    serviceId: "weekday",
    direction: "0",
    pattern: ONE_OFF,
    departure: 5 * 3600,
  });
  for (let index = 0; index < SATURDAY_TRUNK_TRIPS; index++) {
    trip(trips, stopTimes, {
      tripId: `saturday-${index}`,
      routeId: "L1",
      serviceId: "saturday",
      direction: "0",
      pattern: TRUNK,
      departure: SATURDAY_TRUNK_DEPARTURE + index * SATURDAY_TRUNK_HEADWAY,
    });
  }
  trip(trips, stopTimes, {
    tripId: "shuttle-template",
    routeId: "L2",
    serviceId: "weekday",
    direction: "0",
    pattern: SHUTTLE,
    departure: SHUTTLE_BAND_START,
  });

  return {
    routes: [
      {
        route_id: "L1",
        route_type: "1",
        route_short_name: "L1",
        route_long_name: "Trunk Line",
        route_color: "112233",
        route_text_color: "FFFFFF",
      },
      {
        route_id: "L2",
        route_type: "1",
        route_short_name: "L2",
        route_long_name: "Shuttle",
        route_color: "445566",
        route_text_color: "000000",
      },
      // A bus, to prove the route-type filter keeps it out of the artifact.
      { route_id: "B1", route_type: "3", route_short_name: "B1" },
    ],
    trips,
    stops: STOPS.map((stop) => ({
      stop_id: stop.id,
      stop_name: stop.name,
      stop_lat: String(stop.lat),
      stop_lon: String(stop.lng),
    })),
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
      {
        service_id: "saturday",
        monday: "0",
        tuesday: "0",
        wednesday: "0",
        thursday: "0",
        friday: "0",
        saturday: "1",
        sunday: "0",
        start_date: "20260101",
        end_date: "20271231",
      },
    ],
    calendarDates: [
      { service_id: "weekday", date: String(HOLIDAY), exception_type: "2" },
      { service_id: "saturday", date: String(HOLIDAY), exception_type: "1" },
    ],
    shapes: [],
    frequencies: [
      {
        trip_id: "shuttle-template",
        start_time: clock(SHUTTLE_BAND_START),
        end_time: clock(SHUTTLE_BAND_END),
        headway_secs: String(SHUTTLE_HEADWAY),
      },
    ],
    transfers: [],
  };
}

export function fixtureFeeds(): LoadedFeed[] {
  return [{ source: FIXTURE_SOURCE, feed: fixtureFeed() }];
}

// Both artifacts from one feed through their real encoders and decoders, asked what the router asks.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTopology,
  decodeTopology,
  encodeTopology,
  laneIdOf,
} from "../../scripts/transit";
import {
  buildTimetable,
  deriveBands,
  encodeTimetable,
} from "../../scripts/transit-schedule";
import { SECONDS_PER_DAY, servicesOn, shiftedDay } from "./schedule-days";
import {
  FIRST_TRUNK_DEPARTURE,
  fixtureFeeds,
  HOLIDAY,
  SHUTTLE_BAND_START,
  SHUTTLE_HEADWAY,
  TRUNK_HEADWAY,
  TRUNK_OFFSETS,
  TRUNK_STATIONS,
  TRUNK_TRIPS,
} from "./transit.fixture";
import { decodeSchedule, resolveTimetable } from "./transit-schedule";

// Instants use the local Date constructor, so timetables are read in the runner's own zone.
const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// A lane id no pattern in the fixture's feeds hashes to.
const UNRUN_LANE = 0xdead_beef;

const TRUNK_LANE = laneIdOf("t:L1", 0, [...TRUNK_STATIONS]);
const BRANCH_LANE = laneIdOf("t:L1", 0, ["Alpha", "Bay", "Echo"]);
const ONE_OFF_LANE = laneIdOf("t:L1", 0, ["Alpha", "Bay"]);
const SHUTTLE_LANE = laneIdOf("t:L2", 0, ["Fox", "Gulf"]);
const LAST_TRUNK_DEPARTURE =
  FIRST_TRUNK_DEPARTURE + (TRUNK_TRIPS - 1) * TRUNK_HEADWAY;

function topology() {
  return buildTopology(fixtureFeeds());
}

function timetable(date: Date) {
  const bytes = encodeTimetable(
    buildTimetable(fixtureFeeds(), topology().topology),
    20260101,
    0,
  );
  const { record } = decodeSchedule(bytes);
  return resolveTimetable(record, date, LOCAL_ZONE);
}

test("the fixture's calendar assumptions hold", () => {
  expect(new Date(2026, 8, 1).getDay()).toBe(2); // Tuesday
  expect(new Date(2026, 8, 4).getDay()).toBe(5); // the holiday, a Friday
  expect(new Date(2026, 8, 5).getDay()).toBe(6); // Saturday
});

// Keyed to the deployed topology, so a lane the graph can board never silently lacks departures.
test("the timetable covers exactly the committed topology's lanes", () => {
  const unfiltered = buildTopology(fixtureFeeds(), 0).topology;
  const committed = {
    ...unfiltered,
    patterns: [
      ...unfiltered.patterns,
      { ...unfiltered.patterns[0], laneId: UNRUN_LANE },
    ],
  };
  const built = buildTimetable(fixtureFeeds(), committed);

  expect(built.patterns.map((pattern) => pattern.laneId).sort()).toEqual(
    committed.patterns.map((pattern) => pattern.laneId).sort(),
  );
  // The working the share rule drops from the graph is still a lane while the graph carries it.
  expect(
    built.lanes.some(
      (lane) => built.patterns[lane.patternIndex].laneId === ONE_OFF_LANE,
    ),
  ).toBe(true);
  expect(
    built.lanes.some(
      (lane) => built.patterns[lane.patternIndex].laneId === UNRUN_LANE,
    ),
  ).toBe(false);

  const { record } = decodeSchedule(encodeTimetable(built, 20260101, 0));
  const resolved = resolveTimetable(
    record,
    new Date(2026, 8, 1, 5, 50),
    LOCAL_ZONE,
  );
  expect(resolved.covers(UNRUN_LANE)).toBe(true);
  expect(resolved.board(UNRUN_LANE, 0, 0)).toBeNull();
});

test("a timetable is read in the city's zone, not the reader's", () => {
  const bytes = encodeTimetable(
    buildTimetable(fixtureFeeds(), topology().topology),
    20260101,
    0,
  );
  const { record } = decodeSchedule(bytes);

  // 11:30 in New York is 08:30 in Los Angeles; read in the viewer's zone, the 10:00 train would look live.
  const midMorning = new Date("2026-09-02T15:30:00Z");
  const east = resolveTimetable(record, midMorning, "America/New_York");
  const west = resolveTimetable(record, midMorning, "America/Los_Angeles");
  expect(west.board(TRUNK_LANE, 0, 0)?.departure).toBe(8.5 * 3600);
  expect(east.board(TRUNK_LANE, 0, 0)?.departure).toBe(
    FIRST_TRUNK_DEPARTURE + SECONDS_PER_DAY,
  );

  // Past midnight in New York is still the evening before in California, a different calendar row.
  const afterMidnight = new Date("2026-09-02T05:30:00Z");
  expect(shiftedDay(afterMidnight, 0, "America/New_York")).toBe(20260902);
  expect(shiftedDay(afterMidnight, 0, "America/Los_Angeles")).toBe(20260901);
});

test("the two curbs of one name are one station, and the underground one is not surface", () => {
  const { topology: built } = topology();
  const names = built.stations.map((station) => station.name);
  expect(names).toEqual([
    "Fox",
    "Gulf",
    "Alpha",
    "Bay",
    "Echo",
    "Deep",
    "Delta",
  ]);
  const bay = built.stations[names.indexOf("Bay")];
  expect(bay.lat).toBeCloseTo(40.7101, 4);
  expect(
    built.stations.every(
      (station) => station.surface === (station.name !== "Deep"),
    ),
  ).toBe(true);
});

test("only the route types the city rides are kept", () => {
  const { topology: built } = topology();
  expect(built.routes.map((route) => route.id)).toEqual(["t:L1", "t:L2"]);
  expect(built.routes[0].color).toEqual({ red: 0x11, green: 0x22, blue: 0x33 });
});

test("the one-off working is dropped and the branch is kept", () => {
  const { topology: built, counts } = topology();
  const lanes = built.patterns.map((pattern) => pattern.laneId);
  expect(lanes).toContain(TRUNK_LANE);
  expect(lanes).toContain(BRANCH_LANE);
  expect(lanes).toContain(SHUTTLE_LANE);
  expect(lanes).not.toContain(ONE_OFF_LANE);
  expect(counts).toEqual({ raw: 4, kept: 3, droppedTrips: 1 });
});

test("a pattern's offsets are the ride seconds from its first stop", () => {
  const { topology: built } = topology();
  const trunk = built.patterns.find((pattern) => pattern.laneId === TRUNK_LANE);
  expect(trunk?.offsets).toEqual([...TRUNK_OFFSETS]);
  expect(trunk?.stops.map((station) => built.stations[station].name)).toEqual([
    ...TRUNK_STATIONS,
  ]);
  // The two services of one pattern are one pattern: the Saturday trips run the same stops.
  expect(trunk?.trips.length).toBe(TRUNK_TRIPS + 5);
});

test("the topology survives a round trip through the artifact", () => {
  const { topology: built } = topology();
  const decoded = decodeTopology(encodeTopology(built));
  expect(decoded.routes).toEqual([...built.routes]);
  expect(decoded.patterns.map((pattern) => pattern.laneId)).toEqual(
    built.patterns.map((pattern) => pattern.laneId),
  );
  expect(decoded.patterns.map((pattern) => [...pattern.offsets])).toEqual(
    built.patterns.map((pattern) => [...pattern.offsets]),
  );
  expect(decoded.patterns.map((pattern) => [...pattern.stops])).toEqual(
    built.patterns.map((pattern) => [...pattern.stops]),
  );
  built.stations.forEach((station, index) => {
    const read = decoded.stations[index];
    expect(read.name).toBe(station.name);
    expect(read.surface).toBe(station.surface);
    expect(read.complex).toBe(station.complex);
    expect(read.lat).toBeCloseTo(station.lat, 5);
    expect(read.lng).toBeCloseTo(station.lng, 5);
  });
});

test("even service becomes one band, and a lone train its own", () => {
  expect(deriveBands([600, 900, 1200, 1500])).toEqual([
    { start: 600, end: 1500, headway: 300 },
  ]);
  // A gap a quarter over the mean is still the same service; twice it is not.
  expect(deriveBands([600, 900, 1200, 1560])).toEqual([
    { start: 600, end: 1560, headway: 320 },
  ]);
  expect(deriveBands([600, 900, 1200, 2400])).toEqual([
    { start: 600, end: 1200, headway: 300 },
    { start: 2400, end: 2400, headway: 0 },
  ]);
});

test("the next train is the next train, at every stop of the pattern", () => {
  const timing = timetable(new Date(2026, 8, 1, 5, 50));
  const wall = 5 * 3600 + 50 * 60;

  expect(timing.covers(TRUNK_LANE)).toBe(true);
  expect(timing.covers(ONE_OFF_LANE)).toBe(false);
  expect(timing.minWaitSeconds).toBe(0);

  expect(timing.board(TRUNK_LANE, 0, 0)).toEqual({
    departure: FIRST_TRUNK_DEPARTURE,
    wait: FIRST_TRUNK_DEPARTURE - wall,
  });
  expect(timing.board(TRUNK_LANE, 2, 0)).toEqual({
    departure: FIRST_TRUNK_DEPARTURE + TRUNK_OFFSETS[2],
    wait: FIRST_TRUNK_DEPARTURE + TRUNK_OFFSETS[2] - wall,
  });
  const elapsed = 18 * 60;
  expect(timing.board(TRUNK_LANE, 0, elapsed)).toEqual({
    departure: FIRST_TRUNK_DEPARTURE + 2 * TRUNK_HEADWAY,
    wait: FIRST_TRUNK_DEPARTURE + 2 * TRUNK_HEADWAY - wall - elapsed,
  });
  expect(timing.board(TRUNK_LANE, 9, 0)).toBeNull();
});

test("standing on the platform as a train leaves catches that train, not the next", () => {
  const timing = timetable(new Date(2026, 8, 1, 6, 0));
  expect(timing.board(TRUNK_LANE, 0, 0)).toEqual({
    departure: FIRST_TRUNK_DEPARTURE,
    wait: 0,
  });
  expect(timing.board(TRUNK_LANE, 0, 1)).toEqual({
    departure: FIRST_TRUNK_DEPARTURE + TRUNK_HEADWAY,
    wait: TRUNK_HEADWAY - 1,
  });
});

test("the last train of the band is the last train, and tomorrow's is tomorrow's", () => {
  const timing = timetable(new Date(2026, 8, 1, 9, 56));
  const wall = 9 * 3600 + 56 * 60;
  expect(timing.board(TRUNK_LANE, 0, 0)).toEqual({
    departure: LAST_TRUNK_DEPARTURE,
    wait: LAST_TRUNK_DEPARTURE - wall,
  });
  // The three service days around the walk are what make a walk near midnight work.
  expect(timing.board(TRUNK_LANE, 0, 10 * 60)).toEqual({
    departure: FIRST_TRUNK_DEPARTURE + 86_400,
    wait: FIRST_TRUNK_DEPARTURE + 86_400 - wall - 600,
  });
});

test("a holiday runs the Saturday service and nothing else", () => {
  expect(HOLIDAY).toBe(20260904);
  const timing = timetable(new Date(2026, 8, 4, 12, 0));
  expect(timing.board(BRANCH_LANE, 0, 0)).toBeNull();
  expect(timing.board(TRUNK_LANE, 0, 0)).toEqual({
    departure: 8 * 3600 + 86_400,
    wait: 8 * 3600 + 86_400 - 12 * 3600,
  });
});

test("a frequency-based service boards off its published headway", () => {
  const timing = timetable(new Date(2026, 8, 1, 6, 1));
  const wall = 6 * 3600 + 60;
  expect(timing.board(SHUTTLE_LANE, 0, 0)).toEqual({
    departure: SHUTTLE_BAND_START + SHUTTLE_HEADWAY,
    wait: SHUTTLE_BAND_START + SHUTTLE_HEADWAY - wall,
  });
});

// Muni's calendars ended 2026-08-28 while BART's run into 2027; read off the shipped file.
test("a weekday past Muni's calendars still boards Muni, and BART resolves normally", () => {
  const bytes = new Uint8Array(
    readFileSync(
      join(import.meta.dirname, "../../public/transit-schedule/sf.bin"),
    ),
  );
  const { record } = decodeSchedule(bytes);
  const day = 20_260_904; // a Friday, past the Muni calendars and inside the BART ones
  const running = servicesOn(record.services, record.exceptions, day);
  const coverageEnd = (service: number): number =>
    Math.max(
      record.services[service].endDay,
      ...record.exceptions
        .filter((exception) => exception.service === service)
        .map((exception) => exception.day),
    );
  const stale = [...running].filter((service) => coverageEnd(service) < day);
  const live = [...running].filter((service) => coverageEnd(service) >= day);
  expect(live.length).toBeGreaterThan(0); // BART, inside its own range
  expect(stale.length).toBeGreaterThan(0); // Muni, voted in past the end of its own

  // All 37 Muni Metro lanes (J/K/L/M/N/T) are in here, beside the cable cars and the F.
  const noon = new Date(Date.UTC(2026, 8, 4, 19, 0, 0)); // 12:00 PDT
  const table = resolveTimetable(record, noon, "America/Los_Angeles");
  const lanes = new Set(
    record.lanes
      .filter((lane) => stale.includes(lane.service))
      .map((lane) => record.patterns[lane.pattern].laneId),
  );
  expect(lanes.size).toBeGreaterThan(0);
  for (const lane of lanes) {
    expect(table.board(lane, 0, 0)).not.toBeNull();
  }
});

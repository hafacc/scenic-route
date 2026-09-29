import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureFeeds } from "../src/routing/transit.fixture";
import type { GtfsFeed } from "./gtfs";
import type { OsmStationEntrance } from "./overpass";
import {
  BOTH_SIDES,
  buildTopology,
  cityComplexes,
  curatedLines,
  decodeTopology,
  encodeTopology,
  type FeedEntrance,
  type FeedEntrances,
  type LoadedFeed,
  matchStationEntrances,
  muniStationName,
  NORTHBOUND_SIDE,
  parseSideOverrides,
  type RouteTracks,
  routeKey,
  SOUTHBOUND_SIDE,
  TRANSIT_DIR,
  type UndergroundStation,
} from "./transit";

// The fixture's trunk runs due north up longitude -74.
const DEEP = { lat: 40.72, lng: -74.0 };
const CLEAR_DEGREES = 0.0003; // ~25 m, clear of the ambiguous band
const NARROW_DEGREES = 0.00005; // ~4 m, inside it

function door(lng: number, stationId = "C"): FeedEntrance {
  return {
    stationId,
    lat: DEEP.lat,
    lng,
    kind: "stair",
    entry: true,
    exit: true,
    sides: null,
  };
}

function topologyWith(
  entrances: readonly FeedEntrance[],
  split: readonly string[] = ["C"],
  tracks: RouteTracks = new Map(),
) {
  const feedEntrances: FeedEntrances = { entrances, split: new Set(split) };
  return buildTopology(
    fixtureFeeds(),
    undefined,
    new Map([["test", feedEntrances]]),
    tracks,
  ).topology;
}

function stationNamed(
  topology: ReturnType<typeof topologyWith>,
  name: string,
): number {
  const index = topology.stations.findIndex((station) => station.name === name);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

test("a stair east of a northbound track serves the northbound platform", () => {
  const topology = topologyWith([
    door(DEEP.lng + CLEAR_DEGREES),
    door(DEEP.lng - CLEAR_DEGREES),
    door(DEEP.lng + NARROW_DEGREES),
  ]);

  // Right-hand running: the northbound platform is under the eastern pavement.
  const sides = topology.entrances.map((entrance) => entrance.sides);
  expect(sides).toEqual([SOUTHBOUND_SIDE, BOTH_SIDES, NORTHBOUND_SIDE]);
  expect(topology.stations[stationNamed(topology, "Deep")].split).toBe(true);
});

// A station point off its own rails, like Nevins St, whose MTA point sits over the pavement.
const TRACK_EAST_METERS = 10;
const TRACK_EAST_DEGREES =
  TRACK_EAST_METERS /
  (Math.cos((DEEP.lat * Math.PI) / 180) * (Math.PI / 180) * 6_371_008.8);

// Published running south, as half the drawn shapes are; the ride order says which end is north.
function trackEastOfTheStops(): RouteTracks {
  const points = [];
  for (let lat = 40.74; lat > 40.699; lat -= 0.0005) {
    points.push({ lat, lng: DEEP.lng + TRACK_EAST_DEGREES });
  }
  return new Map([[routeKey("L1", "Trunk Line"), [points]]]);
}

test("an entrance is sided by the track, not by the station point beside it", () => {
  // 1 m east of the station point (ambiguous from it) but 9 m west of the rails.
  const near = DEEP.lng + TRACK_EAST_DEGREES / TRACK_EAST_METERS;
  const far = DEEP.lng + TRACK_EAST_DEGREES * 2;

  const bySide = topologyWith(
    [door(near), door(far)],
    ["C"],
    trackEastOfTheStops(),
  );
  const byPoint = topologyWith([door(near), door(far)]);

  expect(bySide.entrances.map((entrance) => entrance.sides)).toEqual([
    SOUTHBOUND_SIDE,
    NORTHBOUND_SIDE,
  ]);
  expect(byPoint.entrances.map((entrance) => entrance.sides)).toEqual([
    BOTH_SIDES,
    NORTHBOUND_SIDE,
  ]);
});

test("a station a rider can cross between inside takes every entrance", () => {
  const topology = topologyWith([door(DEEP.lng + CLEAR_DEGREES)], []);

  expect(topology.stations[stationNamed(topology, "Deep")].split).toBe(false);
  expect(topology.entrances.map((entrance) => entrance.sides)).toEqual([
    BOTH_SIDES,
  ]);
});

test("a station the entrance data never mentions carries no entrance", () => {
  const topology = topologyWith([door(DEEP.lng + CLEAR_DEGREES)]);
  const alpha = stationNamed(topology, "Alpha");

  expect(
    topology.entrances.filter((entrance) => entrance.station === alpha),
  ).toEqual([]);
  expect(topology.entrances).toHaveLength(1);
});

test("the entrances and the split flag survive the encoder", () => {
  const topology = topologyWith([
    door(DEEP.lng + CLEAR_DEGREES),
    { ...door(DEEP.lng - CLEAR_DEGREES), kind: "elevator", entry: false },
  ]);

  const decoded = decodeTopology(encodeTopology(topology));

  expect(decoded.entrances).toHaveLength(2);
  decoded.entrances.forEach((entrance, index) => {
    const written = topology.entrances[index];
    expect(entrance.station).toBe(written.station);
    expect(entrance.sides).toBe(written.sides);
    expect(entrance.kind).toBe(written.kind);
    expect(entrance.entry).toBe(written.entry);
    expect(entrance.exit).toBe(written.exit);
    expect(entrance.lng).toBeCloseTo(written.lng, 6);
    expect(entrance.lat).toBeCloseTo(written.lat, 6);
  });
  expect(decoded.stations.map((station) => station.split)).toEqual(
    topology.stations.map((station) => station.split),
  );
});

test("the New York no-crossover list splits every station it names", () => {
  const ids = curatedLines("nyc-no-crossover.txt");
  expect(ids).toHaveLength(87);
  expect(new Set(ids).size).toBe(ids.length);

  const committed = decodeTopology(
    new Uint8Array(readFileSync(join(TRANSIT_DIR, "nyc.bin"))),
  );
  // Bleecker St too, though it is in a complex: each station keeps its own nodes.
  expect(committed.stations.filter((station) => station.split)).toHaveLength(
    87,
  );
});

test("every side override names a station that is actually split", () => {
  const ids = new Set(curatedLines("nyc-no-crossover.txt"));
  const overrides = [...parseSideOverrides("nyc-entrance-sides.txt").keys()];

  expect(overrides.length).toBeGreaterThan(0);
  for (const key of overrides) {
    expect(ids).toContain(key.split(" ")[0]);
  }
});

// 100 m apart; the first split into a stop per direction, as Muni splits underground platforms.
const DOWNTOWN = { lat: 37.76, lng: -122.43 };
const UPTOWN = { lat: 37.7609, lng: -122.43 };
const OSM_STATIONS: UndergroundStation[] = [
  {
    keys: ["5000", "5001"],
    names: ["Metro Alpha Station/Downtown", "Metro Alpha Station/Outbound"],
    points: [DOWNTOWN, { lat: DOWNTOWN.lat + 0.0001, lng: DOWNTOWN.lng }],
  },
  {
    keys: ["5002"],
    names: ["Metro Beta Station"],
    points: [UPTOWN],
  },
];

function node(
  lat: number,
  stationName?: string,
  access?: string,
): OsmStationEntrance {
  return {
    lat,
    lng: -122.43,
    stationName,
    access,
    elevator: false,
    escalator: false,
    ramp: false,
  };
}

test("an OSM entrance names its station even when another stands nearer", () => {
  const { entrances, unmatched } = matchStationEntrances(OSM_STATIONS, [
    node(37.7603, "Beta Station"),
  ]);

  expect(unmatched).toEqual([]);
  expect(entrances.map(({ stationId }) => stationId)).toEqual(["5002"]);
});

test("an OSM entrance naming nothing takes the nearest station, every platform of it", () => {
  const { entrances, unmatched } = matchStationEntrances(OSM_STATIONS, [
    node(37.76025),
  ]);

  expect(unmatched).toEqual([]);
  expect(entrances.map(({ stationId }) => stationId)).toEqual(["5000", "5001"]);
  expect(entrances.map(({ sides }) => sides)).toEqual([BOTH_SIDES, BOTH_SIDES]);
});

test("an OSM entrance out of reach of every station is no station's", () => {
  const far = node(37.765);
  const { entrances, unmatched } = matchStationEntrances(OSM_STATIONS, [far]);

  expect(entrances).toEqual([]);
  expect(unmatched).toEqual([far]);
});

test("a door a rider may not walk through is no way into the station", () => {
  const shut = node(37.76025, undefined, "no");
  const tenants = node(37.76025, undefined, "private");
  const { entrances, unmatched, closed } = matchStationEntrances(OSM_STATIONS, [
    shut,
    tenants,
  ]);

  expect(entrances).toEqual([]);
  expect(unmatched).toEqual([]);
  expect(closed).toEqual([shut, tenants]);
});

// 37.7627 is ~200 m from Beta: past the distance cap, inside the named one.
test("an OSM entrance that names its station reaches it past the distance cap", () => {
  const named = matchStationEntrances(OSM_STATIONS, [
    node(37.7627, "Beta Station"),
  ]);
  const anonymous = matchStationEntrances(OSM_STATIONS, [node(37.7627)]);

  expect(named.entrances.map(({ stationId }) => stationId)).toEqual(["5002"]);
  expect(anonymous.entrances).toEqual([]);
  expect(anonymous.unmatched.length).toBe(1);
});

test("a Muni stop is named for the place, not the platform", () => {
  expect(muniStationName("Metro Castro Station/Downtown")).toBe("Castro");
  expect(muniStationName("Metro Civic Center Station/Outbd")).toBe(
    "Civic Center",
  );
  expect(muniStationName("Metro Embarcadero Station")).toBe("Embarcadero");
  expect(muniStationName("Van Ness Station Outbound")).toBe("Van Ness");
  expect(muniStationName("Union Square/Market St Station Northbound")).toBe(
    "Union Square/Market St",
  );
  expect(muniStationName("Chinatown - Rose Pak Station")).toBe(
    "Chinatown - Rose Pak",
  );
  expect(muniStationName("Church St & Duboce Ave")).toBe(
    "Church St & Duboce Ave",
  );
});

const METRO_PLATFORMS: readonly [string, string, number][] = [
  ["1", "Metro Castro Station/Downtown", 0],
  ["2", "Metro Castro Station/Outbound", 9],
  ["3", "Metro Powell Station/Downtown", 3000],
  ["4", "Metro Powell Station/Outbound", 3076],
  ["5", "Van Ness Station Outbound", 6000],
  ["6", "Metro Van Ness Station", 6014],
];

// Muni-like: no parent stations, no transfers.txt, one row per direction's platform.
function metroFeeds(): LoadedFeed[] {
  const stops = METRO_PLATFORMS.map(([id, name, meters]) => ({
    stop_id: id,
    stop_name: name,
    stop_lat: String(37.76 + meters / 111_320),
    stop_lon: "-122.43",
  }));
  const trips = [
    { trip_id: "in", route_id: "K", service_id: "all", direction_id: "1" },
    { trip_id: "out", route_id: "K", service_id: "all", direction_id: "0" },
  ];
  const stopTimes = ["in", "out"].flatMap((tripId, direction) =>
    METRO_PLATFORMS.filter((_, index) => index % 2 === direction).map(
      ([stopId], index) => ({
        trip_id: tripId,
        stop_id: stopId,
        stop_sequence: String(index + 1),
        arrival_time: `06:0${index}:00`,
        departure_time: `06:0${index}:00`,
      }),
    ),
  );
  const feed: GtfsFeed = {
    routes: [{ route_id: "K", route_type: "0", route_short_name: "K" }],
    trips,
    stops,
    stopTimes,
    calendar: [],
    calendarDates: [],
    shapes: [],
    frequencies: [],
    transfers: [],
  };
  return [
    {
      source: {
        id: "muni",
        name: "Muni",
        url: "",
        cacheKey: "",
        routeTypes: new Set(["0"]),
        routePrefix: "muni:",
        groupKey: (row) => row.route_id,
        underground: new Set(METRO_PLATFORMS.map(([, name]) => name)),
        displayName: muniStationName,
      },
      feed,
    },
  ];
}

test("a Metro station's two direction platforms are one complex, both ways estimated", () => {
  const { topology } = buildTopology(metroFeeds());
  const byName = (name: string) =>
    topology.stations.filter((station) => station.name === name);

  const castro = byName("Castro");
  expect(castro).toHaveLength(2);
  expect(castro[0].complex).toBeGreaterThan(0);
  expect(castro[1].complex).toBe(castro[0].complex);
  const vanNess = byName("Van Ness");
  expect(vanNess[0].complex).toBeGreaterThan(0);
  expect(vanNess[1].complex).toBe(vanNess[0].complex);
  // 76 m apart, past the direction pair's reach: Powell's join comes through BART.
  expect(byName("Powell").map(({ complex }) => complex)).toEqual([0, 0]);

  expect(topology.complexes.map(({ name }) => name).sort()).toEqual([
    "Castro",
    "Van Ness",
  ]);
  expect(topology.transfers).toHaveLength(4);
  for (const transfer of topology.transfers) {
    expect(transfer.seconds).toBeNull();
    expect(topology.stations[transfer.from].complex).toBe(
      topology.stations[transfer.to].complex,
    );
  }
});

test("complexes and transfer pairs survive the encoder", () => {
  const { topology } = buildTopology(metroFeeds());
  const withTimed = {
    ...topology,
    transfers: [...topology.transfers, { from: 0, to: 1, seconds: 90 }],
  };

  const decoded = decodeTopology(encodeTopology(withTimed));

  expect(decoded.complexes).toEqual(topology.complexes);
  expect(decoded.transfers).toEqual(withTimed.transfers);
  expect(decoded.stations.map(({ complex }) => complex)).toEqual(
    topology.stations.map(({ complex }) => complex),
  );
});

test("the display ingest's complex ids are the routing ingest's", () => {
  const feeds = metroFeeds();
  const { topology } = buildTopology(feeds);
  const { complexOf } = cityComplexes(feeds, []);
  for (const [stopId, , meters] of METRO_PLATFORMS) {
    const station = topology.stations.find(
      ({ lat }) => Math.abs(lat - (37.76 + meters / 111_320)) < 1e-6,
    );
    expect(complexOf("muni", stopId)).toBe(station?.complex ?? -1);
  }
  expect(complexOf("muni", "1")).toBeGreaterThan(0);
});

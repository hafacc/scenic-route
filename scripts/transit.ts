// `bun run build-transit`: the rail TOPOLOGY the routing graph rides on, as data/transit/<city>.bin
// (magic TRNS) — every station a train calls at, every route with the colour and names its agency
// publishes, and every stop PATTERN a route runs, carrying the ride seconds between one stop and the
// next. The tiler turns that into station and platform nodes with board/ride/alight edges; the
// timetable those edges depart against is a different artifact, rebuilt daily
// (scripts/transit-schedule.ts).
//
// Same feeds and the same route types as the display ingests (scripts/subway.ts,
// scripts/subway-sf.ts), through the same cache entries, so the network drawn on the map and the
// network the router rides are one network. Nothing here is clipped to the city's land: rail is not
// walked on, and cutting BART at the shoreline would sever the tube in the middle of the bay.
//
// Plain git, never LFS: it is tens of kilobytes and it is an input the tiler reads on every graph
// build. Layout: scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Cursor, readUnsignedVarint } from "../src/tiles/varint";
import { toSeconds } from "./ferries";
import { COORD_SCALE, haversineMeters, writeVarint } from "./geometry";
import {
  fetchGtfsZipFile,
  type GtfsFeed,
  type GtfsRow,
  parseGtfs,
} from "./gtfs";
import type { Coord } from "./socrata";
import {
  centroid,
  clusterByName,
  nextComplexId,
  parseColor,
  type Rgb,
  transferComplexes,
} from "./subway-format";

const DATA_DIR = join(import.meta.dirname, "..", "data");
export const TRANSIT_DIR = join(DATA_DIR, "transit");

export const TRANSIT_MAGIC = "TRNS";
export const TRANSIT_FORMAT = 1;
const HEADER_BYTES = 56;
const STATION_BYTES = 16;
const ROUTE_BYTES = 12;
const PATTERN_BYTES = 16;
const SURFACE_FLAG = 1;
// Joins the parts of a pattern key. NUL because a GTFS route id or stop name may carry any
// printable character, spaces and punctuation included, but never this one.
const KEY_SEPARATOR = "\u0000";

// The GTFS defaults for a route that publishes no colour, as the display ingests use them.
const DEFAULT_ROUTE_COLOR = "FFFFFF";
const DEFAULT_TEXT_COLOR = "000000";

// How much of its own (route, direction)'s trips a stop pattern has to carry to be kept. A subway
// route runs a handful of patterns that are the service — the full line, the express, the short
// turn — and a long tail of one-offs: a train laying up at a yard, a single put-in, a work move.
// The tail is not service anyone can plan a walk around, and every pattern kept costs a platform
// node at each of its stops.
//
// Unlike the display ingest's service floor there is no empty band to aim at here: the shares run
// continuously from a single trip upward, so the value is set by what it costs against what it
// keeps. At 2% and the 2026 feeds New York drops 80 of its 218 patterns — together 1.3% of its
// trips, and a third of the platform nodes, 6,357 down to 4,084 — the largest of them 12 trips of
// the L in a day. San Francisco drops 15 of 96, carrying 0.45% of its trips. The busiest pattern of
// a (route, direction) is kept whatever its share, so a route can never lose its whole service to
// this: New York's FX runs two trips in the schedule and keeps both.
const MIN_PATTERN_SHARE = 0.02;

// One feed of a city's rail, cached under the key its display ingest already uses so the two read
// one zip.
export interface TransitFeedSource {
  id: string; // namespaces stop and service ids, so two feeds' ids cannot collide
  name: string;
  url: string;
  cacheKey: string;
  routeTypes: ReadonlySet<string>;
  // Prefixed onto the artifact's route id, matching the display ingest's, so a TRNS route and an
  // SBWY route of the same line carry the same id.
  routePrefix: string;
  // Which of the feed's route_ids are one route. BART splits every line into a northbound and a
  // southbound route_id ("Yellow-N", "Yellow-S") that run one pair of rails under one colour, so
  // they are folded the way the map folds them; everywhere else a route_id is a route. A key that
  // is not the route_id is the name the group shares, and becomes the route's short name — "Yellow"
  // rather than whichever direction's row happened to come first.
  groupKey: (row: GtfsRow) => string;
  // Stations the feed models as bare kerbside stops but which are actually underground, so the
  // tiler charges the full descent to the platform rather than a step off the pavement. Only Muni
  // needs one: it publishes no `parent_station`, no `location_type` and no entrances, so nothing in
  // the feed separates the Market Street and Central Subway platforms from a stop on the tarmac.
  underground: ReadonlySet<string>;
}

const NO_UNDERGROUND: ReadonlySet<string> = new Set<string>();

// The Muni stops that are underground, exactly as the feed names them: the Market Street subway
// (Embarcadero to West Portal, both platforms of each), the Central Subway's three, and Forest
// Hill's outbound platform, which the feed names without the "Metro" prefix its twin carries.
const MUNI_UNDERGROUND: ReadonlySet<string> = new Set([
  "Chinatown - Rose Pak Station",
  "Forest Hill Station Outbound",
  "Metro Castro Station/Downtown",
  "Metro Castro Station/Outbound",
  "Metro Church Station/Downtown",
  "Metro Church Station/Outbound",
  "Metro Civic Center Station/Downtn",
  "Metro Civic Center Station/Outbd",
  "Metro Embarcadero Station",
  "Metro Forest Hill Station/Downtown",
  "Metro Montgomery Station/Downtown",
  "Metro Montgomery Station/Outbound",
  "Metro Powell Station/Downtown",
  "Metro Powell Station/Outbound",
  "Metro Van Ness Station",
  "Union Square/Market St Station Northbound",
  "Union Square/Market St Station Southbound",
  "Van Ness Station Outbound",
  "West Portal Station",
  "Yerba Buena/Moscone Station Northbound",
  "Yerba Buena/Moscone Station Southbound",
]);

// Each city's rail feeds. New York: the MTA's subway zip, route_type 1 (the subway proper) and 2
// (the Staten Island Railway) — the two the map draws. San Francisco: Muni's rail, route_type 0
// (the Metro lines and the F streetcar) and 5 (the cable cars), plus BART; no buses in either city.
const CITY_FEEDS: Readonly<Record<string, readonly TransitFeedSource[]>> = {
  nyc: [
    {
      id: "mta",
      name: "MTA subway",
      url: "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip",
      cacheKey: "gtfs-subway",
      routeTypes: new Set(["1", "2"]),
      routePrefix: "",
      groupKey: (row) => row.route_id,
      underground: NO_UNDERGROUND,
    },
  ],
  sf: [
    {
      id: "muni",
      name: "SFMTA Muni",
      url: "https://muni-gtfs.apps.sfmta.com/data/muni_gtfs-current.zip",
      cacheKey: "gtfs-muni",
      routeTypes: new Set(["0", "5"]),
      routePrefix: "muni:",
      groupKey: (row) => row.route_id,
      underground: MUNI_UNDERGROUND,
    },
    {
      id: "bart",
      name: "BART",
      url: "https://www.bart.gov/dev/schedules/google_transit.zip",
      cacheKey: "gtfs-bart",
      routeTypes: new Set(["1"]),
      routePrefix: "bart:",
      groupKey: (row) => (row.route_short_name ?? "").split("-")[0].trim(),
      underground: NO_UNDERGROUND,
    },
  ],
};

// The cities that have rail at all, in the order the daily schedule job walks them.
export const TRANSIT_CITIES: readonly string[] = Object.keys(CITY_FEEDS);

export function feedsOf(cityId: string): readonly TransitFeedSource[] {
  const feeds = CITY_FEEDS[cityId];
  if (!feeds) {
    throw new Error(
      `no transit feeds for ${cityId}; known: ${TRANSIT_CITIES.join(", ")}`,
    );
  } else {
    return feeds;
  }
}

export interface LoadedFeed {
  source: TransitFeedSource;
  feed: GtfsFeed;
}

export async function loadFeeds(cityId: string): Promise<LoadedFeed[]> {
  const loaded: LoadedFeed[] = [];
  for (const source of feedsOf(cityId)) {
    console.error(`transit: reading ${source.name}`);
    loaded.push({
      source,
      feed: parseGtfs(await fetchGtfsZipFile(source.cacheKey, source.url)),
    });
  }
  return loaded;
}

// One station a train calls at: where a walker meets it, what a rider calls it, and whether it is
// entered off the pavement or down a stair.
export interface TransitStation extends Coord {
  name: string;
  // The connected component of the feed's own transfers.txt this station is in, from 1, or 0 where
  // the feed publishes no transfer between two different stations. Two stations sharing a non-zero
  // id are one place to change trains at.
  complex: number;
  surface: boolean;
}

// One route as its agency publishes it. `shortName` is what a rider says ("A", "N", "Yellow"),
// `longName` the corridor.
export interface TransitRoute {
  id: string;
  shortName: string;
  longName: string;
  color: Rgb;
  textColor: Rgb;
}

// One trip on a pattern, for the timetable to depart against. `departure` is seconds from midnight
// of the service day at the pattern's FIRST stop; a trip listed in frequencies.txt has a template
// departure that no train keeps, which is why the schedule writer reads its bands instead.
export interface PatternTrip {
  feedId: string;
  tripId: string;
  serviceKey: string; // `${feedId}:${serviceId}`
  departure: number;
}

// One ordered stop sequence a route runs in one direction: the stations in order, the cumulative
// seconds from the first of them to each (the median over the trips running it), and those trips.
export interface TransitPattern {
  laneId: number;
  routeIndex: number;
  direction: number;
  stops: readonly number[]; // indices into the station table
  offsets: readonly number[]; // seconds from the first stop's departure, non-decreasing, [0] = 0
  trips: readonly PatternTrip[];
}

export interface TransitTopology {
  stations: readonly TransitStation[];
  routes: readonly TransitRoute[];
  patterns: readonly TransitPattern[];
}

// What the share rule threw away, for the ingest log.
export interface PatternCounts {
  raw: number;
  kept: number;
  droppedTrips: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  } else {
    return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  }
}

// A pattern's stable id: FNV-1a over its route, direction and the NAMES of the stations it calls
// at. The graph bakes these ids into its board edges and the daily timetable is keyed by them, so
// the two artifacts are written days apart and have to agree without either reading the other —
// names are what survives that, exactly as the ferry lanes are keyed by terminal name. A pattern
// whose stops change gets a new id and simply has no timetable until the graph is rebuilt.
export function laneIdOf(
  routeId: string,
  direction: number,
  stopNames: readonly string[],
): number {
  const key = [routeId, String(direction), ...stopNames].join(KEY_SEPARATOR);
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(key)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash;
}

// A feed's routes of the kept types, folded onto their group key. The group's primary row — the
// lowest route_id — supplies the names and colours, which for BART is the northbound half of a line
// and for everyone else the route itself.
function feedRoutes(
  feed: GtfsFeed,
  source: TransitFeedSource,
): { route: TransitRoute; feedRouteIds: string[] }[] {
  const groups = new Map<string, GtfsRow[]>();
  for (const row of feed.routes) {
    if (!source.routeTypes.has(row.route_type)) {
      continue;
    }
    const key = source.groupKey(row);
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  const routes: { route: TransitRoute; feedRouteIds: string[] }[] = [];
  for (const [key, group] of groups) {
    const ordered = [...group].sort((left, right) =>
      left.route_id < right.route_id ? -1 : 1,
    );
    const [primary] = ordered;
    routes.push({
      route: {
        id: `${source.routePrefix}${key}`,
        shortName:
          key === primary.route_id
            ? (primary.route_short_name?.trim() ?? "")
            : key,
        longName: primary.route_long_name?.trim() ?? "",
        color: parseColor(primary.route_color ?? "", DEFAULT_ROUTE_COLOR),
        textColor: parseColor(
          primary.route_text_color ?? "",
          DEFAULT_TEXT_COLOR,
        ),
      },
      feedRouteIds: ordered.map((row) => row.route_id),
    });
  }
  return routes;
}

// One station as a feed models it, before the same-name merge below.
interface RawStation extends Coord {
  key: string; // `${feedId}:${stationId}`
  name: string;
  complex: number;
  surface: boolean;
}

// The stations one feed's kept trips call at. GTFS models a station as a parent stop with one child
// platform per direction, so a stop's `parent_station` is the station and a stop without one stands
// in for itself. A feed that publishes no parent anywhere has not said which of its stops are one
// station, so its same-named stops within STATION_MERGE_METERS are chained into one (the display
// ingest's own figure, measured there against Muni's stop pairs) — otherwise
// every Muni intersection would be two stations a median apart and a rider changing direction would
// have no station to change at.
function feedStations(
  feed: GtfsFeed,
  source: TransitFeedSource,
  keptTrips: ReadonlySet<string>,
  complexes: ReadonlyMap<string, number>,
): { stations: RawStation[]; stationOfStop: Map<string, string> } {
  const stopRow = new Map(feed.stops.map((stop) => [stop.stop_id, stop]));
  const publishesParents = feed.stops.some(
    (stop) => (stop.parent_station ?? "").trim() !== "",
  );

  const stationOfStop = new Map<string, string>();
  const raw = new Map<string, RawStation>();
  const seen = new Set<string>();
  for (const time of feed.stopTimes) {
    if (!keptTrips.has(time.trip_id) || seen.has(time.stop_id)) {
      continue;
    }
    seen.add(time.stop_id);
    const stop = stopRow.get(time.stop_id);
    const stationId = stop?.parent_station?.trim() || time.stop_id;
    const row = stopRow.get(stationId);
    const lat = Number(row?.stop_lat);
    const lng = Number(row?.stop_lon);
    if (row === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      console.error(`  station ${stationId}: no coordinate, dropped`);
      continue;
    }
    const name = row.stop_name?.trim() ?? "";
    stationOfStop.set(time.stop_id, `${source.id}:${stationId}`);
    raw.set(`${source.id}:${stationId}`, {
      key: `${source.id}:${stationId}`,
      lat,
      lng,
      name,
      complex: complexes.get(stationId) ?? 0,
      // A feed that models its stops as stations is saying they are enclosed places with a way in;
      // one that models nothing is describing the kerb, apart from the platforms named above.
      surface: !publishesParents && !source.underground.has(name),
    });
  }

  if (publishesParents) {
    return { stations: [...raw.values()], stationOfStop };
  } else {
    return mergeByName([...raw.values()], stationOfStop);
  }
}

// Same-named stops within STATION_MERGE_METERS chained into one station at their centroid, carrying
// the lowest complex any member is in and underground if any member is. Single-link, so a terminal's
// three kerbs become one station.
function mergeByName(
  stations: readonly RawStation[],
  stationOfStop: Map<string, string>,
): { stations: RawStation[]; stationOfStop: Map<string, string> } {
  const merged: RawStation[] = [];
  const mergedKeyOf = new Map<string, string>();
  for (const cluster of clusterByName(stations)) {
    const ids = cluster
      .map(({ complex }) => complex)
      .filter((complex) => complex !== 0);
    // The lowest member key, so the merged station's key does not depend on the order the feed
    // listed its stops in.
    const key = cluster.map(({ key: member }) => member).sort()[0];
    for (const member of cluster) {
      mergedKeyOf.set(member.key, key);
    }
    merged.push({
      ...centroid(cluster),
      key,
      name: cluster[0].name,
      complex: ids.length === 0 ? 0 : Math.min(...ids),
      surface: cluster.every((one) => one.surface),
    });
  }

  const remapped = new Map<string, string>();
  for (const [stopId, stationKey] of stationOfStop) {
    remapped.set(stopId, mergedKeyOf.get(stationKey) ?? stationKey);
  }
  return { stations: merged, stationOfStop: remapped };
}

// How far apart a BART station and a Muni station of the same name may stand and still be one place
// to change trains at. 150 m is the length of a long concourse — Embarcadero's two sets of platforms
// stand about that far apart — and short enough that two different corners never join.
const NAMED_TRANSFER_METERS = 150;

// Words that say what a place IS rather than which place it is, so one feed writing "Embarcadero
// Station" and another "Embarcadero" are not two stations.
const NAME_NOISE: ReadonlySet<string> = new Set([
  "station",
  "bart",
  "muni",
  "metro",
  "mezzanine",
  "level",
  "platform",
  "st",
  "street",
]);

// Which way the platform faces, written on the end of a Muni stop name. Stripped only from the end,
// because a name can begin with one and mean it: BART calls a station Downtown Berkeley.
const DIRECTION_WORDS: ReadonlySet<string> = new Set([
  "inbound",
  "outbound",
  "outbd",
  "downtown",
  "downtn",
]);

function nameTokens(name: string): string[] {
  const tokens = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token !== "" && !NAME_NOISE.has(token));
  while (tokens.length > 1 && DIRECTION_WORDS.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens;
}

// Do these two names describe the same place? One's words run inside the other's, in order and
// unbroken: "Civic Center" inside "Civic Center/UN Plaza", "Glen Park" inside "San Jose
// Ave/Glen Park Station". A shorter name that is genuinely a different place — 16th St against 24th
// St — shares no such run, and the distance cap catches what is left.
function namesAgree(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const [inner, outer] =
    left.length <= right.length ? [left, right] : [right, left];
  if (inner.length === 0) {
    return false;
  }
  for (let start = 0; start + inner.length <= outer.length; start++) {
    if (inner.every((token, index) => token === outer[start + index])) {
      return true;
    }
  }
  return false;
}

// One place to change at, across two agencies that never say so. A feed's own transfers.txt is the
// agency's answer for its own stations and is left alone; what this adds is the join BETWEEN feeds,
// which neither of San Francisco's publishes — BART and Muni share Embarcadero, Montgomery, Powell,
// Civic Center, Glen Park and Balboa Park, and without this a rider changing there was sent up to
// the pavement and back down again, ninety seconds each way and none of it sheltered.
//
// A station already in a complex brings the whole complex with it, and a pair in none is given the
// next free id, so a feed that does publish its transfers keeps the numbering it had.
function joinNamedComplexes(
  stations: RawStation[],
  feedOfKey: ReadonlyMap<string, string>,
  firstId: number,
): { left: string; right: string; meters: number }[] {
  const parent = stations.map((_station, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root];
    }
    parent[index] = root;
    return root;
  };
  for (let index = 0; index < stations.length; index++) {
    const complex = stations[index].complex;
    if (complex !== 0) {
      for (let other = 0; other < index; other++) {
        if (stations[other].complex === complex) {
          parent[find(index)] = find(other);
          break;
        }
      }
    }
  }

  const tokens = stations.map((station) => nameTokens(station.name));
  const joined: { left: string; right: string; meters: number }[] = [];
  for (let index = 0; index < stations.length; index++) {
    for (let other = index + 1; other < stations.length; other++) {
      if (
        feedOfKey.get(stations[index].key) ===
        feedOfKey.get(stations[other].key)
      ) {
        continue;
      }
      const meters = haversineMeters(stations[index], stations[other]);
      if (
        meters > NAMED_TRANSFER_METERS ||
        !namesAgree(tokens[index], tokens[other])
      ) {
        continue;
      }
      joined.push({
        left: stations[index].name,
        right: stations[other].name,
        meters,
      });
      parent[find(index)] = find(other);
    }
  }
  if (joined.length === 0) {
    return joined;
  }

  const members = new Map<number, number[]>();
  for (let index = 0; index < stations.length; index++) {
    const root = find(index);
    const group = members.get(root);
    if (group) {
      group.push(index);
    } else {
      members.set(root, [index]);
    }
  }
  let nextId = firstId;
  for (const group of members.values()) {
    if (group.length < 2) {
      continue;
    }
    const existing = group
      .map((index) => stations[index].complex)
      .filter((complex) => complex !== 0);
    const id = existing.length > 0 ? Math.min(...existing) : nextId++;
    for (const index of group) {
      stations[index].complex = id;
    }
  }
  return joined;
}

// A trip's stop_times in stop_sequence order.
function tripStopTimes(feed: GtfsFeed): Map<string, GtfsRow[]> {
  const byTrip = new Map<string, GtfsRow[]>();
  for (const row of feed.stopTimes) {
    const rows = byTrip.get(row.trip_id);
    if (rows) {
      rows.push(row);
    } else {
      byTrip.set(row.trip_id, [row]);
    }
  }
  for (const rows of byTrip.values()) {
    rows.sort(
      (left, right) => Number(left.stop_sequence) - Number(right.stop_sequence),
    );
  }
  return byTrip;
}

// A pattern under construction: one offset sample per trip, kept until the median is taken.
interface RawPattern {
  routeIndex: number;
  direction: number;
  stops: number[];
  stopNames: string[];
  samples: number[][]; // per stop, one cumulative-seconds sample per trip
  trips: PatternTrip[];
}

// Every station, route and stop pattern the city's feeds describe. Both artifacts are built from
// this one function, so the topology the graph is cut from and the timetable it departs against
// cannot describe different patterns.
export function buildTopology(
  loaded: readonly LoadedFeed[],
  // The daily timetable passes 0: it emits bands for the lanes the COMMITTED topology carries, and a
  // pattern this run would have thrown away is exactly the one whose trips it must still find.
  minPatternShare: number = MIN_PATTERN_SHARE,
): {
  topology: TransitTopology;
  counts: PatternCounts;
} {
  // Every feed's routes first and together, so the table can be ordered by id and a trip can be
  // pointed at its place in it: the artifact has no display order to keep, unlike SBWY's route mask,
  // and an id is steadier than the row order of a routes.txt.
  const feedRouteIds = new Map<string, Map<string, string>>();
  const collected: TransitRoute[] = [];
  for (const { source, feed } of loaded) {
    const artifactOf = new Map<string, string>();
    for (const { route, feedRouteIds: ids } of feedRoutes(feed, source)) {
      collected.push(route);
      for (const id of ids) {
        artifactOf.set(id, route.id);
      }
    }
    feedRouteIds.set(source.id, artifactOf);
  }
  const routes = collected.sort((left, right) => (left.id < right.id ? -1 : 1));
  const indexOfRoute = new Map(routes.map((route, index) => [route.id, index]));

  const perFeed: {
    source: TransitFeedSource;
    feed: GtfsFeed;
    routeOfTrip: Map<string, number>;
    stationOfStop: Map<string, string>;
  }[] = [];
  const rawStations: RawStation[] = [];
  const feedOfKey = new Map<string, string>();

  let firstComplexId = 1;
  for (const { source, feed } of loaded) {
    // Against this feed's own route ids and no other's: a route_id is unique within a feed and
    // nowhere else, and Muni's bus routes are named exactly as BART's route_ids for four of its
    // lines.
    const artifactOf = feedRouteIds.get(source.id) ?? new Map<string, string>();
    const routeOfTrip = new Map<string, number>();
    for (const trip of feed.trips) {
      const index = indexOfRoute.get(artifactOf.get(trip.route_id) ?? "");
      if (index !== undefined) {
        routeOfTrip.set(trip.trip_id, index);
      }
    }
    // Two feeds in one file, so the second agency's complex ids start past the first's: a complex
    // id means one place only within the feed that numbered it.
    const complexes = transferComplexes(feed, firstComplexId);
    firstComplexId = nextComplexId(complexes);
    const { stations, stationOfStop } = feedStations(
      feed,
      source,
      new Set(routeOfTrip.keys()),
      complexes,
    );
    for (const station of stations) {
      feedOfKey.set(station.key, source.id);
    }
    rawStations.push(...stations);
    perFeed.push({ source, feed, routeOfTrip, stationOfStop });
  }

  // Sorted south to north, then west to east, then by name — the order every other point source in
  // this pipeline is written in.
  rawStations.sort(
    (left, right) =>
      left.lat - right.lat ||
      left.lng - right.lng ||
      (left.name < right.name ? -1 : 1),
  );
  for (const { left, right, meters } of joinNamedComplexes(
    rawStations,
    feedOfKey,
    firstComplexId,
  )) {
    console.error(
      `  one complex: "${left}" and "${right}", ${meters.toFixed(0)} m apart`,
    );
  }
  const stationIndexOf = new Map(
    rawStations.map((station, index) => [station.key, index]),
  );
  const stations: TransitStation[] = rawStations.map(
    ({ lat, lng, name, complex, surface }) => ({
      lat,
      lng,
      name,
      complex,
      surface,
    }),
  );

  const raw = new Map<string, RawPattern>();
  for (const { source, feed, routeOfTrip, stationOfStop } of perFeed) {
    const serviceOfTrip = new Map(
      feed.trips.map((trip) => [trip.trip_id, trip.service_id]),
    );
    const directionOfTrip = new Map(
      feed.trips.map((trip) => [trip.trip_id, Number(trip.direction_id) || 0]),
    );
    for (const [tripId, rows] of tripStopTimes(feed)) {
      const routeIndex = routeOfTrip.get(tripId);
      const serviceId = serviceOfTrip.get(tripId);
      if (routeIndex === undefined || serviceId === undefined) {
        continue;
      }
      const departure = toSeconds(rows[0]?.departure_time ?? "");
      if (rows.length < 2 || departure === null) {
        continue;
      }
      const stops: number[] = [];
      const stopNames: string[] = [];
      const offsets: number[] = [];
      let broken = false;
      for (const row of rows) {
        const stationKey = stationOfStop.get(row.stop_id);
        const index =
          stationKey === undefined ? undefined : stationIndexOf.get(stationKey);
        // The DEPARTURE, not the arrival: a train that holds five minutes at a BART platform has
        // not left, and a rider who reaches it during the dwell catches it. Offsets built off the
        // arrival made that rider miss the train they were standing next to. Each ride then absorbs
        // the dwell at its far end, which is where the time is actually spent.
        const at = toSeconds(row.departure_time || row.arrival_time);
        if (index === undefined || at === null) {
          broken = true;
          break;
        }
        // A pattern calling twice in a row at what the merge made one station is one call: the
        // second is the other kerb of the same corner, and a platform node per call would let the
        // router board a train it is already on.
        if (index === stops[stops.length - 1]) {
          continue;
        }
        stops.push(index);
        stopNames.push(stations[index].name);
        offsets.push(at - departure);
      }
      if (broken || stops.length < 2) {
        continue;
      }

      const direction = directionOfTrip.get(tripId) ?? 0;
      const routeId = routes[routeIndex].id;
      const key = [routeId, direction, ...stops].join(KEY_SEPARATOR);
      let pattern = raw.get(key);
      if (!pattern) {
        pattern = {
          routeIndex,
          direction,
          stops,
          stopNames,
          samples: stops.map(() => []),
          trips: [],
        };
        raw.set(key, pattern);
      }
      offsets.forEach((offset, index) => {
        pattern.samples[index].push(offset);
      });
      pattern.trips.push({
        feedId: source.id,
        tripId,
        serviceKey: `${source.id}:${serviceId}`,
        departure,
      });
    }
  }

  // The share rule, per (route, direction): a pattern earns its platform nodes by carrying a real
  // share of the service, and the busiest pattern of a direction is kept whatever its share.
  const tripsPerDirection = new Map<string, number>();
  const busiest = new Map<string, number>();
  for (const pattern of raw.values()) {
    const direction = `${pattern.routeIndex}${KEY_SEPARATOR}${pattern.direction}`;
    tripsPerDirection.set(
      direction,
      (tripsPerDirection.get(direction) ?? 0) + pattern.trips.length,
    );
    busiest.set(
      direction,
      Math.max(busiest.get(direction) ?? 0, pattern.trips.length),
    );
  }

  const patterns: TransitPattern[] = [];
  const laneKeys = new Map<number, string>();
  let droppedTrips = 0;
  for (const [key, pattern] of raw) {
    const direction = `${pattern.routeIndex}${KEY_SEPARATOR}${pattern.direction}`;
    const total = tripsPerDirection.get(direction) ?? 1;
    const share = pattern.trips.length / total;
    if (
      share < minPatternShare &&
      pattern.trips.length < (busiest.get(direction) ?? 0)
    ) {
      droppedTrips += pattern.trips.length;
      continue;
    }

    // Two trips can put two stops a second apart in either order, so the running maximum is what
    // keeps a ride from running backwards.
    let running = 0;
    const offsets = pattern.samples.map((samples) => {
      running = Math.max(running, median(samples));
      return running;
    });
    const laneId = laneIdOf(
      routes[pattern.routeIndex].id,
      pattern.direction,
      pattern.stopNames,
    );
    // Catches a hash collision and, with it, two patterns whose stations differ but whose station
    // NAMES do not — the lane id is built from names, so those would be one lane to the timetable.
    const seen = laneKeys.get(laneId);
    if (seen !== undefined && seen !== key) {
      // Loud, and then on without this pattern: the daily job rebuilds the timetable from a feed
      // that can change under it, and a collision that stopped the run would take every other city's
      // schedule down with it. The lane the collision names keeps the pattern that claimed it first.
      const readable = (text: string): string =>
        text.replaceAll(KEY_SEPARATOR, " · ");
      console.warn(
        `transit: WARNING two patterns hash to lane ${laneId}: ${readable(seen)} and ${readable(key)}; keeping the first and dropping the second`,
      );
      droppedTrips += pattern.trips.length;
      continue;
    }
    laneKeys.set(laneId, key);
    patterns.push({
      laneId,
      routeIndex: pattern.routeIndex,
      direction: pattern.direction,
      stops: pattern.stops,
      offsets,
      trips: pattern.trips,
    });
  }

  // Ordered by lane id, which the timetable orders by too: the ids are what the two artifacts share,
  // and neither's order may depend on the other's tables.
  patterns.sort((left, right) => left.laneId - right.laneId);

  return {
    topology: { stations, routes, patterns },
    counts: { raw: raw.size, kept: patterns.length, droppedTrips },
  };
}

// The TRNS blob: a header, three fixed-size tables, the pattern-stop varint blob and the name
// table. Little-endian throughout; coordinates quantized to COORD_SCALE about a south-west origin,
// exactly the shared codec.
export function encodeTopology(topology: TransitTopology): Uint8Array {
  const { stations, routes, patterns } = topology;

  let originLng = Number.POSITIVE_INFINITY;
  let originLat = Number.POSITIVE_INFINITY;
  for (const { lat, lng } of stations) {
    originLng = Math.min(originLng, lng);
    originLat = Math.min(originLat, lat);
  }
  if (!Number.isFinite(originLng) || !Number.isFinite(originLat)) {
    originLng = 0;
    originLat = 0;
  }

  const names = [
    ...new Set([
      ...stations.map((station) => station.name),
      ...routes.flatMap((route) => [route.id, route.shortName, route.longName]),
    ]),
  ].sort();
  if (names.length > 0xffff) {
    throw new Error(`${names.length} names: a route's name id is a u16`);
  }
  const widest = Math.max(0, ...stations.map((station) => station.complex));
  if (widest > 0xffff) {
    throw new Error(`complex id ${widest}: a station's complex id is a u16`);
  }
  const nameIndex = new Map(names.map((name, index) => [name, index]));

  const stopBytes: number[] = [];
  const patternOffsets: number[] = [];
  const scratch = new Uint8Array(10);
  const push = (value: number): void => {
    const end = writeVarint(scratch, 0, value);
    for (let byte = 0; byte < end; byte++) {
      stopBytes.push(scratch[byte]);
    }
  };
  for (const pattern of patterns) {
    patternOffsets.push(stopBytes.length);
    let previous = 0;
    pattern.stops.forEach((station, index) => {
      push(station);
      push(pattern.offsets[index] - previous);
      previous = pattern.offsets[index];
    });
  }
  while (stopBytes.length % 4 !== 0) {
    stopBytes.push(0);
  }
  const stopBlob = Uint8Array.from(stopBytes);

  const stationTable = new Uint8Array(stations.length * STATION_BYTES);
  const stationView = new DataView(stationTable.buffer);
  stations.forEach((station, index) => {
    const record = index * STATION_BYTES;
    stationView.setInt32(
      record,
      Math.round((station.lng - originLng) / COORD_SCALE),
      true,
    );
    stationView.setInt32(
      record + 4,
      Math.round((station.lat - originLat) / COORD_SCALE),
      true,
    );
    stationView.setUint32(record + 8, nameIndex.get(station.name) ?? 0, true);
    stationView.setUint16(record + 12, station.complex, true);
    stationView.setUint8(record + 14, station.surface ? SURFACE_FLAG : 0);
  });

  const routeTable = new Uint8Array(routes.length * ROUTE_BYTES);
  const routeView = new DataView(routeTable.buffer);
  routes.forEach((route, index) => {
    const record = index * ROUTE_BYTES;
    routeTable[record] = route.color.red;
    routeTable[record + 1] = route.color.green;
    routeTable[record + 2] = route.color.blue;
    routeTable[record + 3] = route.textColor.red;
    routeTable[record + 4] = route.textColor.green;
    routeTable[record + 5] = route.textColor.blue;
    routeView.setUint16(record + 6, nameIndex.get(route.shortName) ?? 0, true);
    routeView.setUint16(record + 8, nameIndex.get(route.longName) ?? 0, true);
    routeView.setUint16(record + 10, nameIndex.get(route.id) ?? 0, true);
  });

  const patternTable = new Uint8Array(patterns.length * PATTERN_BYTES);
  const patternView = new DataView(patternTable.buffer);
  patterns.forEach((pattern, index) => {
    const record = index * PATTERN_BYTES;
    patternView.setUint32(record, pattern.laneId, true);
    patternView.setUint16(record + 4, pattern.routeIndex, true);
    patternView.setUint8(record + 6, pattern.direction);
    patternView.setUint16(record + 8, pattern.stops.length, true);
    patternView.setUint32(record + 12, patternOffsets[index], true);
  });

  const encoder = new TextEncoder();
  const nameBytes = names.map((name) => encoder.encode(name));
  const nameStarts = new Uint32Array(names.length + 1);
  let nameCursor = 0;
  nameBytes.forEach((bytes, index) => {
    nameStarts[index] = nameCursor;
    nameCursor += bytes.length;
  });
  nameStarts[names.length] = nameCursor;
  const nameTable = new Uint8Array(4 + nameStarts.byteLength + nameCursor);
  new DataView(nameTable.buffer).setUint32(0, names.length, true);
  nameTable.set(new Uint8Array(nameStarts.buffer), 4);
  nameBytes.forEach((bytes, index) => {
    nameTable.set(bytes, 4 + nameStarts.byteLength + nameStarts[index]);
  });

  const stationOffset = HEADER_BYTES;
  const routeOffset = stationOffset + stationTable.length;
  const patternOffset = routeOffset + routeTable.length;
  const stopOffset = patternOffset + patternTable.length;
  const nameOffset = stopOffset + stopBlob.length;
  const total = nameOffset + nameTable.length;

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 4; index++) {
    bytes[index] = TRANSIT_MAGIC.charCodeAt(index);
  }
  view.setUint16(4, TRANSIT_FORMAT, true);
  view.setUint16(6, HEADER_BYTES, true);
  view.setUint32(8, stations.length, true);
  view.setUint32(12, routes.length, true);
  view.setUint32(16, patterns.length, true);
  view.setUint32(20, stopBlob.length, true);
  view.setFloat64(24, originLng, true);
  view.setFloat64(32, originLat, true);
  view.setFloat64(40, COORD_SCALE, true);
  view.setUint32(48, nameOffset, true);
  view.setUint32(52, total, true);
  bytes.set(stationTable, stationOffset);
  bytes.set(routeTable, routeOffset);
  bytes.set(patternTable, patternOffset);
  bytes.set(stopBlob, stopOffset);
  bytes.set(nameTable, nameOffset);
  return bytes;
}

// The reader the Rust tiler's is written against, and what S3 reads to name a ride. `trips` comes
// back empty: the artifact carries the topology, not the schedule.
export function decodeTopology(bytes: Uint8Array): TransitTopology {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const version = view.getUint16(4, true);
  if (magic !== TRANSIT_MAGIC || version !== TRANSIT_FORMAT) {
    throw new Error(`not a v${TRANSIT_FORMAT} transit topology`);
  }
  const stationCount = view.getUint32(8, true);
  const routeCount = view.getUint32(12, true);
  const patternCount = view.getUint32(16, true);
  const originLng = view.getFloat64(24, true);
  const originLat = view.getFloat64(32, true);
  const scale = view.getFloat64(40, true);
  const nameOffset = view.getUint32(48, true);

  const nameCount = view.getUint32(nameOffset, true);
  const nameBlob = nameOffset + 4 + (nameCount + 1) * 4;
  const decoder = new TextDecoder();
  const names: string[] = [];
  for (let index = 0; index < nameCount; index++) {
    const start = view.getUint32(nameOffset + 4 + index * 4, true);
    const end = view.getUint32(nameOffset + 8 + index * 4, true);
    names.push(
      decoder.decode(bytes.subarray(nameBlob + start, nameBlob + end)),
    );
  }

  const stationOffset = HEADER_BYTES;
  const stations: TransitStation[] = [];
  for (let index = 0; index < stationCount; index++) {
    const record = stationOffset + index * STATION_BYTES;
    stations.push({
      lng: originLng + view.getInt32(record, true) * scale,
      lat: originLat + view.getInt32(record + 4, true) * scale,
      name: names[view.getUint32(record + 8, true)] ?? "",
      complex: view.getUint16(record + 12, true),
      surface: (view.getUint8(record + 14) & SURFACE_FLAG) !== 0,
    });
  }

  const routeOffset = stationOffset + stationCount * STATION_BYTES;
  const routes: TransitRoute[] = [];
  for (let index = 0; index < routeCount; index++) {
    const record = routeOffset + index * ROUTE_BYTES;
    routes.push({
      color: {
        red: bytes[record],
        green: bytes[record + 1],
        blue: bytes[record + 2],
      },
      textColor: {
        red: bytes[record + 3],
        green: bytes[record + 4],
        blue: bytes[record + 5],
      },
      shortName: names[view.getUint16(record + 6, true)] ?? "",
      longName: names[view.getUint16(record + 8, true)] ?? "",
      id: names[view.getUint16(record + 10, true)] ?? "",
    });
  }

  const patternOffset = routeOffset + routeCount * ROUTE_BYTES;
  const stopOffset = patternOffset + patternCount * PATTERN_BYTES;
  const patterns: TransitPattern[] = [];
  for (let index = 0; index < patternCount; index++) {
    const record = patternOffset + index * PATTERN_BYTES;
    const stopCount = view.getUint16(record + 8, true);
    const cursor: Cursor = {
      offset: stopOffset + view.getUint32(record + 12, true),
    };
    const stops: number[] = [];
    const offsets: number[] = [];
    let at = 0;
    for (let stop = 0; stop < stopCount; stop++) {
      stops.push(readUnsignedVarint(bytes, cursor));
      at += readUnsignedVarint(bytes, cursor);
      offsets.push(at);
    }
    patterns.push({
      laneId: view.getUint32(record, true),
      routeIndex: view.getUint16(record + 4, true),
      direction: view.getUint8(record + 6),
      stops,
      offsets,
      trips: [],
    });
  }

  return { stations, routes, patterns };
}

export async function buildTransit(cityId: string): Promise<void> {
  const started = performance.now();
  await mkdir(TRANSIT_DIR, { recursive: true });
  const loaded = await loadFeeds(cityId);
  const { topology, counts } = buildTopology(loaded);
  const bytes = encodeTopology(topology);
  await writeFile(join(TRANSIT_DIR, `${cityId}.bin`), bytes);

  const { stations, routes, patterns } = topology;
  routes.forEach((route, index) => {
    const mine = patterns.filter((pattern) => pattern.routeIndex === index);
    const stops = new Set(mine.flatMap((pattern) => [...pattern.stops]));
    console.error(
      `  ${route.shortName} (${route.id}): ${mine.length} pattern(s) over ${stops.size} stations`,
    );
  });
  const surface = stations.filter((station) => station.surface).length;
  const complexes = new Set(
    stations.map(({ complex }) => complex).filter((complex) => complex !== 0),
  );
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.error(
    `transit: ${cityId} ${routes.length} routes, ${stations.length} stations ` +
      `(${surface} at street level, ${complexes.size} transfer complexes), ` +
      `${patterns.length} of ${counts.raw} patterns kept ` +
      `(${counts.droppedTrips} trips on the dropped ones), ` +
      `${bytes.length} bytes in ${seconds}s, sha256 ` +
      `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`,
  );
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { city: { type: "string" } } });
  for (const cityId of values.city === undefined
    ? TRANSIT_CITIES
    : [values.city]) {
    await buildTransit(cityId);
  }
}

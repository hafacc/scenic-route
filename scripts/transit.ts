// Not clipped to land: cutting BART at the shoreline would sever the tube mid-bay.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { decodeSubway } from "../src/subway/format";
import { type Cursor, readUnsignedVarint } from "../src/tiles/varint";
import { toSeconds } from "./ferries";
import {
  COORD_SCALE,
  EARTH_RADIUS_METERS,
  haversineMeters,
  UNNAMED_ID,
  writeVarint,
} from "./geometry";
import {
  fetchGtfsZipFile,
  type GtfsFeed,
  type GtfsRow,
  parseGtfs,
} from "./gtfs";
import { fetchStationEntrances, type OsmStationEntrance } from "./overpass";
import { type Coord, NY_STATE_OPEN_DATA } from "./socrata";
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
const SUBWAY_DIR = join(DATA_DIR, "subway");

export const TRANSIT_MAGIC = "TRNS";
export const TRANSIT_FORMAT = 2;
const HEADER_BYTES = 64;
const STATION_BYTES = 16;
const ENTRANCE_BYTES = 16;
const ROUTE_BYTES = 12;
const PATTERN_BYTES = 16;
const SURFACE_FLAG = 1;
const SPLIT_FLAG = 2;
const ENTRY_FLAG = 1;
const EXIT_FLAG = 2;

// A `sides` mask: bit d for GTFS `direction_id` d.
export const NORTHBOUND_SIDE = 1;
export const SOUTHBOUND_SIDE = 2;
export const BOTH_SIDES = 3;

// Indexed by the `kind` byte; "passage" covers every corridor, where the walk is the cost.
export const ENTRANCE_KINDS = [
  "stair",
  "escalator",
  "elevator",
  "ramp",
  "station house",
  "passage",
] as const;
export type EntranceKind = (typeof ENTRANCE_KINDS)[number];

// NUL: a GTFS route id or stop name may carry any printable character.
const KEY_SEPARATOR = "\u0000";

const DEFAULT_ROUTE_COLOR = "FFFFFF";
const DEFAULT_TEXT_COLOR = "000000";

// Min share of its (route, direction)'s trips a pattern needs; the busiest is always kept.
const MIN_PATTERN_SHARE = 0.02;

export interface TransitFeedSource {
  id: string; // namespaces stop and service ids across feeds
  name: string;
  url: string;
  cacheKey: string;
  routeTypes: ReadonlySet<string>;
  // Matches the display ingest's prefix, so TRNS and SBWY ids agree.
  routePrefix: string;
  // BART splits each line into "-N"/"-S" route_ids; a non-route_id key becomes the short name.
  groupKey: (row: GtfsRow) => string;
  // Muni publishes nothing that separates its subway platforms from curbside stops.
  underground: ReadonlySet<string>;
  displayName?: (feedName: string) => string;
  entrances?: (feed: GtfsFeed) => Promise<FeedEntrances>;
}

export interface FeedEntrance extends Coord {
  stationId: string; // the feed's parent stop id
  kind: EntranceKind;
  entry: boolean;
  exit: boolean;
  // `null` defers to the right-hand rule.
  sides: number | null;
}

export interface FeedEntrances {
  entrances: readonly FeedEntrance[];
  // No free crossover, so the graph gives each direction its own node.
  split: ReadonlySet<string>;
}

const NO_UNDERGROUND: ReadonlySet<string> = new Set<string>();

// Exactly as the feed names them; Forest Hill's outbound platform lacks the "Metro" prefix.
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

const MUNI_PLATFORM_WORDS: ReadonlySet<string> = new Set([
  "downtown",
  "downtn",
  "inbound",
  "outbound",
  "outbd",
  "northbound",
  "southbound",
]);

const METRO_PREFIX = "Metro ";
const STATION_SUFFIX = " Station";

// "Metro Castro Station/Downtown" -> "Castro". Display only; matching keys on the feed's name.
export function muniStationName(feedName: string): string {
  let display = feedName.trim();
  if (display.startsWith(METRO_PREFIX)) {
    display = display.slice(METRO_PREFIX.length);
  }
  const lastBreak = Math.max(
    display.lastIndexOf("/"),
    display.lastIndexOf(" "),
  );
  const tail = display.slice(lastBreak + 1).toLowerCase();
  if (lastBreak > 0 && MUNI_PLATFORM_WORDS.has(tail)) {
    display = display.slice(0, lastBreak);
  }
  if (display.endsWith(STATION_SUFFIX)) {
    display = display.slice(0, -STATION_SUFFIX.length);
  }
  return display.trim();
}

// Anything with a stair in it is a stair: it costs the same descent as the escalator beside it.
const MTA_ENTRANCE_KINDS: Readonly<Record<string, EntranceKind>> = {
  Stair: "stair",
  "Stair/Escalator": "stair",
  "Stair/Ramp": "stair",
  "Stair/Ramp/Walkway": "stair",
  Escalator: "escalator",
  Elevator: "elevator",
  Ramp: "ramp",
  "Station House": "station house",
  "Easement - Street": "passage",
  "Easement - Passage": "passage",
  Walkway: "passage",
  Underpass: "passage",
  Overpass: "passage",
};

// "Subway Entrances and Exits: 2024"; it says nothing about which platform an entrance reaches.
const MTA_ENTRANCE_DATASET = "i9wp-a4ja";
const MTA_ENTRANCE_ROWS = 2_120;

interface MtaEntranceRow {
  gtfs_stop_id?: string;
  entrance_type?: string;
  entry_allowed?: string;
  exit_allowed?: string;
  entrance_latitude?: string;
  entrance_longitude?: string;
}

// One entry per line, `#` comments.
export function curatedLines(name: string): string[] {
  const text = readFileSync(join(TRANSIT_DIR, name), "utf-8");
  return text
    .split("\n")
    .map((line) => line.split("#")[0].trim())
    .filter((line) => line !== "");
}

// Six decimals (~0.1 m) is finer than the dataset's precision, so entrances never collide.
function entranceKey(stationId: string, lng: number, lat: number): string {
  return `${stationId} ${lng.toFixed(6)} ${lat.toFixed(6)}`;
}

export function parseSideOverrides(name: string): Map<string, number> {
  const overrides = new Map<string, number>();
  for (const line of curatedLines(name)) {
    const [stationId, lng, lat, side] = line.split(/\s+/);
    const mask =
      side === "N"
        ? NORTHBOUND_SIDE
        : side === "S"
          ? SOUTHBOUND_SIDE
          : side === "both"
            ? BOTH_SIDES
            : 0;
    if (mask === 0) {
      throw new Error(`${name}: "${line}" names no side (N, S or both)`);
    }
    overrides.set(entranceKey(stationId, Number(lng), Number(lat)), mask);
  }
  return overrides;
}

async function mtaEntrances(): Promise<FeedEntrances> {
  const rows = await NY_STATE_OPEN_DATA.dataset<MtaEntranceRow>(
    MTA_ENTRANCE_DATASET,
    { $select: "*" },
    MTA_ENTRANCE_ROWS,
  );
  const overrides = parseSideOverrides("nyc-entrance-sides.txt");
  // A moved stair would silently drop its override, so every override must match.
  const matched = new Set<string>();
  const entrances: FeedEntrance[] = [];
  for (const row of rows) {
    // Some rows name two stations of one complex, which the graph makes one node anyway.
    const stationId = (row.gtfs_stop_id ?? "").split(";")[0].trim();
    const lat = Number(row.entrance_latitude);
    const lng = Number(row.entrance_longitude);
    const kind = MTA_ENTRANCE_KINDS[(row.entrance_type ?? "").trim()];
    if (stationId === "" || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    } else if (kind === undefined) {
      console.error(`  entrance type "${row.entrance_type}": unknown, dropped`);
      continue;
    }
    const key = entranceKey(stationId, lng, lat);
    const sides = overrides.get(key);
    if (sides !== undefined) {
      matched.add(key);
    }
    entrances.push({
      stationId,
      lat,
      lng,
      kind,
      entry: row.entry_allowed === "YES",
      exit: row.exit_allowed === "YES",
      sides: sides ?? null,
    });
  }
  if (matched.size !== overrides.size) {
    const lost = [...overrides.keys()].filter((key) => !matched.has(key));
    throw new Error(
      `nyc-entrance-sides.txt: ${lost.length} of ${overrides.size} overrides match no published` +
        ` entrance (${lost.join("; ")}). Re-read the dataset's own coordinates for them.`,
    );
  }
  return { entrances, split: new Set(curatedLines("nyc-no-crossover.txt")) };
}

// `location_type=2` stops; every BART mezzanine spans both platforms, so no station is split.
async function bartEntrances(feed: GtfsFeed): Promise<FeedEntrances> {
  const entrances: FeedEntrance[] = [];
  for (const stop of feed.stops) {
    const stationId = (stop.parent_station ?? "").trim();
    const lat = Number(stop.stop_lat);
    const lng = Number(stop.stop_lon);
    if (
      stop.location_type !== "2" ||
      stationId === "" ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {
      continue;
    }
    const name = (stop.stop_name ?? "").toLowerCase();
    entrances.push({
      stationId,
      lat,
      lng,
      kind: name.includes("elevator")
        ? "elevator"
        : name.includes("escalator")
          ? "escalator"
          : name.includes("ramp")
            ? "ramp"
            : "stair",
      entry: true,
      exit: true,
      sides: BOTH_SIDES,
    });
  }
  return { entrances, split: new Set<string>() };
}

// Muni's per-direction stops of one station sit at their own platform ends, up to a block apart.
const PLATFORM_ROW_METERS = 150;

// A Market Street concourse runs a block, so its far door is far from the feed's platform point.
const OSM_ENTRANCE_METERS = 150;

// Only catches a stale name: Montgomery's Sansome & Sutter door is 153 m from its platform.
const NAMED_ENTRANCE_METERS = 300;

const CLOSED_ACCESS: ReadonlySet<string> = new Set(["no", "private"]);

// Rounded out, since the query is cached by its text and a stop moving meters shouldn't refetch.
const ENTRANCE_BOX_MARGIN_DEGREES = 0.01;
const ENTRANCE_BOX_STEP = 100;

function outward(value: number, margin: number): number {
  const moved = value + margin;
  return (
    (margin < 0
      ? Math.floor(moved * ENTRANCE_BOX_STEP)
      : Math.ceil(moved * ENTRANCE_BOX_STEP)) / ENTRANCE_BOX_STEP
  );
}

function entranceBox(points: readonly Coord[]): {
  south: number;
  west: number;
  north: number;
  east: number;
} {
  const lats = points.map(({ lat }) => lat);
  const lngs = points.map(({ lng }) => lng);
  return {
    south: outward(Math.min(...lats), -ENTRANCE_BOX_MARGIN_DEGREES),
    west: outward(Math.min(...lngs), -ENTRANCE_BOX_MARGIN_DEGREES),
    north: outward(Math.max(...lats), ENTRANCE_BOX_MARGIN_DEGREES),
    east: outward(Math.max(...lngs), ENTRANCE_BOX_MARGIN_DEGREES),
  };
}

// `keys` are the per-direction station-table ids sharing one mezzanine.
export interface UndergroundStation {
  keys: readonly string[];
  names: readonly string[];
  points: readonly Coord[];
}

// Merged as the station table merges them, then directions chained on distance.
function undergroundStations(feed: GtfsFeed): UndergroundStation[] {
  const platforms: (Coord & { key: string; name: string })[] = [];
  for (const stop of feed.stops) {
    const name = stop.stop_name?.trim() ?? "";
    const lat = Number(stop.stop_lat);
    const lng = Number(stop.stop_lon);
    if (
      MUNI_UNDERGROUND.has(name) &&
      Number.isFinite(lat) &&
      Number.isFinite(lng)
    ) {
      platforms.push({ key: stop.stop_id, name, lat, lng });
    }
  }
  const rows = clusterByName(platforms).map((cluster) => ({
    ...centroid(cluster),
    key: cluster.map(({ key }) => key).sort()[0],
    name: cluster[0].name,
  }));

  const stations: UndergroundStation[] = [];
  const taken = new Set<string>();
  for (const seed of rows) {
    if (taken.has(seed.key)) {
      continue;
    }
    taken.add(seed.key);
    const members = [seed];
    for (let member = 0; member < members.length; member++) {
      for (const other of rows) {
        if (
          !taken.has(other.key) &&
          haversineMeters(members[member], other) <= PLATFORM_ROW_METERS
        ) {
          taken.add(other.key);
          members.push(other);
        }
      }
    }
    stations.push({
      keys: members.map(({ key }) => key),
      names: members.map(({ name }) => name),
      points: members.map(({ lat, lng }) => ({ lat, lng })),
    });
  }
  return stations;
}

// OSM tags the descent only where it is not a stair, so a node that says nothing is one.
function osmEntranceKind(node: OsmStationEntrance): EntranceKind {
  if (node.elevator) {
    return "elevator";
  } else if (node.escalator) {
    return "escalator";
  } else if (node.ramp) {
    return "ramp";
  } else {
    return "stair";
  }
}

// OSM `station_name`, minus "station", is a substring of the feed's; `name` is the street corner.
function namesStation(written: string, stationName: string): boolean {
  const wanted = written.toLowerCase().replaceAll("station", "").trim();
  return wanted !== "" && stationName.toLowerCase().includes(wanted);
}

// The named station wins over the nearest; in SF the unmatched are BART doors, already in its feed.
export function matchStationEntrances(
  stations: readonly UndergroundStation[],
  nodes: readonly OsmStationEntrance[],
): {
  entrances: FeedEntrance[];
  unmatched: OsmStationEntrance[];
  closed: OsmStationEntrance[];
} {
  const entrances: FeedEntrance[] = [];
  const unmatched: OsmStationEntrance[] = [];
  const closed: OsmStationEntrance[] = [];
  for (const node of nodes) {
    if (CLOSED_ACCESS.has((node.access ?? "").toLowerCase())) {
      closed.push(node);
      continue;
    }
    const written = node.stationName;
    const reachable = stations
      .map((station) => ({
        station,
        meters: Math.min(
          ...station.points.map((point) => haversineMeters(point, node)),
        ),
      }))
      .filter(({ meters }) => meters <= NAMED_ENTRANCE_METERS)
      .sort((left, right) => left.meters - right.meters);
    const named =
      written === undefined
        ? undefined
        : reachable.find(({ station }) =>
            station.names.some((name) => namesStation(written, name)),
          );
    const matched =
      named ?? reachable.find(({ meters }) => meters <= OSM_ENTRANCE_METERS);
    if (matched === undefined) {
      unmatched.push(node);
      continue;
    }
    for (const key of matched.station.keys) {
      entrances.push({
        stationId: key,
        lat: node.lat,
        lng: node.lng,
        kind: osmEntranceKind(node),
        entry: true,
        exit: true,
        sides: BOTH_SIDES,
      });
    }
  }
  return { entrances, unmatched, closed };
}

// Muni publishes no entrances, so these come from OSM; every Metro mezzanine spans both directions.
async function muniEntrances(feed: GtfsFeed): Promise<FeedEntrances> {
  const stations = undergroundStations(feed);
  const { south, west, north, east } = entranceBox(
    stations.flatMap(({ points }) => points),
  );
  const nodes = await fetchStationEntrances(south, west, north, east);
  const { entrances, unmatched, closed } = matchStationEntrances(
    stations,
    nodes,
  );
  for (const node of closed) {
    const written = node.name ?? node.stationName ?? "unnamed";
    console.error(
      `  OSM entrance "${written}" at ${node.lat.toFixed(6)},${node.lng.toFixed(6)}: ` +
        `access=${node.access}, skipped`,
    );
  }
  for (const node of unmatched) {
    const written = node.stationName ?? node.name ?? "unnamed";
    console.error(
      `  OSM entrance "${written}" at ${node.lat.toFixed(6)},${node.lng.toFixed(6)}: ` +
        `no Metro station within ${OSM_ENTRANCE_METERS} m, dropped`,
    );
  }
  for (const station of stations) {
    const doors = entrances.filter(
      ({ stationId }) => stationId === station.keys[0],
    );
    console.error(
      `  ${station.names.join(" + ")}: ${doors.length} OSM entrance(s)`,
    );
  }
  console.error(
    `  ${nodes.length} OSM node(s) in ${south},${west},${north},${east}, ` +
      `${closed.length} closed, ${unmatched.length} not a Metro station's, ` +
      `${entrances.length} entrance row(s)`,
  );
  return { entrances, split: new Set<string>() };
}

// route_type 0 light rail, 1 subway, 2 rail (Staten Island Railway), 5 cable car.
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
      entrances: mtaEntrances,
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
      displayName: muniStationName,
      entrances: muniEntrances,
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
      entrances: bartEntrances,
    },
  ],
};

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

export interface TransitStation extends Coord {
  name: string;
  // transfers.txt component, from 1; 0 for none. Stations sharing an id are one transfer point.
  complex: number;
  surface: boolean;
  // No free crossover; never set within a complex, where a transfer never reaches the street.
  split: boolean;
}

export interface TransitEntrance extends Coord {
  station: number;
  sides: number;
  kind: EntranceKind;
  entry: boolean;
  exit: boolean;
}

export interface TransitRoute {
  id: string;
  shortName: string;
  longName: string;
  color: Rgb;
  textColor: Rgb;
}

export interface PatternTrip {
  feedId: string;
  tripId: string;
  serviceKey: string; // `${feedId}:${serviceId}`
  // Seconds after service-day midnight at the first stop; a frequencies.txt trip's is a template.
  departure: number;
}

export interface TransitPattern {
  laneId: number;
  routeIndex: number;
  direction: number;
  stops: readonly number[]; // indices into the station table
  offsets: readonly number[]; // median seconds from the first stop, non-decreasing, [0] = 0
  trips: readonly PatternTrip[];
}

export interface TransitTopology {
  stations: readonly TransitStation[];
  entrances: readonly TransitEntrance[];
  routes: readonly TransitRoute[];
  patterns: readonly TransitPattern[];
}

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

// FNV-1a over station names, so the graph and a timetable built days later agree without sharing.
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

// The lowest route_id in a group supplies its names and colors.
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

interface RawStation extends Coord {
  key: string; // `${feedId}:${stationId}`
  name: string;
  complex: number;
  surface: boolean;
}

// A feed with no `parent_station` anywhere gets its same-named nearby stops merged into stations.
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
      // A feed that models parent stations is describing enclosed places, not the curb.
      surface: !publishesParents && !source.underground.has(name),
    });
  }

  if (publishesParents) {
    return { stations: [...raw.values()], stationOfStop };
  } else {
    return mergeByName([...raw.values()], stationOfStop);
  }
}

// Single-link, so a terminal's three curbs become one station.
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
    // Lowest, so the key doesn't depend on feed order.
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

// A long concourse: Embarcadero's BART and Muni platforms are about this far apart.
const NAMED_TRANSFER_METERS = 150;

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

// Stripped only from the end: BART has a Downtown Berkeley.
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

// True when one name's tokens run contiguously inside the other's.
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

// Cross-feed transfers, which neither SF feed publishes; a station brings its whole complex along.
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

interface RawPattern {
  routeIndex: number;
  direction: number;
  stops: number[];
  stopNames: string[];
  samples: number[][]; // per stop, one cumulative-seconds sample per trip
  trips: PatternTrip[];
}

// Meters east and north.
export interface Bearing {
  east: number;
  north: number;
}

const DEGREES_TO_METERS = (Math.PI / 180) * EARTH_RADIUS_METERS;

function offsetMeters(from: Coord, to: Coord): Bearing {
  const middle = (((from.lat + to.lat) / 2) * Math.PI) / 180;
  return {
    east: (to.lng - from.lng) * Math.cos(middle) * DEGREES_TO_METERS,
    north: (to.lat - from.lat) * DEGREES_TO_METERS,
  };
}

function offsetPoint(from: Coord, offset: Bearing): Coord {
  const middle = (from.lat * Math.PI) / 180;
  return {
    lng: from.lng + offset.east / (Math.cos(middle) * DEGREES_TO_METERS),
    lat: from.lat + offset.north / DEGREES_TO_METERS,
  };
}

function normalize(vector: Bearing): Bearing | null {
  const length = Math.hypot(vector.east, vector.north);
  if (length === 0) {
    return null;
  } else {
    return { east: vector.east / length, north: vector.north / length };
  }
}

export interface TrackAxis {
  origin: Coord; // on the rails
  bearing: Bearing; // the way a direction-0 train runs
}

// Closer to the axis than this, an entrance is astride the tracks and reaches both platforms.
const AMBIGUOUS_METERS = 8;

// NYC runs right-handed, so a stair reaches the platform of the direction whose right it is on.
export function sideMask(axis: TrackAxis, entrance: Coord): number {
  const offset = offsetMeters(axis.origin, entrance);
  const across =
    axis.bearing.east * offset.north - axis.bearing.north * offset.east;
  if (Math.abs(across) < AMBIGUOUS_METERS) {
    return BOTH_SIDES;
  } else if (across < 0) {
    return NORTHBOUND_SIDE;
  } else {
    return SOUTHBOUND_SIDE;
  }
}

// Coarse (a chord between neighboring stops), so only used to orient drawn track or as a fallback.
function rideBearings(
  stations: readonly TransitStation[],
  patterns: readonly TransitPattern[],
): (Bearing | null)[] {
  const sums: Bearing[] = stations.map(() => ({ east: 0, north: 0 }));
  for (const pattern of patterns) {
    if (pattern.direction !== 0) {
      continue;
    }
    const last = pattern.stops.length - 1;
    pattern.stops.forEach((station, index) => {
      const step = normalize(
        offsetMeters(
          stations[pattern.stops[Math.max(0, index - 1)]],
          stations[pattern.stops[Math.min(last, index + 1)]],
        ),
      );
      if (step !== null) {
        sums[station].east += step.east;
        sums[station].north += step.north;
      }
    });
  }
  return sums.map(normalize);
}

// Keyed by short + long name: SBWY has no route id, and NYC has three `S` shuttles.
export type RouteTracks = ReadonlyMap<string, readonly (readonly Coord[])[]>;

export function routeKey(shortName: string, longName: string): string {
  return [shortName, longName].join(KEY_SEPARATOR);
}

export function readRouteTracks(cityId: string): RouteTracks {
  const path = join(SUBWAY_DIR, `${cityId}.bin`);
  if (!existsSync(path)) {
    console.error(`  ${path}: no drawn track; siding entrances by the ride`);
    return new Map();
  }
  const file = readFileSync(path);
  const subway = decodeSubway(
    file.buffer.slice(
      file.byteOffset,
      file.byteOffset + file.byteLength,
    ) as ArrayBuffer,
  );
  const tracks = new Map<string, Coord[][]>();
  for (const line of subway.lines) {
    const route = subway.routes[line.route];
    if (route === undefined) {
      continue;
    }
    const points: Coord[] = [];
    for (let vertex = 0; vertex < line.lngs.length; vertex++) {
      points.push({ lng: line.lngs[vertex], lat: line.lats[vertex] });
    }
    const key = routeKey(route.shortName, route.longName);
    const drawn = tracks.get(key);
    if (drawn) {
      drawn.push(points);
    } else {
      tracks.set(key, [points]);
    }
  }
  return tracks;
}

// Each side of the station; a single GTFS shape segment is mostly quantization noise.
const TANGENT_METERS = 25;
const MAX_TRACK_METERS = 150;

// Measured from the track, not the station point: the feed puts Nevins St over the sidewalk.
function trackAxis(
  station: Coord,
  lines: readonly (readonly Coord[])[],
  ride: Bearing,
): TrackAxis | null {
  let bestLine: readonly Coord[] | null = null;
  let bestVertex = 0;
  let bestOffset: Bearing = { east: 0, north: 0 };
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const local = line.map((point) => offsetMeters(station, point));
    for (let vertex = 0; vertex + 1 < local.length; vertex++) {
      const from = local[vertex];
      const to = local[vertex + 1];
      const runEast = to.east - from.east;
      const runNorth = to.north - from.north;
      const lengthSquared = runEast * runEast + runNorth * runNorth;
      const along =
        lengthSquared === 0
          ? 0
          : Math.min(
              1,
              Math.max(
                0,
                -(from.east * runEast + from.north * runNorth) / lengthSquared,
              ),
            );
      const offset = {
        east: from.east + along * runEast,
        north: from.north + along * runNorth,
      };
      const distance = Math.hypot(offset.east, offset.north);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestLine = line;
        bestVertex = vertex;
        bestOffset = offset;
      }
    }
  }
  if (bestLine === null || bestDistance > MAX_TRACK_METERS) {
    return null;
  }
  const line = bestLine;

  const origin = offsetPoint(station, bestOffset);
  const metersOff = (point: Coord): number => {
    const offset = offsetMeters(origin, point);
    return Math.hypot(offset.east, offset.north);
  };
  const walk = (step: number): Coord => {
    let at = step < 0 ? bestVertex : bestVertex + 1;
    while (
      metersOff(line[at]) < TANGENT_METERS &&
      at + step >= 0 &&
      at + step < line.length
    ) {
      at += step;
    }
    return line[at];
  };
  const chord = normalize(offsetMeters(walk(-1), walk(1)));
  if (chord === null) {
    return null;
  }
  // A shape runs whichever way it was published, so the ride orients it.
  const forward = chord.east * ride.east + chord.north * ride.north >= 0;
  return {
    origin,
    bearing: forward ? chord : { east: -chord.east, north: -chord.north },
  };
}

function drawnLinesByStation(
  stations: readonly TransitStation[],
  routes: readonly TransitRoute[],
  patterns: readonly TransitPattern[],
  tracks: RouteTracks,
): (readonly Coord[])[][] {
  const perStation: (readonly Coord[])[][] = stations.map(() => []);
  const seen = stations.map(() => new Set<number>());
  for (const pattern of patterns) {
    const route = routes[pattern.routeIndex];
    const drawn =
      route === undefined
        ? undefined
        : tracks.get(routeKey(route.shortName, route.longName));
    if (drawn === undefined) {
      continue;
    }
    for (const station of pattern.stops) {
      if (!seen[station].has(pattern.routeIndex)) {
        seen[station].add(pattern.routeIndex);
        perStation[station].push(...drawn);
      }
    }
  }
  return perStation;
}

export interface EntranceCounts {
  unmatched: string[]; // station ids with no station in the topology
  dropped: number; // entrances at those stations
  split: number;
  splitInComplex: string[];
  sidedByTrack: number;
}

// Separate from the build, which the daily timetable also runs and must stay synchronous.
export async function loadEntrances(
  loaded: readonly LoadedFeed[],
): Promise<Map<string, FeedEntrances>> {
  const byFeed = new Map<string, FeedEntrances>();
  for (const { source, feed } of loaded) {
    if (source.entrances !== undefined) {
      console.error(`transit: reading ${source.name} entrances`);
      byFeed.set(source.id, await source.entrances(feed));
    }
  }
  return byFeed;
}

// Runs after the patterns, since the side rule needs the direction-0 ride.
function placeEntrances(
  loaded: readonly LoadedFeed[],
  byFeed: ReadonlyMap<string, FeedEntrances>,
  stations: TransitStation[],
  stationIndexOf: ReadonlyMap<string, number>,
  routes: readonly TransitRoute[],
  patterns: readonly TransitPattern[],
  tracks: RouteTracks,
): { entrances: TransitEntrance[]; counts: EntranceCounts } {
  // Most transfers.txt stations transfer only to themselves; a complex means a shared id.
  const complexSize = new Map<number, number>();
  for (const { complex } of stations) {
    if (complex !== 0) {
      complexSize.set(complex, (complexSize.get(complex) ?? 0) + 1);
    }
  }

  const unmatched = new Set<string>();
  const splitInComplex: string[] = [];
  for (const { source } of loaded) {
    for (const stationId of byFeed.get(source.id)?.split ?? []) {
      const index = stationIndexOf.get(`${source.id}:${stationId}`);
      if (index === undefined) {
        unmatched.add(`${source.id}:${stationId}`);
      } else if ((complexSize.get(stations[index].complex) ?? 0) > 1) {
        splitInComplex.push(stations[index].name);
      } else {
        stations[index].split = true;
      }
    }
  }

  // Lazy: only split stations (86 of 496) need an axis.
  const bearings = rideBearings(stations, patterns);
  const drawnFor = drawnLinesByStation(stations, routes, patterns, tracks);
  const axes = new Map<number, { axis: TrackAxis; drawn: boolean } | null>();
  const axisOf = (
    index: number,
  ): { axis: TrackAxis; drawn: boolean } | null => {
    const known = axes.get(index);
    if (known !== undefined) {
      return known;
    }
    const ride = bearings[index];
    const station = stations[index];
    const drawn =
      ride === null ? null : trackAxis(station, drawnFor[index], ride);
    let found: { axis: TrackAxis; drawn: boolean } | null = null;
    if (drawn !== null) {
      found = { axis: drawn, drawn: true };
    } else if (ride !== null) {
      found = { axis: { origin: station, bearing: ride }, drawn: false };
    }
    axes.set(index, found);
    return found;
  };

  const entrances: TransitEntrance[] = [];
  let dropped = 0;
  let onTrack = 0;
  for (const { source } of loaded) {
    for (const entrance of byFeed.get(source.id)?.entrances ?? []) {
      const index = stationIndexOf.get(`${source.id}:${entrance.stationId}`);
      if (index === undefined) {
        unmatched.add(`${source.id}:${entrance.stationId}`);
        dropped += 1;
        continue;
      }
      const found = stations[index].split ? axisOf(index) : null;
      if (found?.drawn) {
        onTrack += 1;
      }
      entrances.push({
        lat: entrance.lat,
        lng: entrance.lng,
        station: index,
        sides:
          entrance.sides ??
          (found === null ? BOTH_SIDES : sideMask(found.axis, entrance)),
        kind: entrance.kind,
        entry: entrance.entry,
        exit: entrance.exit,
      });
    }
  }
  entrances.sort(
    (left, right) =>
      left.station - right.station ||
      left.lng - right.lng ||
      left.lat - right.lat,
  );

  return {
    entrances,
    counts: {
      unmatched: [...unmatched].sort(),
      dropped,
      split: stations.filter((station) => station.split).length,
      splitInComplex,
      sidedByTrack: onTrack,
    },
  };
}

// Shared by the topology and the timetable, so the two can't describe different patterns.
export function buildTopology(
  loaded: readonly LoadedFeed[],
  // The timetable passes 0: it must find trips for every lane the committed topology carries.
  minPatternShare: number = MIN_PATTERN_SHARE,
  feedEntrances: ReadonlyMap<string, FeedEntrances> = new Map(),
  tracks: RouteTracks = new Map(),
): {
  topology: TransitTopology;
  counts: PatternCounts;
  entranceCounts: EntranceCounts;
} {
  // All feeds' routes first, so the table can be ordered by id.
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
    // Per feed: four Muni bus route_ids equal BART route_ids.
    const artifactOf = feedRouteIds.get(source.id) ?? new Map<string, string>();
    const routeOfTrip = new Map<string, number>();
    for (const trip of feed.trips) {
      const index = indexOfRoute.get(artifactOf.get(trip.route_id) ?? "");
      if (index !== undefined) {
        routeOfTrip.set(trip.trip_id, index);
      }
    }
    // Each feed's complex ids start past the previous feed's.
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

  // South to north, west to east, then name, like every other point source.
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
  const displayNameOf = new Map(
    loaded.map(({ source }) => [source.id, source.displayName]),
  );
  const stations: TransitStation[] = rawStations.map(
    ({ key, lat, lng, name, complex, surface }) => {
      const display = displayNameOf.get(feedOfKey.get(key) ?? "");
      return {
        lat,
        lng,
        name: display === undefined ? name : display(name),
        complex,
        surface,
        split: false,
      };
    },
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
        // Departure, not arrival: a rider reaching the platform during a dwell still catches it.
        const at = toSeconds(row.departure_time || row.arrival_time);
        if (index === undefined || at === null) {
          broken = true;
          break;
        }
        // Two curbs merged into one station are one call, or the router could board its own train.
        if (index === stops[stops.length - 1]) {
          continue;
        }
        stops.push(index);
        // The feed's name, not the display name, so a display rename doesn't move the lane id.
        stopNames.push(rawStations[index].name);
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

    // Medians of close stops can invert, so a running max keeps rides from going backwards.
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
    // Catches hash collisions and distinct patterns with identical station names.
    const seen = laneKeys.get(laneId);
    if (seen !== undefined && seen !== key) {
      // Warn, not throw: failing would take every other city's daily schedule down too.
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

  // By lane id, as the timetable orders them.
  patterns.sort((left, right) => left.laneId - right.laneId);

  const { entrances, counts: entranceCounts } = placeEntrances(
    loaded,
    feedEntrances,
    stations,
    stationIndexOf,
    routes,
    patterns,
    tracks,
  );

  return {
    topology: { stations, entrances, routes, patterns },
    counts: { raw: raw.size, kept: patterns.length, droppedTrips },
    entranceCounts,
  };
}

export function encodeTopology(topology: TransitTopology): Uint8Array {
  const { stations, entrances, routes, patterns } = topology;
  if (stations.length > 0xffff) {
    throw new Error(
      `${stations.length} stations: an entrance's station is a u16`,
    );
  }

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
    stationView.setUint8(
      record + 14,
      (station.surface ? SURFACE_FLAG : 0) | (station.split ? SPLIT_FLAG : 0),
    );
  });

  const entranceTable = new Uint8Array(entrances.length * ENTRANCE_BYTES);
  const entranceView = new DataView(entranceTable.buffer);
  entrances.forEach((entrance, index) => {
    const record = index * ENTRANCE_BYTES;
    entranceView.setInt32(
      record,
      Math.round((entrance.lng - originLng) / COORD_SCALE),
      true,
    );
    entranceView.setInt32(
      record + 4,
      Math.round((entrance.lat - originLat) / COORD_SCALE),
      true,
    );
    entranceView.setUint16(record + 8, entrance.station, true);
    entranceView.setUint8(record + 10, entrance.sides);
    entranceView.setUint8(record + 11, ENTRANCE_KINDS.indexOf(entrance.kind));
    entranceView.setUint8(
      record + 12,
      (entrance.entry ? ENTRY_FLAG : 0) | (entrance.exit ? EXIT_FLAG : 0),
    );
    // Entrance name slot, not yet written.
    entranceView.setUint16(record + 14, UNNAMED_ID, true);
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
  const entranceOffset = stationOffset + stationTable.length;
  const routeOffset = entranceOffset + entranceTable.length;
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
  view.setUint32(56, entrances.length, true);
  bytes.set(stationTable, stationOffset);
  bytes.set(entranceTable, entranceOffset);
  bytes.set(routeTable, routeOffset);
  bytes.set(patternTable, patternOffset);
  bytes.set(stopBlob, stopOffset);
  bytes.set(nameTable, nameOffset);
  return bytes;
}

// `trips` comes back empty: the artifact carries no schedule.
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
  const entranceCount = view.getUint32(56, true);
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
      split: (view.getUint8(record + 14) & SPLIT_FLAG) !== 0,
    });
  }

  const entranceOffset = stationOffset + stationCount * STATION_BYTES;
  const entrances: TransitEntrance[] = [];
  for (let index = 0; index < entranceCount; index++) {
    const record = entranceOffset + index * ENTRANCE_BYTES;
    const flags = view.getUint8(record + 12);
    entrances.push({
      lng: originLng + view.getInt32(record, true) * scale,
      lat: originLat + view.getInt32(record + 4, true) * scale,
      station: view.getUint16(record + 8, true),
      sides: view.getUint8(record + 10),
      kind: ENTRANCE_KINDS[view.getUint8(record + 11)],
      entry: (flags & ENTRY_FLAG) !== 0,
      exit: (flags & EXIT_FLAG) !== 0,
    });
  }

  const routeOffset = entranceOffset + entranceCount * ENTRANCE_BYTES;
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

  return { stations, entrances, routes, patterns };
}

export async function buildTransit(cityId: string): Promise<void> {
  const started = performance.now();
  await mkdir(TRANSIT_DIR, { recursive: true });
  const loaded = await loadFeeds(cityId);
  const { topology, counts, entranceCounts } = buildTopology(
    loaded,
    MIN_PATTERN_SHARE,
    await loadEntrances(loaded),
    readRouteTracks(cityId),
  );
  const bytes = encodeTopology(topology);
  await writeFile(join(TRANSIT_DIR, `${cityId}.bin`), bytes);

  const { stations, entrances, routes, patterns } = topology;
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
  for (const name of entranceCounts.splitInComplex) {
    console.error(
      `  ${name}: no free crossover, but inside a transfer complex; kept as one station`,
    );
  }
  if (entranceCounts.unmatched.length > 0) {
    console.error(
      `  ${entranceCounts.unmatched.length} station id(s) the feeds do not carry, ` +
        `${entranceCounts.dropped} entrance(s) dropped: ` +
        entranceCounts.unmatched.join(", "),
    );
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.error(
    `transit: ${cityId} ${routes.length} routes, ${stations.length} stations ` +
      `(${surface} at street level, ${complexes.size} transfer complexes, ` +
      `${entranceCounts.split} split by direction), ` +
      `${entrances.length} entrances ` +
      `(${entranceCounts.sidedByTrack} sided against drawn track), ` +
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

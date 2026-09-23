// `bun run build-transit`: the rail TOPOLOGY the routing graph rides on, as data/transit/<city>.bin
// (magic TRNS) — every station a train calls at, every route with the color and names its agency
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
// The display ingest's artifact, which is where the drawn track comes from; scripts/subway.ts and
// scripts/subway-sf.ts write it out of the same feeds this reads.
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

// A `sides` mask names the directions an entrance serves, bit d for GTFS `direction_id` d. Both is
// also what a station whose platforms a rider can walk between gets: there is one way in.
export const NORTHBOUND_SIDE = 1;
export const SOUTHBOUND_SIDE = 2;
export const BOTH_SIDES = 3;

// What a rider goes down, in the order the `kind` byte numbers them. The last covers every way in
// that is a corridor rather than a descent — an easement through a building, a passage, a walkway,
// an underpass or an overpass — because what they share is that the walk is the cost.
export const ENTRANCE_KINDS = [
  "stair",
  "escalator",
  "elevator",
  "ramp",
  "station house",
  "passage",
] as const;
export type EntranceKind = (typeof ENTRANCE_KINDS)[number];

// Joins the parts of a pattern key. NUL because a GTFS route id or stop name may carry any
// printable character, spaces and punctuation included, but never this one.
const KEY_SEPARATOR = "\u0000";

// The GTFS defaults for a route that publishes no color, as the display ingests use them.
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
  // southbound route_id ("Yellow-N", "Yellow-S") that run one pair of rails under one color, so
  // they are folded the way the map folds them; everywhere else a route_id is a route. A key that
  // is not the route_id is the name the group shares, and becomes the route's short name — "Yellow"
  // rather than whichever direction's row happened to come first.
  groupKey: (row: GtfsRow) => string;
  // Stations the feed models as bare curbside stops but which are actually underground, so the
  // tiler charges the full descent to the platform rather than a step off the pavement. Only Muni
  // needs one: it publishes no `parent_station`, no `location_type` and no entrances, so nothing in
  // the feed separates the Market Street and Central Subway platforms from a stop on the tarmac.
  underground: ReadonlySet<string>;
  // The name to show a rider, where the feed's own is the platform's rather than the place's. Left
  // out, a station is called whatever the feed calls it, which is what New York and BART want.
  displayName?: (feedName: string) => string;
  // Where the feed's stations are actually entered, and which of them a rider cannot cross between
  // inside. A feed with no source of either leaves this out and its stations are entered at their
  // own point, which is what the graph did before entrances existed.
  entrances?: (feed: GtfsFeed) => Promise<FeedEntrances>;
}

// One way into a station as its agency publishes it, before the topology has resolved which of its
// stations that is.
export interface FeedEntrance extends Coord {
  // The feed's own station id — the parent stop the agency lists the entrance against.
  stationId: string;
  kind: EntranceKind;
  entry: boolean;
  exit: boolean;
  // Which platform it reaches, where the agency itself says so. `null` asks the right-hand rule
  // below, which is the only answer New York has.
  sides: number | null;
}

export interface FeedEntrances {
  entrances: readonly FeedEntrance[];
  // The feed's stations with no free crossover: a rider who goes down the wrong stair has to come
  // back up, so the graph gives the station one node per direction.
  split: ReadonlySet<string>;
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

// What Muni writes on the end of a stop name to say which platform it is, after a slash or a space.
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

// Muni names a stop for the platform it is — "Metro Castro Station/Downtown", "Van Ness Station
// Outbound" — and the graph shows that name to a rider about to walk in, so what it carries is the
// place: "Castro", "Van Ness". Matching still runs on the feed's own name, which is what the OSM
// nodes, the complex join and the lane ids are all keyed by.
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

// The MTA's own name for what a rider goes down, mapped onto the kinds above. Anything with a
// stair in it is a stair: the stair is what a walker who cannot use the escalator beside it gets,
// and both cost the same descent.
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

// "Subway Entrances and Exits: 2024", the MTA's published list of every way into the system:
// 2,120 rows over 485 stations, each carrying the GTFS parent stop it belongs to, what kind of
// entrance it is, whether a rider may enter and leave by it, and where it stands. It says nothing
// about which platform it reaches — no dataset does — so that is left to the rule.
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

// The two curated files beside the artifact, each one id or one entrance per line, `#` to the end
// of a line a comment. Committed rather than derived because their sources are gone: see the
// header of each.
export function curatedLines(name: string): string[] {
  const text = readFileSync(join(TRANSIT_DIR, name), "utf-8");
  return text
    .split("\n")
    .map((line) => line.split("#")[0].trim())
    .filter((line) => line !== "");
}

// An override's key: the station and the entrance point exactly as the MTA publishes it. Six
// decimal places is ~0.1 m, finer than the dataset's own precision, so two entrances never collide
// and an entrance the MTA moves simply stops matching and falls back to the rule.
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
  // Every override has to find its entrance. The key is the MTA's own published point to six
  // decimals, so a dataset that moves a stair by a meter silently drops the correction and the
  // geometric rule — which was wrong about that stair, or there would be no line for it — takes it
  // back. There is nothing to see in the output when that happens, so it is a failure here.
  const matched = new Set<string>();
  const entrances: FeedEntrance[] = [];
  for (const row of rows) {
    // A handful of rows name two stations, for an entrance a transfer complex shares. The complex
    // is one node in the graph whichever of its members the door hangs off, so the first is enough.
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

// BART names its entrances in the feed itself, as `location_type=2` stops hung off their station:
// "B2 13th St and Broadway Entrance / Exit", "Elevator Entrance / Exit", "A2 John F Foran Fwy
// (Ramp) Entrance / Exit". Every BART station has a paid mezzanine spanning both platforms, so no
// entrance is ever one direction's alone and no station is split.
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

// How far apart the two halves of one underground Muni station stand, at most: the feed carries a
// stop per direction ("/Downtown", "/Outbound") and puts them at their own platform's end, which
// under Market Street is most of a block apart.
const PLATFORM_ROW_METERS = 150;

// How far an OSM node may stand from a station's platforms and still be a way into it. A Market
// Street station's concourse runs the length of a block, so its far door is a long way from the
// point the feed gives the platform.
const OSM_ENTRANCE_METERS = 150;

// How far a node that NAMES its station may stand from it. A mapper who wrote the station down has
// said what the distance can only guess at, so the cap is there to catch a stale name rather than
// to decide the match: Montgomery's Sansome & Sutter head house is 153 m from the platform the feed
// gives and is unarguably a way in.
const NAMED_ENTRANCE_METERS = 300;

// What OSM writes on a door nobody may walk through: one closed for construction, one a building's
// tenants alone may use. Neither is a way into the station.
const CLOSED_ACCESS: ReadonlySet<string> = new Set(["no", "private"]);

// A margin on the box the OSM nodes are read in, and the hundredth of a degree the box is rounded
// out to: the query is cached by its own text, and rounding keeps a stop moving a few meters from
// re-fetching the city.
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

// One underground station as the topology will carry it: the feed splits a Metro station into a
// stop per direction and the station table keeps them apart, so a door on the street is a way into
// every one of them — the platforms share a mezzanine. `keys` are those stations' ids, exactly as
// the station table keys them.
export interface UndergroundStation {
  keys: readonly string[];
  names: readonly string[];
  points: readonly Coord[];
}

// The underground Metro stops, merged into stations the way the station table merges them (same
// name within STATION_MERGE_METERS, keyed by the lowest member id), then the directions of one
// station chained together on distance. Nothing in the feed says two stops are one station, which
// is why this is where it is said.
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

// A mapper writes the station on a node as `station_name` — "Embarcadero Station", "Van Ness",
// "Castro" — where they write it at all; the feed calls the same places "Metro Embarcadero
// Station", "Van Ness Station Outbound", "Metro Castro Station/Downtown". Lowercased and with the
// word "station" dropped, what the mapper wrote is a substring of what the feed wrote. The `name`
// tag is not this: it is the corner the door stands on ("Market & 8th St").
function namesStation(written: string, stationName: string): boolean {
  const wanted = written.toLowerCase().replaceAll("station", "").trim();
  return wanted !== "" && stationName.toLowerCase().includes(wanted);
}

// Each OSM node onto the station it is a way into: the one it names where it names one and that
// station is within NAMED_ENTRANCE_METERS, otherwise the nearest within OSM_ENTRANCE_METERS. A door
// a rider may not walk through is returned closed and a node in reach of nothing unmatched — in San
// Francisco the unmatched are BART's own doors, which the graph already has from BART's feed. One
// row per direction of the matched station, because the mezzanine is shared.
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

// Muni publishes no entrance at all — no `location_type`, no pathways, nothing — so the Metro's
// underground stations are entered through OpenStreetMap's own `railway=subway_entrance` nodes.
// Every Metro station has a mezzanine spanning both directions, so no door is one direction's
// alone and no station is split. The four Market Street stations share a transfer complex with the
// BART station under them, which the graph gives one node, so a door there joins the same node
// whichever of the two it hangs off.
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
  // No free crossover: the two directions are two separate places to stand, so the graph gives the
  // station a node per direction and an entrance only reaches the platform it was cut for. Never
  // set on a station sharing a complex, where a change of train never reaches the street anyway.
  split: boolean;
}

// One way into a station, placed. `station` indexes the station table, `sides` names the directions
// whose platform it reaches (bit d for direction d, 3 for both) and `kind` indexes ENTRANCE_KINDS.
export interface TransitEntrance extends Coord {
  station: number;
  sides: number;
  kind: EntranceKind;
  entry: boolean;
  exit: boolean;
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
  entrances: readonly TransitEntrance[];
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
// lowest route_id — supplies the names and colors, which for BART is the northbound half of a line
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
      // one that models nothing is describing the curb, apart from the platforms named above.
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
// three curbs become one station.
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

// A step across the ground in meters, east and north, which is what a bearing and an entrance
// offset are both measured in.
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

// The line a station's platforms lie along: a point ON the rails and the direction a direction-0
// train runs there.
export interface TrackAxis {
  origin: Coord;
  bearing: Bearing;
}

// How far off the axis an entrance has to stand before the rule will name a side. Inside that it is
// astride the tracks — a station house over the cut, a stair in the middle of a wide avenue — and
// reaches both platforms.
const AMBIGUOUS_METERS = 8;

// New York's railway runs right-handed, so a side platform lies under the pavement to the RIGHT of
// its direction of travel and its stairs rise onto that pavement. The sign of the cross product of
// the axis with the entrance's offset from it is therefore which platform the stair drops onto.
// Nothing published says: this rule and the agency's own sign text
// (data/transit/nyc-entrance-sides.txt) are the whole of what is known.
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

// Which way a direction-0 train runs through each station, as a unit vector, averaged over the
// patterns calling there: a station the line curves through averages its two legs, and a terminal
// takes the one neighbor it has. Coarse — it is a chord between two stops half a kilometer apart —
// so it is only ever used to point the drawn track the right way round, and as the fallback axis
// where nothing is drawn. `null` where no direction-0 pattern calls at all.
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

// The drawn track of every route, keyed by the short and long names the routing artifact and the
// display artifact both take from the feed's routes.txt — the SBWY blob carries no route id, and
// those two together separate even New York's three `S` shuttles.
export type RouteTracks = ReadonlyMap<string, readonly (readonly Coord[])[]>;

export function routeKey(shortName: string, longName: string): string {
  return [shortName, longName].join(KEY_SEPARATOR);
}

// The city's drawn track, from the display artifact the map already ships. Empty — and the rule
// falls back to the ride bearing through the station point — for a city that has none.
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

// How much track the tangent is measured over, either side of the station. A GTFS shape puts its
// vertices a few meters apart, so the one segment the station stands beside is mostly quantization
// noise; 25 m is a platform's worth of rail, short enough to follow a curve through a station.
const TANGENT_METERS = 25;
// How far a station may stand from the drawn track and still be on it. A shape the display ingest
// cut at the city edge can leave a station with a polyline that only passes within a kilometer, and
// a perpendicular taken off that says nothing; past this the ride through the station point is the
// honest answer.
const MAX_TRACK_METERS = 150;

// Where the rails run past a station: the nearest point on any of its routes' drawn lines, and the
// chord of the track about it, turned to face the way a direction-0 train goes. This is what the
// side rule measures from. The station's OWN point will not do — the feed puts Nevins St over the
// northeastern pavement rather than between the tracks, which pushes both of its northeastern
// stairs onto the wrong side of the station and into the ambiguous band.
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
  // Outward along the polyline from the segment the station stands beside, until the vertex is a
  // tangent's length away or the line runs out.
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
  // A drawn line is whichever direction its shape was published in, and both directions' shapes are
  // drawn where they run apart, so the track says the axis and the ride says which end is north.
  const forward = chord.east * ride.east + chord.north * ride.north >= 0;
  return {
    origin,
    bearing: forward ? chord : { east: -chord.east, north: -chord.north },
  };
}

// The drawn lines of every route calling at each station, which are the candidates its platforms
// could lie along. Both directions' shapes are in there where the display ingest kept them, and the
// nearest wins: a station stands beside its own track and not beside the express rails under the
// next avenue.
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

// What the placement made of the entrance sources, for the ingest log.
export interface EntranceCounts {
  // Station ids an entrance or a no-crossover flag names that the topology carries no station for:
  // a station no kept pattern calls at, or one renamed since the source was published.
  unmatched: string[];
  dropped: number; // the entrances standing at those stations
  split: number; // stations given a node per direction
  // Flagged no-crossover but inside a transfer complex, which is one node whatever its members say.
  splitInComplex: string[];
  // Entrances sided against drawn track rather than against the ride through the station point.
  sidedByTrack: number;
}

// Every feed's entrances, read before the build so the build itself stays synchronous — the daily
// timetable rebuilds the topology too, and it has no business reading a Socrata dataset to do it.
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

// The entrances onto the built stations, and the split flags onto the stations themselves. Runs
// after the patterns because the side rule is a sign against the northbound ride.
function placeEntrances(
  loaded: readonly LoadedFeed[],
  byFeed: ReadonlyMap<string, FeedEntrances>,
  stations: TransitStation[],
  stationIndexOf: ReadonlyMap<string, number>,
  routes: readonly TransitRoute[],
  patterns: readonly TransitPattern[],
  tracks: RouteTracks,
): { entrances: TransitEntrance[]; counts: EntranceCounts } {
  // A complex id is set on every station its feed lists in transfers.txt, most of them only
  // transferring to themselves, so what makes a station part of a complex is SHARING its id.
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

  // Only a split station is ever asked which platform a stair drops onto, and there are 86 of them
  // against 496 stations, so the nearest point on the track is looked up when one comes up rather
  // than for the whole city.
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
      // A station a rider can cross between inside has one way in whichever stair they take, so the
      // rule is only ever asked about a split one.
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

// Every station, route and stop pattern the city's feeds describe. Both artifacts are built from
// this one function, so the topology the graph is cut from and the timetable it departs against
// cannot describe different patterns.
export function buildTopology(
  loaded: readonly LoadedFeed[],
  // The daily timetable passes 0: it emits bands for the lanes the COMMITTED topology carries, and a
  // pattern this run would have thrown away is exactly the one whose trips it must still find.
  minPatternShare: number = MIN_PATTERN_SHARE,
  // From `loadEntrances`. Left out — by the timetable, and by a city whose feeds publish none — the
  // topology carries no entrance and no station is split.
  feedEntrances: ReadonlyMap<string, FeedEntrances> = new Map(),
  // From `readRouteTracks`. Left out, an entrance is sided against the ride through the station
  // point, which is coarser but never unavailable.
  tracks: RouteTracks = new Map(),
): {
  topology: TransitTopology;
  counts: PatternCounts;
  entranceCounts: EntranceCounts;
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
        // second is the other curb of the same corner, and a platform node per call would let the
        // router board a train it is already on.
        if (index === stops[stops.length - 1]) {
          continue;
        }
        stops.push(index);
        // The feed's own name, not the one a rider is shown: a lane id has to mean the same thing
        // to a timetable built days later, and renaming a station for display must not move it.
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

// The TRNS blob: a header, three fixed-size tables, the pattern-stop varint blob and the name
// table. Little-endian throughout; coordinates quantized to COORD_SCALE about a south-west origin,
// exactly the shared codec.
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
    // The name slot a door's own wording would go in, which nothing writes yet.
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

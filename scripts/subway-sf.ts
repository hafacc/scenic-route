// Display only. Not clipped to the land mask: BART's tube crosses open water and runs far outside it.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fetchGtfsZipFile,
  type GtfsFeed,
  type GtfsRow,
  parseGtfs,
} from "./gtfs";
import type { Coord } from "./socrata";
import {
  centroid,
  chooseLines,
  clusterByName,
  encodeSubway,
  nextComplexId,
  parseColor,
  type Rgb,
  type ShapeVariant,
  type TransitRoute,
  type TransitStation,
  transferComplexes,
} from "./subway-format";
import { muniStationName } from "./transit";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const SUBWAY_DIR = join(DATA_DIR, "subway");

// Keyless; documented at https://www.sfmta.com/reports/gtfs-transit-data.
const MUNI_FEED_URL =
  "https://muni-gtfs.apps.sfmta.com/data/muni_gtfs-current.zip";
const MUNI_CACHE_KEY = "gtfs-muni";
// Redirects to the current dated zip; api.bart.gov/gtfs/google_transit.zip still serves a 2013 feed.
const BART_FEED_URL = "https://www.bart.gov/dev/schedules/google_transit.zip";
const BART_CACHE_KEY = "gtfs-bart";

// Metro lines and the F (0) and cable cars (5); buses alone wouldn't fit the station mask's 32 routes.
const MUNI_ROUTE_TYPES = new Set(["0", "5"]);
// BART's `BB-*` bus bridges are route_type 3 and carry no shapes.
const BART_ROUTE_TYPE = "1";

// The GTFS spec's defaults for a route publishing no color.
const DEFAULT_ROUTE_COLOR = "FFFFFF";
const DEFAULT_TEXT_COLOR = "000000";

// `routeIds` is plural because BART splits each line into a route_id per direction.
interface FeedRoute {
  id: string;
  shortName: string;
  longName: string;
  color: Rgb;
  textColor: Rgb;
  routeIds: string[];
  variants: ShapeVariant[];
}

function readShapes(feed: GtfsFeed): Map<string, Coord[]> {
  const ordered = new Map<string, { sequence: number; point: Coord }[]>();
  for (const row of feed.shapes) {
    const entry = {
      sequence: Number(row.shape_pt_sequence),
      point: { lat: Number(row.shape_pt_lat), lng: Number(row.shape_pt_lon) },
    };
    const existing = ordered.get(row.shape_id);
    if (existing) {
      existing.push(entry);
    } else {
      ordered.set(row.shape_id, [entry]);
    }
  }
  const shapes = new Map<string, Coord[]>();
  for (const [shapeId, entries] of ordered) {
    entries.sort((left, right) => left.sequence - right.sequence);
    shapes.set(
      shapeId,
      entries.map((entry) => entry.point),
    );
  }
  return shapes;
}

// A shape used by any primary trip counts as primary.
function shapeVariants(
  feed: GtfsFeed,
  shapes: ReadonlyMap<string, Coord[]>,
  routeIds: readonly string[],
  isPrimary: (trip: GtfsRow) => boolean,
): ShapeVariant[] {
  const wanted = new Set(routeIds);
  const counted = new Map<string, { primary: boolean; trips: number }>();
  for (const trip of feed.trips) {
    if (!wanted.has(trip.route_id) || trip.shape_id === "") {
      continue;
    }
    const seen = counted.get(trip.shape_id);
    if (seen) {
      seen.trips += 1;
      seen.primary ||= isPrimary(trip);
    } else {
      counted.set(trip.shape_id, { primary: isPrimary(trip), trips: 1 });
    }
  }

  const variants: ShapeVariant[] = [];
  for (const [shapeId, { primary, trips }] of counted) {
    const points = shapes.get(shapeId);
    if (!points || points.length < 2) {
      continue;
    }
    variants.push({
      shapeId,
      primary,
      trips,
      lines: [points],
    });
  }
  return variants;
}

// Legend order: the feed publishes no route_sort_order.
function muniRoutes(feed: GtfsFeed): FeedRoute[] {
  const shapes = readShapes(feed);
  const rows = feed.routes
    .filter((row) => MUNI_ROUTE_TYPES.has(row.route_type))
    .sort(
      (left, right) =>
        Number(left.route_type) - Number(right.route_type) ||
        (left.route_short_name < right.route_short_name ? -1 : 1),
    );
  return rows.map((row) => ({
    id: `muni:${row.route_id}`,
    shortName: row.route_short_name?.trim() ?? "",
    longName: row.route_long_name?.trim() ?? "",
    color: parseColor(row.route_color ?? "", DEFAULT_ROUTE_COLOR),
    textColor: parseColor(row.route_text_color ?? "", DEFAULT_TEXT_COLOR),
    routeIds: [row.route_id],
    variants: shapeVariants(
      feed,
      shapes,
      [row.route_id],
      (trip) => trip.direction_id === "0",
    ),
  }));
}

// The feed's "Yellow-S"/"Yellow-N" route_ids are one line's two directions, folded into one route.
function bartRoutes(feed: GtfsFeed): FeedRoute[] {
  const shapes = readShapes(feed);
  const byColor = new Map<string, GtfsRow[]>();
  for (const row of feed.routes) {
    if (row.route_type !== BART_ROUTE_TYPE) {
      continue;
    }
    const color = (row.route_short_name ?? "").split("-")[0].trim();
    const group = byColor.get(color);
    if (group) {
      group.push(row);
    } else {
      byColor.set(color, [row]);
    }
  }

  const routes: FeedRoute[] = [];
  for (const [color, group] of byColor) {
    const ordered = [...group].sort(
      (left, right) => Number(left.route_id) - Number(right.route_id),
    );
    const [primary] = ordered;
    routes.push({
      id: `bart:${color}`,
      shortName: color,
      longName: primary.route_long_name?.trim() ?? "",
      color: parseColor(primary.route_color ?? "", DEFAULT_ROUTE_COLOR),
      textColor: parseColor(primary.route_text_color ?? "", DEFAULT_TEXT_COLOR),
      routeIds: ordered.map((row) => row.route_id),
      variants: shapeVariants(
        feed,
        shapes,
        ordered.map((row) => row.route_id),
        (trip) => trip.route_id === primary.route_id,
      ),
    });
  }
  return routes.sort(
    (left, right) => Number(left.routeIds[0]) - Number(right.routeIds[0]),
  );
}

// Routes come from the schedule, not drawn shapes; Muni has no parent_station, so stops stand in.
function feedStations(
  feed: GtfsFeed,
  routeOfTrip: ReadonlyMap<string, number>,
  complexes: ReadonlyMap<string, number>,
  displayName: (feedName: string) => string = (feedName) => feedName,
): TransitStation[] {
  const stopRow = new Map(feed.stops.map((stop) => [stop.stop_id, stop]));
  const masks = new Map<string, number>();
  for (const time of feed.stopTimes) {
    const route = routeOfTrip.get(time.trip_id);
    const stop = stopRow.get(time.stop_id);
    if (route === undefined || stop === undefined) {
      continue;
    }
    const stationId = stop.parent_station?.trim() || stop.stop_id;
    masks.set(stationId, (masks.get(stationId) ?? 0) | (1 << route));
  }

  const stations: TransitStation[] = [];
  for (const [stationId, routeMask] of masks) {
    const row = stopRow.get(stationId);
    const lat = Number(row?.stop_lat);
    const lng = Number(row?.stop_lon);
    if (row === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      console.error(`  station ${stationId}: no coordinate, dropped`);
      continue;
    }
    stations.push({
      lat,
      lng,
      name: displayName(row.stop_name?.trim() ?? ""),
      routeMask,
      complex: complexes.get(stationId) ?? 0,
    });
  }
  return stations;
}

// Across both agencies, so a same-named Muni stop and BART station on one corner are one marker.
function mergeStations(stations: readonly TransitStation[]): TransitStation[] {
  const merged = clusterByName(stations).map((cluster) => {
    const ids = cluster
      .map(({ complex }) => complex)
      .filter((complex) => complex !== 0);
    return {
      ...centroid(cluster),
      name: cluster[0].name,
      routeMask: cluster.reduce((mask, one) => mask | one.routeMask, 0),
      complex: ids.length === 0 ? 0 : Math.min(...ids),
    };
  });

  return merged.sort(
    (left, right) =>
      left.lat - right.lat ||
      left.lng - right.lng ||
      (left.name < right.name ? -1 : 1),
  );
}

// `routes` must be this feed's only: route_ids collide across feeds (Muni bus 1 vs BART Yellow).
function tripRouteIndex(
  feed: GtfsFeed,
  routes: readonly FeedRoute[],
  indexOf: ReadonlyMap<string, number>,
): Map<string, number> {
  const byFeedRoute = new Map<string, number>();
  for (const route of routes) {
    const index = indexOf.get(route.id);
    if (index === undefined) {
      continue;
    }
    for (const feedRouteId of route.routeIds) {
      byFeedRoute.set(feedRouteId, index);
    }
  }
  const trips = new Map<string, number>();
  for (const trip of feed.trips) {
    const index = byFeedRoute.get(trip.route_id);
    if (index !== undefined) {
      trips.set(trip.trip_id, index);
    }
  }
  return trips;
}

async function ingestSubwaySf(cityId: string): Promise<void> {
  const started = performance.now();
  await mkdir(SUBWAY_DIR, { recursive: true });

  const muni = parseGtfs(await fetchGtfsZipFile(MUNI_CACHE_KEY, MUNI_FEED_URL));
  const bart = parseGtfs(await fetchGtfsZipFile(BART_CACHE_KEY, BART_FEED_URL));

  const muniFeedRoutes = muniRoutes(muni);
  const bartFeedRoutes = bartRoutes(bart);
  const routes: TransitRoute[] = [];
  for (const route of [...muniFeedRoutes, ...bartFeedRoutes]) {
    const lines = chooseLines(route.variants);
    if (lines.length === 0) {
      console.error(`  ${route.shortName}: no shape to draw, dropped`);
      continue;
    }
    routes.push({
      id: route.id,
      shortName: route.shortName,
      longName: route.longName,
      color: route.color,
      textColor: route.textColor,
      sortOrder: routes.length,
      lines,
    });
  }

  const indexOf = new Map(routes.map((route, index) => [route.id, index]));
  // Complex ids are per feed, so BART's start past Muni's.
  const muniComplexes = transferComplexes(muni, 1);
  const bartComplexes = transferComplexes(bart, nextComplexId(muniComplexes));
  const stations = mergeStations([
    ...feedStations(
      muni,
      tripRouteIndex(muni, muniFeedRoutes, indexOf),
      muniComplexes,
      muniStationName,
    ),
    ...feedStations(
      bart,
      tripRouteIndex(bart, bartFeedRoutes, indexOf),
      bartComplexes,
    ),
  ]);

  const bytes = encodeSubway(routes, stations);
  const file = `${cityId}.bin`;
  await writeFile(join(SUBWAY_DIR, file), bytes);

  let lines = 0;
  let vertices = 0;
  for (let index = 0; index < routes.length; index++) {
    const route = routes[index];
    lines += route.lines.length;
    const counts = route.lines.map((line) => line.length);
    vertices += counts.reduce((total, count) => total + count, 0);
    const hex = (color: Rgb): string =>
      [color.red, color.green, color.blue]
        .map((channel) => channel.toString(16).padStart(2, "0"))
        .join("");
    const called = stations.filter(
      (station) => (station.routeMask & (1 << index)) !== 0,
    ).length;
    console.error(
      `  ${route.shortName} (${route.id}) #${hex(route.color)} ${route.longName}: ` +
        `${counts.length} line(s), ${counts.join("+")} vertices, ${called} stations`,
    );
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const kib = (bytes.length / 1024).toFixed(1);
  console.error(
    `subway: ${routes.length} routes, ${lines} lines, ${vertices} vertices, ` +
      `${stations.length} stations, ${kib} KiB in ${seconds}s, sha256 ` +
      `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`,
  );
}

if (import.meta.main) {
  // Flags belong to scripts/cache.ts.
  const city = process.argv
    .slice(2)
    .find((argument) => !argument.startsWith("--"));
  await ingestSubwaySf(city ?? "sf");
}

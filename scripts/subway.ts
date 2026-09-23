// Display only: routing rides scripts/transit.ts's blob, baked from this same feed.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchGtfsZipFile, type GtfsFeed, parseGtfs } from "./gtfs";
import type { SourceFile } from "./manifest";
import type { Coord } from "./socrata";
import {
  encodeSubway,
  parseColor,
  type Rgb,
  SUBWAY_FORMAT,
  type TransitRoute,
  type TransitStation,
  transferComplexes,
} from "./subway-format";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const SUBWAY_DIR = join(DATA_DIR, "subway");

const FEED_URL = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip";
const FEED_CACHE_KEY = "gtfs-subway";

// 1 is the subway; 2 is heavy rail, here only the Staten Island Railway, which the MTA map draws.
const KEPT_ROUTE_TYPES = new Set(["1", "2"]);

const FORWARD_DIRECTION = "0";
// ~600 m of track a reverse shape must add (e.g. the southbound-only R and W); 5-30 all agree.
const NEW_TRACK_CELLS = 20;
// ~39 x 29 m, coarser than the rails are apart, so the opposite rail reads as already covered.
const COVERAGE_CELL_DEGREES = 0.00035;
const CELL_STRIDE = 10_000_000;

// Share of a route's trips a station needs to list it; the feed has a clean gap from 3.4% to 10%.
const MIN_TRIP_SHARE = 0.058;

const STATION_LINE_METERS = 25;
// Bounds for extending a shape that stops short of its platform (the Q ends 103 m shy of 96 St).
const MAX_TERMINAL_EXTENSION_METERS = 250;
const MAX_TERMINAL_OFFSET_METERS = 25;
const METERS_PER_DEGREE_LAT = 111_320;

// The GTFS spec defaults for a route with no color.
const DEFAULT_ROUTE_COLOR = "FFFFFF";
const DEFAULT_TEXT_COLOR = "000000";
// A route with no route_sort_order sorts last.
const NO_SORT_ORDER = 0xffff;

function cellKey(row: number, column: number): number {
  return row * CELL_STRIDE + column;
}

function addTrack(points: readonly Coord[], covered: Set<number>): void {
  for (const { lat, lng } of points) {
    covered.add(
      cellKey(
        Math.round(lat / COVERAGE_CELL_DEGREES),
        Math.round(lng / COVERAGE_CELL_DEGREES),
      ),
    );
  }
}

// Distinct cells of a shape with no covered cell among their eight neighbors or themselves.
function newTrackCells(points: readonly Coord[], covered: Set<number>): number {
  const seen = new Set<number>();
  let fresh = 0;
  for (const { lat, lng } of points) {
    const row = Math.round(lat / COVERAGE_CELL_DEGREES);
    const column = Math.round(lng / COVERAGE_CELL_DEGREES);
    const key = cellKey(row, column);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    let touches = false;
    for (let deltaRow = -1; deltaRow <= 1 && !touches; deltaRow++) {
      for (let deltaColumn = -1; deltaColumn <= 1; deltaColumn++) {
        if (covered.has(cellKey(row + deltaRow, column + deltaColumn))) {
          touches = true;
          break;
        }
      }
    }
    if (!touches) {
      fresh += 1;
    }
  }
  return fresh;
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

interface ShapeVariant {
  shapeId: string;
  direction: string;
  trips: number;
}

// Forward first, so reverse shapes must earn their place against everything already drawn.
function shapeVariants(feed: GtfsFeed): Map<string, ShapeVariant[]> {
  const counts = new Map<string, Map<string, ShapeVariant>>();
  for (const trip of feed.trips) {
    if (trip.shape_id === "") {
      continue;
    }
    let perShape = counts.get(trip.route_id);
    if (!perShape) {
      perShape = new Map<string, ShapeVariant>();
      counts.set(trip.route_id, perShape);
    }
    const seen = perShape.get(trip.shape_id);
    if (seen) {
      seen.trips += 1;
    } else {
      perShape.set(trip.shape_id, {
        shapeId: trip.shape_id,
        direction: trip.direction_id,
        trips: 1,
      });
    }
  }

  const reverse = (variant: ShapeVariant): number =>
    variant.direction === FORWARD_DIRECTION ? 0 : 1;
  const ranked = new Map<string, ShapeVariant[]>();
  for (const [routeId, perShape] of counts) {
    ranked.set(
      routeId,
      [...perShape.values()].sort(
        (left, right) =>
          reverse(left) - reverse(right) ||
          right.trips - left.trips ||
          (left.shapeId < right.shapeId ? -1 : 1),
      ),
    );
  }
  return ranked;
}

function buildRoutes(feed: GtfsFeed): TransitRoute[] {
  const shapes = readShapes(feed);
  const ranked = shapeVariants(feed);
  const routes: TransitRoute[] = [];

  for (const row of feed.routes) {
    if (!KEPT_ROUTE_TYPES.has(row.route_type)) {
      continue;
    }
    // Overlapping variants stay for the renderer to offset; only exact or reverse retraces drop.
    const lines: Coord[][] = [];
    const drawn = new Set<string>();
    const covered = new Set<number>();
    for (const variant of ranked.get(row.route_id) ?? []) {
      const points = shapes.get(variant.shapeId);
      if (!points || points.length < 2) {
        continue;
      }
      const signature = points.map(({ lat, lng }) => `${lat},${lng}`).join(" ");
      const retraces =
        variant.direction !== FORWARD_DIRECTION &&
        newTrackCells(points, covered) < NEW_TRACK_CELLS;
      if (drawn.has(signature) || retraces) {
        continue;
      }
      drawn.add(signature);
      lines.push(points);
      addTrack(points, covered);
    }
    if (lines.length === 0) {
      console.error(`  ${row.route_id}: no usable shape, dropped`);
      continue;
    }
    const sortOrder = Number(row.route_sort_order);
    routes.push({
      id: row.route_id,
      shortName: row.route_short_name?.trim() ?? "",
      longName: row.route_long_name?.trim() ?? "",
      color: parseColor(row.route_color ?? "", DEFAULT_ROUTE_COLOR),
      textColor: parseColor(row.route_text_color ?? "", DEFAULT_TEXT_COLOR),
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : NO_SORT_ORDER,
      lines,
    });
  }

  return routes.sort(
    (left, right) =>
      left.sortOrder - right.sortOrder || (left.id < right.id ? -1 : 1),
  );
}

// Parent stops, not platforms: GTFS gives each direction its own platform a few meters apart.
function buildStations(
  feed: GtfsFeed,
  routeIndex: ReadonlyMap<string, number>,
  complexes: ReadonlyMap<string, number>,
): TransitStation[] {
  const stopRow = new Map(feed.stops.map((stop) => [stop.stop_id, stop]));
  const routeOf = new Map(
    feed.trips.map((trip) => [trip.trip_id, trip.route_id]),
  );
  const routeTrips = new Map<string, number>();
  for (const trip of feed.trips) {
    routeTrips.set(trip.route_id, (routeTrips.get(trip.route_id) ?? 0) + 1);
  }

  // Distinct trips, so a pattern touching a station twice counts once.
  const calls = new Map<string, Map<string, Set<string>>>();
  for (const time of feed.stopTimes) {
    const routeId = routeOf.get(time.trip_id);
    const stop = stopRow.get(time.stop_id);
    if (
      routeId === undefined ||
      stop === undefined ||
      !routeIndex.has(routeId)
    ) {
      continue;
    }
    const stationId = stop.parent_station?.trim() || stop.stop_id;
    let perRoute = calls.get(stationId);
    if (!perRoute) {
      perRoute = new Map<string, Set<string>>();
      calls.set(stationId, perRoute);
    }
    const trips = perRoute.get(routeId);
    if (trips) {
      trips.add(time.trip_id);
    } else {
      perRoute.set(routeId, new Set([time.trip_id]));
    }
  }

  const stations: TransitStation[] = [];
  let thinned = 0;
  for (const [stationId, perRoute] of calls) {
    let routeMask = 0;
    for (const [routeId, trips] of perRoute) {
      const bit = routeIndex.get(routeId);
      if (bit === undefined) {
        continue;
      }
      if (trips.size / (routeTrips.get(routeId) ?? 1) < MIN_TRIP_SHARE) {
        thinned += 1;
        continue;
      }
      routeMask |= 1 << bit;
    }
    const row = stopRow.get(stationId);
    const lat = Number(row?.stop_lat);
    const lng = Number(row?.stop_lon);
    if (row === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      console.error(`  station ${stationId}: no coordinate, dropped`);
      continue;
    }
    if (routeMask === 0) {
      console.error(
        `  station ${stationId}: no route clears the service floor, dropped`,
      );
      continue;
    }
    stations.push({
      lat,
      lng,
      name: row.stop_name?.trim() ?? "",
      routeMask,
      complex: complexes.get(stationId) ?? 0,
    });
  }
  console.error(
    `  masks: ${thinned} station-route pairs below ${(MIN_TRIP_SHARE * 100).toFixed(1)}% of the` +
      " route's trips dropped",
  );

  // The order every point source is written in.
  return stations.sort(
    (left, right) =>
      left.lat - right.lat ||
      left.lng - right.lng ||
      (left.name < right.name ? -1 : 1),
  );
}

function offsetMeters(from: Coord, to: Coord): { east: number; north: number } {
  return {
    east:
      (to.lng - from.lng) *
      METERS_PER_DEGREE_LAT *
      Math.cos((from.lat * Math.PI) / 180),
    north: (to.lat - from.lat) * METERS_PER_DEGREE_LAT,
  };
}

// To segments, not vertices: a station often sits between two shape points.
function lineMeters(point: Coord, lines: readonly Coord[][]): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    for (let index = 1; index < line.length; index++) {
      const toPoint = offsetMeters(line[index - 1], point);
      const toEnd = offsetMeters(line[index - 1], line[index]);
      const length2 = toEnd.east ** 2 + toEnd.north ** 2;
      const fraction =
        length2 === 0
          ? 0
          : Math.min(
              1,
              Math.max(
                0,
                (toPoint.east * toEnd.east + toPoint.north * toEnd.north) /
                  length2,
              ),
            );
      nearest = Math.min(
        nearest,
        Math.hypot(
          toPoint.east - fraction * toEnd.east,
          toPoint.north - fraction * toEnd.north,
        ),
      );
    }
  }
  return nearest;
}

// Extends a line only straight along its end heading; bending toward a station would invent track.
function reachTerminals(
  routes: readonly TransitRoute[],
  stations: readonly TransitStation[],
): void {
  for (let index = 0; index < routes.length; index++) {
    const route = routes[index];
    for (const station of stations) {
      if ((station.routeMask & (1 << index)) === 0) {
        continue;
      }
      const before = lineMeters(station, route.lines);
      if (before <= STATION_LINE_METERS) {
        continue;
      }
      let extended = 0;
      for (let line = 0; line < route.lines.length; line++) {
        for (const atStart of [true, false]) {
          const points = route.lines[line];
          const tip = atStart ? points[0] : points[points.length - 1];
          const behind = atStart ? points[1] : points[points.length - 2];
          const heading = offsetMeters(behind, tip);
          const length = Math.hypot(heading.east, heading.north);
          if (length === 0) {
            continue;
          }
          const away = offsetMeters(tip, station);
          const along =
            (away.east * heading.east + away.north * heading.north) / length;
          const across =
            Math.abs(away.east * heading.north - away.north * heading.east) /
            length;
          if (
            along <= 0 ||
            along > MAX_TERMINAL_EXTENSION_METERS ||
            across > MAX_TERMINAL_OFFSET_METERS
          ) {
            continue;
          }
          const foot = {
            lat:
              tip.lat +
              (along * heading.north) / length / METERS_PER_DEGREE_LAT,
            lng:
              tip.lng +
              (along * heading.east) /
                length /
                (METERS_PER_DEGREE_LAT * Math.cos(tip.lat * (Math.PI / 180))),
          };
          route.lines[line] = atStart ? [foot, ...points] : [...points, foot];
          extended += 1;
        }
      }
      if (extended === 0) {
        console.error(
          `  ${route.shortName} (${route.id}): ${station.name} is ${before.toFixed(0)} m off` +
            " every line of the route and not ahead of any of their ends, left as it is",
        );
      } else {
        console.error(
          `  ${route.shortName} (${route.id}): ran ${extended} line(s) on to ${station.name},` +
            ` ${before.toFixed(0)} m past where the feed's shape ends, now` +
            ` ${lineMeters(station, route.lines).toFixed(0)} m off the line`,
        );
      }
    }
  }
}

export async function ingestSubway(cityId: string): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(SUBWAY_DIR, { recursive: true });

  const feed = parseGtfs(await fetchGtfsZipFile(FEED_CACHE_KEY, FEED_URL));
  const routes = buildRoutes(feed);
  const routeIndex = new Map(routes.map((route, index) => [route.id, index]));
  const complexes = transferComplexes(feed, 1);
  const stations = buildStations(feed, routeIndex, complexes);
  reachTerminals(routes, stations);
  const bytes = encodeSubway(routes, stations);
  const file = `${cityId}.bin`;
  await writeFile(join(SUBWAY_DIR, file), bytes);

  let lines = 0;
  let vertices = 0;
  let pairs = 0;
  let worst = 0;
  for (let index = 0; index < routes.length; index++) {
    const route = routes[index];
    lines += route.lines.length;
    const counts = route.lines.map((line) => line.length);
    vertices += counts.reduce((total, count) => total + count, 0);
    const hex = (color: Rgb): string =>
      [color.red, color.green, color.blue]
        .map((channel) => channel.toString(16).padStart(2, "0"))
        .join("");
    const calling = stations.filter(
      (station) => (station.routeMask & (1 << index)) !== 0,
    );
    pairs += calling.length;
    for (const station of calling) {
      worst = Math.max(worst, lineMeters(station, route.lines));
    }
    console.error(
      `  ${route.shortName} (${route.id}) #${hex(route.color)} ${route.longName}: ` +
        `${counts.length} line(s), ${counts.join("+")} vertices, ${calling.length} stations`,
    );
  }
  const members = new Map<number, number>();
  for (const { complex } of stations) {
    members.set(complex, (members.get(complex) ?? 0) + 1);
  }
  const joined = [...members.values()].filter((count) => count > 1);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const kib = (bytes.length / 1024).toFixed(1);
  console.error(
    `  complexes: ${members.size} over the ${stations.length} stations, ${joined.length} of them` +
      ` holding more than one (the largest ${Math.max(0, ...joined)}), ` +
      `${members.get(0) ?? 0} stations transfers.txt never names`,
  );
  console.error(
    `subway: ${routes.length} routes, ${lines} lines, ${vertices} vertices, ` +
      `${stations.length} stations, ${pairs} station-route pairs, the furthest ` +
      `${worst.toFixed(0)} m off its route's lines, ${kib} KiB in ${seconds}s`,
  );

  return {
    file,
    format: SUBWAY_FORMAT,
    count: routes.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  // Skip flags: they belong to scripts/cache.ts.
  const city = process.argv
    .slice(2)
    .find((argument) => !argument.startsWith("--"));
  await ingestSubway(city ?? "nyc");
}

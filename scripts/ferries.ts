// Segment time is the median crossing plus half the median headway, capped. See scripts/README.md.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  COORD_SCALE,
  EARTH_RADIUS_METERS,
  haversineMeters,
  writeVarint,
  zigzag,
} from "./geometry";
import { fetchGtfsZip, type GtfsFeed, parseGtfs } from "./gtfs";
import { type LandContext, loadLandContext } from "./land";
import type { Coord } from "./socrata";

export interface FeedSource {
  id: string; // namespaces stop ids within a city
  name: string;
  zipFile: string; // committed under data/ferries/
  url: string;
  cacheKey: string;
}

// WETA's ODC-BY license is stated only at https://sanfranciscobayferry.com/developers/.
// Golden Gate Transit is absent: it only serves Marin (off our land) and publishes no license.
const CITY_FEEDS: Readonly<Record<string, readonly FeedSource[]>> = {
  nyc: [
    {
      id: "si",
      name: "Staten Island Ferry",
      zipFile: "siferry-gtfs.zip",
      url: "https://www.nyc.gov/html/dot/downloads/misc/siferry-gtfs.zip",
      cacheKey: "gtfs-siferry",
    },
    {
      id: "nyc",
      name: "NYC Ferry",
      zipFile: "nycferry-gtfs.zip",
      url: "https://nycferry.connexionz.net/rtt/public/utility/gtfs.aspx",
      cacheKey: "gtfs-nycferry",
    },
  ],
  sf: [
    {
      id: "weta",
      name: "SF Bay Ferry",
      zipFile: "sfbayferry-gtfs.zip",
      url: "https://gtfs.sanfranciscobayferry.com/gtfs.zip",
      cacheKey: "gtfs-sfbayferry",
    },
  ],
};

export const FERRY_CITIES: readonly string[] = Object.keys(CITY_FEEDS);

export function feedsOf(cityId: string): readonly FeedSource[] {
  const feeds = CITY_FEEDS[cityId];
  if (!feeds) {
    throw new Error(
      `no ferry feeds for ${cityId}; known: ${FERRY_CITIES.join(", ")}`,
    );
  } else {
    return feeds;
  }
}

const DATA_DIR = join(import.meta.dirname, "..", "data");
const FERRY_DIR = join(DATA_DIR, "ferries");
const FERRY_FORMAT = 2;
const FERRY_MAGIC = "FERR";
const NO_ROUTE_NAME = 0xffff;
const FERRY_HEADER_BYTES = 56;
const FERRY_STOP_BYTES = 12;
const FERRY_SEGMENT_BYTES = 20;
const NO_GEOMETRY = 0xffffffff; // a straight line
const WAIT_CAP_SECONDS = 600;
const KEY_SEPARATOR = "|";
export const FERRY_ROUTE_TYPE = "4"; // GTFS route_type; NYC Ferry also carries shuttle buses (3)

// By name, to survive renumbering. Rockaway isn't walk-connected; the SF ones are off our land.
const EXCLUDED_STOP_NAMES: Readonly<Record<string, ReadonlySet<string>>> = {
  nyc: new Set(["Rockaway"]),
  sf: new Set([
    "Richmond Ferry Terminal",
    "South San Francisco Ferry Terminal",
    "Vallejo Ferry Terminal",
    "Mare Island Ferry Terminal",
  ]),
};

export function excludedStopNames(cityId: string): ReadonlySet<string> {
  return EXCLUDED_STOP_NAMES[cityId] ?? new Set<string>();
}

// Terminals sit on piers hundreds of meters out over water the land polygons omit.
const LAND_TOLERANCE_METERS = 500;
// `onLand` tests a point, so the tolerance disc is sampled on rings of bearings.
const LAND_PROBE_RINGS = 3;
const LAND_PROBE_BEARINGS = 16;

function nearLand(stop: Coord, onLand: (coord: Coord) => boolean): boolean {
  if (onLand(stop)) {
    return true;
  } else {
    const metersPerLat = (Math.PI / 180) * EARTH_RADIUS_METERS;
    const metersPerLng = metersPerLat * Math.cos((stop.lat * Math.PI) / 180);
    for (let ring = 1; ring <= LAND_PROBE_RINGS; ring++) {
      const radius = (LAND_TOLERANCE_METERS * ring) / LAND_PROBE_RINGS;
      for (let step = 0; step < LAND_PROBE_BEARINGS; step++) {
        const bearing = (2 * Math.PI * step) / LAND_PROBE_BEARINGS;
        const probe = {
          lat: stop.lat + (radius * Math.cos(bearing)) / metersPerLat,
          lng: stop.lng + (radius * Math.sin(bearing)) / metersPerLng,
        };
        if (onLand(probe)) {
          return true;
        }
      }
    }
    return false;
  }
}

// Unsnapped; `key` is `${feed}:${stopId}`.
interface Stop extends Coord {
  key: string;
  name: string;
}

// `stopA` is the lexicographically smaller key; null geometry is a straight line.
interface Segment {
  stopA: string;
  stopB: string;
  rawTimeSeconds: number;
  medianCrossingSeconds: number; // log only
  headwaySeconds: number; // Infinity when served by single trips only
  geometry: Coord[] | null;
  routeName: string | null; // the route with the most trips on this pair
}

export function toSeconds(clock: string): number | null {
  const match = /^(\d+):(\d{2}):(\d{2})$/.exec(clock.trim());
  if (!match) {
    return null;
  } else {
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  } else {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
}

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

// Skips all-zero-mask services (SI Ferry's `holiday`, `threeboat`): they're atypical substitutions.
function activeServices(feed: GtfsFeed, referenceDate: number): Set<string> {
  const active = new Set<string>();
  for (const row of feed.calendar) {
    const start = Number(row.start_date);
    const end = Number(row.end_date);
    const runsAWeekday = WEEKDAYS.some((day) => row[day] === "1");
    if (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start <= referenceDate &&
      referenceDate <= end &&
      runsAWeekday
    ) {
      active.add(row.service_id);
    }
  }
  return active;
}

function groupBy<Row>(
  rows: Row[],
  key: (row: Row) => string,
): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const group = groups.get(key(row));
    if (group) {
      group.push(row);
    } else {
      groups.set(key(row), [row]);
    }
  }
  return groups;
}

// Nearest vertex, non-decreasing: shape_dist_traveled is empty in both feeds.
function projectStops(stops: Coord[], shape: Coord[]): number[] {
  const indices: number[] = [];
  let floor = 0;
  for (const stop of stops) {
    let best = floor;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let vertex = floor; vertex < shape.length; vertex++) {
      const deltaLat = shape[vertex].lat - stop.lat;
      const deltaLng = shape[vertex].lng - stop.lng;
      const distance = deltaLat * deltaLat + deltaLng * deltaLng;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = vertex;
      }
    }
    indices.push(best);
    floor = best;
  }
  return indices;
}

function dropRepeats(points: Coord[]): Coord[] {
  const unique: Coord[] = [];
  for (const point of points) {
    const previous = unique[unique.length - 1];
    if (!previous || previous.lat !== point.lat || previous.lng !== point.lng) {
      unique.push(point);
    }
  }
  return unique;
}

// Shapes overshoot this slip and reverse into it; named, since a threshold would catch real turns.
const SLIP_STOP_NAME = "Wall St/Pier 11";
const SLIP_REVERSAL_DEGREES = 170; // the shapes reverse by 178.9-179.9 here
const SLIP_REACH_METERS = 100; // the maneuver lies within 71 m of the stop

// 0 straight on, 180 straight back.
function turnDegrees(before: Coord, at: Coord, after: Coord): number {
  const shrink = Math.cos((at.lat * Math.PI) / 180);
  const inX = (at.lng - before.lng) * shrink;
  const inY = at.lat - before.lat;
  const outX = (after.lng - at.lng) * shrink;
  const outY = after.lat - at.lat;
  const cross = inX * outY - inY * outX;
  const dot = inX * outX + inY * outY;
  return Math.abs((Math.atan2(cross, dot) * 180) / Math.PI);
}

// Keeps the stop as the end vertex: the graph pass replaces it with the snapped walking node.
function trimSlipAtEnd(points: Coord[], stopName: string): Coord[] {
  if (stopName !== SLIP_STOP_NAME) {
    return points;
  } else {
    const terminus = points[points.length - 1];
    let cut = points.length - 1;
    for (let vertex = points.length - 2; vertex > 0; vertex--) {
      if (haversineMeters(points[vertex], terminus) > SLIP_REACH_METERS) {
        break;
      } else if (
        turnDegrees(points[vertex - 1], points[vertex], points[vertex + 1]) >=
        SLIP_REVERSAL_DEGREES
      ) {
        cut = vertex;
      }
    }
    if (cut === points.length - 1) {
      return points;
    } else {
      return [...points.slice(0, cut), terminus];
    }
  }
}

function trimSlips(
  points: Coord[],
  startStop: string,
  endStop: string,
): Coord[] {
  const tail = trimSlipAtEnd(points, endStop);
  return trimSlipAtEnd([...tail].reverse(), startStop).reverse();
}

interface Accumulator {
  stops: Map<string, Stop>;
  segments: Map<string, Segment>;
  crossings: Map<string, number[]>;
  // Keyed `${fromStop} ${service}`, so a headway gap never spans services or directions.
  departures: Map<string, Map<string, number[]>>;
  // Segment -> `${feed}:${routeId}` -> trip count.
  segmentRoutes: Map<string, Map<string, number>>;
  routeNames: Map<string, string>;
}

interface FerryGraph {
  stops: Stop[];
  segments: Segment[];
  activeRoutes: number;
}

// Nearby stops (the two St. George berths, Ferry Building gates E-G) stay distinct here.
function consolidate(
  feed: GtfsFeed,
  feedId: string,
  referenceDate: number,
  excluded: ReadonlySet<string>,
  accumulator: Accumulator,
): number {
  const { stops, segments, crossings, departures, segmentRoutes, routeNames } =
    accumulator;
  const services = activeServices(feed, referenceDate);
  const serviceOf = new Map(
    feed.trips.map((trip) => [trip.trip_id, trip.service_id]),
  );
  const shapeOf = new Map(
    feed.trips.map((trip) => [trip.trip_id, trip.shape_id]),
  );
  const routeOf = new Map(
    feed.trips.map((trip) => [trip.trip_id, trip.route_id]),
  );
  const routeTypeOf = new Map(
    feed.routes.map((route) => [route.route_id, route.route_type]),
  );
  // `route_short_name` is a bare code ("AS", "ER") or empty in both feeds.
  const routeDisplayOf = new Map(
    feed.routes.map((route) => [
      route.route_id,
      route.route_long_name?.trim() || route.route_short_name?.trim() || "",
    ]),
  );
  const stopRow = new Map(feed.stops.map((stop) => [stop.stop_id, stop]));

  const shapes = new Map<string, Coord[]>();
  for (const [shapeId, points] of groupBy(feed.shapes, (row) => row.shape_id)) {
    const ordered = points
      .map((row) => ({
        sequence: Number(row.shape_pt_sequence),
        lat: Number(row.shape_pt_lat),
        lng: Number(row.shape_pt_lon),
      }))
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ lat, lng }) => ({ lat, lng }));
    shapes.set(shapeId, ordered);
  }

  const activeRoutes = new Set<string>();
  for (const [tripId, times] of groupBy(feed.stopTimes, (row) => row.trip_id)) {
    const service = serviceOf.get(tripId);
    if (service === undefined || !services.has(service)) {
      continue;
    }
    const route = routeOf.get(tripId);
    if (route === undefined || routeTypeOf.get(route) !== FERRY_ROUTE_TYPE) {
      continue;
    }
    activeRoutes.add(route);
    const ordered = [...times].sort(
      (left, right) => Number(left.stop_sequence) - Number(right.stop_sequence),
    );
    const shape = shapes.get(shapeOf.get(tripId) ?? "");
    const shapeStops = shape
      ? ordered.map((time) => {
          const row = stopRow.get(time.stop_id);
          return { lat: Number(row?.stop_lat), lng: Number(row?.stop_lon) };
        })
      : null;
    const projected =
      shape && shapeStops ? projectStops(shapeStops, shape) : null;

    for (let index = 0; index + 1 < ordered.length; index++) {
      const from = ordered[index];
      const to = ordered[index + 1];
      const departure = toSeconds(from.departure_time);
      const arrival = toSeconds(to.arrival_time);
      if (departure === null || arrival === null) {
        continue;
      }
      const crossing = arrival - departure;
      const fromKey = `${feedId}:${from.stop_id}`;
      const toKey = `${feedId}:${to.stop_id}`;
      if (crossing < 0 || fromKey === toKey) {
        continue;
      }
      const fromName = stopRow.get(from.stop_id)?.stop_name;
      const toName = stopRow.get(to.stop_id)?.stop_name;
      if (
        (fromName !== undefined && excluded.has(fromName)) ||
        (toName !== undefined && excluded.has(toName))
      ) {
        continue;
      }
      for (const [key, stopId] of [
        [fromKey, from.stop_id],
        [toKey, to.stop_id],
      ] as const) {
        if (!stops.has(key)) {
          const row = stopRow.get(stopId);
          if (row) {
            stops.set(key, {
              key,
              name: row.stop_name,
              lat: Number(row.stop_lat),
              lng: Number(row.stop_lon),
            });
          }
        }
      }

      const [stopA, stopB] =
        fromKey < toKey ? [fromKey, toKey] : [toKey, fromKey];
      const segmentKey = `${stopA}${KEY_SEPARATOR}${stopB}`;

      const routeKey = `${feedId}:${route}`;
      routeNames.set(routeKey, routeDisplayOf.get(route) ?? "");
      let routeCounts = segmentRoutes.get(segmentKey);
      if (!routeCounts) {
        routeCounts = new Map<string, number>();
        segmentRoutes.set(segmentKey, routeCounts);
      }
      routeCounts.set(routeKey, (routeCounts.get(routeKey) ?? 0) + 1);

      const crossingList = crossings.get(segmentKey);
      if (crossingList) {
        crossingList.push(crossing);
      } else {
        crossings.set(segmentKey, [crossing]);
      }

      let variants = departures.get(segmentKey);
      if (!variants) {
        variants = new Map<string, number[]>();
        departures.set(segmentKey, variants);
      }
      const variantKey = `${fromKey} ${service}`;
      const departureList = variants.get(variantKey);
      if (departureList) {
        departureList.push(departure);
      } else {
        variants.set(variantKey, [departure]);
      }

      const existing = segments.get(segmentKey);
      if (!existing?.geometry) {
        let geometry: Coord[] | null = null;
        if (shape && projected) {
          const lower = Math.min(projected[index], projected[index + 1]);
          const upper = Math.max(projected[index], projected[index + 1]);
          const between = shape.slice(lower, upper + 1);
          const fromCoord = stops.get(fromKey);
          const toCoord = stops.get(toKey);
          if (fromCoord && toCoord) {
            const walk = [fromCoord, ...between, toCoord];
            const forward = fromKey === stopA;
            const oriented = forward ? walk : [...walk].reverse();
            geometry = trimSlips(
              dropRepeats(oriented),
              forward ? fromCoord.name : toCoord.name,
              forward ? toCoord.name : fromCoord.name,
            );
            if (geometry.length < 2) {
              geometry = null;
            }
          }
        }
        if (existing) {
          existing.geometry = geometry;
        } else {
          segments.set(segmentKey, {
            stopA,
            stopB,
            rawTimeSeconds: 0,
            medianCrossingSeconds: 0,
            headwaySeconds: Number.POSITIVE_INFINITY,
            geometry,
            routeName: null,
          });
        }
      }
    }
  }

  return activeRoutes.size;
}

function buildGraph(
  feeds: { source: FeedSource; feed: GtfsFeed }[],
  excluded: ReadonlySet<string>,
): FerryGraph {
  const referenceDate = Number(
    new Date().toISOString().slice(0, 10).replace(/-/g, ""),
  );
  const accumulator: Accumulator = {
    stops: new Map<string, Stop>(),
    segments: new Map<string, Segment>(),
    crossings: new Map<string, number[]>(),
    departures: new Map<string, Map<string, number[]>>(),
    segmentRoutes: new Map<string, Map<string, number>>(),
    routeNames: new Map<string, string>(),
  };

  let activeRoutes = 0;
  for (const { source, feed } of feeds) {
    activeRoutes += consolidate(
      feed,
      source.id,
      referenceDate,
      excluded,
      accumulator,
    );
  }

  for (const [segmentKey, segment] of accumulator.segments) {
    const medianCrossing = median(accumulator.crossings.get(segmentKey) ?? [0]);
    const gaps: number[] = [];
    for (const times of accumulator.departures.get(segmentKey)?.values() ??
      []) {
      const sorted = [...times].sort((left, right) => left - right);
      for (let index = 1; index < sorted.length; index++) {
        gaps.push(sorted[index] - sorted[index - 1]);
      }
    }
    const headway = gaps.length > 0 ? median(gaps) : Number.POSITIVE_INFINITY;
    segment.medianCrossingSeconds = medianCrossing;
    segment.headwaySeconds = headway;
    segment.rawTimeSeconds =
      medianCrossing + Math.min(headway / 2, WAIT_CAP_SECONDS);

    const routeCounts = accumulator.segmentRoutes.get(segmentKey);
    let bestRouteKey: string | null = null;
    let bestCount = -1;
    for (const [routeKey, count] of routeCounts ?? []) {
      const better =
        count > bestCount ||
        (count === bestCount &&
          bestRouteKey !== null &&
          routeKey < bestRouteKey);
      if (better) {
        bestRouteKey = routeKey;
        bestCount = count;
      }
    }
    const routeName = bestRouteKey
      ? (accumulator.routeNames.get(bestRouteKey) ?? "")
      : "";
    segment.routeName = routeName === "" ? null : routeName;
  }

  return {
    stops: [...accumulator.stops.values()].sort((left, right) =>
      left.key < right.key ? -1 : 1,
    ),
    segments: [...accumulator.segments.values()],
    activeRoutes,
  };
}

// Layout: scripts/README.md
function encodeFerries(graph: FerryGraph): Uint8Array {
  const { stops, segments } = graph;
  const stopIndex = new Map(stops.map((stop, index) => [stop.key, index]));

  let originLng = Number.POSITIVE_INFINITY;
  let originLat = Number.POSITIVE_INFINITY;
  const swallow = ({ lat, lng }: Coord): void => {
    originLng = Math.min(originLng, lng);
    originLat = Math.min(originLat, lat);
  };
  for (const stop of stops) {
    swallow(stop);
  }
  for (const segment of segments) {
    for (const point of segment.geometry ?? []) {
      swallow(point);
    }
  }
  const quantize = ({ lat, lng }: Coord): { x: number; y: number } => ({
    x: Math.round((lng - originLng) / COORD_SCALE),
    y: Math.round((lat - originLat) / COORD_SCALE),
  });

  // Stop and route names share one table.
  const routeNames = segments
    .map((segment) => segment.routeName)
    .filter((name): name is string => name !== null);
  const names = [
    ...new Set([...stops.map((stop) => stop.name), ...routeNames]),
  ].sort();
  const nameIndex = new Map(names.map((name, index) => [name, index]));

  const stopTable = new Uint8Array(stops.length * FERRY_STOP_BYTES);
  const stopView = new DataView(stopTable.buffer);
  for (let index = 0; index < stops.length; index++) {
    const stop = stops[index];
    const { x, y } = quantize(stop);
    const record = index * FERRY_STOP_BYTES;
    stopView.setInt32(record, x, true);
    stopView.setInt32(record + 4, y, true);
    stopView.setUint32(record + 8, nameIndex.get(stop.name) ?? 0, true);
  }

  const geometryBytes: number[] = [];
  const geometryOffsets: number[] = [];
  const geometryCounts: number[] = [];
  const scratch = new Uint8Array(10);
  for (const segment of segments) {
    if (!segment.geometry) {
      geometryOffsets.push(NO_GEOMETRY);
      geometryCounts.push(0);
      continue;
    }
    geometryOffsets.push(geometryBytes.length);
    geometryCounts.push(segment.geometry.length);
    let previousX = 0;
    let previousY = 0;
    for (const point of segment.geometry) {
      const { x, y } = quantize(point);
      for (const delta of [x - previousX, y - previousY]) {
        const end = writeVarint(scratch, 0, zigzag(delta));
        for (let byte = 0; byte < end; byte++) {
          geometryBytes.push(scratch[byte]);
        }
      }
      previousX = x;
      previousY = y;
    }
  }
  while (geometryBytes.length % 4 !== 0) {
    geometryBytes.push(0); // pad so the name blob starts 4-byte aligned
  }
  const geometryBlob = Uint8Array.from(geometryBytes);

  const segmentTable = new Uint8Array(segments.length * FERRY_SEGMENT_BYTES);
  const segmentView = new DataView(segmentTable.buffer);
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const record = index * FERRY_SEGMENT_BYTES;
    segmentView.setUint32(record, stopIndex.get(segment.stopA) ?? 0, true);
    segmentView.setUint32(record + 4, stopIndex.get(segment.stopB) ?? 0, true);
    segmentView.setFloat32(record + 8, segment.rawTimeSeconds, true);
    segmentView.setUint32(record + 12, geometryOffsets[index], true);
    segmentView.setUint16(record + 16, geometryCounts[index], true);
    const routeNameId =
      segment.routeName !== null
        ? (nameIndex.get(segment.routeName) ?? NO_ROUTE_NAME)
        : NO_ROUTE_NAME;
    segmentView.setUint16(record + 18, routeNameId, true);
  }

  const encoder = new TextEncoder();
  const nameBytes = names.map((name) => encoder.encode(name));
  let nameBlobLength = 4;
  for (const bytes of nameBytes) {
    nameBlobLength += 2 + bytes.length;
  }
  const nameBlob = new Uint8Array(nameBlobLength);
  const nameView = new DataView(nameBlob.buffer);
  nameView.setUint32(0, names.length, true);
  let nameCursor = 4;
  for (const bytes of nameBytes) {
    nameView.setUint16(nameCursor, bytes.length, true);
    nameCursor += 2;
    nameBlob.set(bytes, nameCursor);
    nameCursor += bytes.length;
  }

  const geometryOffset =
    FERRY_HEADER_BYTES + stopTable.length + segmentTable.length;
  const nameBlobOffset = geometryOffset + geometryBlob.length;
  const bytes = new Uint8Array(nameBlobOffset + nameBlob.length);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 4; index++) {
    bytes[index] = FERRY_MAGIC.charCodeAt(index);
  }
  view.setUint16(4, FERRY_FORMAT, true);
  view.setUint16(6, FERRY_HEADER_BYTES, true);
  view.setUint32(8, stops.length, true);
  view.setUint32(12, segments.length, true);
  view.setFloat64(16, originLng, true);
  view.setFloat64(24, originLat, true);
  view.setFloat64(32, COORD_SCALE, true);
  view.setUint32(40, geometryOffset, true);
  view.setUint32(44, geometryBlob.length, true);
  view.setUint32(48, nameBlobOffset, true);
  view.setUint32(52, nameBlob.length, true);
  bytes.set(stopTable, FERRY_HEADER_BYTES);
  bytes.set(segmentTable, FERRY_HEADER_BYTES + stopTable.length);
  bytes.set(geometryBlob, geometryOffset);
  bytes.set(nameBlob, nameBlobOffset);
  return bytes;
}

export interface FerrySource {
  file: string;
  format: number;
  stops: number;
  segments: number;
  bytes: number;
  sha256: string;
}

// Freezes the raw zips so a later pass can re-derive from the exact feeds this build read.
export async function ingestFerries(cityId: string): Promise<FerrySource> {
  const started = performance.now();
  await mkdir(FERRY_DIR, { recursive: true });

  const loaded: { source: FeedSource; feed: GtfsFeed }[] = [];
  for (const source of feedsOf(cityId)) {
    console.error(`ferries: fetching ${source.name}`);
    const zip = await fetchGtfsZip(source.cacheKey, source.url);
    await writeFile(join(FERRY_DIR, source.zipFile), zip);
    loaded.push({ source, feed: parseGtfs(zip) });
  }

  const graph = buildGraph(loaded, excludedStopNames(cityId));

  // An off-land terminal would snap to the wrong shore; warn only, since the land test is optional.
  let land: LandContext | null = null;
  try {
    land = await loadLandContext(cityId);
  } catch (error) {
    console.error(
      `ferries: WARNING no terminal was checked against ${cityId}'s land, ` +
        `the land test being unavailable: ${error}`,
    );
  }
  if (land) {
    for (const stop of graph.stops) {
      if (!nearLand(stop, land.onLand)) {
        console.error(
          `ferries: WARNING ${stop.name} (${stop.lat}, ${stop.lng}) is over ` +
            `${LAND_TOLERANCE_METERS} m from ${cityId}'s land; it will snap to the nearest ` +
            "shore wherever that is",
        );
      }
    }
  }

  const bytes = encodeFerries(graph);
  const file = `${cityId}.bin`;
  await writeFile(join(FERRY_DIR, file), bytes);

  const nameOf = new Map(graph.stops.map((stop) => [stop.key, stop.name]));
  const minutes = (seconds: number): string => (seconds / 60).toFixed(1);
  console.error(
    `ferries: ${graph.activeRoutes} active routes, ${graph.stops.length} stops, ${graph.segments.length} segments`,
  );
  for (const segment of graph.segments) {
    const headway =
      segment.headwaySeconds === Number.POSITIVE_INFINITY
        ? "n/a"
        : `${minutes(segment.headwaySeconds)}m`;
    const shape = segment.geometry
      ? `${segment.geometry.length}-pt shape`
      : "straight";
    const route = segment.routeName ?? "?";
    console.error(
      `  [${route}] ${nameOf.get(segment.stopA)} <-> ${nameOf.get(segment.stopB)}: ` +
        `${minutes(segment.rawTimeSeconds)}m (cross ${minutes(segment.medianCrossingSeconds)}m, ` +
        `headway ${headway}, ${shape})`,
    );
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const megabytes = (bytes.length / 1024 / 1024).toFixed(3);
  console.error(`ferries: wrote ${file} (${megabytes} MiB) in ${seconds}s`);

  return {
    file,
    format: FERRY_FORMAT,
    stops: graph.stops.length,
    segments: graph.segments.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

// `--refresh` is read by scripts/cache.ts; it's declared so parseArgs doesn't reject it.
if (import.meta.main) {
  const { values } = parseArgs({
    options: { city: { type: "string" }, refresh: { type: "boolean" } },
  });
  await ingestFerries(values.city ?? "nyc");
}

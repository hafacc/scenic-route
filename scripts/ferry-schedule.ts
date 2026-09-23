// A separate artifact, not baked into the graph, because the daily job can't rebuild the graph.

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  excludedStopNames,
  FERRY_CITIES,
  FERRY_ROUTE_TYPE,
  type FeedSource,
  feedsOf,
  toSeconds,
} from "./ferries";
import { writeVarint } from "./geometry";
import { fetchGtfsZip, type GtfsFeed, parseGtfs } from "./gtfs";
import {
  CURRENT_LAST_DAY,
  collectServices,
  dayNumber,
  dayString,
  type Exception,
  encodeExceptions,
  encodeServices,
  localDay,
  publishRecord,
  type Service,
} from "./schedule-record";

// Not public/ferries/, which is gitignored tile-build output; this one is committed.
const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
export const SCHEDULE_DIR = join(PUBLIC_DIR, "ferry-schedule");

export const SCHEDULE_MAGIC = "FSCH";
export const SCHEDULE_FORMAT = 1;
const HEADER_BYTES = 40;
const LANE_BYTES = 16;
const NO_ROUTE_NAME = 0xffff;
// NUL: GTFS names may contain any printable character, but never this.
const KEY_SEPARATOR = "\u0000";

// Directional, since timetables aren't symmetric.
interface Lane {
  fromName: string;
  toName: string;
  routeName: string;
  serviceKey: string;
  // Seconds from service-day midnight (may pass 86400); crossing is per trip, as speeds differ.
  departures: { at: number; crossing: number }[];
}

export interface Timetable {
  lanes: Lane[];
  services: Service[];
  exceptions: Exception[];
}

// Excludes by stop name, not a land check, so the daily CI job needs no GIS services.
function consolidate(
  feed: GtfsFeed,
  feedId: string,
  excluded: ReadonlySet<string>,
  lanes: Map<string, Lane>,
  usedServices: Set<string>,
  stopOfName: Map<string, string>,
): void {
  const routeTypeOf = new Map(
    feed.routes.map((route) => [route.route_id, route.route_type]),
  );
  const routeDisplayOf = new Map(
    feed.routes.map((route) => [
      route.route_id,
      route.route_long_name?.trim() || route.route_short_name?.trim() || "",
    ]),
  );
  const tripRoute = new Map(
    feed.trips.map((trip) => [trip.trip_id, trip.route_id]),
  );
  const tripService = new Map(
    feed.trips.map((trip) => [trip.trip_id, trip.service_id]),
  );

  const nameOf = new Map<string, string>();
  for (const stop of feed.stops) {
    nameOf.set(stop.stop_id, stop.stop_name);
  }

  const byTrip = new Map<string, GtfsFeed["stopTimes"]>();
  for (const row of feed.stopTimes) {
    const rows = byTrip.get(row.trip_id);
    if (rows) {
      rows.push(row);
    } else {
      byTrip.set(row.trip_id, [row]);
    }
  }

  for (const [tripId, rows] of byTrip) {
    const routeId = tripRoute.get(tripId);
    const serviceId = tripService.get(tripId);
    if (
      routeId === undefined ||
      serviceId === undefined ||
      routeTypeOf.get(routeId) !== FERRY_ROUTE_TYPE
    ) {
      continue;
    }
    const routeName = routeDisplayOf.get(routeId) ?? "";
    const serviceKey = `${feedId}:${serviceId}`;
    const ordered = [...rows].sort(
      (left, right) => Number(left.stop_sequence) - Number(right.stop_sequence),
    );

    for (let index = 0; index + 1 < ordered.length; index++) {
      const from = ordered[index];
      const to = ordered[index + 1];
      const at = toSeconds(from.departure_time);
      const arrival = toSeconds(to.arrival_time);
      const fromName = nameOf.get(from.stop_id);
      const toName = nameOf.get(to.stop_id);
      if (
        at === null ||
        arrival === null ||
        fromName === undefined ||
        toName === undefined ||
        fromName === toName ||
        excluded.has(fromName) ||
        excluded.has(toName)
      ) {
        continue;
      }
      const crossing = arrival - at;
      if (crossing < 0) {
        continue;
      }
      // The graph joins by stop name, so a shared name would make a lane ambiguous.
      for (const [stopId, name] of [
        [`${feedId}:${from.stop_id}`, fromName],
        [`${feedId}:${to.stop_id}`, toName],
      ] as const) {
        const seen = stopOfName.get(name);
        if (seen !== undefined && seen !== stopId) {
          throw new Error(
            `ferry stops ${seen} and ${stopId} share the name "${name}" — the graph joins ` +
              "the timetable by name, so it cannot tell them apart",
          );
        }
        stopOfName.set(name, stopId);
      }

      usedServices.add(serviceKey);
      const key = [fromName, toName, routeName, serviceKey].join(KEY_SEPARATOR);
      const lane = lanes.get(key);
      if (lane) {
        lane.departures.push({ at, crossing });
      } else {
        lanes.set(key, {
          fromName,
          toName,
          routeName,
          serviceKey,
          departures: [{ at, crossing }],
        });
      }
    }
  }
}

export function buildTimetable(
  feeds: { source: FeedSource; feed: GtfsFeed }[],
  excluded: ReadonlySet<string> = new Set<string>(),
): Timetable {
  const lanes = new Map<string, Lane>();
  const usedServices = new Set<string>();
  const stopOfName = new Map<string, string>();
  for (const { source, feed } of feeds) {
    consolidate(feed, source.id, excluded, lanes, usedServices, stopOfName);
  }
  const { services, exceptions } = collectServices(
    feeds.map(({ source, feed }) => ({ feedId: source.id, feed })),
    usedServices,
  );

  // Sorted so the bytes are a pure function of the feeds; otherwise no-op days look like changes.
  for (const lane of lanes.values()) {
    // Same-second departures are one sailing listed twice; keep the quicker crossing.
    const sorted = [...lane.departures].sort(
      (left, right) => left.at - right.at || left.crossing - right.crossing,
    );
    lane.departures = sorted.filter(
      (departure, index) => departure.at !== sorted[index - 1]?.at,
    );
  }
  const ordered = [...lanes.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([, lane]) => lane);

  return { lanes: ordered, services, exceptions };
}

// Little-endian; every section a multiple of 4 so concatenated history records stay aligned.
export function encodeTimetable(
  timetable: Timetable,
  firstDay: number,
  lastDay: number,
): Uint8Array {
  const { lanes, services, exceptions } = timetable;
  const serviceIndex = new Map(
    services.map((service, index) => [service.key, index]),
  );

  const names = [
    ...new Set(
      lanes.flatMap((lane) =>
        lane.routeName === ""
          ? [lane.fromName, lane.toName]
          : [lane.fromName, lane.toName, lane.routeName],
      ),
    ),
  ].sort();
  const nameIndex = new Map(names.map((name, index) => [name, index]));

  // Departure gaps and crossings are all non-negative, so plain LEB128 rather than zigzag.
  const departureBytes: number[] = [];
  const laneOffsets: number[] = [];
  const scratch = new Uint8Array(10);
  const push = (value: number): void => {
    const end = writeVarint(scratch, 0, value);
    for (let byte = 0; byte < end; byte++) {
      departureBytes.push(scratch[byte]);
    }
  };
  for (const lane of lanes) {
    laneOffsets.push(departureBytes.length);
    let previous = 0;
    for (const departure of lane.departures) {
      push(departure.at - previous);
      push(departure.crossing);
      previous = departure.at;
    }
  }
  while (departureBytes.length % 4 !== 0) {
    departureBytes.push(0);
  }
  const departureBlob = Uint8Array.from(departureBytes);

  const serviceTable = encodeServices(services);
  const exceptionTable = encodeExceptions(exceptions, serviceIndex);

  const laneTable = new Uint8Array(lanes.length * LANE_BYTES);
  const laneView = new DataView(laneTable.buffer);
  lanes.forEach((lane, index) => {
    const record = index * LANE_BYTES;
    laneView.setUint16(record, nameIndex.get(lane.fromName) ?? 0, true);
    laneView.setUint16(record + 2, nameIndex.get(lane.toName) ?? 0, true);
    laneView.setUint16(
      record + 4,
      lane.routeName === ""
        ? NO_ROUTE_NAME
        : (nameIndex.get(lane.routeName) ?? NO_ROUTE_NAME),
      true,
    );
    laneView.setUint16(
      record + 6,
      serviceIndex.get(lane.serviceKey) ?? 0,
      true,
    );
    laneView.setUint16(record + 8, lane.departures.length, true);
    laneView.setUint32(record + 12, laneOffsets[index], true);
  });

  const encoder = new TextEncoder();
  const nameBytes = names.map((name) => encoder.encode(name));
  const nameOffsets = new Uint32Array(names.length + 1);
  let nameCursor = 0;
  nameBytes.forEach((bytes, index) => {
    nameOffsets[index] = nameCursor;
    nameCursor += bytes.length;
  });
  nameOffsets[names.length] = nameCursor;
  const nameTable = new Uint8Array(4 + nameOffsets.byteLength + nameCursor);
  new DataView(nameTable.buffer).setUint32(0, names.length, true);
  nameTable.set(new Uint8Array(nameOffsets.buffer), 4);
  nameBytes.forEach((bytes, index) => {
    nameTable.set(bytes, 4 + nameOffsets.byteLength + nameOffsets[index]);
  });

  const serviceOffset = HEADER_BYTES;
  const exceptionOffset = serviceOffset + serviceTable.length;
  const laneOffset = exceptionOffset + exceptionTable.length;
  const departureOffset = laneOffset + laneTable.length;
  const nameOffset = departureOffset + departureBlob.length;
  // Padding counts in `total` so walking the history file by record length stays aligned.
  const total = (nameOffset + nameTable.length + 3) & ~3;

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 4; index++) {
    bytes[index] = SCHEDULE_MAGIC.charCodeAt(index);
  }
  view.setUint16(4, SCHEDULE_FORMAT, true);
  view.setUint16(6, HEADER_BYTES, true);
  view.setUint32(8, firstDay, true);
  view.setUint32(12, lastDay, true);
  view.setUint32(16, services.length, true);
  view.setUint32(20, exceptions.length, true);
  view.setUint32(24, lanes.length, true);
  view.setUint32(28, departureBlob.length, true);
  view.setUint32(32, nameOffset, true);
  view.setUint32(36, total, true);
  bytes.set(serviceTable, serviceOffset);
  bytes.set(exceptionTable, exceptionOffset);
  bytes.set(laneTable, laneOffset);
  bytes.set(departureBlob, departureOffset);
  bytes.set(nameTable, nameOffset);
  return bytes;
}

export interface ScheduleUpdate {
  changed: boolean;
  firstDay: number;
  lanes: number;
  services: number;
  bytes: number;
  sha256: string;
}

export async function updateFerrySchedule(
  cityId: string,
  today: string,
): Promise<ScheduleUpdate> {
  await mkdir(SCHEDULE_DIR, { recursive: true });
  const loaded: { source: FeedSource; feed: GtfsFeed }[] = [];
  for (const source of feedsOf(cityId)) {
    console.error(`ferry-schedule: fetching ${source.name}`);
    const zip = await fetchGtfsZip(source.cacheKey, source.url);
    loaded.push({ source, feed: parseGtfs(zip) });
  }

  const timetable = buildTimetable(loaded, excludedStopNames(cityId));
  const day = dayNumber(today);
  const { changed, firstDay, record } = await publishRecord({
    directory: SCHEDULE_DIR,
    cityId,
    candidate: encodeTimetable(timetable, day, CURRENT_LAST_DAY),
    headerBytes: HEADER_BYTES,
    today: day,
    label: "ferry-schedule",
  });

  const departures = timetable.lanes.reduce(
    (sum, lane) => sum + lane.departures.length,
    0,
  );
  console.error(
    `ferry-schedule: ${cityId} ${timetable.lanes.length} lanes, ${departures} departures, ` +
      `${timetable.services.length} services, in effect from ${dayString(firstDay)} ` +
      `(${changed ? "changed" : "unchanged"}, ${record.length} bytes)`,
  );

  return {
    changed,
    firstDay,
    lanes: timetable.lanes.length,
    services: timetable.services.length,
    bytes: record.length,
    sha256: createHash("sha256").update(record).digest("hex"),
  };
}

// One `today` for the whole run, so every city opens its new record on the same day.
if (import.meta.main) {
  // Declared only so parseArgs accepts them; scripts/cache.ts reads argv itself.
  const { values } = parseArgs({
    options: {
      city: { type: "string" },
      offline: { type: "boolean" },
      refresh: { type: "boolean" },
    },
  });
  const cities = values.city === undefined ? FERRY_CITIES : [values.city];
  const today = localDay(new Date());
  for (const cityId of cities) {
    await updateFerrySchedule(cityId, today);
  }
}

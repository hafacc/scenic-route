// Per-direction sailings for the routed day; days without a record fall back to the graph's baked figure.

import { type Cursor, readUnsignedVarint } from "../tiles/varint";
import type { RoutingGraph } from "./graph";
import {
  dayNumber,
  decodeExceptions,
  decodeServices,
  EXCEPTION_BYTES,
  SERVICE_BYTES,
  type ServiceCalendar,
  secondsOfDay,
  serviceDays,
  shiftedDay,
  timeZoneOf,
} from "./schedule-days";
import { scheduleReader } from "./schedule-records";

export { dayNumber };

const MAGIC = "FSCH";
const FORMAT_VERSION = 1;
const HEADER_BYTES = 40;
const LANE_BYTES = 16;
const NO_ROUTE_NAME = 0xffff;

// Read from `main` over raw.githubusercontent.com so schedule changes skip a deploy; local in development.
const SCHEDULE_MAIN_URL =
  "https://raw.githubusercontent.com/hafaio/scenic-route/main/public/ferry-schedule";
const SCHEDULE_BASE =
  process.env.NEXT_PUBLIC_FERRY_SCHEDULE_BASE ??
  (process.env.NODE_ENV === "development"
    ? "ferry-schedule"
    : SCHEDULE_MAIN_URL);

// Departure is seconds from midnight of the routed day, so a next-day boat reads past 86400.
export interface Sailing {
  departure: number;
  wait: number;
  crossing: number;
  route: string | null;
}

// Directional: the 8:15 out of St. George is not the 8:15 out of Whitehall.
export interface FerryTimetable {
  // An edge matching no lane (a renamed stop, say) keeps the baked figure rather than reading as missed.
  covers(edge: number): boolean;
  // Null once the day's last boat has gone, which makes a missed ferry cost Infinity.
  board(edge: number, fromNode: number, elapsedSeconds: number): Sailing | null;
  // The quickest crossing with no wait, since the A* ferry credit needs a true lower bound.
  minRideSeconds(edge: number): number;
}

interface Sailings {
  departures: Float64Array;
  crossings: Float64Array;
  routes: (string | null)[];
}

interface EdgeSailings {
  nodeA: number; // boarding here sails forward, toward node b
  nodeB: number;
  forward: Sailings | null;
  backward: Sailings | null;
}

interface Lane {
  fromName: string;
  toName: string;
  route: string | null;
  service: number;
  sailings: { at: number; crossing: number }[];
}

export interface ScheduleRecord {
  firstDay: number;
  lastDay: number; // 0 while this is the timetable in effect
  services: ServiceCalendar[];
  exceptions: { day: number; service: number; type: number }[];
  lanes: Lane[];
}

export function decodeSchedule(
  bytes: Uint8Array,
  offset = 0,
): { record: ScheduleRecord; nextOffset: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
  const version = view.getUint16(offset + 4, true);
  if (magic !== MAGIC || version !== FORMAT_VERSION) {
    throw new Error(`not a v${FORMAT_VERSION} ferry schedule`);
  }
  const firstDay = view.getUint32(offset + 8, true);
  const lastDay = view.getUint32(offset + 12, true);
  const serviceCount = view.getUint32(offset + 16, true);
  const exceptionCount = view.getUint32(offset + 20, true);
  const laneCount = view.getUint32(offset + 24, true);
  const departureBytes = view.getUint32(offset + 28, true);
  const nameTableOffset = offset + view.getUint32(offset + 32, true);
  const recordBytes = view.getUint32(offset + 36, true);

  const nameCount = view.getUint32(nameTableOffset, true);
  const nameBlob = nameTableOffset + 4 + (nameCount + 1) * 4;
  const decoder = new TextDecoder();
  const names: string[] = [];
  for (let index = 0; index < nameCount; index++) {
    const start = view.getUint32(nameTableOffset + 4 + index * 4, true);
    const end = view.getUint32(nameTableOffset + 8 + index * 4, true);
    names.push(
      decoder.decode(bytes.subarray(nameBlob + start, nameBlob + end)),
    );
  }

  const serviceOffset = offset + HEADER_BYTES;
  const services = decodeServices(view, serviceOffset, serviceCount);
  const exceptionOffset = serviceOffset + serviceCount * SERVICE_BYTES;
  const exceptions = decodeExceptions(view, exceptionOffset, exceptionCount);

  const laneOffset = exceptionOffset + exceptionCount * EXCEPTION_BYTES;
  const departureOffset = laneOffset + laneCount * LANE_BYTES;
  const lanes: Lane[] = [];
  for (let index = 0; index < laneCount; index++) {
    const record = laneOffset + index * LANE_BYTES;
    const routeId = view.getUint16(record + 4, true);
    const count = view.getUint16(record + 8, true);
    const cursor: Cursor = {
      offset: departureOffset + view.getUint32(record + 12, true),
    };
    const sailings: Lane["sailings"] = [];
    let at = 0;
    for (let sailing = 0; sailing < count; sailing++) {
      at += readUnsignedVarint(bytes, cursor);
      sailings.push({ at, crossing: readUnsignedVarint(bytes, cursor) });
    }
    lanes.push({
      fromName: names[view.getUint16(record, true)] ?? "",
      toName: names[view.getUint16(record + 2, true)] ?? "",
      route: routeId === NO_ROUTE_NAME ? null : (names[routeId] ?? null),
      service: view.getUint16(record + 6, true),
      sailings,
    });
  }

  if (departureOffset + departureBytes > nameTableOffset) {
    throw new Error("ferry schedule departure blob overruns the name table");
  }

  return {
    record: { firstDay, lastDay, services, exceptions, lanes },
    nextOffset: offset + recordBytes,
  };
}

class ResolvedTimetable implements FerryTimetable {
  constructor(
    private readonly departureSecondsOfDay: number,
    private readonly covered: Set<number>,
    private readonly sailings: Map<number, EdgeSailings>,
    private readonly minRide: Map<number, number>,
  ) {}

  // Over the whole record, so a weekend-only run reads "no boat" rather than the whole-timetable average.
  covers(edge: number): boolean {
    return this.covered.has(edge);
  }

  board(
    edge: number,
    fromNode: number,
    elapsedSeconds: number,
  ): Sailing | null {
    const lanes = this.sailings.get(edge);
    if (!lanes) {
      return null;
    }
    // A node that is neither end gets nothing, rather than the other direction's timetable.
    const side =
      fromNode === lanes.nodeA
        ? lanes.forward
        : fromNode === lanes.nodeB
          ? lanes.backward
          : null;
    if (!side) {
      return null;
    }
    const wall = this.departureSecondsOfDay + elapsedSeconds;
    const { departures, crossings, routes } = side;
    let low = 0;
    let high = departures.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (departures[middle] < wall) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (low >= departures.length) {
      return null;
    } else {
      return {
        departure: departures[low],
        wait: departures[low] - wall,
        crossing: crossings[low],
        route: routes[low],
      };
    }
  }

  minRideSeconds(edge: number): number {
    return this.minRide.get(edge) ?? Number.POSITIVE_INFINITY;
  }
}

// Three service days, since walks start near midnight and GTFS writes after-midnight sailings as 25:10.
function sailingsFor(
  record: ScheduleRecord,
  days: { day: number; offset: number; services: Set<number> }[],
  fromName: string,
  toName: string,
): Sailings | null {
  const merged: {
    departure: number;
    crossing: number;
    route: string | null;
  }[] = [];
  for (const { offset, services } of days) {
    for (const lane of record.lanes) {
      if (
        lane.fromName !== fromName ||
        lane.toName !== toName ||
        !services.has(lane.service)
      ) {
        continue;
      }
      for (const sailing of lane.sailings) {
        merged.push({
          departure: sailing.at + offset,
          crossing: sailing.crossing,
          route: lane.route,
        });
      }
    }
  }
  if (merged.length === 0) {
    return null;
  }
  // Routes sharing a stop pair are separate lanes; merged, you board whichever boat leaves next.
  merged.sort((left, right) => left.departure - right.departure);
  return {
    departures: Float64Array.from(merged, (sailing) => sailing.departure),
    crossings: Float64Array.from(merged, (sailing) => sailing.crossing),
    routes: merged.map((sailing) => sailing.route),
  };
}

function leastCrossing(...sides: (Sailings | null)[]): number {
  let least = Number.POSITIVE_INFINITY;
  for (const side of sides) {
    for (const crossing of side?.crossings ?? []) {
      least = Math.min(least, crossing);
    }
  }
  return least;
}

export function resolveTimetable(
  graph: RoutingGraph,
  record: ScheduleRecord,
  date: Date,
  timeZone: string,
): FerryTimetable {
  const days = serviceDays(record.services, record.exceptions, date, timeZone);

  const scheduled = new Set(
    record.lanes.map((lane) => `${lane.fromName}\u0000${lane.toName}`),
  );

  const covered = new Set<number>();
  const sailings = new Map<number, EdgeSailings>();
  const minRide = new Map<number, number>();
  for (const edge of graph.ferryEdges) {
    const ends = graph.ferryEndpointNames.get(edge);
    if (
      !ends ||
      !(
        scheduled.has(`${ends.a}\u0000${ends.b}`) ||
        scheduled.has(`${ends.b}\u0000${ends.a}`)
      )
    ) {
      continue; // no lane by these names at all: this edge keeps the graph's baked figure
    }
    covered.add(edge);
    const forward = sailingsFor(record, days, ends.a, ends.b);
    const backward = sailingsFor(record, days, ends.b, ends.a);
    if (!forward && !backward) {
      continue; // scheduled, but not on these days — `board` returning null is the right answer
    }
    sailings.set(edge, {
      nodeA: graph.edgeNodeA[edge],
      nodeB: graph.edgeNodeB[edge],
      forward,
      backward,
    });
    minRide.set(edge, leastCrossing(forward, backward));
  }

  const departureSecondsOfDay = secondsOfDay(date, timeZone);
  return new ResolvedTimetable(
    departureSecondsOfDay,
    covered,
    sailings,
    minRide,
  );
}

// Leaves `graph.ferries` null, the baked figure, for any day before the first record.
export async function computeFerrySchedule(
  graph: RoutingGraph,
  cityId: string,
  date: Date,
): Promise<void> {
  const timeZone = timeZoneOf(cityId);
  const record = await loadScheduleRecord(
    cityId,
    shiftedDay(date, 0, timeZone),
  );
  graph.ferries = record
    ? resolveTimetable(graph, record, date, timeZone)
    : null;
}

export const loadScheduleRecord = scheduleReader(SCHEDULE_BASE, decodeSchedule);

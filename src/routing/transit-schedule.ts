// The rail timetable the router departs against (magic TSCH, written by scripts/transit-schedule.ts).
//
// The graph carries the topology — which pattern calls at which station, and the seconds between one
// stop and the next — and each of its board edges names a LANE, the pattern a walker would be
// getting on. This says when that pattern leaves: for the day being routed, the headway bands at the
// pattern's first stop, shifted by the stop's own offset so the answer is the next train from the
// platform the walker is standing on.
//
// It is bands rather than departures, so a `board` answer is the modeled train and not a promise
// about a particular one: over the 2026 feeds the modeled departure is a mean of 20 seconds from the
// real one. That is the trade the artifact exists to make — a departure list would be ten times the
// records for a wait nobody can tell apart.
//
// A different artifact for a different day, exactly as the ferry timetable does it: the daily job
// records the day range each one was in effect for, so routing on a past day resolves to the
// timetable that actually ran. Days before the first recorded one — and any day at all when the fetch
// fails — get no timetable, and the router falls back to whatever it does without one.
//
// Layout: scripts/README.md.

import { type Cursor, readUnsignedVarint } from "../tiles/varint";
import {
  decodeExceptions,
  decodeServices,
  EXCEPTION_BYTES,
  SERVICE_BYTES,
  type ServiceCalendar,
  type ServiceException,
  secondsOfDay,
  serviceDays,
  shiftedDay,
  timeZoneOf,
} from "./schedule-days";
import { scheduleReader } from "./schedule-records";

const MAGIC = "TSCH";
const FORMAT_VERSION = 1;
const HEADER_BYTES = 44;
const PATTERN_BYTES = 12;
const LANE_BYTES = 12;

// Where the timetable comes from: `public/transit-schedule/` on `main`, which the daily job commits
// to, read over raw.githubusercontent.com rather than out of the deploy — the same reasoning as the
// ferry timetable and the shed artifact, since a schedule change must reach the client without a
// deploy. In development it stays on the local `public/transit-schedule/`, which is also the only way
// to see a pipeline change before it is pushed.
const SCHEDULE_MAIN_URL =
  "https://raw.githubusercontent.com/hafaio/scenic-route/main/public/transit-schedule";
const SCHEDULE_BASE =
  process.env.NEXT_PUBLIC_TRANSIT_SCHEDULE_BASE ??
  (process.env.NODE_ENV === "development"
    ? "transit-schedule"
    : SCHEDULE_MAIN_URL);

// One window of even service at a pattern's first stop: trains at `start`, `start + headway`, … up
// to `end`, and `end` itself, which is the window's last train whether or not the grid lands on it.
// A `headway` of 0 is a window of one train.
export interface Band {
  start: number; // seconds from midnight of the day being routed
  end: number;
  headway: number;
}

// The train a walker catches: when it leaves the stop they are standing at, and how long they wait
// for it first.
export interface Departure {
  departure: number;
  wait: number;
}

// What the cost model asks of a timetable.
export interface TransitTimetable {
  // Whether this lane is in the timetable at all. A board edge whose lane the timetable does not name
  // — a pattern the feed has since changed — is not scheduled, and the caller decides what that
  // means rather than being handed a wrong departure.
  covers(laneId: number): boolean;
  // The first departure at `stopIndex` of the lane at or after `elapsedSeconds` into the walk, or
  // null once the day's last train has gone. Null is what makes a missed train cost Infinity and
  // drop out of the search.
  board(
    laneId: number,
    stopIndex: number,
    elapsedSeconds: number,
  ): Departure | null;
  // The least anyone can wait for a train: zero, because a train can be standing at the platform.
  // The A* transit credit is built from this, so it has to be a true lower bound over every
  // departure time.
  readonly minWaitSeconds: number;
}

interface Lane {
  pattern: number;
  service: number;
  bands: Band[];
}

interface Pattern {
  laneId: number;
  offsets: number[]; // seconds from the first stop's departure to each stop
}

// One decoded TSCH record: the timetable plus the day range it was in effect for.
export interface ScheduleRecord {
  firstDay: number;
  lastDay: number; // 0 while this is the timetable in effect
  services: ServiceCalendar[];
  exceptions: ServiceException[];
  patterns: Pattern[];
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
    throw new Error(`not a v${FORMAT_VERSION} transit schedule`);
  }
  const firstDay = view.getUint32(offset + 8, true);
  const lastDay = view.getUint32(offset + 12, true);
  const serviceCount = view.getUint32(offset + 16, true);
  const exceptionCount = view.getUint32(offset + 20, true);
  const patternCount = view.getUint32(offset + 24, true);
  const laneCount = view.getUint32(offset + 28, true);
  const bandBytes = view.getUint32(offset + 32, true);
  const offsetBytes = view.getUint32(offset + 36, true);
  const recordBytes = view.getUint32(offset + 40, true);

  const serviceOffset = offset + HEADER_BYTES;
  const services = decodeServices(view, serviceOffset, serviceCount);
  const exceptionOffset = serviceOffset + serviceCount * SERVICE_BYTES;
  const exceptions = decodeExceptions(view, exceptionOffset, exceptionCount);

  const patternOffset = exceptionOffset + exceptionCount * EXCEPTION_BYTES;
  const laneOffset = patternOffset + patternCount * PATTERN_BYTES;
  const bandOffset = laneOffset + laneCount * LANE_BYTES;
  const blobOffset = bandOffset + bandBytes;
  if (blobOffset + offsetBytes > offset + recordBytes) {
    throw new Error("transit schedule blobs overrun the record");
  }

  const patterns: Pattern[] = [];
  for (let index = 0; index < patternCount; index++) {
    const record = patternOffset + index * PATTERN_BYTES;
    const stopCount = view.getUint16(record + 4, true);
    const cursor: Cursor = {
      offset: blobOffset + view.getUint32(record + 8, true),
    };
    const offsets: number[] = [];
    let at = 0;
    for (let stop = 0; stop < stopCount; stop++) {
      at += readUnsignedVarint(bytes, cursor);
      offsets.push(at);
    }
    patterns.push({ laneId: view.getUint32(record, true), offsets });
  }

  const lanes: Lane[] = [];
  for (let index = 0; index < laneCount; index++) {
    const record = laneOffset + index * LANE_BYTES;
    const count = view.getUint16(record + 4, true);
    const cursor: Cursor = {
      offset: bandOffset + view.getUint32(record + 8, true),
    };
    const bands: Band[] = [];
    let start = 0;
    for (let band = 0; band < count; band++) {
      start += readUnsignedVarint(bytes, cursor);
      const span = readUnsignedVarint(bytes, cursor);
      bands.push({
        start,
        end: start + span,
        headway: readUnsignedVarint(bytes, cursor),
      });
    }
    lanes.push({
      pattern: view.getUint16(record, true),
      service: view.getUint16(record + 2, true),
      bands,
    });
  }

  return {
    record: { firstDay, lastDay, services, exceptions, patterns, lanes },
    nextOffset: offset + recordBytes,
  };
}

// The first train of a band at or after `at`, or null when the band is already over. `end` is a
// departure in its own right: the band's headway is the mean over the window, so the grid can land a
// few seconds short of the last train, and answering null there would lose it.
function nextInBand(band: Band, at: number): number | null {
  if (at <= band.start) {
    return band.start;
  } else if (at > band.end) {
    return null;
  } else if (band.headway <= 0) {
    return null; // a one-train band, and that train has gone
  } else {
    const grid =
      band.start + Math.ceil((at - band.start) / band.headway) * band.headway;
    return grid <= band.end ? grid : band.end;
  }
}

interface ResolvedLane {
  offsets: number[];
  bands: Band[]; // over the three service days, sorted by start
}

class ResolvedTimetable implements TransitTimetable {
  readonly minWaitSeconds = 0;

  constructor(
    private readonly departureSecondsOfDay: number,
    private readonly covered: ReadonlySet<number>,
    private readonly lanes: ReadonlyMap<number, ResolvedLane>,
  ) {}

  // Coverage is over the WHOLE record, not the day being routed: a pattern that runs on weekends only
  // is covered on a Wednesday and simply has no train, which is a different answer from "this lane is
  // not in the timetable".
  covers(laneId: number): boolean {
    return this.covered.has(laneId);
  }

  board(
    laneId: number,
    stopIndex: number,
    elapsedSeconds: number,
  ): Departure | null {
    const lane = this.lanes.get(laneId);
    const offset = lane?.offsets[stopIndex];
    if (!lane || offset === undefined) {
      return null;
    }
    const wall = this.departureSecondsOfDay + elapsedSeconds;
    // The bands are the FIRST stop's departures, so the walk down the line comes off the clock
    // before the search and goes back on after it.
    const wanted = wall - offset;
    let best: number | null = null;
    for (const band of lane.bands) {
      if (best !== null && band.start > best) {
        break; // sorted by start: nothing later can beat what we have
      }
      const departure = nextInBand(band, wanted);
      if (departure !== null && (best === null || departure < best)) {
        best = departure;
      }
    }
    if (best === null) {
      return null;
    } else {
      return { departure: best + offset, wait: best + offset - wall };
    }
  }
}

// Resolve a decoded timetable against a departure instant: which services run on the three days
// around it, and per lane the bands of those days as seconds from midnight of the routed day.
export function resolveTimetable(
  record: ScheduleRecord,
  date: Date,
  timeZone: string,
): TransitTimetable {
  const days = serviceDays(record.services, record.exceptions, date, timeZone);

  const bandsOf = new Map<number, Band[]>();
  for (const lane of record.lanes) {
    const pattern = record.patterns[lane.pattern];
    if (!pattern) {
      continue;
    }
    for (const { offset, services } of days) {
      if (!services.has(lane.service)) {
        continue;
      }
      const shifted = lane.bands.map((band) => ({
        start: band.start + offset,
        end: band.end + offset,
        headway: band.headway,
      }));
      const existing = bandsOf.get(pattern.laneId);
      if (existing) {
        existing.push(...shifted);
      } else {
        bandsOf.set(pattern.laneId, shifted);
      }
    }
  }

  const lanes = new Map<number, ResolvedLane>();
  for (const pattern of record.patterns) {
    const bands = bandsOf.get(pattern.laneId);
    if (bands) {
      bands.sort((left, right) => left.start - right.start);
      lanes.set(pattern.laneId, { offsets: pattern.offsets, bands });
    }
  }

  const departureSecondsOfDay = secondsOfDay(date, timeZone);
  return new ResolvedTimetable(
    departureSecondsOfDay,
    new Set(record.patterns.map((pattern) => pattern.laneId)),
    lanes,
  );
}

// The two published files, read through the shared reader: which record was in effect on a day is
// the same question of both artifacts, asked of this one's own directory and decoder.
export const loadScheduleRecord = scheduleReader(SCHEDULE_BASE, decodeSchedule);

// The timetable in effect on the departure date, resolved against it, or null when no record covers
// that day — which is every day before the first the daily job ever wrote.
export async function loadTimetable(
  cityId: string,
  date: Date,
): Promise<TransitTimetable | null> {
  const timeZone = timeZoneOf(cityId);
  const record = await loadScheduleRecord(
    cityId,
    shiftedDay(date, 0, timeZone),
  );
  return record ? resolveTimetable(record, date, timeZone) : null;
}

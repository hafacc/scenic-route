// Headway bands, not departures: 2026 feeds model departures within 20 s on average at a tenth the size.

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

// Read from `main` over raw.githubusercontent.com so schedule changes skip a deploy; local in development.
const SCHEDULE_MAIN_URL =
  "https://raw.githubusercontent.com/hafaio/scenic-route/main/public/transit-schedule";
const SCHEDULE_BASE =
  process.env.NEXT_PUBLIC_TRANSIT_SCHEDULE_BASE ??
  (process.env.NODE_ENV === "development"
    ? "transit-schedule"
    : SCHEDULE_MAIN_URL);

// `end` is the window's last train whether or not the grid lands on it; a `headway` of 0 is one train.
export interface Band {
  start: number; // seconds from midnight of the day being routed
  end: number;
  headway: number;
}

export interface Departure {
  departure: number;
  wait: number;
}

export interface TransitTimetable {
  // An unnamed lane is unscheduled, and the caller decides what that means.
  covers(laneId: number): boolean;
  // Null once the day's last train has gone, which makes a missed train cost Infinity.
  board(
    laneId: number,
    stopIndex: number,
    elapsedSeconds: number,
  ): Departure | null;
  // Zero, since a train can be standing at the platform; the A* transit credit needs a true lower bound.
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

// `end` is a departure too: the headway is a window mean, so the grid can land short of the last train.
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

  // Over the whole record, so a weekend-only lane is covered on a Wednesday but has no train.
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
    // Bands are the first stop's departures, so the stop's offset comes off the clock and back on.
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

// Bands as seconds from midnight of the routed day, over the three service days around it.
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

export const loadScheduleRecord = scheduleReader(SCHEDULE_BASE, decodeSchedule);

// Null for any day before the first the daily job ever wrote.
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

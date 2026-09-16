// The calendar arithmetic both published timetables read: which GTFS services run on a day, and the
// three service days a departure instant can catch a vehicle on.
//
// The ferry timetable (FSCH) and the rail one (TSCH) hold different things, but they answer the same
// question about a day, out of the same two GTFS tables, and a walk planned at 23:50 has to look at
// tomorrow in both.

import { cityById } from "../cities";

// The zone a city's published timetables are written in. Unknown ids fall back to the reader's own
// zone, which is a fixture with no city behind it rather than anything the app routes in.
export function timeZoneOf(cityId: string): string {
  return (
    cityById(cityId)?.timeZone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone
  );
}

export const SECONDS_PER_DAY = 86_400;
export const EXCEPTION_ADDED = 1;

// One GTFS service as an artifact stores it.
export interface ServiceCalendar {
  mask: number; // bit 0 Monday .. bit 6 Sunday
  startDay: number; // YYYYMMDD
  endDay: number;
}

export interface ServiceException {
  day: number; // YYYYMMDD
  service: number; // index into the service table
  type: number;
}

export function dayNumber(day: string): number {
  return Number(day.replaceAll("-", ""));
}

// The two calendar tables sit at the front of both artifacts, in the same layout: a service is
// (u32 start day, u32 end day, u8 weekday mask) and an exception (u32 day, u16 service index, u8
// type), each padded out to a multiple of four. Written by scripts/schedule-record.ts.
export const SERVICE_BYTES = 12;
export const EXCEPTION_BYTES = 8;

export function decodeServices(
  view: DataView,
  offset: number,
  count: number,
): ServiceCalendar[] {
  const services: ServiceCalendar[] = [];
  for (let index = 0; index < count; index++) {
    const record = offset + index * SERVICE_BYTES;
    services.push({
      startDay: view.getUint32(record, true),
      endDay: view.getUint32(record + 4, true),
      mask: view.getUint8(record + 8),
    });
  }
  return services;
}

export function decodeExceptions(
  view: DataView,
  offset: number,
  count: number,
): ServiceException[] {
  const exceptions: ServiceException[] = [];
  for (let index = 0; index < count; index++) {
    const record = offset + index * EXCEPTION_BYTES;
    exceptions.push({
      day: view.getUint32(record, true),
      service: view.getUint16(record + 4, true),
      type: view.getUint8(record + 6),
    });
  }
  return exceptions;
}

// A timetable is written in the city's own local time, and the walker reading it may be anywhere:
// the browser's clock says which instant it is, never which hour of which service day that is in
// New York. So every calendar question here is asked of the city's zone through Intl, and the
// browser's own offset is never consulted.
const formatters = new Map<string, Intl.DateTimeFormat>();

function partsOf(date: Date, timeZone: string): Record<string, number> {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  const fields: Record<string, number> = {};
  for (const { type, value } of formatter.formatToParts(date)) {
    if (type !== "literal") {
      fields[type] = Number(value);
    }
  }
  return fields;
}

// Seconds since the city's own midnight, which is what a GTFS time is counted from.
export function secondsOfDay(date: Date, timeZone: string): number {
  const { hour, minute, second } = partsOf(date, timeZone);
  return hour * 3600 + minute * 60 + second;
}

// The city's day `offset` days from `date`, as YYYYMMDD. The arithmetic runs on the civil date in
// UTC, so a day that is 23 or 25 hours long where the city keeps time still steps by exactly one.
export function shiftedDay(
  date: Date,
  offset: number,
  timeZone: string,
): number {
  const { year, month, day } = partsOf(date, timeZone);
  const shifted = new Date(Date.UTC(year, month - 1, day + offset));
  const shiftedMonth = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const shiftedDate = String(shifted.getUTCDate()).padStart(2, "0");
  return Number(`${shifted.getUTCFullYear()}${shiftedMonth}${shiftedDate}`);
}

function dateOfDay(day: number): Date {
  return new Date(
    Date.UTC(
      Math.floor(day / 10000),
      (Math.floor(day / 100) % 100) - 1,
      day % 100,
    ),
  );
}

function dayOfDate(date: Date): number {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getUTCDate()).padStart(2, "0");
  return Number(`${date.getUTCFullYear()}${month}${dayOfMonth}`);
}

// Monday-first weekday bit of a YYYYMMDD day, matching the mask the artifacts write.
function weekdayBit(day: number): number {
  return (dateOfDay(day).getUTCDay() + 6) % 7;
}

// How many same-weekday days the vote past the end of a service's calendars looks back over.
const FALLBACK_SAMPLES = 6;

// Every calendar_dates row, by the service it names: day -> type. Built once per question because
// the vote below asks about one service on six days and a scan per ask would be a scan per sample.
function exceptionsByService(
  exceptions: readonly ServiceException[],
): Map<number, Map<number, number>> {
  const rows = new Map<number, Map<number, number>>();
  for (const exception of exceptions) {
    const own = rows.get(exception.service);
    if (own) {
      own.set(exception.day, exception.type);
    } else {
      rows.set(exception.service, new Map([[exception.day, exception.type]]));
    }
  }
  return rows;
}

// Whether one service runs on one day: its weekday mask inside its date range, then its own
// calendar_dates row for that day, which applies whatever the range says.
function activeOn(
  service: ServiceCalendar,
  rows: ReadonlyMap<number, number> | undefined,
  day: number,
): boolean {
  const exception = rows?.get(day);
  if (exception !== undefined) {
    return exception === EXCEPTION_ADDED;
  } else {
    return (
      service.startDay <= day &&
      day <= service.endDay &&
      (service.mask & (1 << weekdayBit(day))) !== 0
    );
  }
}

// The last day a service's own feed speaks for: its calendar range, extended by any calendar_dates
// row naming it. A service written entirely as exceptions is covered only by those rows, and one
// with neither is covered by nothing.
function coverageEnd(
  service: ServiceCalendar,
  rows: ReadonlyMap<number, number> | undefined,
): number {
  let end = service.endDay === 0 ? Number.NEGATIVE_INFINITY : service.endDay;
  if (rows) {
    for (const day of rows.keys()) {
      end = Math.max(end, day);
    }
  }
  return end;
}

// The days a request past the end of one service's coverage is answered from: the last same-weekday
// days at or before `end`, most recent first, and never before the first day the FEED covers — a
// calendar row written for two special weeks has to be outvoted by the ordinary weeks behind it,
// which only exist inside the feed's own window.
function fallbackDays(end: number, feedStart: number, day: number): number[] {
  if (!Number.isFinite(end)) {
    return []; // a service with neither a range nor a row of its own covers nothing to vote over
  }
  const cursor = dateOfDay(end);
  cursor.setUTCDate(
    cursor.getUTCDate() - ((weekdayBit(end) - weekdayBit(day) + 7) % 7),
  );
  const days: number[] = [];
  while (days.length < FALLBACK_SAMPLES) {
    const candidate = dayOfDate(cursor);
    if (candidate < feedStart) {
      break;
    } else {
      days.push(candidate);
      cursor.setUTCDate(cursor.getUTCDate() - 7);
    }
  }
  return days;
}

// The first day any calendar in the feed covers, which bounds every vote below.
function feedStartDay(services: readonly ServiceCalendar[]): number {
  let first = Number.POSITIVE_INFINITY;
  for (const service of services) {
    // A service written entirely as calendar_dates rows has no range of its own and bounds nothing.
    if (service.endDay !== 0) {
      first = Math.min(first, service.startDay);
    }
  }
  return first;
}

// The services running on one day.
//
// A feed nobody has re-fetched would otherwise strand every rider the day after its calendars run
// out: a service that ended on Friday runs nothing on Saturday and nothing ever again. So past the
// end each service is asked about the same weekday of each of the last six weeks its OWN feed
// covers, and runs if most of them ran it — a holiday, or a calendar row written for one special
// week, is outvoted by the ordinary weeks around it.
//
// Per service rather than per feed, because one artifact holds several agencies: San Francisco's
// carries BART's calendars into 2027 beside Muni's, which ended in August, and a feed-wide test
// would leave Muni resolving normally to nothing at all for the rest of the year.
export function servicesOn(
  services: readonly ServiceCalendar[],
  exceptions: readonly ServiceException[],
  day: number,
): Set<number> {
  const byService = exceptionsByService(exceptions);
  const feedStart = feedStartDay(services);
  const active = new Set<number>();
  services.forEach((service, index) => {
    const rows = byService.get(index);
    const end = coverageEnd(service, rows);
    if (day <= end) {
      if (activeOn(service, rows, day)) {
        active.add(index);
      }
      return;
    }
    const sampled = fallbackDays(end, feedStart, day);
    let ran = 0;
    for (const sample of sampled) {
      if (activeOn(service, rows, sample)) {
        ran += 1;
      }
    }
    // Walked most recent first, so a tie is broken by whether the most recent covered day ran it.
    const majority =
      2 * ran > sampled.length ||
      (2 * ran === sampled.length &&
        sampled.length > 0 &&
        activeOn(service, rows, sampled[0]));
    if (majority) {
      active.add(index);
    }
  });
  return active;
}

// The three service days around a departure instant, each with the seconds to add to a time written
// on that day to read it as seconds from midnight of the routed one. Three rather than one because a
// walk beginning near midnight catches a vehicle on the next service day, and because GTFS writes an
// after-midnight departure as the previous day's 25:10.
export function serviceDays(
  services: readonly ServiceCalendar[],
  exceptions: readonly ServiceException[],
  date: Date,
  timeZone: string,
): { day: number; offset: number; services: Set<number> }[] {
  return [-1, 0, 1].map((offset) => {
    const day = shiftedDay(date, offset, timeZone);
    return {
      day,
      offset: offset * SECONDS_PER_DAY,
      services: servicesOn(services, exceptions, day),
    };
  });
}

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

// Monday-first weekday bit of a YYYYMMDD day, matching the mask the artifacts write.
function weekdayBit(day: number): number {
  const date = new Date(
    Date.UTC(
      Math.floor(day / 10000),
      (Math.floor(day / 100) % 100) - 1,
      day % 100,
    ),
  );
  return (date.getUTCDay() + 6) % 7;
}

// The services running on one day: the calendar's weekday mask inside its date range, then
// calendar_dates' own additions and removals, which apply whatever the range says.
export function servicesOn(
  services: readonly ServiceCalendar[],
  exceptions: readonly ServiceException[],
  day: number,
): Set<number> {
  const bit = weekdayBit(day);
  const active = new Set<number>();
  services.forEach((service, index) => {
    if (
      service.startDay <= day &&
      day <= service.endDay &&
      (service.mask & (1 << bit)) !== 0
    ) {
      active.add(index);
    }
  });
  for (const exception of exceptions) {
    if (exception.day === day) {
      if (exception.type === EXCEPTION_ADDED) {
        active.add(exception.service);
      } else {
        active.delete(exception.service);
      }
    }
  }
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

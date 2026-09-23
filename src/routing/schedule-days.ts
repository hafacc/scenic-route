// Shared by FSCH and TSCH, which read the same two GTFS calendar tables.

import { cityById } from "../cities";

// Unknown ids fall back to the reader's own zone, which only a fixture with no city uses.
export function timeZoneOf(cityId: string): string {
  return (
    cityById(cityId)?.timeZone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone
  );
}

export const SECONDS_PER_DAY = 86_400;
export const EXCEPTION_ADDED = 1;

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

// service (u32 start, u32 end, u8 mask), exception (u32 day, u16 service, u8 type), each padded to 4.
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

// Asked in the city's zone through Intl; the browser's own offset is never consulted.
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

export function secondsOfDay(date: Date, timeZone: string): number {
  const { hour, minute, second } = partsOf(date, timeZone);
  return hour * 3600 + minute * 60 + second;
}

// Civil-date arithmetic in UTC, so a 23- or 25-hour day still steps by exactly one.
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

function weekdayBit(day: number): number {
  return (dateOfDay(day).getUTCDay() + 6) % 7;
}

const FALLBACK_SAMPLES = 6;

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

// A calendar_dates row applies whatever the range says.
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

// A service written entirely as exceptions is covered only by those rows.
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

// Never before the feed's first day, so special-week rows are outvoted by ordinary weeks inside it.
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

function feedStartDay(services: readonly ServiceCalendar[]): number {
  let first = Number.POSITIVE_INFINITY;
  for (const service of services) {
    if (service.endDay !== 0) {
      first = Math.min(first, service.startDay);
    }
  }
  return first;
}

// Past a service's own calendar, a vote over its last six covered same-weekdays; per service, not per feed.
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
    // Walked most recent first, so a tie goes to the most recent covered day.
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

// Three days, since walks start near midnight and GTFS writes after-midnight trips as 25:10.
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

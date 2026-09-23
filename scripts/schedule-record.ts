// `<id>.bin` is the record in effect; `<id>-past.bin` appends every superseded one, never rewritten.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GtfsFeed } from "./gtfs";

const FIRST_DAY_OFFSET = 8;
const LAST_DAY_OFFSET = 12;
export const CURRENT_LAST_DAY = 0; // a record's lastDay while it is the one in effect

// GTFS calendar_dates exception types.
export const EXCEPTION_ADDED = 1;
export const EXCEPTION_REMOVED = 2;

const WEEKDAY_COLUMNS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export interface Service {
  key: string; // `${feedId}:${serviceId}`
  mask: number; // bit 0 Monday .. bit 6 Sunday
  startDay: number; // YYYYMMDD
  endDay: number;
}

export interface Exception {
  serviceKey: string;
  day: number; // YYYYMMDD
  type: number;
}

// Read by src/routing/schedule-days.ts; each record padded to a multiple of four bytes.
export const SERVICE_BYTES = 12;
export const EXCEPTION_BYTES = 8;

export function encodeServices(services: readonly Service[]): Uint8Array {
  const table = new Uint8Array(services.length * SERVICE_BYTES);
  const view = new DataView(table.buffer);
  services.forEach((service, index) => {
    const record = index * SERVICE_BYTES;
    view.setUint32(record, service.startDay, true);
    view.setUint32(record + 4, service.endDay, true);
    view.setUint8(record + 8, service.mask);
  });
  return table;
}

// An exception whose service is not in `serviceIndex` is written against service 0.
export function encodeExceptions(
  exceptions: readonly Exception[],
  serviceIndex: ReadonlyMap<string, number>,
): Uint8Array {
  const table = new Uint8Array(exceptions.length * EXCEPTION_BYTES);
  const view = new DataView(table.buffer);
  exceptions.forEach((exception, index) => {
    const record = index * EXCEPTION_BYTES;
    view.setUint32(record, exception.day, true);
    view.setUint16(
      record + 4,
      serviceIndex.get(exception.serviceKey) ?? 0,
      true,
    );
    view.setUint8(record + 6, exception.type);
  });
  return table;
}

export function dayNumber(day: string): number {
  return Number(day.replaceAll("-", ""));
}

export function dayString(day: number): string {
  const text = String(day);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

// Local, not UTC: a run after 8pm ET would otherwise open the timetable on tomorrow's date.
export function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function previousDay(day: number): number {
  const date = new Date(
    Date.UTC(
      Math.floor(day / 10000),
      (Math.floor(day / 100) % 100) - 1,
      day % 100,
    ),
  );
  date.setUTCDate(date.getUTCDate() - 1);
  return dayNumber(date.toISOString().slice(0, 10));
}

// A service only in calendar_dates gets a zero mask, so only its exception days turn it on.
export function collectServices(
  feeds: readonly { feedId: string; feed: GtfsFeed }[],
  usedServices: ReadonlySet<string>,
): { services: Service[]; exceptions: Exception[] } {
  const services = new Map<string, Service>();
  const exceptions: Exception[] = [];

  for (const { feedId, feed } of feeds) {
    for (const row of feed.calendar) {
      const key = `${feedId}:${row.service_id}`;
      if (!usedServices.has(key)) {
        continue;
      }
      let mask = 0;
      WEEKDAY_COLUMNS.forEach((column, bit) => {
        if (row[column] === "1") {
          mask |= 1 << bit;
        }
      });
      services.set(key, {
        key,
        mask,
        startDay: Number(row.start_date),
        endDay: Number(row.end_date),
      });
    }
    for (const row of feed.calendarDates) {
      const key = `${feedId}:${row.service_id}`;
      const day = Number(row.date);
      const type = Number(row.exception_type);
      if (
        !usedServices.has(key) ||
        !Number.isFinite(day) ||
        (type !== EXCEPTION_ADDED && type !== EXCEPTION_REMOVED)
      ) {
        continue;
      }
      exceptions.push({ serviceKey: key, day, type });
      if (!services.has(key)) {
        services.set(key, { key, mask: 0, startDay: 0, endDay: 0 });
      }
    }
  }

  exceptions.sort(
    (left, right) =>
      left.day - right.day ||
      (left.serviceKey < right.serviceKey ? -1 : 1) ||
      left.type - right.type,
  );
  return {
    services: [...services.values()].sort((left, right) =>
      left.key < right.key ? -1 : 1,
    ),
    exceptions,
  };
}

// Skips the header, whose day range changes without the feeds changing.
function sameBody(
  left: Uint8Array,
  right: Uint8Array,
  headerBytes: number,
): boolean {
  const leftBody = left.subarray(headerBytes);
  const rightBody = right.subarray(headerBytes);
  return (
    leftBody.length === rightBody.length &&
    leftBody.every((byte, index) => byte === rightBody[index])
  );
}

async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

function firstDayOf(record: Uint8Array): number {
  return new DataView(
    record.buffer,
    record.byteOffset,
    record.byteLength,
  ).getUint32(FIRST_DAY_OFFSET, true);
}

export interface PublishedRecord {
  changed: boolean;
  firstDay: number;
  record: Uint8Array;
}

// Both formats keep the day range at header bytes 8 and 12; the superseded record closes yesterday.
export async function publishRecord(options: {
  directory: string;
  cityId: string;
  candidate: Uint8Array;
  headerBytes: number;
  today: number;
  label: string;
}): Promise<PublishedRecord> {
  const { directory, cityId, candidate, headerBytes, today, label } = options;
  const currentPath = join(directory, `${cityId}.bin`);
  const pastPath = join(directory, `${cityId}-past.bin`);
  const standing = await readIfPresent(currentPath);

  let record = candidate;
  let changed = true;
  if (standing && sameBody(standing, candidate, headerBytes)) {
    // Rewriting it with today's date would make every run a commit.
    record = standing;
    changed = false;
  } else if (standing) {
    const standingFirst = firstDayOf(standing);
    const closesOn = previousDay(today);
    if (standingFirst > closesOn) {
      // It took effect today, so closing it would append a backwards range no day can match.
      console.error(
        `${label}: replacing today's timetable in place (took effect ${dayString(standingFirst)})`,
      );
    } else {
      const closed = new Uint8Array(standing);
      new DataView(closed.buffer).setUint32(LAST_DAY_OFFSET, closesOn, true);
      const past = (await readIfPresent(pastPath)) ?? new Uint8Array(0);
      const appended = new Uint8Array(past.length + closed.length);
      appended.set(past, 0);
      appended.set(closed, past.length);
      await writeFile(pastPath, appended);
      console.error(
        `${label}: retired the timetable of ${dayString(standingFirst)}..${dayString(closesOn)}`,
      );
    }
  }

  await writeFile(currentPath, record);
  return { changed, firstDay: firstDayOf(record), record };
}

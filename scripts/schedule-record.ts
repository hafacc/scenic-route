// What the two daily timetables share: the GTFS calendars behind the services they publish, and the
// two-file publishing that keeps a record of which timetable was in effect on which day.
//
// The ferry timetable (scripts/ferry-schedule.ts, magic FSCH) and the transit one
// (scripts/transit-schedule.ts, magic TSCH) are different artifacts holding different things, but
// both are rebuilt daily from a published feed, both are committed, and both have to answer "what
// ran on the 3rd of last month". That answer is this file: `<id>.bin` is the record in effect now
// and `<id>-past.bin` is every superseded one, appended whole and never rewritten.
//
// Both formats put the day range at bytes 8 and 12 of their header and everything the feed decides
// after it, which is what lets one publisher serve both: a record's body is a pure function of the
// feeds, so a day that finds them unchanged rewrites identical bytes and the daily job's "nothing to
// commit" path fires.

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

// A GTFS service as the client re-derives it: the weekday mask and date range from calendar.txt, and
// the individual days calendar_dates.txt adds or removes.
export interface Service {
  key: string; // `${feedId}:${serviceId}`, so two feeds' service ids cannot collide
  mask: number; // bit 0 Monday .. bit 6 Sunday
  startDay: number; // YYYYMMDD
  endDay: number;
}

export interface Exception {
  serviceKey: string;
  day: number; // YYYYMMDD
  type: number;
}

// The two calendar tables both artifacts open with, in the layout the client reads them in
// (src/routing/schedule-days.ts): a service is (u32 start day, u32 end day, u8 weekday mask) and an
// exception (u32 day, u16 service index, u8 type), each padded out to a multiple of four.
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

// `serviceIndex` places each service key in the table above; an exception naming a service that is
// not in it is written against the first, as it always has been.
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

// A "YYYY-MM-DD" day as the YYYYMMDD integer a record stores. Ordered as an integer exactly as it is
// as a date, so a range check is a pair of comparisons.
export function dayNumber(day: string): number {
  return Number(day.replaceAll("-", ""));
}

export function dayString(day: number): string {
  const text = String(day);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

// The LOCAL day, not `toISOString()`'s UTC one: a run after 8pm ET would otherwise open the new
// timetable on tomorrow's date and leave today with no record covering it.
export function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// The day before `day`, so a superseded record's range can be closed the day the new one opens.
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

// The calendars behind the services a timetable actually uses. A service named only by
// calendar_dates (no calendar.txt row) still needs a row to be indexable, and gets a zero mask —
// which never matches a weekday, so only its exception days ever turn it on. That is what an
// exceptions-only service is.
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

// Everything past the header — the part that depends only on the feeds. Comparing this is what tells
// a schedule change from a run on another day: the header carries the day range, which moves on its
// own whenever a change is recorded.
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

// Publishes `candidate` — encoded with a first day of `today` and no last day — as the city's
// standing record, and only if it differs from the one already there. The superseded record is
// closed the day before, so the two ranges meet without overlapping and no day is left without a
// timetable.
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
    // Unchanged: keep the standing record exactly as it is, first day and all. Rewriting it with
    // today's date would make every run a commit.
    record = standing;
    changed = false;
  } else if (standing) {
    const standingFirst = firstDayOf(standing);
    const closesOn = previousDay(today);
    if (standingFirst > closesOn) {
      // The standing record took effect today and is already being replaced — the feed moved twice
      // in one day, or a run is being redone. It covered no completed day, so there is nothing to
      // keep: closing it would append a record whose range runs backwards and which no day can ever
      // match.
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

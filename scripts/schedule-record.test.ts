import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeExceptions,
  decodeServices,
  SERVICE_BYTES,
} from "../src/routing/schedule-days";
import type { GtfsFeed } from "./gtfs";
import {
  collectServices,
  dayNumber,
  dayString,
  EXCEPTION_ADDED,
  EXCEPTION_REMOVED,
  encodeExceptions,
  encodeServices,
  localDay,
  previousDay,
  publishRecord,
} from "./schedule-record";

const HEADER_BYTES = 16;

// The publisher reads only the day range at bytes 8 and 12.
function record(firstDay: number, body: string): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES + body.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, firstDay, true);
  bytes.set(new TextEncoder().encode(body), HEADER_BYTES);
  return bytes;
}

function rangeOf(bytes: Uint8Array, offset = 0): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(offset + 8, true), view.getUint32(offset + 12, true)];
}

async function publish(
  directory: string,
  day: number,
  body: string,
): Promise<{ changed: boolean; firstDay: number }> {
  const { changed, firstDay } = await publishRecord({
    directory,
    cityId: "city",
    candidate: record(day, body),
    headerBytes: HEADER_BYTES,
    today: day,
    label: "test",
  });
  return { changed, firstDay };
}

async function read(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

test("the calendar tables read back as what was written", () => {
  const services = [
    {
      key: "mta:weekday",
      mask: 0b0011111,
      startDay: 20_260_101,
      endDay: 20_261_231,
    },
    {
      key: "mta:sunday",
      mask: 0b1000000,
      startDay: 20_260_105,
      endDay: 20_260_704,
    },
  ];
  const exceptions = [
    { serviceKey: "mta:sunday", day: 20_260_704, type: EXCEPTION_ADDED },
    { serviceKey: "mta:weekday", day: 20_261_225, type: EXCEPTION_REMOVED },
  ];
  const index = new Map(services.map((service, at) => [service.key, at]));
  const table = encodeServices(services);
  const exceptionTable = encodeExceptions(exceptions, index);
  expect(table.length).toBe(services.length * SERVICE_BYTES);

  const view = (bytes: Uint8Array): DataView =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(decodeServices(view(table), 0, services.length)).toEqual(
    services.map(({ mask, startDay, endDay }) => ({ mask, startDay, endDay })),
  );
  expect(decodeExceptions(view(exceptionTable), 0, exceptions.length)).toEqual([
    { day: 20_260_704, service: 1, type: EXCEPTION_ADDED },
    { day: 20_261_225, service: 0, type: EXCEPTION_REMOVED },
  ]);
});

test("a day is a number that orders like a date", () => {
  expect(dayNumber("2026-09-04")).toBe(20260904);
  expect(dayString(20260904)).toBe("2026-09-04");
  expect(previousDay(20260901)).toBe(20260831);
  expect(previousDay(20260101)).toBe(20251231);
  expect(localDay(new Date(2026, 8, 4, 23, 30))).toBe("2026-09-04");
});

test("an unchanged feed keeps the standing record, day and all", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schedule-"));
  expect(await publish(directory, 20260901, "one")).toEqual({
    changed: true,
    firstDay: 20260901,
  });
  // The record must not move, or every day would be a commit.
  expect(await publish(directory, 20260908, "one")).toEqual({
    changed: false,
    firstDay: 20260901,
  });
  expect(await read(join(directory, "city-past.bin"))).toBeNull();
});

test("a changed feed retires the standing record the day before", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schedule-"));
  await publish(directory, 20260901, "one");
  expect(await publish(directory, 20260908, "two")).toEqual({
    changed: true,
    firstDay: 20260908,
  });

  const current = await read(join(directory, "city.bin"));
  const past = await read(join(directory, "city-past.bin"));
  expect(rangeOf(current ?? new Uint8Array())).toEqual([20260908, 0]);
  expect(rangeOf(past ?? new Uint8Array())).toEqual([20260901, 20260907]);
});

test("a second change on the same day replaces it in place", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schedule-"));
  await publish(directory, 20260901, "one");
  await publish(directory, 20260901, "two");
  // Closing a record that covered no completed day would append a range no day can match.
  expect(await read(join(directory, "city-past.bin"))).toBeNull();
  expect(
    rangeOf((await read(join(directory, "city.bin"))) ?? new Uint8Array()),
  ).toEqual([20260901, 0]);
});

function calendarFeed(): GtfsFeed {
  return {
    routes: [],
    trips: [],
    stops: [],
    stopTimes: [],
    calendar: [
      {
        service_id: "weekday",
        monday: "1",
        tuesday: "1",
        wednesday: "1",
        thursday: "1",
        friday: "1",
        saturday: "0",
        sunday: "0",
        start_date: "20260101",
        end_date: "20261231",
      },
      {
        service_id: "unused",
        monday: "1",
        tuesday: "0",
        wednesday: "0",
        thursday: "0",
        friday: "0",
        saturday: "0",
        sunday: "0",
        start_date: "20260101",
        end_date: "20261231",
      },
    ],
    calendarDates: [
      { service_id: "holiday", date: "20260904", exception_type: "1" },
      { service_id: "weekday", date: "20260904", exception_type: "2" },
      { service_id: "unused", date: "20260904", exception_type: "1" },
    ],
    shapes: [],
    frequencies: [],
    transfers: [],
  };
}

test("only the services a timetable uses are published", () => {
  const { services, exceptions } = collectServices(
    [{ feedId: "f", feed: calendarFeed() }],
    new Set(["f:weekday", "f:holiday"]),
  );
  expect(services.map((service) => service.key)).toEqual([
    "f:holiday",
    "f:weekday",
  ]);
  // A service named only by calendar_dates runs only on its exception days.
  expect(services[0]).toEqual({
    key: "f:holiday",
    mask: 0,
    startDay: 0,
    endDay: 0,
  });
  expect(services[1].mask).toBe(0b0011111);
  expect(exceptions).toEqual([
    { serviceKey: "f:holiday", day: 20260904, type: 1 },
    { serviceKey: "f:weekday", day: 20260904, type: 2 },
  ]);
});

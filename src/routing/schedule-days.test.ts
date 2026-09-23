import { expect, test } from "bun:test";
import {
  EXCEPTION_ADDED,
  type ServiceCalendar,
  type ServiceException,
  servicesOn,
} from "./schedule-days";

const EXCEPTION_REMOVED = 2;
const WEEKDAYS = 0b001_1111; // Monday .. Friday
const FRIDAY = 0b001_0000;
const WEEKEND = 0b110_0000;

// Calendars running to Friday 2026-08-28, the shape of the cached Muni feed.
const SERVICES: readonly ServiceCalendar[] = [
  { mask: WEEKDAYS, startDay: 20_260_601, endDay: 20_260_828 },
  { mask: WEEKEND, startDay: 20_260_601, endDay: 20_260_828 },
];

const NO_EXCEPTIONS: readonly ServiceException[] = [];

test("a day inside the range reads its own calendars and its own exceptions", () => {
  expect(servicesOn(SERVICES, NO_EXCEPTIONS, 20_260_821)).toEqual(new Set([0]));
  expect(servicesOn(SERVICES, NO_EXCEPTIONS, 20_260_822)).toEqual(new Set([1]));
  const holiday: readonly ServiceException[] = [
    { day: 20_260_821, service: 0, type: EXCEPTION_REMOVED },
    { day: 20_260_821, service: 1, type: EXCEPTION_ADDED },
  ];
  expect(servicesOn(SERVICES, holiday, 20_260_821)).toEqual(new Set([1]));
});

test("a day past every calendar runs the same weekday's ordinary service", () => {
  expect(servicesOn(SERVICES, NO_EXCEPTIONS, 20_260_904)).toEqual(new Set([0]));
  expect(servicesOn(SERVICES, NO_EXCEPTIONS, 20_260_905)).toEqual(new Set([1]));
  expect(servicesOn(SERVICES, NO_EXCEPTIONS, 20_261_225)).toEqual(new Set([0]));
});

test("a day before every calendar starts still runs nothing", () => {
  expect(servicesOn(SERVICES, NO_EXCEPTIONS, 20_260_501)).toEqual(
    new Set<number>(),
  );
});

test("a holiday on the last covered same weekday is outvoted", () => {
  // Friday the 28th ran a Sunday timetable; the five ordinary Fridays behind it outvote it.
  const holiday: readonly ServiceException[] = [
    { day: 20_260_828, service: 0, type: EXCEPTION_REMOVED },
    { day: 20_260_828, service: 1, type: EXCEPTION_ADDED },
  ];
  expect(servicesOn(SERVICES, holiday, 20_260_828)).toEqual(new Set([1]));
  expect(servicesOn(SERVICES, holiday, 20_260_904)).toEqual(new Set([0]));
});

test("a calendar row written for two special weeks is outvoted", () => {
  const services: readonly ServiceCalendar[] = [
    { mask: WEEKDAYS, startDay: 20_260_601, endDay: 20_260_828 },
    { mask: FRIDAY, startDay: 20_260_821, endDay: 20_260_828 }, // a two-week extra
  ];
  expect(servicesOn(services, NO_EXCEPTIONS, 20_260_828)).toEqual(
    new Set([0, 1]),
  );
  expect(servicesOn(services, NO_EXCEPTIONS, 20_260_904)).toEqual(new Set([0]));
});

test("a service written only as calendar_dates rows rides the vote", () => {
  // SFMTA cancels the weekday row every weekday and adds an unscheduled id, so masks alone board nothing.
  const services: readonly ServiceCalendar[] = [
    { mask: WEEKDAYS, startDay: 20_260_601, endDay: 20_260_828 },
    { mask: 0, startDay: 0, endDay: 0 },
  ];
  const fridays = [
    20_260_724, 20_260_731, 20_260_807, 20_260_814, 20_260_821, 20_260_828,
  ];
  const exceptions: readonly ServiceException[] = fridays.flatMap((day) => [
    { day, service: 0, type: EXCEPTION_REMOVED },
    { day, service: 1, type: EXCEPTION_ADDED },
  ]);
  expect(servicesOn(services, exceptions, 20_260_904)).toEqual(new Set([1]));
});

test("a range shorter than the vote's window still answers", () => {
  const services: readonly ServiceCalendar[] = [
    { mask: WEEKDAYS, startDay: 20_260_817, endDay: 20_260_828 }, // two weeks
  ];
  expect(servicesOn(services, NO_EXCEPTIONS, 20_260_904)).toEqual(new Set([0]));
  const holiday: readonly ServiceException[] = [
    { day: 20_260_828, service: 0, type: EXCEPTION_REMOVED },
  ];
  // Two Fridays, one of them a holiday: the tie goes to the more recent day.
  expect(servicesOn(services, holiday, 20_260_904)).toEqual(new Set<number>());
});

test("calendars ending on different days vote over the latest of them", () => {
  const staggered: readonly ServiceCalendar[] = [
    { mask: WEEKDAYS, startDay: 20_260_601, endDay: 20_260_814 },
    { mask: WEEKDAYS, startDay: 20_260_601, endDay: 20_260_828 },
  ];
  // The retired calendar covers four of the last six Fridays, so a Friday there is both calendars.
  expect(servicesOn(staggered, NO_EXCEPTIONS, 20_260_904)).toEqual(
    new Set([0, 1]),
  );
});

test("a stale service falls back while a live one beside it resolves normally", () => {
  // A feed-wide test would leave the bus running nothing, since rail still covers the day.
  const mixed: readonly ServiceCalendar[] = [
    { mask: WEEKDAYS, startDay: 20_260_601, endDay: 20_270_108 }, // rail
    { mask: WEEKDAYS, startDay: 20_260_601, endDay: 20_260_828 }, // bus
    { mask: WEEKEND, startDay: 20_260_601, endDay: 20_270_109 }, // rail, weekends
  ];
  expect(servicesOn(mixed, NO_EXCEPTIONS, 20_260_904)).toEqual(new Set([0, 1]));
  expect(servicesOn(mixed, NO_EXCEPTIONS, 20_260_905)).toEqual(new Set([2]));
  const holidays: readonly ServiceException[] = [
    { day: 20_260_828, service: 1, type: EXCEPTION_REMOVED },
    { day: 20_260_904, service: 0, type: EXCEPTION_REMOVED },
  ];
  expect(servicesOn(mixed, holidays, 20_260_904)).toEqual(new Set([1]));
});

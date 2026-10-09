import { expect, test } from "bun:test";
import { dayInRange, readDayPick } from "./store";

// What a date field hands over while "01/15/2026" is typed into it, a keystroke at a time.

const EARLIEST = "2017-12-28";
const LATEST = "2027-10-08";

test("a day inside the range is a pick", () => {
  expect(dayInRange("2026-01-15", EARLIEST, LATEST)).toBe("2026-01-15");
  expect(dayInRange(EARLIEST, EARLIEST, LATEST)).toBe(EARLIEST);
  expect(dayInRange(LATEST, EARLIEST, LATEST)).toBe(LATEST);
});

test("a field emptied mid-entry picks nothing", () => {
  expect(dayInRange("", EARLIEST, LATEST)).toBeNull();
});

test("the years a typed 2026 passes through pick nothing until it is whole", () => {
  for (const partial of ["0002-01-15", "0020-01-15", "0202-01-15"]) {
    expect(dayInRange(partial, EARLIEST, LATEST)).toBeNull();
  }
  expect(dayInRange("2026-01-15", EARLIEST, LATEST)).toBe("2026-01-15");
});

test("a day past either end picks nothing", () => {
  expect(dayInRange("2017-12-27", EARLIEST, LATEST)).toBeNull();
  expect(dayInRange("2027-10-09", EARLIEST, LATEST)).toBeNull();
});

test("anything but a real YYYY-MM-DD day picks nothing, however it orders as text", () => {
  for (const malformed of [
    "20260-01-15",
    "2026-1-15",
    "2026-01-5",
    "2026-01-15T00:00",
    " 2026-01-15",
    "2026/01/15",
    "2026-13-01",
    "2026-02-30",
    "2026-00-10",
    "2026-01-00",
    "today",
  ]) {
    expect(dayInRange(malformed, EARLIEST, LATEST), malformed).toBeNull();
  }
  expect(dayInRange("2024-02-29", EARLIEST, LATEST)).toBe("2024-02-29");
});

// The four things a date field can be telling the clock, and what each asks of it.

test("a field emptied with no key down asks for today, and one emptied by typing asks to be left alone", () => {
  // Both read as an empty value; the picker's Clear arrives with no key held in the field.
  expect(readDayPick("", false, EARLIEST, LATEST)).toEqual({ kind: "today" });
  expect(readDayPick("", true, EARLIEST, LATEST)).toEqual({ kind: "wait" });
});

test("a field left fully empty asks for today, and one left part-typed asks to be put back", () => {
  // Both read as an empty value on blur; only the part-typed one reports `badInput`.
  const left = (badInput: boolean) =>
    readDayPick("", badInput, EARLIEST, LATEST);
  expect(left(false)).toEqual({ kind: "today" });
  expect(left(true)).toEqual({ kind: "wait" });
});

test("a whole day in range is a pick, typed, picked or left in the field", () => {
  for (const partial of [false, true]) {
    expect(readDayPick("2026-01-15", partial, EARLIEST, LATEST)).toEqual({
      kind: "day",
      day: "2026-01-15",
    });
  }
});

test("a day out of range or out of shape is waited out and put back on blur, never pinned and never read as a clear", () => {
  for (const value of [
    "0002-01-15",
    "2027-10-09",
    "2026-02-30",
    "20260-01-15",
  ]) {
    for (const partial of [false, true]) {
      expect(readDayPick(value, partial, EARLIEST, LATEST), value).toEqual({
        kind: "wait",
      });
    }
  }
});

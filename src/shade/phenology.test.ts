import { expect, test } from "bun:test";
import { cityById } from "../cities";
import { canopyTau, rainTau } from "./phenology";

const IN_LEAF = 0.814;
const LEAF_OFF = 0.4;

test("holds the sourced endpoints through winter and summer", () => {
  for (const [month, day] of [
    [1, 15],
    [3, 31],
    [12, 20],
  ]) {
    expect(canopyTau(new Date(2026, month - 1, day), DECIDUOUS)).toBeCloseTo(
      LEAF_OFF,
      6,
    );
  }
  for (const [month, day] of [
    [5, 15],
    [7, 4],
    [9, 30],
  ]) {
    expect(canopyTau(new Date(2026, month - 1, day), DECIDUOUS)).toBeCloseTo(
      IN_LEAF,
      6,
    );
  }
});

test("is half leafed out in the last week of April", () => {
  const middle = (IN_LEAF + LEAF_OFF) / 2;
  expect(canopyTau(new Date(2026, 3, 24), DECIDUOUS)).toBeCloseTo(middle, 2);
});

test("rises through the spring and falls through the autumn, never backwards", () => {
  const days = (from: Date, to: Date): Date[] => {
    const dates: Date[] = [];
    for (let at = from; at <= to; at = new Date(at.getTime() + 86_400_000)) {
      dates.push(at);
    }
    return dates;
  };
  for (const window of [
    { dates: days(new Date(2026, 3, 1), new Date(2026, 4, 10)), rising: true },
    {
      dates: days(new Date(2026, 9, 1), new Date(2026, 11, 10)),
      rising: false,
    },
  ]) {
    const taus = window.dates.map((date) => canopyTau(date, DECIDUOUS));
    for (const [index, tau] of taus.slice(1).entries()) {
      expect(window.rising ? tau >= taus[index] : tau <= taus[index]).toBe(
        true,
      );
    }
  }
});

const RAIN_IN_LEAF = 0.35;
const RAIN_LEAF_OFF = 0.15;

const DECIDUOUS = { evergreen: false };
const EVERGREEN = { evergreen: true };

test("rain tau holds its own endpoints on the same seasonal curve", () => {
  expect(rainTau(new Date(2026, 6, 4), DECIDUOUS)).toBeCloseTo(RAIN_IN_LEAF, 6);
  expect(rainTau(new Date(2026, 0, 15), DECIDUOUS)).toBeCloseTo(
    RAIN_LEAF_OFF,
    6,
  );
  const middle = (RAIN_IN_LEAF + RAIN_LEAF_OFF) / 2;
  expect(rainTau(new Date(2026, 3, 24), DECIDUOUS)).toBeCloseTo(middle, 2);
  for (const date of [new Date(2026, 6, 4), new Date(2026, 0, 15)]) {
    expect(rainTau(date, DECIDUOUS)).toBeLessThan(
      canopyTau(date, DECIDUOUS) / 2,
    );
  }
});

test("an evergreen city keeps the in-leaf rain tau all year", () => {
  for (const month of [0, 3, 6, 10]) {
    expect(rainTau(new Date(2026, month, 15), EVERGREEN)).toBe(RAIN_IN_LEAF);
  }
});

test("the cities say which of them is evergreen", () => {
  expect(cityById("nyc")?.evergreen).toBe(false);
  expect(cityById("sf")?.evergreen).toBe(true);
});

// The ramps' own first and last days, and their middles, for a city that has a winter and one that has none.
test("rain tau turns at the ramps' ends in a deciduous city and nowhere in an evergreen one", () => {
  const at = (month: number, day: number, city: { evergreen: boolean }) =>
    rainTau(new Date(2026, month - 1, day), city);
  // Leaf-out runs 12 April to 6 May; fall, 5 October to 5 December.
  expect(at(4, 12, DECIDUOUS)).toBe(RAIN_LEAF_OFF);
  expect(at(4, 13, DECIDUOUS)).toBeGreaterThan(RAIN_LEAF_OFF);
  expect(at(5, 5, DECIDUOUS)).toBeLessThan(RAIN_IN_LEAF);
  expect(at(5, 6, DECIDUOUS)).toBeCloseTo(RAIN_IN_LEAF, 12);
  expect(at(10, 5, DECIDUOUS)).toBeCloseTo(RAIN_IN_LEAF, 12);
  expect(at(10, 6, DECIDUOUS)).toBeLessThan(RAIN_IN_LEAF);
  expect(at(12, 4, DECIDUOUS)).toBeGreaterThan(RAIN_LEAF_OFF);
  expect(at(12, 5, DECIDUOUS)).toBeCloseTo(RAIN_LEAF_OFF, 12);
  // Halfway through each ramp the smoothstep is halfway between the two.
  const middle = (RAIN_IN_LEAF + RAIN_LEAF_OFF) / 2;
  expect(at(4, 24, DECIDUOUS)).toBeCloseTo(middle, 12);
  expect(at(11, 4, DECIDUOUS)).toBeCloseTo(middle, 2);
  for (const [month, day] of [
    [4, 12],
    [4, 24],
    [5, 6],
    [10, 6],
    [11, 4],
    [12, 5],
  ]) {
    expect(at(month, day, EVERGREEN)).toBe(RAIN_IN_LEAF);
  }
});

test("an evergreen city's crowns block the in-leaf share of the light all year, and a deciduous one's do not", () => {
  for (let month = 0; month < 12; month++) {
    const date = new Date(2026, month, 15);
    expect(canopyTau(date, EVERGREEN)).toBe(IN_LEAF);
    expect(canopyTau(date, DECIDUOUS)).toBeLessThanOrEqual(IN_LEAF + 1e-12);
  }
  expect(canopyTau(new Date(2026, 0, 15), DECIDUOUS)).toBeCloseTo(LEAF_OFF, 12);
  // The cities themselves: New York has a winter and the Bay Area has none.
  const january = new Date(2026, 0, 15);
  const nyc = cityById("nyc");
  const bay = cityById("sf");
  if (!nyc || !bay) {
    throw new Error("a city is missing");
  }
  expect(canopyTau(january, nyc)).toBeCloseTo(LEAF_OFF, 12);
  expect(canopyTau(january, bay)).toBe(IN_LEAF);
});

test("the year turns over without a seam: New Year's Eve and New Year's Day are the same bare winter", () => {
  for (const tau of [canopyTau, rainTau]) {
    const eve = tau(new Date(2026, 11, 31, 23, 59), DECIDUOUS);
    const day = tau(new Date(2027, 0, 1, 0, 1), DECIDUOUS);
    expect(day).toBe(eve);
    expect(tau(new Date(2026, 11, 31), EVERGREEN)).toBe(
      tau(new Date(2027, 0, 1), EVERGREEN),
    );
  }
  expect(canopyTau(new Date(2026, 11, 31), DECIDUOUS)).toBeCloseTo(
    LEAF_OFF,
    12,
  );
  // A leap day sits inside winter like any other.
  expect(rainTau(new Date(2028, 1, 29), DECIDUOUS)).toBeCloseTo(
    RAIN_LEAF_OFF,
    12,
  );
});

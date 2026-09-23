// A route costed against a timetable or the sun must be re-costed every tick or it goes stale.

import { expect, test } from "bun:test";
import { followsRouteTime, type RouteTimeInputs } from "./contexts";

const STILL: RouteTimeInputs = {
  shade: 0,
  shelter: 0,
  allowSheds: true,
  allowFerries: false,
  allowTransit: false,
};

test("a plain walk with nothing to catch does not follow the clock", () => {
  expect(followsRouteTime(STILL)).toBe(false);
});

test("a train to catch is a clock to follow, boats or no boats", () => {
  expect(followsRouteTime({ ...STILL, allowTransit: true })).toBe(true);
  expect(followsRouteTime({ ...STILL, allowFerries: true })).toBe(true);
});

test("so is the sun, the rain and the scaffolding", () => {
  expect(followsRouteTime({ ...STILL, shade: -0.5 })).toBe(true);
  expect(followsRouteTime({ ...STILL, shelter: 0.5 })).toBe(true);
  expect(followsRouteTime({ ...STILL, allowSheds: false })).toBe(true);
});

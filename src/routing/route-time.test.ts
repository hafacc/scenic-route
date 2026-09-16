// Which walks follow the clock. A route costed against a timetable or against the sun goes stale on
// its own: the page has to re-cost it on every tick, or it goes on quoting a departure that has gone.

import { expect, test } from "bun:test";
import { followsRouteTime, type RouteTimeInputs } from "./contexts";

// Nothing time-dependent at all: no sun preference, no shelter preference, scaffolding allowed where
// it stands, and neither boats nor trains to catch.
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

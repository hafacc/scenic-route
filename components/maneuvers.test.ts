import { expect, test } from "bun:test";
import {
  MdAccessTime,
  MdElevator,
  MdLogout,
  MdStairs,
} from "../src/icons/glyphs";
import type { Maneuver } from "../src/routing/directions";
import type { NavProgress } from "../src/routing/nav-progress";
import { maneuverIcon, maneuverState } from "./maneuvers";

function stationManeuver(overrides: Partial<Maneuver>): Maneuver {
  return {
    kind: "station",
    text: "Enter Bridge St",
    name: "Bridge St",
    side: null,
    turn: null,
    lengthMeters: 20,
    startMeters: 0,
    station: "enter",
    stepRange: [0, 1],
    at: { lat: 40.7, lng: -74 },
    ...overrides,
  };
}

test("a lift wears the lift icon and every other door the stair", () => {
  expect(maneuverIcon(stationManeuver({ door: "elevator" }))).toBe(MdElevator);
  expect(maneuverIcon(stationManeuver({ door: "stair" }))).toBe(MdStairs);
  // A curbside stop carries no door at all, and still reads as a way in.
  expect(maneuverIcon(stationManeuver({}))).toBe(MdStairs);
  expect(
    maneuverIcon(stationManeuver({ station: "alight", door: undefined })),
  ).toBe(MdLogout);
});

test("a wait wears the clock", () => {
  expect(
    maneuverIcon(
      stationManeuver({ kind: "wait", station: undefined, lengthMeters: 0 }),
    ),
  ).toBe(MdAccessTime);
});

function progressAt(
  currentManeuver: number,
  nextManeuver: number,
): NavProgress {
  return {
    alongMeters: 100,
    remainingMeters: 400,
    offRouteMeters: 3,
    currentManeuver,
    nextManeuver,
    distanceToNextMeters: 25,
  };
}

test("the dimmed run reaches the highlighted row with no bright gap", () => {
  const progress = progressAt(2, 3);
  const states = [0, 1, 2, 3, 4, 5].map((index) =>
    maneuverState(progress, index),
  );
  expect(states).toEqual([
    "passed",
    "passed",
    "passed",
    "next",
    "ahead",
    "ahead",
  ]);
  // The row whose span the walker is inside: its turn is behind them, so it dims with the rest.
  expect(maneuverState(progress, 2)).toBe("passed");
});

// Rows: a walk, the wait, the ride it waits for, the walk off, arrive.
test("a wait row is neither next nor dimmed on the way to its ride, and dims with it", () => {
  // Walking up: navProgress steps past the wait, so the ride is next.
  const approaching = progressAt(0, 2);
  expect(
    [0, 1, 2, 3, 4].map((index) => maneuverState(approaching, index)),
  ).toEqual(["passed", "ahead", "next", "ahead", "ahead"]);
  // On the pier or platform the ride is current, and the wait dims only now, with it.
  const boarding = progressAt(2, 3);
  expect(
    [0, 1, 2, 3, 4].map((index) => maneuverState(boarding, index)),
  ).toEqual(["passed", "passed", "passed", "next", "ahead"]);
});

test("the arrive row is highlighted and not also dimmed", () => {
  // At the end of the route nextManeuver is clamped onto currentManeuver.
  const progress = progressAt(5, 5);
  expect(maneuverState(progress, 5)).toBe("next");
  expect(
    [0, 1, 2, 3, 4].map((index) => maneuverState(progress, index)),
  ).toEqual(["passed", "passed", "passed", "passed", "passed"]);
});

test("without a live position every maneuver is still ahead", () => {
  expect([0, 1, 2, 3, 4, 5].map((index) => maneuverState(null, index))).toEqual(
    ["ahead", "ahead", "ahead", "ahead", "ahead", "ahead"],
  );
});

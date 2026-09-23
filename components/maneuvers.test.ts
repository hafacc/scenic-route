
import { expect, test } from "bun:test";
import { MdElevator, MdLogout, MdStairs } from "react-icons/md";
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
  expect(maneuverIcon(stationManeuver({ door: "elevator" })).type).toBe(
    MdElevator,
  );
  expect(maneuverIcon(stationManeuver({ door: "stair" })).type).toBe(MdStairs);
  // A curbside stop carries no door at all, and still reads as a way in.
  expect(maneuverIcon(stationManeuver({})).type).toBe(MdStairs);
  expect(
    maneuverIcon(stationManeuver({ station: "alight", door: undefined })).type,
  ).toBe(MdLogout);
});

function progressAt(currentManeuver: number, nextManeuver: number): NavProgress {
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

test("the arrive row is highlighted and not also dimmed", () => {
  // At the end of the route nextManeuver is clamped onto currentManeuver.
  const progress = progressAt(5, 5);
  expect(maneuverState(progress, 5)).toBe("next");
  expect([0, 1, 2, 3, 4].map((index) => maneuverState(progress, index))).toEqual(
    ["passed", "passed", "passed", "passed", "passed"],
  );
});

test("without a live position every maneuver is still ahead", () => {
  expect([0, 1, 2, 3, 4, 5].map((index) => maneuverState(null, index))).toEqual([
    "ahead",
    "ahead",
    "ahead",
    "ahead",
    "ahead",
    "ahead",
  ]);
});

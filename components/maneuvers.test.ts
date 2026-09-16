// The icon a maneuver wears, which for a station is the act and not the station: off a train, from
// one train to the next, down a stair, or into a lift.

import { expect, test } from "bun:test";
import { MdElevator, MdLogout, MdStairs } from "react-icons/md";
import type { Maneuver } from "../src/routing/directions";
import { maneuverIcon } from "./maneuvers";

function stationManeuver(overrides: Partial<Maneuver>): Maneuver {
  return {
    kind: "station",
    text: "Enter Bridge St",
    name: "Bridge St",
    side: null,
    turn: null,
    lengthMeters: 20,
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
  // A kerbside stop carries no door at all, and still reads as a way in.
  expect(maneuverIcon(stationManeuver({})).type).toBe(MdStairs);
  expect(
    maneuverIcon(stationManeuver({ station: "alight", door: undefined })).type,
  ).toBe(MdLogout);
});

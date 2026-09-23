import { expect, test } from "bun:test";

// Pins the DEM tile naming against tiles the survey actually stages.
import {
  type DemSquare,
  demSquaresOf,
  EAST_BAY_WINDOW,
  OAKLAND_TEST_WINDOW,
} from "./lidar";

const named = ({ name }: DemSquare): string => name;

test("the downtown window falls in the one tile it was measured on", () => {
  expect(demSquaresOf(OAKLAND_TEST_WINDOW, "utm10n").map(named)).toEqual([
    "x56y419",
  ]);
});

test("both cities reach the squares the survey staged nothing for", () => {
  const squares = demSquaresOf(EAST_BAY_WINDOW, "utm10n").map(named);
  expect(squares).toContain("x56y419");
  // The survey stages no DEM tile for these three; their ground comes from the point cloud.
  expect(squares).toContain("x55y417");
  expect(squares).toContain("x55y418");
  expect(squares).toContain("x56y417");
});

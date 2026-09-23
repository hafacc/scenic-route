import { expect, test } from "bun:test";
import {
  type CrownAllometry,
  crownDiameterMeters,
  NOCALC_LONDON_PLANE,
  NOEAST_LONDON_PLANE,
} from "./allometry";

const CM_PER_INCH = 2.54;

// San Francisco's quadratic turns at 40 inches of trunk, inside the range of real street trees.
test("a quadratic crown never shrinks as the trunk grows", () => {
  let previous = 0;
  for (let inches = 1; inches <= 60; inches++) {
    const crown = crownDiameterMeters(NOCALC_LONDON_PLANE, inches);
    expect(crown).toBeGreaterThanOrEqual(previous - 1e-9);
    previous = crown;
  }
});

test("past the turning point the crown holds at its peak rather than falling away", () => {
  const { b, c } = NOCALC_LONDON_PLANE as Extract<
    CrownAllometry,
    { form: "quad" }
  >;
  const vertexInches = -b / (2 * c) / CM_PER_INCH;
  expect(vertexInches).toBeGreaterThan(20);
  expect(vertexInches).toBeLessThan(60); // inside the dbh clamp
  const peak = crownDiameterMeters(NOCALC_LONDON_PLANE, vertexInches);
  expect(crownDiameterMeters(NOCALC_LONDON_PLANE, 60)).toBeCloseTo(peak, 6);
});

test("the log-log form still grows over the whole range", () => {
  expect(crownDiameterMeters(NOEAST_LONDON_PLANE, 60)).toBeGreaterThan(
    crownDiameterMeters(NOEAST_LONDON_PLANE, 40),
  );
});

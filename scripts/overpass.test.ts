import { expect, test } from "bun:test";
import { tunneled } from "./overpass";

test("a way is in a tunnel when the tag says so, whatever value it says it with", () => {
  expect(tunneled({ tunnel: "yes" })).toBe(true);
  expect(tunneled({ tunnel: "building_passage" })).toBe(true);
  expect(tunneled({ tunnel: "covered" })).toBe(true);
  expect(tunneled({ tunnel: "no" })).toBe(false);
  expect(tunneled({})).toBe(false);
});

test("only covered=yes is a roof all the way round", () => {
  expect(tunneled({ covered: "yes" })).toBe(true);
  // An arcade or colonnade is open along one side: sheltered from rain, not from sun.
  expect(tunneled({ covered: "arcade" })).toBe(false);
  expect(tunneled({ covered: "colonnade" })).toBe(false);
  expect(tunneled({ covered: "no" })).toBe(false);
});

test("a bridge or a layer alone is not a tunnel", () => {
  expect(tunneled({ bridge: "yes", layer: "1" })).toBe(false);
  expect(tunneled({ layer: "-1" })).toBe(false);
});

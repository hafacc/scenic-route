import { expect, test } from "bun:test";

// Chunk pyramids are keyed by x/y alone, so two cities sharing a chunk would silently interleave.
import { overlappingCities } from "./manifest";

const city = (
  id: string,
  south: number,
  west: number,
  north: number,
  east: number,
) => ({ id, bounds: { south, west, north, east } }) as never;

test("nyc and sf do not share a chunk", () => {
  expect(
    overlappingCities([
      city("nyc", 40.4968, -74.2555, 40.9155, -73.6975),
      city("sf", 37.7068, -122.5141, 37.8325, -122.3607),
    ]),
  ).toBeNull();
});

test("a neighbor that shares the grid is caught", () => {
  expect(
    overlappingCities([
      city("sf", 37.7068, -122.5141, 37.8325, -122.3607),
      city("oakland", 37.7, -122.355, 37.885, -122.114),
    ]),
  ).toEqual(["sf", "oakland"]);
});

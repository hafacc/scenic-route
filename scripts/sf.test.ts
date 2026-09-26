import { expect, test } from "bun:test";
import { roadTypeOf } from "./sf";
import { ROAD_PATH, ROAD_STREET, ROAD_TUNNEL } from "./streets";

test("the city's tunnels are walked as tunnels, sidewalks and all", () => {
  // Stockton and the two Broadway bores, which the centerline files as `TUNL`.
  expect(roadTypeOf({ layer: "STREETS", st_type: "TUNL" })).toBe(ROAD_TUNNEL);
  expect(roadTypeOf({ layer: "STREETS", st_type: "ST" })).toBe(ROAD_STREET);
  // An override never promotes a park path to a roadway.
  expect(roadTypeOf({ layer: "PARKS", st_type: "TUNL" })).toBe(ROAD_PATH);
});

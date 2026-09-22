import { describe, expect, test } from "bun:test";
import { endpointCity } from "./endpoint-city";

describe("endpointCity", () => {
  test("an empty map records no city and never leaves one", () => {
    expect(endpointCity(null, "nyc", false)).toEqual({
      recorded: null,
      left: false,
    });
    expect(endpointCity("nyc", "sf", false)).toEqual({
      recorded: null,
      left: false,
    });
  });

  test("the first endpoints adopt the city they arrived in", () => {
    expect(endpointCity(null, "sf", true)).toEqual({
      recorded: "sf",
      left: false,
    });
  });

  test("the same city again changes nothing", () => {
    expect(endpointCity("sf", "sf", true)).toEqual({
      recorded: "sf",
      left: false,
    });
  });

  test("leaving the city the endpoints were picked in drops them and forgets it", () => {
    expect(endpointCity("nyc", "sf", true)).toEqual({
      recorded: null,
      left: true,
    });
  });

  test("the next endpoints adopt the new city, as the first ones did", () => {
    const left = endpointCity("nyc", "sf", true);
    expect(endpointCity(left.recorded, "sf", true)).toEqual({
      recorded: "sf",
      left: false,
    });
  });
});

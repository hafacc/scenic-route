import { expect, test } from "bun:test";
import { parseHouseNumber } from "../src/search/address-format";
import {
  buildAddressIndex,
  matchAddress,
  normalizeStreet,
  type PlaceAddressIndex,
  type PlacedAddress,
  splitAddress,
  toNeighborhoods,
} from "./places";

const HERE = { lat: 40.7, lng: -74 };

function house(number: string, at = HERE): PlacedAddress {
  return { number: parseHouseNumber(number)!, ...at };
}

function index(
  streets: Readonly<Record<string, readonly PlacedAddress[]>>,
): PlaceAddressIndex {
  return buildAddressIndex(
    Object.entries(streets).map(([name, addresses]) => ({ name, addresses })),
  );
}

test("folds the spellings the two files disagree about", () => {
  expect(normalizeStreet("W 39th St")).toBe("W 39 ST");
  expect(normalizeStreet("West Portal Avenue")).toBe("W PORTAL AVE");
  expect(normalizeStreet("03 St")).toBe("3 ST");
  expect(normalizeStreet("O'Farrell St")).toBe("OFARRELL ST");
  expect(normalizeStreet("St. Nicholas Ave")).toBe("ST NICHOLAS AVE");
  expect(normalizeStreet("W  39 ST")).toBe(normalizeStreet("West 39th Street"));
});

test("splits the house number off the front of the line", () => {
  expect(splitAddress("178 Broadway")).toEqual({
    number: { major: 178, minor: 0, suffix: 0 },
    street: "BROADWAY",
  });
  expect(splitAddress("269B Guerrero St")).toEqual({
    number: { major: 269, minor: 0, suffix: 2 },
    street: "GUERRERO ST",
  });
  expect(splitAddress("1 W 39th St")?.street).toBe("W 39 ST");
  // The address file carries no units.
  expect(splitAddress("305 W 39th St Ste 210")?.street).toBe("W 39 ST");
});

test("joins an ordinal street to the number-only spelling", () => {
  const addresses = index({ "W 39 ST": [house("305")] });
  expect(matchAddress("305 W 39th St", HERE, addresses)).toEqual({
    street: "W 39 ST",
    houseNumber: { major: 305, minor: 0, suffix: 0 },
    meters: 0,
  });
});

test("joins a spelled-out directional to the abbreviated one", () => {
  const addresses = index({ "WEST PORTAL AVE": [house("124")] });
  expect(matchAddress("124 W Portal Ave", HERE, addresses)?.street).toBe(
    "WEST PORTAL AVE",
  );
});

test("joins a Queens house number written either way", () => {
  const addresses = index({ "LIBERTY AVE": [house("126-10")] });
  const hyphenated = matchAddress("126-10 Liberty Ave", HERE, addresses);
  expect(hyphenated?.houseNumber).toEqual({ major: 126, minor: 10, suffix: 0 });
  // Overture often runs the two halves together.
  expect(matchAddress("12610 Liberty Ave", HERE, addresses)).toEqual(
    hyphenated!,
  );
});

test("keeps a real house number ahead of a run-together Queens one", () => {
  const addresses = index({
    "LIBERTY AVE": [house("126-10"), house("12610")],
  });
  expect(
    matchAddress("12610 Liberty Ave", HERE, addresses)?.houseNumber,
  ).toEqual({ major: 12610, minor: 0, suffix: 0 });
});

test("joins a house number the source padded with a zero", () => {
  const addresses = index({ "IRVING ST": [house("123")] });
  expect(matchAddress("0123 Irving St", HERE, addresses)?.houseNumber).toEqual({
    major: 123,
    minor: 0,
    suffix: 0,
  });
});

test("joins the names the two files disagree about", () => {
  const newYork = index({
    "GRAND CONC": [house("1")],
    "7 AVE": [house("550")],
  });
  expect(matchAddress("1 Grand Concourse", HERE, newYork)?.street).toBe(
    "GRAND CONC",
  );
  expect(matchAddress("550 Fashion Ave", HERE, newYork)?.street).toBe("7 AVE");

  const sanFrancisco = index({
    "BAY SHORE BLVD": [house("2000")],
    "THE EMBARCADERO": [house("1")],
  });
  expect(matchAddress("2000 Bayshore Blvd", HERE, sanFrancisco)?.street).toBe(
    "BAY SHORE BLVD",
  );
  expect(matchAddress("1 Embarcadero", HERE, sanFrancisco)?.street).toBe(
    "THE EMBARCADERO",
  );
});

test("answers null where the place has no doorway to join", () => {
  const addresses = index({ "POLK ST": [house("1517")] });
  expect(matchAddress("Ocean Beach Parking", HERE, addresses)).toBeNull();
  expect(matchAddress("1 Ferry Plz", HERE, addresses)).toBeNull();
  expect(matchAddress("1519 Polk St", HERE, addresses)).toBeNull();
});

test("picks the borough's own house out of the streets that share a name", () => {
  const brooklyn = { lat: 40.686, lng: -73.995 };
  const statenIsland = { lat: 40.643, lng: -74.077 };
  const addresses = index({
    "COURT ST": [house("312", brooklyn), house("312", statenIsland)],
  });
  const hit = matchAddress("312 Court St", statenIsland, addresses);
  expect(hit?.street).toBe("COURT ST");
  expect(hit?.meters).toBeLessThan(1);

  const far = matchAddress(
    "312 Court St",
    { lat: 40.75, lng: -73.98 },
    addresses,
  );
  expect(far?.meters).toBeGreaterThan(7000);
});

test("one district written down twice is one row, and a community board is none", () => {
  const kept = toNeighborhoods([
    { name: "Herald Square", lat: 40.7503, lng: -73.9878 },
    { name: "Herald Square", lat: 40.7495, lng: -73.988 },
    { name: "Manhattan Community Board 5", lat: 40.75, lng: -73.98 },
    // Chelsea in Manhattan and Chelsea in Staten Island.
    { name: "Chelsea", lat: 40.7465, lng: -74.0015 },
    { name: "Chelsea", lat: 40.6007, lng: -74.1949 },
  ]);
  expect(kept.map((row) => row.name)).toEqual([
    "Chelsea",
    "Chelsea",
    "Herald Square",
  ]);
});

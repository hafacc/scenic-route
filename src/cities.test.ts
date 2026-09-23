import { expect, test } from "bun:test";
import {
  CITIES,
  citiesInView,
  cityById,
  cityInSentence,
  containsPoint,
  DEFAULT_CITY,
  metersFromCity,
  nearestCity,
} from "./cities";

test("every city offers overlays and a center inside its own bounds", () => {
  expect(CITIES.length).toBeGreaterThan(0);
  for (const city of CITIES) {
    expect(city.overlays.length).toBeGreaterThan(0);
    expect(containsPoint(city, city.center)).toBe(true);
  }
});

test("a point in the city is zero from it, one outside is its ground distance", () => {
  const timesSquare = { lat: 40.758, lng: -73.9855 };
  expect(metersFromCity(DEFAULT_CITY, timesSquare)).toBe(0);
  expect(containsPoint(DEFAULT_CITY, timesSquare)).toBe(true);

  // Due north of the bounds by a tenth of a degree, so the gap is latitude alone.
  const north = { lat: DEFAULT_CITY.bounds.north + 0.1, lng: timesSquare.lng };
  expect(metersFromCity(DEFAULT_CITY, north)).toBeCloseTo(11_132, 0);
  expect(containsPoint(DEFAULT_CITY, north)).toBe(false);
});

test("an east-west gap is scaled by latitude", () => {
  const { bounds } = DEFAULT_CITY;
  const lat = (bounds.north + bounds.south) / 2;
  const east = metersFromCity(DEFAULT_CITY, { lat, lng: bounds.east + 0.1 });
  expect(east).toBeLessThan(11_132);
  expect(east).toBeCloseTo(11_132 * Math.cos((lat * Math.PI) / 180), 0);
});

test("a point far outside every city still resolves to the nearest one", () => {
  const sanFrancisco = { lat: 37.7749, lng: -122.4194 };
  expect(containsPoint(DEFAULT_CITY, sanFrancisco)).toBe(false);
  expect(CITIES).toContain(nearestCity(sanFrancisco));
});

test("a region's name takes an article in a sentence and a city's does not", () => {
  const bay = cityById("sf");
  expect(bay && cityInSentence(bay)).toBe("the Bay Area");
  expect(cityInSentence(DEFAULT_CITY)).toBe(DEFAULT_CITY.name);
});

test("an unknown or absent city id resolves to nothing rather than a default", () => {
  expect(cityById(DEFAULT_CITY.id)).toBe(DEFAULT_CITY);
  expect(cityById("atlantis")).toBeNull();
  expect(cityById(null)).toBeNull();
});

// The camera hands over the city only when a view names exactly one.
test("a view reports every city it overlaps, however little", () => {
  const { bounds } = DEFAULT_CITY;
  const clipped = {
    south: bounds.north - 0.01,
    north: bounds.north + 5,
    west: bounds.east - 0.01,
    east: bounds.east + 5,
  };
  expect(citiesInView(clipped)).toEqual([DEFAULT_CITY]);

  const world = { south: -85, north: 85, west: -180, east: 180 };
  expect(citiesInView(world)).toEqual([...CITIES]);

  const empty = { south: 0, north: 10, west: 0, east: 10 };
  expect(citiesInView(empty)).toEqual([]);
});

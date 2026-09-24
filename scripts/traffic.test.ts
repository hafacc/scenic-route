import { expect, test } from "bun:test";
import { projectX } from "./planar";
import type { Coord } from "./socrata";
import {
  conflateVolumes,
  LOOSE_REACH,
  namesAgree,
  normalizedName,
  type VolumeLine,
  weightedMedian,
} from "./traffic";

const METERS_PER_DEGREE_LNG = projectX(1);

// Planar meters east and north of (40.7, -74.0).
function at(x: number, y: number): Coord {
  return { lng: -74 + x / METERS_PER_DEGREE_LNG, lat: 40.7 + y / 111_320 };
}

function eastWest(y: number, fromX = 0, toX = 500): Coord[] {
  return [at(fromX, y), at(toX, y)];
}

function count(
  aadt: number,
  points: Coord[],
  name: string | null = null,
): VolumeLine {
  return { aadt, name, points };
}

test("an OSM name and an HPMS abbreviation of it agree", () => {
  const osm = normalizedName("Atlantic Avenue");
  expect(osm).toEqual(["ATLANTIC", "AVE"]);
  expect(namesAgree(osm ?? [], normalizedName("ATLANTIC AVE") ?? [])).toBe(
    true,
  );
  expect(
    namesAgree(
      normalizedName("4th Avenue") ?? [],
      normalizedName("4TH AV") ?? [],
    ),
  ).toBe(true);
  expect(
    namesAgree(
      normalizedName("Flatbush Avenue") ?? [],
      normalizedName("FLATBSH AV EXT") ?? [],
    ),
  ).toBe(false);
  expect(normalizedName(" ")).toBeNull();
});

test("the weighted median is the value holding the middle of the weight", () => {
  expect(weightedMedian([10, 20, 30], [1, 1, 5])).toBe(30);
  expect(weightedMedian([30, 10, 20], [1, 1, 1])).toBe(20);
  expect(weightedMedian([10], [0])).toBeNull();
});

test("both carriageways of a divided road take the centerline's two-way total", () => {
  const volumes = [count(40_000, eastWest(0))];
  const [north, south] = conflateVolumes(
    [
      { name: null, points: eastWest(12) },
      { name: null, points: eastWest(-12).reverse() },
    ],
    volumes,
  );
  expect(north.aadt).toBe(40_000);
  expect(south.aadt).toBe(40_000);
  expect(north.matchedMeters).toBeCloseTo(north.meters, 0);
});

test("a count too far off or running across the road is no match", () => {
  const volumes = [
    count(40_000, eastWest(40)),
    count(90_000, [at(250, -300), at(250, 300)]),
  ];
  const [road] = conflateVolumes(
    [{ name: null, points: eastWest(0) }],
    volumes,
  );
  expect(road.aadt).toBeNull();
});

test("the loose reach takes a count the strict one leaves", () => {
  const volumes = [
    count(70_000, eastWest(45)),
    count(90_000, [at(250, -300), at(250, 300)]),
  ];
  const roads = [{ name: null, points: eastWest(0) }];
  expect(conflateVolumes(roads, volumes)[0].aadt).toBeNull();
  expect(conflateVolumes(roads, volumes, LOOSE_REACH)[0].aadt).toBe(70_000);
});

test("a same-named count wins over a nearer one of another name", () => {
  const volumes = [
    count(90_000, eastWest(5), "BKLYN/QUEENS EXP"),
    count(12_000, eastWest(20), "ATLANTIC AVE"),
  ];
  const [named, unnamed] = conflateVolumes(
    [
      { name: "Atlantic Avenue", points: eastWest(0) },
      { name: null, points: eastWest(0) },
    ],
    volumes,
  );
  expect(named.aadt).toBe(12_000);
  expect(unnamed.aadt).toBe(90_000);
});

test("a road's count is the length-weighted median along it, and a sliver of match is none", () => {
  const volumes = [
    count(10_000, eastWest(0, 0, 150)),
    count(30_000, eastWest(0, 150, 500)),
    count(80_000, eastWest(0, 900, 950)),
  ];
  const [road, mostlyUncounted] = conflateVolumes(
    [
      { name: null, points: eastWest(3) },
      { name: null, points: eastWest(3, 600, 1_000) },
    ],
    volumes,
  );
  expect(road.aadt).toBe(30_000);
  expect(mostlyUncounted.aadt).toBeNull();
});

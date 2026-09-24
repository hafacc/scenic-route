import { expect, test } from "bun:test";
import {
  NUISANCE_CLASS,
  nuisanceLineOf,
  type OverpassElement,
  tunneled,
} from "./overpass";

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

function way(tags: Record<string, string>): OverpassElement {
  return {
    type: "way",
    id: 1,
    tags,
    geometry: [
      { lat: 40.7, lon: -74.0 },
      { lat: 40.71, lon: -73.99 },
    ],
  };
}

test("a road's nuisance class is its own, and a ramp's is its parent road's", () => {
  expect(nuisanceLineOf(way({ highway: "motorway" }))?.klass).toBe(
    NUISANCE_CLASS.motorway,
  );
  expect(nuisanceLineOf(way({ highway: "primary_link" }))?.klass).toBe(
    NUISANCE_CLASS.primary,
  );
  expect(nuisanceLineOf(way({ highway: "motorway_link" }))?.klass).toBe(
    NUISANCE_CLASS.motorway,
  );
  expect(nuisanceLineOf(way({ highway: "tertiary" }))?.klass).toBe(
    NUISANCE_CLASS.tertiary,
  );
  expect(nuisanceLineOf(way({ highway: "tertiary" }))?.kind).toBe("highway");
});

test("a road keeps its name for matching traffic counts", () => {
  expect(
    nuisanceLineOf(way({ highway: "primary", name: " Atlantic Avenue " }))
      ?.name,
  ).toBe("Atlantic Avenue");
  expect(nuisanceLineOf(way({ highway: "primary" }))?.name).toBeNull();
});

test("a street below tertiary is no nuisance at all", () => {
  // A residential street is the walk itself; weighting it would penalize every route alike.
  expect(nuisanceLineOf(way({ highway: "residential" }))).toBeNull();
  expect(nuisanceLineOf(way({ highway: "service" }))).toBeNull();
  expect(nuisanceLineOf(way({ highway: "footway" }))).toBeNull();
});

test("above-ground rail is the one class a railway takes, and underground is none", () => {
  expect(nuisanceLineOf(way({ railway: "rail" }))?.klass).toBe(
    NUISANCE_CLASS.rail,
  );
  expect(nuisanceLineOf(way({ railway: "subway", layer: "0" }))?.klass).toBe(
    NUISANCE_CLASS.rail,
  );
  expect(nuisanceLineOf(way({ railway: "subway", tunnel: "yes" }))).toBeNull();
  expect(nuisanceLineOf(way({ railway: "subway", layer: "-1" }))).toBeNull();
});

test("a tunneled road is not a road you walk beside", () => {
  expect(
    nuisanceLineOf(way({ highway: "motorway", tunnel: "yes" })),
  ).toBeNull();
});

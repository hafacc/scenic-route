import { expect, test } from "bun:test";
import {
  cemeteryLanes,
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

// A unit square is ~100 m on a side at 40.65° N.
function at([lat, lon]: [number, number]): { lat: number; lon: number } {
  return { lat: 40.65 + lat * 0.0009, lon: -74 + lon * 0.00118 };
}

function ring(corners: [number, number][]): { lat: number; lon: number }[] {
  return [...corners, corners[0]].map(at);
}

function lane(
  id: number,
  tags: Record<string, string>,
  points: [number, number][],
): OverpassElement {
  return {
    type: "way",
    id,
    tags: { highway: "service", name: "Sassafras Avenue", ...tags },
    geometry: points.map(at),
  };
}

const OUTER = ring([
  [0, 0],
  [0, 1],
  [1, 1],
  [1, 0],
]);

// A multipolygon arrives as open member chains; this one also has a hole.
const cemetery: OverpassElement = {
  type: "relation",
  id: 9,
  tags: { landuse: "cemetery", type: "multipolygon" },
  members: [
    { type: "way", role: "outer", geometry: OUTER.slice(0, 3) },
    { type: "way", role: "outer", geometry: OUTER.slice(2) },
    {
      type: "way",
      role: "inner",
      geometry: ring([
        [0.4, 0.4],
        [0.4, 0.6],
        [0.6, 0.6],
        [0.6, 0.4],
      ]),
    },
  ],
};

function kept(...lanes: OverpassElement[]): number[] {
  return cemeteryLanes([cemetery, ...lanes]).map((path) => path.id);
}

const INSIDE: [number, number][] = [
  [0.1, 0.1],
  [0.1, 0.9],
];

test("a service lane inside a cemetery is a path, named or not", () => {
  const avenue = lane(1, { access: "permissive" }, INSIDE);
  const unnamed = { ...lane(2, {}, INSIDE), tags: { highway: "service" } };
  expect(kept(avenue, unnamed)).toEqual([1, 2]);
  expect(cemeteryLanes([avenue, unnamed])).toEqual([]);
});

test("a lane through the gate is kept with its short stub outside the fence", () => {
  expect(
    kept(
      lane(1, {}, [
        [-0.1, 0.2],
        [0.9, 0.2],
      ]),
    ),
  ).toEqual([1]);
});

test("a service road outside, mostly outside, or in a hole of a cemetery stays out", () => {
  expect(
    kept(
      lane(1, {}, [
        [1.2, 0],
        [1.2, 1],
      ]),
      lane(2, {}, [
        [-0.8, 0.5],
        [0.2, 0.5],
      ]),
      lane(3, {}, [
        [0.45, 0.45],
        [0.55, 0.55],
      ]),
    ),
  ).toEqual([]);
});

test("a cemetery lane that is barred or a parking aisle stays out", () => {
  expect(
    kept(
      lane(2, { access: "private" }, INSIDE),
      lane(3, { access: "no", foot: "permissive" }, INSIDE),
      lane(4, { foot: "no" }, INSIDE),
      lane(5, { service: "parking_aisle" }, INSIDE),
      lane(6, { highway: "residential" }, INSIDE),
    ),
  ).toEqual([]);
});

test("a closed grave_yard way is a cemetery too", () => {
  const churchyard: OverpassElement = {
    type: "way",
    id: 8,
    tags: { amenity: "grave_yard" },
    geometry: ring([
      [0, 2],
      [0, 3],
      [1, 3],
      [1, 2],
    ]),
  };
  const walk = lane(1, {}, [
    [0.5, 2.1],
    [0.5, 2.9],
  ]);
  expect(cemeteryLanes([churchyard, walk]).map((path) => path.id)).toEqual([1]);
});

test("a two-node lane is judged by how much of it is inside, not by its midpoint", () => {
  // 65% inside: its one midpoint is well within the fence.
  expect(
    kept(
      lane(1, {}, [
        [-0.35, 0.2],
        [0.65, 0.2],
      ]),
    ),
  ).toEqual([]);
});

test("a broken multipolygon or a site relation is no cemetery", () => {
  const broken: OverpassElement = {
    ...cemetery,
    members: [{ type: "way", role: "outer", geometry: OUTER.slice(0, 3) }],
  };
  const site: OverpassElement = {
    ...cemetery,
    tags: { amenity: "grave_yard", type: "site" },
  };
  const walk = lane(1, {}, INSIDE);
  // West of the broken outline, where an open chain would flip the even-odd test.
  const west = lane(2, {}, [
    [0.1, -0.9],
    [0.9, -0.9],
  ]);
  expect(cemeteryLanes([broken, walk, west])).toEqual([]);
  expect(cemeteryLanes([site, walk])).toEqual([]);
});

test("only outer and inner members outline a cemetery", () => {
  const withEntrance: OverpassElement = {
    ...cemetery,
    members: [
      ...(cemetery.type === "relation" ? (cemetery.members ?? []) : []),
      { type: "way", role: "entrance", geometry: [at([0.2, 0.2])] },
    ],
  };
  expect(cemeteryLanes([withEntrance, lane(1, {}, INSIDE)]).length).toBe(1);
});

test("a lane glued to the fence is judged by the rest of its length", () => {
  expect(
    kept(
      // Along the south fence alone: never inside, whatever the rounding.
      lane(1, {}, [
        [0, 0.1],
        [0, 0.9],
      ]),
      // Along the fence, then well inside: kept on its inside run.
      lane(2, {}, [
        [0, 0.1],
        [0, 0.3],
        [0.3, 0.3],
      ]),
    ),
  ).toEqual([2]);
});

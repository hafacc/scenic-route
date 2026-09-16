import { describe, expect, test } from "bun:test";
import type { Polyline } from "../tiles/polylines";
import { sliceTrack, trackShapes } from "./tracks";

// A trunk running due east along the 40.75 parallel that splits at 0.02 degrees: one variant carries
// on east, the other turns north. Two stations on the trunk, one on each branch. Degrees are used
// directly rather than a real feed's coordinates so the answers can be read off by eye.
const line = (points: [number, number][]): Polyline => ({
  lngs: Float64Array.from(points.map(([lng]) => lng)),
  lats: Float64Array.from(points.map(([, lat]) => lat)),
});

const EAST: Polyline = line([
  [-74.0, 40.75],
  [-73.99, 40.75],
  [-73.98, 40.75],
  [-73.97, 40.75],
  [-73.96, 40.75],
]);
const NORTH: Polyline = line([
  [-74.0, 40.75],
  [-73.99, 40.75],
  [-73.98, 40.75],
  [-73.98, 40.76],
  [-73.98, 40.77],
]);

const at = (lng: number, lat: number) => ({ lat, lng });

describe("sliceTrack", () => {
  test("a ride down the trunk is cut out of it at both ends", () => {
    const sliced = sliceTrack(
      [EAST, NORTH],
      at(-73.995, 40.75),
      at(-73.985, 40.75),
    );
    expect(sliced).not.toBeNull();
    const cut = sliced as Polyline;
    // The ends are the projections, and the trunk vertex between them is kept.
    expect([...cut.lngs]).toEqual([-73.995, -73.99, -73.985]);
    expect([...cut.lats]).toEqual([40.75, 40.75, 40.75]);
  });

  test("the slice starts and ends at the stations, not at their projections", () => {
    // Both platforms stand a little off the track, which is where a real one is: the ride has to
    // reach back to them, or it is drawn floating clear of the walk that gets you there.
    const board = at(-73.995, 40.7505);
    const alight = at(-73.985, 40.7495);
    const cut = sliceTrack([EAST, NORTH], board, alight) as Polyline;
    expect(cut).not.toBeNull();
    expect([cut.lngs[0], cut.lats[0]]).toEqual([board.lng, board.lat]);
    expect([
      cut.lngs[cut.lngs.length - 1],
      cut.lats[cut.lats.length - 1],
    ]).toEqual([alight.lng, alight.lat]);
  });

  test("the branch both stations sit on is the one drawn", () => {
    const sliced = sliceTrack(
      [EAST, NORTH],
      at(-73.99, 40.75),
      at(-73.98, 40.765),
    );
    expect(sliced).not.toBeNull();
    const cut = sliced as Polyline;
    // Down the trunk to the junction and then north: the east variant would have been a straight
    // line more than a kilometre off the second station.
    expect([...cut.lngs]).toEqual([-73.99, -73.98, -73.98, -73.98]);
    expect([...cut.lats].map((lat) => Number(lat.toFixed(6)))).toEqual([
      40.75, 40.75, 40.76, 40.765,
    ]);
  });

  test("a ride against the shape's own direction is returned in travel order", () => {
    const sliced = sliceTrack([EAST], at(-73.97, 40.75), at(-73.99, 40.75));
    const cut = sliced as Polyline;
    expect([...cut.lngs]).toEqual([-73.97, -73.98, -73.99]);
  });

  test("a station nowhere near the shapes leaves the caller its chord", () => {
    expect(
      sliceTrack([EAST, NORTH], at(-73.99, 40.75), at(-73.9, 40.9)),
    ).toBeNull();
  });

  test("a line the artifact does not draw has nothing to slice", () => {
    expect(sliceTrack([], at(-73.99, 40.75), at(-73.98, 40.75))).toBeNull();
  });
});

describe("trackShapes", () => {
  const subway = {
    routes: [
      {
        color: "#0039a6",
        textColor: "#ffffff",
        shortName: "A",
        longName: "8 Av",
      },
      {
        color: "#fccc0a",
        textColor: "#000000",
        shortName: "N",
        longName: "Broadway",
      },
    ],
    lines: [
      { ...EAST, route: 0 },
      { ...NORTH, route: 0 },
      { ...EAST, route: 1 },
    ],
    stations: [],
  };

  test("every variant the line is drawn as, and no other line's", () => {
    expect(
      trackShapes(subway, { shortName: "A", color: "#0039a6" }),
    ).toHaveLength(2);
  });

  test("a name the two files agree on carries a livery they do not", () => {
    // The graph and the display artifact are built from different feeds; where the colours have
    // drifted the name is still the join, rather than the line going undrawn.
    expect(
      trackShapes(subway, { shortName: "N", color: "#ffffff" }),
    ).toHaveLength(1);
  });

  test("a line the artifact never heard of draws nothing", () => {
    expect(trackShapes(subway, { shortName: "SIR", color: "#0039a6" })).toEqual(
      [],
    );
  });
});

import { expect, test } from "bun:test";
import type { SidewalkTaggedRoad } from "./overpass";
import {
  type SidedSegment,
  type SidewalkSides,
  statedSides,
  taggedSides,
  tagSurvey,
} from "./sidewalks";

function road(
  tags: Omit<SidewalkTaggedRoad, "id" | "points">,
): SidewalkTaggedRoad {
  return { id: 1, points: [], ...tags };
}

test("the generic key states both curbs, and a named side bares the other", () => {
  expect(taggedSides(road({ sidewalk: "both" }))).toEqual({
    left: "paved",
    right: "paved",
  });
  expect(taggedSides(road({ sidewalk: "left" }))).toEqual({
    left: "paved",
    right: "bare",
  });
  expect(taggedSides(road({ sidewalk: "right" }))).toEqual({
    left: "bare",
    right: "paved",
  });
});

// Only an untagged side, never a stated `no`, may be answered by a weaker source.
test("no and none are stated bare, an untagged road is unstated", () => {
  expect(taggedSides(road({ sidewalk: "no" }))).toEqual({
    left: "bare",
    right: "bare",
  });
  expect(taggedSides(road({ sidewalk: "none" }))).toEqual({
    left: "bare",
    right: "bare",
  });
  expect(taggedSides(road({}))).toEqual({
    left: "unstated",
    right: "unstated",
  });
});

// `separate` means the pavement is its own way, which the mapped sidewalks answer for.
test("separate states nothing", () => {
  expect(taggedSides(road({ sidewalk: "separate" }))).toEqual({
    left: "unstated",
    right: "unstated",
  });
  expect(taggedSides(road({ sidewalk: "both", left: "separate" }))).toEqual({
    left: "paved",
    right: "paved",
  });
});

test("a side-specific key overrides the generic one", () => {
  expect(taggedSides(road({ sidewalk: "both", left: "no" }))).toEqual({
    left: "bare",
    right: "paved",
  });
  expect(taggedSides(road({ sidewalk: "no", both: "yes" }))).toEqual({
    left: "paved",
    right: "paved",
  });
  expect(taggedSides(road({ both: "yes", right: "no" }))).toEqual({
    left: "paved",
    right: "bare",
  });
});

// About 84 m at the reference latitude, so `stations` places five.
const WEST = -74.0;
const EAST = -73.999;
const LAT = 40.7;

function street(points: SidedSegment["points"]): SidedSegment {
  return {
    physicalId: 1,
    roadType: 1,
    streetWidth: 30,
    flags: 0,
    lengthMeters: 84,
    points,
  };
}

const EASTBOUND = street([
  { lat: LAT, lng: WEST },
  { lat: LAT, lng: EAST },
]);
const WESTBOUND = street([
  { lat: LAT, lng: EAST },
  { lat: LAT, lng: WEST },
]);

const TAGGED_EASTBOUND: SidewalkTaggedRoad = {
  id: 10,
  left: "yes",
  right: "no",
  points: [
    { lat: LAT, lng: WEST },
    { lat: LAT, lng: EAST },
  ],
};

// Tag sides are the OSM way's own, and the datasets disagree on which end a street starts at.
test("a street digitized against the tagged road reads its sides reversed", () => {
  const survey = tagSurvey([TAGGED_EASTBOUND]);
  expect(survey(EASTBOUND)).toEqual({ left: "paved", right: "bare" });
  expect(survey(WESTBOUND)).toEqual({ left: "bare", right: "paved" });
});

test("a tag on a fifth of the block is not a statement about the block", () => {
  const stub: SidewalkTaggedRoad = {
    ...TAGGED_EASTBOUND,
    points: [
      { lat: LAT, lng: WEST },
      { lat: LAT, lng: WEST + 0.0002 },
    ],
  };
  expect(tagSurvey([stub])(EASTBOUND)).toEqual({
    left: "unstated",
    right: "unstated",
  });
});

test("a parallel road out of reach states nothing", () => {
  const parallel: SidewalkTaggedRoad = {
    ...TAGGED_EASTBOUND,
    points: TAGGED_EASTBOUND.points.map(({ lat, lng }) => ({
      lat: lat + 0.0005,
      lng,
    })),
  };
  expect(tagSurvey([parallel])(EASTBOUND)).toEqual({
    left: "unstated",
    right: "unstated",
  });
});

const TAGS: SidewalkSides = { left: "paved", right: "paved" };

test("the city's survey wins every side it states, and is not overruled by a tag", () => {
  const survey: SidewalkSides = { left: "bare", right: "bare" };
  let asked = 0;
  const answer = statedSides(survey, () => {
    asked += 1;
    return TAGS;
  });
  expect(answer).toEqual(survey);
  expect(asked).toBe(0);
});

test("a tag answers only the sides the survey leaves unstated", () => {
  expect(statedSides({ left: "bare", right: "unstated" }, () => TAGS)).toEqual({
    left: "bare",
    right: "paved",
  });
  expect(
    statedSides({ left: "unstated", right: "unstated" }, () => TAGS),
  ).toEqual(TAGS);
});

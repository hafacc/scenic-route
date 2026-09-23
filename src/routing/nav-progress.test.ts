import { expect, test } from "bun:test";
import type { Maneuver } from "./directions";
import { navProgress } from "./nav-progress";
import type { RouteResult } from "./search";

const METERS_PER_DEGREE_LAT = 111_320;

// An L: north from A to B, then east to C; maneuver lengths match the geodesic legs.
const START_LAT = 40.74;
const START_LNG = -73.99;
const CORNER_LAT = 40.741;
const EAST_LNG = -73.988;

const metersPerDegreeLng =
  METERS_PER_DEGREE_LAT * Math.cos((CORNER_LAT * Math.PI) / 180);
const northLegMeters = (CORNER_LAT - START_LAT) * METERS_PER_DEGREE_LAT;
const eastLegMeters = (EAST_LNG - START_LNG) * metersPerDegreeLng;

function makeManeuver(
  kind: Maneuver["kind"],
  startMeters: number,
  lengthMeters: number,
  at: { lat: number; lng: number },
): Maneuver {
  return {
    kind,
    text: kind,
    name: null,
    side: null,
    turn: null,
    lengthMeters,
    startMeters,
    stepRange: [0, 0],
    at,
  };
}

function userAt(alongMeters: number): { lat: number; lng: number } {
  if (alongMeters <= northLegMeters) {
    return {
      lat: START_LAT + alongMeters / METERS_PER_DEGREE_LAT,
      lng: START_LNG,
    };
  } else {
    return {
      lat: CORNER_LAT,
      lng: START_LNG + (alongMeters - northLegMeters) / metersPerDegreeLng,
    };
  }
}

function makeRoute(): RouteResult {
  return {
    path: {
      lats: Float64Array.from([START_LAT, CORNER_LAT, CORNER_LAT]),
      lngs: Float64Array.from([START_LNG, START_LNG, EAST_LNG]),
    },
  } as unknown as RouteResult;
}

const maneuvers: Maneuver[] = [
  makeManeuver("start", 0, northLegMeters, { lat: START_LAT, lng: START_LNG }),
  makeManeuver("turn", northLegMeters, eastLegMeters, {
    lat: CORNER_LAT,
    lng: START_LNG,
  }),
  makeManeuver("arrive", northLegMeters + eastLegMeters, 0, {
    lat: CORNER_LAT,
    lng: EAST_LNG,
  }),
];

// A zero-length landmark row a third of the way up the north leg.
const landmarkMeters = northLegMeters / 3;
const withLandmark: Maneuver[] = [
  makeManeuver("start", 0, northLegMeters, { lat: START_LAT, lng: START_LNG }),
  makeManeuver("landmark", landmarkMeters, 0, userAt(landmarkMeters)),
  makeManeuver("turn", northLegMeters, eastLegMeters, {
    lat: CORNER_LAT,
    lng: START_LNG,
  }),
  makeManeuver("arrive", northLegMeters + eastLegMeters, 0, {
    lat: CORNER_LAT,
    lng: EAST_LNG,
  }),
];

test("a point near the start points at the first action with the right distance", () => {
  const along = northLegMeters / 5;
  const user = {
    lat: START_LAT + (CORNER_LAT - START_LAT) / 5,
    lng: START_LNG,
  };
  const progress = navProgress(makeRoute(), maneuvers, user);
  expect(progress).not.toBeNull();
  if (!progress) {
    throw new Error("expected progress");
  }
  expect(progress.currentManeuver).toBe(0);
  expect(progress.nextManeuver).toBe(1);
  expect(progress.offRouteMeters).toBeLessThan(1);
  expect(progress.alongMeters).toBeCloseTo(along, 1);
  expect(progress.distanceToNextMeters).toBeCloseTo(northLegMeters - along, 1);
});

test("a mid-route point sits in the second maneuver with arrive next", () => {
  const user = { lat: CORNER_LAT, lng: (START_LNG + EAST_LNG) / 2 };
  const progress = navProgress(makeRoute(), maneuvers, user);
  expect(progress).not.toBeNull();
  if (!progress) {
    throw new Error("expected progress");
  }
  expect(progress.currentManeuver).toBe(1);
  expect(progress.nextManeuver).toBe(2);
  expect(progress.offRouteMeters).toBeLessThan(1);
  expect(progress.alongMeters).toBeCloseTo(
    northLegMeters + eastLegMeters / 2,
    1,
  );
  expect(progress.remainingMeters).toBeCloseTo(eastLegMeters / 2, 1);
});

test("distance to next decreases as the walker advances along the route", () => {
  const near = navProgress(makeRoute(), maneuvers, {
    lat: START_LAT + (CORNER_LAT - START_LAT) / 5,
    lng: START_LNG,
  });
  const far = navProgress(makeRoute(), maneuvers, {
    lat: START_LAT + (4 * (CORNER_LAT - START_LAT)) / 5,
    lng: START_LNG,
  });
  expect(near?.remainingMeters).toBeGreaterThan(far?.remainingMeters ?? 0);
});

test("a point far off the route returns null", () => {
  // ~1.1 km north of the corner, far beyond OFF_ROUTE_METERS.
  const user = { lat: CORNER_LAT + 0.01, lng: EAST_LNG };
  expect(navProgress(makeRoute(), maneuvers, user)).toBeNull();
});

test("a passed landmark does not hide the turn after it", () => {
  const highlighted = new Set<number>();
  const total = northLegMeters + eastLegMeters;
  const stepCount = 40;
  for (let step = 0; step <= stepCount; step++) {
    const progress = navProgress(
      makeRoute(),
      withLandmark,
      userAt((total * step) / stepCount),
    );
    if (progress) {
      highlighted.add(progress.nextManeuver);
    }
  }
  expect(highlighted.has(2)).toBe(true);
});

test("the landmark is next until it is passed, then the turn is", () => {
  const before = navProgress(
    makeRoute(),
    withLandmark,
    userAt(landmarkMeters / 2),
  );
  const after = navProgress(
    makeRoute(),
    withLandmark,
    userAt((landmarkMeters + northLegMeters) / 2),
  );
  expect(before?.nextManeuver).toBe(1);
  expect(after?.nextManeuver).toBe(2);
});

import type { Maneuver } from "./directions";
import type { RouteResult } from "./search";

// Beyond this the walker isn't following the route, so progress is null and the UI shows the summary.
export const OFF_ROUTE_METERS = 60;

const METERS_PER_DEGREE_LAT = 111_320;

export interface NavProgress {
  alongMeters: number; // how far along the route the user is (from start)
  remainingMeters: number; // along-route distance left to the destination
  offRouteMeters: number; // perpendicular distance from the route polyline
  currentManeuver: number; // index into maneuvers whose span the user is within
  nextManeuver: number; // the upcoming maneuver to act on (>= currentManeuver + 1, clamped to last)
  distanceToNextMeters: number; // along-route distance from the user to nextManeuver's start
}

function projectToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { param: number; distance: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const param =
    lengthSq > 0
      ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
      : 0;
  const closestX = ax + param * dx;
  const closestY = ay + param * dy;
  return { param, distance: Math.hypot(px - closestX, py - closestY) };
}

export function navProgress(
  result: RouteResult,
  maneuvers: Maneuver[],
  user: { lat: number; lng: number },
): NavProgress | null {
  const { lats, lngs } = result.path;
  if (lats.length < 2 || maneuvers.length === 0) {
    return null;
  }

  // Accurate to well under a meter across a city-scale route.
  const metersPerDegreeLng =
    METERS_PER_DEGREE_LAT * Math.cos((user.lat * Math.PI) / 180);
  const toFrame = (lat: number, lng: number): { x: number; y: number } => ({
    x: (lng - user.lng) * metersPerDegreeLng,
    y: (lat - user.lat) * METERS_PER_DEGREE_LAT,
  });

  let bestDistance = Number.POSITIVE_INFINITY;
  let bestAlong = 0;
  let cumulative = 0;
  let previous = toFrame(lats[0], lngs[0]);
  for (let vertex = 1; vertex < lats.length; vertex++) {
    const current = toFrame(lats[vertex], lngs[vertex]);
    const segmentLength = Math.hypot(
      current.x - previous.x,
      current.y - previous.y,
    );
    const { param, distance } = projectToSegment(
      0,
      0,
      previous.x,
      previous.y,
      current.x,
      current.y,
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      bestAlong = cumulative + param * segmentLength;
    }
    cumulative += segmentLength;
    previous = current;
  }

  if (bestDistance > OFF_ROUTE_METERS) {
    return null;
  }

  const alongMeters = bestAlong;
  const totalMeters = cumulative;

  const lastIndex = maneuvers.length - 1;

  // Starts are non-decreasing (a landmark can tie its host), so the scan stops at the first past the walker.
  let currentManeuver = 0;
  for (let index = 0; index <= lastIndex; index++) {
    if (maneuvers[index].startMeters <= alongMeters) {
      currentManeuver = index;
    } else {
      break;
    }
  }

  const nextManeuver = Math.min(currentManeuver + 1, lastIndex);
  return {
    alongMeters,
    remainingMeters: Math.max(0, totalMeters - alongMeters),
    offRouteMeters: bestDistance,
    currentManeuver,
    nextManeuver,
    distanceToNextMeters: Math.max(
      0,
      maneuvers[nextManeuver].startMeters - alongMeters,
    ),
  };
}

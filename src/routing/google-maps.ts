// Google's URL scheme takes no polyline, so a route reaches Google as a few waypoints.

import type { Waypoint } from "./waypoints";

// Google takes 3 waypoints on mobile browsers and 9 elsewhere, silently dropping any extras.
export const MAX_WAYPOINTS = 9;

// About 0.1 m, finer than Google's own snapping.
const COORD_DIGITS = 6;

function coordinate({ lat, lng }: Waypoint): string {
  return `${lat.toFixed(COORD_DIGITS)},${lng.toFixed(COORD_DIGITS)}`;
}

// Endpoints are the requested ones, not our snaps, since Google re-snaps to its own network.
// Transit goes as just the endpoints: pins between stations would be walked.
export function googleMapsTransitUrl(
  origin: Waypoint,
  destination: Waypoint,
): string {
  const params = new URLSearchParams({
    api: "1",
    origin: coordinate(origin),
    destination: coordinate(destination),
    travelmode: "transit",
  });
  return `https://www.google.com/maps/dir/?${params}`;
}

export function googleMapsWalkingUrl(
  origin: Waypoint,
  destination: Waypoint,
  waypoints: readonly Waypoint[],
): string {
  const params = new URLSearchParams({
    api: "1",
    origin: coordinate(origin),
    destination: coordinate(destination),
    travelmode: "walking",
  });
  if (waypoints.length > 0) {
    params.set(
      "waypoints",
      waypoints.slice(0, MAX_WAYPOINTS).map(coordinate).join("|"),
    );
  }
  return `https://www.google.com/maps/dir/?${params}`;
}

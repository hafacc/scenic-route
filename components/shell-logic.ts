// The decisions map-shell.svelte makes when its state changes, as plain functions.
import {
  CITY_ZOOM,
  type City,
  cityById,
  containsPoint,
  nearestCity,
} from "../src/cities";
import type {
  Camera,
  LatLng,
  PlaceUrlState,
  ViewUrlState,
} from "../src/url-state";
import type { MapTarget } from "./map-types";
import {
  LOCATED_ZOOM,
  metersBetween,
  RESNAP_METERS,
  SEARCH_PIN_ZOOM,
} from "./shell-helpers";

interface StartHold {
  // What the search starts from; one object for as long as it stands, so nothing reruns.
  point: LatLng | null;
  // The fix a live start was taken at; null while the start is a named one.
  basis: LatLng | null;
}

export const NO_START: StartHold = { point: null, basis: null };

// A named start wins; a live one is chased only past the resnap threshold, so GPS doesn't churn the search.
export function resolveStart(
  held: StartHold,
  manualStart: LatLng | null,
  live: LatLng | null,
): StartHold {
  if (manualStart) {
    const { point } = held;
    const same =
      point !== null &&
      point.lat === manualStart.lat &&
      point.lng === manualStart.lng;
    if (same && held.basis === null) {
      return held;
    }
    return {
      point: same ? point : { lat: manualStart.lat, lng: manualStart.lng },
      basis: null,
    };
  } else if (!live) {
    // A fix outside the active city is not a start; adopting it guarantees a failed search.
    return held.point === null ? held : NO_START;
  } else if (!held.basis || metersBetween(held.basis, live) > RESNAP_METERS) {
    const point = { lat: live.lat, lng: live.lng };
    return { point, basis: point };
  } else {
    return held;
  }
}

// A live start that ends a route is pinned, or it would move as you walk and share as nothing.
export function liveStartToPin(
  dest: LatLng | null,
  manualStart: LatLng | null,
  live: LatLng | null,
): LatLng | null {
  return dest && !manualStart && live ? live : null;
}

// Endpoints belong to the city they were set in, so leaving it closes their route and pins nothing.
export function leavesRoute(
  dest: LatLng | null,
  manualStart: LatLng | null,
): boolean {
  return dest !== null || manualStart !== null;
}

// The start marker sits on the street only once the drawn route starts where the reader asked.
export function shownStart(
  snapped: LatLng | null,
  routedFrom: LatLng | null,
  asked: LatLng | null,
): LatLng | null {
  const settled =
    snapped !== null &&
    routedFrom !== null &&
    asked !== null &&
    routedFrom.lat === asked.lat &&
    routedFrom.lng === asked.lng;
  return settled ? snapped : asked;
}

type FollowTap = "locate" | "release" | "engage" | "enter";

// With no fix a tap asks for one; with a fix outside the city, engaging moves the city to it.
export function tapFollow(
  following: boolean,
  fix: LatLng | null,
  routable: boolean,
): FollowTap {
  if (fix === null) {
    return "locate";
  } else if (!routable) {
    return "enter";
  } else {
    return following ? "release" : "engage";
  }
}

// Costs are directional (hills, ferries, sun), so the way back is a new search.
export function swapEndpoints<Endpoint>(
  manualStart: Endpoint | null,
  dest: Endpoint | null,
): { manualStart: Endpoint | null; dest: Endpoint | null } {
  return { manualStart: dest, dest: manualStart };
}

// A lookup's name lands only on the point it was asked for, which may have moved since.
export function relabel<Point extends LatLng & { label: string | null }>(
  current: Point | null,
  at: LatLng,
  label: string,
): Point | null {
  return current && current.lat === at.lat && current.lng === at.lng
    ? { ...current, label }
    : current;
}

interface FirstFix {
  // Null leaves the city and the camera where the link put them.
  move: { city: City; target: MapTarget } | null;
  // Outside every city there is nothing to follow.
  follow: boolean;
}

// The first fix picks the city unless the link named one; null leaves the map as the link put it.
export function placeFirstFix(
  fix: LatLng,
  linkedCity: boolean,
): FirstFix | null {
  const nearest = nearestCity(fix);
  if (!containsPoint(nearest, fix)) {
    // A link's city, route and camera stand wherever the reader is.
    const target = { ...nearest.center, zoom: CITY_ZOOM };
    return {
      move: linkedCity ? null : { city: nearest, target },
      follow: false,
    };
  } else if (!linkedCity) {
    // The camera moves with the city, or it reports the old city back and undoes this.
    const target = { lat: fix.lat, lng: fix.lng, zoom: LOCATED_ZOOM };
    return { move: { city: nearest, target }, follow: true };
  } else {
    return null;
  }
}

interface LinkFrame {
  // Null when the link names no place, which leaves the city to the first fix.
  city: City | null;
  camera: Camera | null;
  preframedDest: LatLng | null;
  // False once the link shows somewhere, so the first fix can't pull the map off it.
  follow: boolean;
}

// The city comes from the link, then the live fix, then the default; never the last one viewed.
export function frameLink(view: ViewUrlState, route: PlaceUrlState): LinkFrame {
  const city =
    cityById(view.city) ??
    (route.dest ? nearestCity(route.dest) : null) ??
    (route.pin ? nearestCity(route.pin) : null);
  // A link naming a route wins over the first location fix, even in the same city.
  const follow =
    route.dest === null && view.camera === null && route.pin === null;
  if (view.camera) {
    return { city, camera: view.camera, preframedDest: route.dest, follow };
  } else if (route.pin) {
    // A pin has no route bounds, so the link frames the pin itself.
    const camera = { center: route.pin, zoom: SEARCH_PIN_ZOOM };
    return { city, camera, preframedDest: null, follow };
  } else if (city) {
    // Framed before the map settles, since the camera decides the active city.
    const camera = { center: city.center, zoom: CITY_ZOOM };
    return { city, camera, preframedDest: null, follow };
  } else {
    return { city, camera: null, preframedDest: null, follow };
  }
}

export interface RoutedPair {
  start: LatLng;
  dest: LatLng;
}

type SolvePlan =
  | { kind: "idle" }
  | { kind: "hold" }
  | { kind: "solve"; request: RoutedPair; isNewTarget: boolean };

// `holding` is a deck that replans on the drop, mid-drag: its plan stays up while the marker moves.
export function planSolve(
  start: LatLng | null,
  dest: LatLng | null,
  routedFor: RoutedPair | null,
  holding: boolean,
): SolvePlan {
  if (!start || !dest) {
    return { kind: "idle" };
  } else if (holding) {
    return { kind: "hold" };
  } else {
    // Same endpoints again (a slider, the clock) recompute without a loading flash.
    const isNewTarget =
      !routedFor ||
      routedFor.dest.lat !== dest.lat ||
      routedFor.dest.lng !== dest.lng ||
      routedFor.start.lat !== start.lat ||
      routedFor.start.lng !== start.lng;
    return {
      kind: "solve",
      request: {
        start: { lat: start.lat, lng: start.lng },
        dest: { lat: dest.lat, lng: dest.lng },
      },
      isNewTarget,
    };
  }
}

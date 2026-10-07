import { expect, test } from "bun:test";
import { CITY_ZOOM, cityById, DEFAULT_CITY, nearestCity } from "../src/cities";
import { decodeView, hashParams, type PlaceUrlState } from "../src/url-state";
import { LOCATED_ZOOM, SEARCH_PIN_ZOOM } from "./shell-helpers";
import {
  frameLink,
  leavesRoute,
  liveStartToPin,
  NO_START,
  placeFirstFix,
  planSolve,
  relabel,
  resolveStart,
  shownStart,
  swapEndpoints,
  tapFollow,
} from "./shell-logic";

const NYC = DEFAULT_CITY;
const SF = cityById("sf") ?? DEFAULT_CITY;
const UNION_SQUARE = { lat: 40.7359, lng: -73.9911 };
const BRYANT_PARK = { lat: 40.7536, lng: -73.9832 };
const FERRY_BUILDING = { lat: 37.7955, lng: -122.3937 };
const DENVER = { lat: 39.7392, lng: -104.9903 };
// About eleven meters per ten-thousandth of a degree of latitude.
const north = (point: { lat: number; lng: number }, meters: number) => ({
  lat: point.lat + meters / 111_320,
  lng: point.lng,
});

const NO_PLACES: PlaceUrlState = {
  start: null,
  dest: null,
  pin: null,
  customHour: null,
  customDay: null,
};
const viewOf = (hash: string) => decodeView(hashParams(hash));

test("the two cities the cases below stand in are distinct", () => {
  expect(NYC.id).toBe("nyc");
  expect(SF.id).toBe("sf");
});

test("a route starts from the reader's position until they name a start", () => {
  const live = resolveStart(NO_START, null, UNION_SQUARE);
  expect(live.point).toEqual(UNION_SQUARE);
  const named = resolveStart(live, BRYANT_PARK, UNION_SQUARE);
  expect(named.point).toEqual(BRYANT_PARK);
});

test("walking a few meters does not ask for the route again, walking on does", () => {
  const first = resolveStart(NO_START, null, UNION_SQUARE);
  const nudged = resolveStart(first, null, north(UNION_SQUARE, 10));
  expect(nudged.point).toBe(first.point);
  const walked = resolveStart(nudged, null, north(UNION_SQUARE, 40));
  expect(walked.point).toEqual(north(UNION_SQUARE, 40));
});

test("small steps add up: the route follows once the reader is 25 m from where it last started", () => {
  let held = resolveStart(NO_START, null, UNION_SQUARE);
  const origin = held.point;
  for (const meters of [10, 20]) {
    held = resolveStart(held, null, north(UNION_SQUARE, meters));
    expect(held.point).toBe(origin);
  }
  held = resolveStart(held, null, north(UNION_SQUARE, 30));
  expect(held.point).toEqual(north(UNION_SQUARE, 30));
});

test("pinning the live start where it stands, or naming it, keeps the same search", () => {
  const live = resolveStart(NO_START, null, UNION_SQUARE);
  const pinned = resolveStart(live, { ...UNION_SQUARE }, UNION_SQUARE);
  expect(pinned.point).toBe(live.point);
  const relabelled = resolveStart(pinned, { ...UNION_SQUARE }, BRYANT_PARK);
  expect(relabelled).toBe(pinned);
});

test("clearing a named start goes back to the position, however near the old one was", () => {
  const named = resolveStart(NO_START, UNION_SQUARE, null);
  const cleared = resolveStart(named, null, north(UNION_SQUARE, 5));
  expect(cleared.point).toEqual(north(UNION_SQUARE, 5));
});

test("with no usable position and no named start there is nothing to route from", () => {
  const live = resolveStart(NO_START, null, UNION_SQUARE);
  expect(resolveStart(live, null, null).point).toBeNull();
  expect(resolveStart(NO_START, null, null)).toBe(NO_START);
});

test("a destination with only a live start pins that start, so the link can be shared", () => {
  expect(liveStartToPin(BRYANT_PARK, null, UNION_SQUARE)).toEqual(UNION_SQUARE);
  expect(liveStartToPin(null, null, UNION_SQUARE)).toBeNull();
  expect(liveStartToPin(BRYANT_PARK, UNION_SQUARE, BRYANT_PARK)).toBeNull();
  expect(liveStartToPin(BRYANT_PARK, null, null)).toBeNull();
});

test("a city switch with a route up clears the route", () => {
  expect(leavesRoute(BRYANT_PARK, UNION_SQUARE)).toBe(true);
  expect(leavesRoute(BRYANT_PARK, null)).toBe(true);
  // A lone start is a route in the making, and is no more use in the other city.
  expect(leavesRoute(null, UNION_SQUARE)).toBe(true);
});

test("a city switch with nothing placed closes nothing", () => {
  expect(leavesRoute(null, null)).toBe(false);
});

test("switching to the city the reader stands in closes the route and pins no start", () => {
  // A destination in New York, the reader in San Francisco, and the switch to San Francisco.
  expect(leavesRoute(BRYANT_PARK, null)).toBe(true);
  // With the route closed there is no destination, so the fix there is not pinned as a start.
  expect(liveStartToPin(null, null, FERRY_BUILDING)).toBeNull();
});

test("after a swap the start marker shows the asked point until its route lands", () => {
  const snapped = north(UNION_SQUARE, 8);
  // The drawn route still starts at Union Square; the reader now asks to start from Bryant Park.
  expect(shownStart(snapped, UNION_SQUARE, BRYANT_PARK)).toEqual(BRYANT_PARK);
  // Once the route from Bryant Park is drawn, the marker takes its snapped start.
  const landed = north(BRYANT_PARK, 5);
  expect(shownStart(landed, BRYANT_PARK, BRYANT_PARK)).toEqual(landed);
  // Nothing drawn yet shows what was asked, and nothing asked shows nothing.
  expect(shownStart(null, null, BRYANT_PARK)).toEqual(BRYANT_PARK);
  expect(shownStart(null, null, null)).toBeNull();
});

test("a tap on follow asks for a location when there is none, whatever follow says", () => {
  expect(tapFollow(true, null, false)).toBe("locate");
  expect(tapFollow(false, null, false)).toBe("locate");
});

test("a tap on follow with a fix releases, engages, or moves to the reader's city", () => {
  expect(tapFollow(true, UNION_SQUARE, true)).toBe("release");
  expect(tapFollow(false, UNION_SQUARE, true)).toBe("engage");
  expect(tapFollow(false, FERRY_BUILDING, false)).toBe("enter");
  // Follow can't hold on a fix outside the city, so a tap there engages by moving too.
  expect(tapFollow(true, FERRY_BUILDING, false)).toBe("enter");
});

test("swap exchanges start and destination", () => {
  expect(swapEndpoints(UNION_SQUARE, BRYANT_PARK)).toEqual({
    manualStart: BRYANT_PARK,
    dest: UNION_SQUARE,
  });
  // With a live start the destination becomes the start and the other end is asked for.
  expect(swapEndpoints(null, BRYANT_PARK)).toEqual({
    manualStart: BRYANT_PARK,
    dest: null,
  });
});

test("a looked-up name lands on the pin it was asked for and on no other", () => {
  const pin = { ...UNION_SQUARE, label: "Dropped pin" };
  expect(relabel(pin, UNION_SQUARE, "Union Square")).toEqual({
    ...UNION_SQUARE,
    label: "Union Square",
  });
  // The pin moved, or went, while the lookup ran.
  const moved = { ...BRYANT_PARK, label: "Dropped pin" };
  expect(relabel(moved, UNION_SQUARE, "Union Square")).toBe(moved);
  expect(relabel(null, UNION_SQUARE, "Union Square")).toBeNull();
});

test("the first fix opens the map on the reader, in their city", () => {
  expect(placeFirstFix(FERRY_BUILDING, false)).toEqual({
    move: { city: SF, target: { ...FERRY_BUILDING, zoom: LOCATED_ZOOM } },
    follow: true,
  });
});

test("a reader outside every city sees the nearest one whole, unfollowed", () => {
  const nearest = nearestCity(DENVER);
  expect(placeFirstFix(DENVER, false)).toEqual({
    move: { city: nearest, target: { ...nearest.center, zoom: CITY_ZOOM } },
    follow: false,
  });
});

test("a link keeps its city, route and camera from a reader outside every city", () => {
  // Nothing moves, whether the nearest city is the link's or the other one.
  expect(placeFirstFix(DENVER, true)).toEqual({ move: null, follow: false });
});

test("a link's city is not overridden by where the reader happens to be", () => {
  expect(placeFirstFix(FERRY_BUILDING, true)).toBeNull();
});

test("a link with no place leaves the city and the camera to the first fix", () => {
  expect(frameLink(viewOf(""), NO_PLACES)).toEqual({
    city: null,
    camera: null,
    preframedDest: null,
    follow: true,
  });
});

test("a link to a destination opens in that destination's city, off the reader's position", () => {
  const frame = frameLink(viewOf(""), { ...NO_PLACES, dest: FERRY_BUILDING });
  expect(frame.city).toBe(SF);
  expect(frame.camera).toEqual({ center: SF.center, zoom: CITY_ZOOM });
  expect(frame.follow).toBe(false);
});

test("a link's own camera and city win over where its places are", () => {
  const frame = frameLink(viewOf("#at=40.75,-73.98,15&city=nyc"), {
    ...NO_PLACES,
    dest: FERRY_BUILDING,
  });
  expect(frame.city).toBe(NYC);
  expect(frame.camera).toEqual({
    center: { lat: 40.75, lng: -73.98 },
    zoom: 15,
  });
  // The sharer's framing stands, so the route must not reframe the map when it lands.
  expect(frame.preframedDest).toEqual(FERRY_BUILDING);
  expect(frame.follow).toBe(false);
});

test("a link to a looked-up place frames the place itself", () => {
  const frame = frameLink(viewOf(""), { ...NO_PLACES, pin: FERRY_BUILDING });
  expect(frame.city).toBe(SF);
  expect(frame.camera).toEqual({
    center: FERRY_BUILDING,
    zoom: SEARCH_PIN_ZOOM,
  });
  expect(frame.follow).toBe(false);
});

test("a link naming only a city shows that city and still follows the reader", () => {
  const frame = frameLink(viewOf("#city=sf"), NO_PLACES);
  expect(frame.city).toBe(SF);
  expect(frame.camera).toEqual({ center: SF.center, zoom: CITY_ZOOM });
  expect(frame.follow).toBe(true);
});

test("no route is asked for until both ends exist", () => {
  expect(planSolve(null, BRYANT_PARK, null, false)).toEqual({ kind: "idle" });
  expect(planSolve(UNION_SQUARE, null, null, false)).toEqual({ kind: "idle" });
  // Even mid-drag: the dragged marker's route is gone with its other end.
  expect(planSolve(null, null, null, true)).toEqual({ kind: "idle" });
});

test("new endpoints show the route loading; the same ones re-costed do not", () => {
  const first = planSolve(UNION_SQUARE, BRYANT_PARK, null, false);
  expect(first).toEqual({
    kind: "solve",
    request: { start: UNION_SQUARE, dest: BRYANT_PARK },
    isNewTarget: true,
  });
  const routed = first.kind === "solve" ? first.request : null;
  // A slider or the clock asks again for the same pair.
  const again = planSolve(
    { ...UNION_SQUARE },
    { ...BRYANT_PARK },
    routed,
    false,
  );
  expect(again.kind === "solve" && again.isNewTarget).toBe(false);
  const moved = planSolve(UNION_SQUARE, FERRY_BUILDING, routed, false);
  expect(moved.kind === "solve" && moved.isNewTarget).toBe(true);
  const restarted = planSolve(BRYANT_PARK, BRYANT_PARK, routed, false);
  expect(restarted.kind === "solve" && restarted.isNewTarget).toBe(true);
});

test("a plan that waits for the drop is neither cleared nor re-asked while the marker moves", () => {
  expect(planSolve(UNION_SQUARE, BRYANT_PARK, null, true)).toEqual({
    kind: "hold",
  });
});

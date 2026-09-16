import { expect, test } from "bun:test";
import { DEFAULT_MODE, MODES } from "./modes/modes";
import { DEFAULT_TREE_WEIGHT, type RouteWeights } from "./routing/cost";
import {
  DEFAULT_MODE_STATE,
  DEFAULT_ROUTE_STATE,
  DEFAULT_WEIGHTS,
  decodeModes,
  decodeRoute,
  decodeView,
  encodeModes,
  encodeRoute,
  encodeView,
  formatHash,
  hashParams,
  type ModeUrlState,
  type RouteUrlState,
  replaceOwnKeys,
  shareUrl,
} from "./url-state";

const roundTrip = (state: RouteUrlState): RouteUrlState =>
  decodeRoute(hashParams(formatHash(encodeRoute(state))));

test("a fresh session writes no keys at all", () => {
  expect(formatHash(encodeRoute(DEFAULT_ROUTE_STATE))).toBe("");
});

test("every route field survives a round trip", () => {
  const weights: RouteWeights = {
    tree: 0.42,
    ferry: 0.9,
    landmark: 0.75,
    art: 0.3,
    hill: 0.4,
    highway: 0.05,
    commercial: 0.6,
    industrial: 0.35,
    historic: 0.55,
    bridge: 0.65,
    shade: -0.85,
    shelter: 0.25,
    transit: 1.5,
    allowFerries: false,
    // No key of its own: the planner owns it, so a link neither carries nor restores it.
    allowTransit: true,
    allowSheds: false,
    allowCrossings: true,
  };
  const state: RouteUrlState = {
    start: { lat: 40.712776, lng: -74.005974 },
    dest: { lat: 40.785091, lng: -73.968285 },
    pin: { lat: 40.741895, lng: -73.989308 },
    weights,
    customHour: 14.25,
    customDay: "2026-12-21",
  };
  expect(roundTrip(state)).toEqual(state);
});

test("a searched pin travels on its own, without a route", () => {
  const pin = { lat: 40.741895, lng: -73.989308 };
  const hash = formatHash(encodeRoute({ ...DEFAULT_ROUTE_STATE, pin }));
  expect(hash).toBe("#pin=40.741895,-73.989308");
  expect(decodeRoute(hashParams(hash))).toEqual({
    ...DEFAULT_ROUTE_STATE,
    pin,
  });
});

test("a rewrite owns the pin key, so clearing the pin drops it", () => {
  const hash = replaceOwnKeys(
    "#pin=40.741895,-73.989308&about",
    encodeRoute(DEFAULT_ROUTE_STATE),
  );
  expect(hash).toBe("#about");
});

test("only the fields off their defaults are written", () => {
  const hash = formatHash(
    encodeRoute({
      ...DEFAULT_ROUTE_STATE,
      weights: { ...DEFAULT_WEIGHTS, shade: -0.5 },
    }),
  );
  expect(hash).toBe("#shade=-0.5");
});

test("coordinates keep 6 decimals and weights 2", () => {
  const hash = formatHash(
    encodeRoute({
      ...DEFAULT_ROUTE_STATE,
      dest: { lat: 40.7127763456, lng: -74.0059731111 },
      weights: { ...DEFAULT_WEIGHTS, tree: 0.123456 },
    }),
  );
  expect(hash).toBe("#to=40.712776,-74.005973&tree=0.12");
});

test("a missing key takes the caller's default, an unknown key is ignored", () => {
  const stored: RouteUrlState = {
    ...DEFAULT_ROUTE_STATE,
    weights: { ...DEFAULT_WEIGHTS, tree: 0.25 },
  };
  const decoded = decodeRoute(hashParams("#ninth=0.5&art=0.9"), stored);
  expect(decoded.weights.tree).toBe(0.25); // the persisted value, untouched by the link
  expect(decoded.weights.art).toBe(0.9);
  expect(decoded.dest).toBeNull();
});

test("a malformed value falls back rather than poisoning the state", () => {
  const decoded = decodeRoute(hashParams("#to=nowhere&tree=lots&time=x"));
  expect(decoded.dest).toBeNull();
  expect(decoded.weights.tree).toBe(DEFAULT_TREE_WEIGHT);
  expect(decoded.customHour).toBe(12); // "time" was present, so an hour is pinned
});

test("out-of-range weights clamp instead of breaking the search", () => {
  const decoded = decodeRoute(hashParams("#tree=9&shade=-4"));
  expect(decoded.weights.tree).toBe(1);
  expect(decoded.weights.shade).toBe(-1);
});

test("no view keys leaves every part of the view alone", () => {
  expect(decodeView(hashParams("#tree=0.5"))).toEqual({
    camera: null,
    overlays: null,
    city: null,
  });
});

test("the view round trips, and an empty layer list stays distinct from none", () => {
  const camera = { center: { lat: 40.7128, lng: -74.006 }, zoom: 15.5 };
  const full = decodeView(
    hashParams(formatHash(encodeView(camera, ["shade"], "nyc"))),
  );
  expect(full).toEqual({ camera, overlays: ["shade"], city: "nyc" });
  const bare = decodeView(
    hashParams(formatHash(encodeView(camera, [], "nyc"))),
  );
  expect(bare.overlays).toEqual([]);
});

test("rewriting the route keeps foreign keys, including the About flag", () => {
  const hash = replaceOwnKeys(
    "#about&tree=0.5&at=40.7,-74,15&ninth=1",
    encodeRoute({ ...DEFAULT_ROUTE_STATE, weights: DEFAULT_WEIGHTS }),
  );
  expect(hash).toBe("#about&ninth=1");
  expect(hashParams(hash).has("about")).toBe(true);
});

// The key was written as `crossings=0` before the flag was inverted and is `crossings=1` now, and in
// both schemes it was only ever written when crossings are FREE. A link shared before the rename has
// to keep describing the route it described.
test("both spellings of the crossings key mean crossings are free", () => {
  const decode = (hash: string) =>
    decodeRoute(hashParams(hash)).weights.allowCrossings;
  expect(decode("#crossings=0")).toBe(true); // shared before the rename
  expect(decode("#crossings=1")).toBe(true); // shared since
  expect(decode("#at=40.7,-74,15")).toBe(false); // absent: the default, priced
});

const modeRoundTrip = (state: ModeUrlState): ModeUrlState =>
  decodeModes(hashParams(formatHash(encodeModes(state))));

test("a fresh Modes session writes no keys either", () => {
  expect(formatHash(encodeModes(DEFAULT_MODE_STATE))).toBe("");
});

test("every Modes field survives a round trip", () => {
  const state: ModeUrlState = {
    start: { lat: 40.712776, lng: -74.005974 },
    dest: { lat: 40.785091, lng: -73.968285 },
    pin: { lat: 40.741895, lng: -73.989308 },
    mode: "historic",
    alt: 2,
    toggles: { sun: "shade", hills: "some", ferries: false },
    customHour: null,
    customDay: null,
  };
  expect(modeRoundTrip(state)).toEqual(state);
});

// Modes routes at now: it writes no clock, and it reads none out of a link that carries Explorer's.
test("a pinned clock is neither written nor read by Modes", () => {
  const pinned = formatHash(
    encodeModes({
      ...DEFAULT_MODE_STATE,
      customHour: 14.25,
      customDay: "2026-12-21",
    }),
  );
  expect(pinned).toBe("");
  const decoded = decodeModes(
    hashParams("#to=40.75,-73.98&time=14&date=2026-12-21"),
  );
  expect(decoded.customHour).toBeNull();
  expect(decoded.customDay).toBeNull();
});

test("only the Modes fields off their defaults are written", () => {
  const hash = formatHash(
    encodeModes({
      ...DEFAULT_MODE_STATE,
      mode: "rain",
      toggles: { ...DEFAULT_MODE_STATE.toggles, sun: "sun" },
    }),
  );
  expect(hash).toBe("#mode=rain&sun=sun");
});

// The recipient's own settings fill in whatever the link leaves out, so a link that pins a card has
// to pin the plan that card belongs to — every key of it, however ordinary the sender's own are.
test("a link that pins a card pins the plan it is a card of", () => {
  const sent: ModeUrlState = {
    ...DEFAULT_MODE_STATE,
    dest: { lat: 40.785091, lng: -73.968285 },
    alt: 2,
  };
  const theirs: ModeUrlState = {
    ...DEFAULT_MODE_STATE,
    mode: "rain",
    toggles: { sun: "sun", hills: "some", ferries: false },
  };
  const opened = decodeModes(hashParams(formatHash(encodeModes(sent))), theirs);
  expect(opened.mode).toBe(sent.mode);
  expect(opened.toggles).toEqual(sent.toggles);
  expect(opened.alt).toBe(2);
});

// The one key both pages encode the same way.
test("the ferry gate is spelled the way Explorer spells it", () => {
  const barred = formatHash(
    encodeModes({
      ...DEFAULT_MODE_STATE,
      toggles: { ...DEFAULT_MODE_STATE.toggles, ferries: false },
    }),
  );
  expect(barred).toBe("#ferries=0");
  expect(decodeModes(hashParams(barred)).toggles.ferries).toBe(false);
  expect(decodeRoute(hashParams(barred)).weights.allowFerries).toBe(false);
});

// Old links break by design, but they must break by opening rather than by refusing to.
test("a link written before Modes existed opens the default mode where it points", () => {
  const decoded = decodeModes(
    hashParams("#from=40.7,-74&to=40.75,-73.98&tree=0.9&shade=-1&crossings=1"),
  );
  expect(decoded.mode).toBe(DEFAULT_MODE.id);
  expect(decoded.toggles).toEqual(DEFAULT_MODE_STATE.toggles);
  expect(decoded.dest).toEqual({ lat: 40.75, lng: -73.98 });
});

test("a mode or a switch this build does not know falls back rather than breaking", () => {
  const decoded = decodeModes(
    hashParams("#mode=cartographer&sun=moonlight&hills=lots&alt=third"),
  );
  expect(decoded.mode).toBe(DEFAULT_MODE.id);
  expect(decoded.toggles).toEqual(DEFAULT_MODE_STATE.toggles);
  expect(decoded.alt).toBeNull();
});

test("a missing Modes key takes the reader's own default", () => {
  const stored: ModeUrlState = {
    ...DEFAULT_MODE_STATE,
    mode: "streetlife",
    toggles: { sun: "shade", hills: "none", ferries: false },
  };
  const decoded = decodeModes(hashParams("#to=40.75,-73.98"), stored);
  expect(decoded.mode).toBe("streetlife");
  expect(decoded.toggles).toEqual(stored.toggles);
});

test("every mode's id survives its own link", () => {
  for (const mode of MODES) {
    const hash = formatHash(
      encodeModes({ ...DEFAULT_MODE_STATE, mode: mode.id }),
    );
    expect(decodeModes(hashParams(hash)).mode, mode.id).toBe(mode.id);
  }
});

test("a rewrite clears the Modes keys as well as the route's", () => {
  const hash = replaceOwnKeys(
    "#mode=rain&sun=sun&hills=none&alt=1&about",
    encodeRoute(DEFAULT_ROUTE_STATE),
  );
  expect(hash).toBe("#about");
});

test("a share link is the page it was made on, plus the hash", () => {
  const page = {
    origin: "https://hafaio.github.io",
    pathname: "/scenic-route/explorer",
    search: "",
  };
  expect(shareUrl(page, encodeRoute({ ...DEFAULT_ROUTE_STATE }))).toBe(
    "https://hafaio.github.io/scenic-route/explorer",
  );
  expect(
    shareUrl(
      { ...page, pathname: "/scenic-route/" },
      encodeModes({ ...DEFAULT_MODE_STATE, mode: "rain" }),
    ),
  ).toBe("https://hafaio.github.io/scenic-route/#mode=rain");
});

test("the bridge weight rides on its own key", () => {
  const weights: RouteWeights = { ...DEFAULT_WEIGHTS, bridge: 0.75 };
  const hash = formatHash(encodeRoute({ ...DEFAULT_ROUTE_STATE, weights }));

  expect(hash).toBe("#bridge=0.75");
  expect(decodeRoute(hashParams(hash)).weights.bridge).toBe(0.75);
});

import { expect, test } from "bun:test";
import { DEFAULT_LENS, LENSES } from "./lenses/lenses";
import { DEFAULT_TREE_WEIGHT, type RouteWeights } from "./routing/cost";
import {
  carriesState,
  DEFAULT_LENS_STATE,
  DEFAULT_ROUTE_STATE,
  DEFAULT_WEIGHTS,
  decodeLenses,
  decodeRoute,
  decodeView,
  encodeLenses,
  encodeRoute,
  encodeView,
  formatHash,
  hashParams,
  type LensUrlState,
  linkState,
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
    // No key of its own: the planner owns it.
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
  expect(decoded.customHour).toBeNull(); // an unreadable time pins none
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

// `crossings=0` predates the flag inversion; both schemes wrote it only when crossings are free.
test("both spellings of the crossings key mean crossings are free", () => {
  const decode = (hash: string) =>
    decodeRoute(hashParams(hash)).weights.allowCrossings;
  expect(decode("#crossings=0")).toBe(true); // shared before the rename
  expect(decode("#crossings=1")).toBe(true); // shared since
  expect(decode("#at=40.7,-74,15")).toBe(false); // absent: the default, priced
});

const lensRoundTrip = (state: LensUrlState): LensUrlState =>
  decodeLenses(hashParams(formatHash(encodeLenses(state))));

test("a fresh Lenses session writes no keys either", () => {
  expect(formatHash(encodeLenses(DEFAULT_LENS_STATE))).toBe("");
});

test("every Lenses field survives a round trip", () => {
  const state: LensUrlState = {
    start: { lat: 40.712776, lng: -74.005974 },
    dest: { lat: 40.785091, lng: -73.968285 },
    pin: { lat: 40.741895, lng: -73.989308 },
    lens: "historic",
    alt: 2,
    toggles: { sun: "shade", hills: "some", ferries: false },
    customHour: null,
    customDay: null,
  };
  expect(lensRoundTrip(state)).toEqual(state);
});

test("a pinned clock is neither written nor read by Lenses", () => {
  const pinned = formatHash(
    encodeLenses({
      ...DEFAULT_LENS_STATE,
      customHour: 14.25,
      customDay: "2026-12-21",
    }),
  );
  expect(pinned).toBe("");
  const decoded = decodeLenses(
    hashParams("#to=40.75,-73.98&time=14&date=2026-12-21"),
  );
  expect(decoded.customHour).toBeNull();
  expect(decoded.customDay).toBeNull();
});

test("only the Lenses fields off their defaults are written", () => {
  const hash = formatHash(
    encodeLenses({
      ...DEFAULT_LENS_STATE,
      lens: "rain",
      toggles: { ...DEFAULT_LENS_STATE.toggles, sun: "sun" },
    }),
  );
  expect(hash).toBe("#lens=rain&sun=sun");
});

// The recipient's settings fill the gaps, so a link pinning a card must pin every key of its plan.
test("a link that pins a card pins the plan it is a card of", () => {
  const sent: LensUrlState = {
    ...DEFAULT_LENS_STATE,
    dest: { lat: 40.785091, lng: -73.968285 },
    alt: 2,
  };
  const theirs: LensUrlState = {
    ...DEFAULT_LENS_STATE,
    lens: "rain",
    toggles: { sun: "sun", hills: "some", ferries: false },
  };
  const opened = decodeLenses(
    hashParams(formatHash(encodeLenses(sent))),
    theirs,
  );
  expect(opened.lens).toBe(sent.lens);
  expect(opened.toggles).toEqual(sent.toggles);
  expect(opened.alt).toBe(2);
});

test("the ferry gate is spelled the way Explorer spells it", () => {
  const barred = formatHash(
    encodeLenses({
      ...DEFAULT_LENS_STATE,
      toggles: { ...DEFAULT_LENS_STATE.toggles, ferries: false },
    }),
  );
  expect(barred).toBe("#ferries=0");
  expect(decodeLenses(hashParams(barred)).toggles.ferries).toBe(false);
  expect(decodeRoute(hashParams(barred)).weights.allowFerries).toBe(false);
});

test("a link written before Lenses existed opens the default lens where it points", () => {
  const decoded = decodeLenses(
    hashParams("#from=40.7,-74&to=40.75,-73.98&tree=0.9&shade=-1&crossings=1"),
  );
  expect(decoded.lens).toBe(DEFAULT_LENS.id);
  expect(decoded.toggles).toEqual(DEFAULT_LENS_STATE.toggles);
  expect(decoded.dest).toEqual({ lat: 40.75, lng: -73.98 });
});

test("a lens or a switch this build does not know falls back rather than breaking", () => {
  const decoded = decodeLenses(
    hashParams("#lens=cartographer&sun=moonlight&hills=lots&alt=third"),
  );
  expect(decoded.lens).toBe(DEFAULT_LENS.id);
  expect(decoded.toggles).toEqual(DEFAULT_LENS_STATE.toggles);
  expect(decoded.alt).toBeNull();
});

test("a missing Lenses key takes the reader's own default", () => {
  const stored: LensUrlState = {
    ...DEFAULT_LENS_STATE,
    lens: "streetlife",
    toggles: { sun: "shade", hills: "none", ferries: false },
  };
  const decoded = decodeLenses(hashParams("#to=40.75,-73.98"), stored);
  expect(decoded.lens).toBe("streetlife");
  expect(decoded.toggles).toEqual(stored.toggles);
});

test("every lens's id survives its own link", () => {
  for (const lens of LENSES) {
    const hash = formatHash(
      encodeLenses({ ...DEFAULT_LENS_STATE, lens: lens.id }),
    );
    expect(decodeLenses(hashParams(hash)).lens, lens.id).toBe(lens.id);
  }
});

test("a rewrite clears the Lenses keys as well as the route's", () => {
  const hash = replaceOwnKeys(
    "#lens=rain&sun=sun&hills=none&alt=1&about",
    encodeRoute(DEFAULT_ROUTE_STATE),
  );
  expect(hash).toBe("#about");
});

test("a share link is the page it was made on, plus the hash", () => {
  const page = {
    origin: "https://scenic.hafa.cc",
    pathname: "/explorer",
    search: "",
  };
  expect(shareUrl(page, encodeRoute({ ...DEFAULT_ROUTE_STATE }))).toBe(
    "https://scenic.hafa.cc/explorer",
  );
  expect(
    shareUrl(
      { ...page, pathname: "/" },
      encodeLenses({ ...DEFAULT_LENS_STATE, lens: "rain" }),
    ),
  ).toBe("https://scenic.hafa.cc/#lens=rain");
});

test("the bridge weight rides on its own key", () => {
  const weights: RouteWeights = { ...DEFAULT_WEIGHTS, bridge: 0.75 };
  const hash = formatHash(encodeRoute({ ...DEFAULT_ROUTE_STATE, weights }));

  expect(hash).toBe("#bridge=0.75");
  expect(decodeRoute(hashParams(hash)).weights.bridge).toBe(0.75);
});

test("a blank or unreadable coordinate is no point, not the equator", () => {
  for (const hash of ["#to=,", "#to=", "#to=,-73.9", "#to=40.7,", "#to= , "]) {
    expect(decodeRoute(hashParams(hash)).dest).toBeNull();
  }
  expect(decodeRoute(hashParams("#from=,&pin=,")).start).toBeNull();
  expect(decodeRoute(hashParams("#from=,&pin=,")).pin).toBeNull();
  expect(decodeRoute(hashParams("#to=abc,def")).dest).toBeNull();
  expect(decodeRoute(hashParams("#to=91,0")).dest).toBeNull();
  expect(decodeRoute(hashParams("#to=0,181")).dest).toBeNull();
  // A real point on the equator still reads.
  expect(decodeRoute(hashParams("#to=0,0")).dest).toEqual({ lat: 0, lng: 0 });
  // The camera is a point and a zoom, and a blank is neither.
  expect(decodeView(hashParams("#at=,,14")).camera).toBeNull();
  expect(decodeView(hashParams("#at=40.7,-73.9,")).camera).toBeNull();
});

test("a blank weight or card keeps the reader's own, not zero", () => {
  expect(decodeRoute(hashParams("#tree=")).weights.tree).toBe(
    DEFAULT_TREE_WEIGHT,
  );
  expect(decodeLenses(hashParams("#alt=")).alt).toBeNull();
});

test("an unreadable time pins no time", () => {
  expect(decodeRoute(hashParams("#time=abc")).customHour).toBeNull();
  expect(decodeRoute(hashParams("#time=")).customHour).toBeNull();
  expect(decodeRoute(hashParams("#time=9.5")).customHour).toBe(9.5);
  // Out of range is still a time, held to the day.
  expect(decodeRoute(hashParams("#time=30")).customHour).toBe(24);
});

test("a date the calendar lacks pins no day", () => {
  expect(decodeRoute(hashParams("#date=2026-13-45")).customDay).toBeNull();
  expect(decodeRoute(hashParams("#date=2026-02-30")).customDay).toBeNull();
  expect(decodeRoute(hashParams("#date=2027-02-29")).customDay).toBeNull();
  expect(decodeRoute(hashParams("#date=2028-02-29")).customDay).toBe(
    "2028-02-29",
  );
  expect(decodeRoute(hashParams("#date=tomorrow")).customDay).toBeNull();
});

test("link state compares the reader's keys and nothing else", () => {
  const link = "#from=40.758,-73.9855&to=40.7308,-73.9973&lens=quiet";
  // A dialog flag, key order and comma escaping change nothing.
  expect(linkState(`${link}&about`)).toBe(linkState(link));
  expect(
    linkState("#lens=quiet&to=40.7308%2C-73.9973&from=40.758,-73.9855"),
  ).toBe(linkState(link));
  expect(linkState("#about&settings=offline")).toBe("");
  expect(linkState("#to=40.73,-73.99")).not.toBe(linkState(link));
  expect(linkState("#city=sf")).not.toBe("");
});

test("a hash that only says where to look carries no state", () => {
  expect(carriesState("#at=40.7,-73.9,14&layers=canopy&city=nyc")).toBe(false);
  expect(carriesState("#about")).toBe(false);
  expect(carriesState("#tree=0.5")).toBe(true);
  expect(carriesState("#lens=quiet&about")).toBe(true);
});

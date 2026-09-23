// Query parameters so old links survive new factors: defaults omitted, unknown keys left alone.

import {
  DEFAULT_MODE,
  DEFAULT_TOGGLES,
  HILLS_VALUES,
  isModeId,
  type ModeId,
  SUN_VALUES,
  type Toggles,
} from "./modes/modes";
import {
  DEFAULT_ART_WEIGHT,
  DEFAULT_BRIDGE_WEIGHT,
  DEFAULT_COMMERCIAL_WEIGHT,
  DEFAULT_FERRY_WEIGHT,
  DEFAULT_HIGHWAY_WEIGHT,
  DEFAULT_HILL_WEIGHT,
  DEFAULT_HISTORIC_WEIGHT,
  DEFAULT_INDUSTRIAL_WEIGHT,
  DEFAULT_LANDMARK_WEIGHT,
  DEFAULT_SHADE_WEIGHT,
  DEFAULT_SHELTER_WEIGHT,
  DEFAULT_TRANSIT_WEIGHT,
  DEFAULT_TREE_WEIGHT,
  MAX_ART_WEIGHT,
  MAX_BRIDGE_WEIGHT,
  MAX_COMMERCIAL_WEIGHT,
  MAX_FERRY_WEIGHT,
  MAX_HIGHWAY_WEIGHT,
  MAX_HILL_WEIGHT,
  MAX_HISTORIC_WEIGHT,
  MAX_INDUSTRIAL_WEIGHT,
  MAX_LANDMARK_WEIGHT,
  MAX_SHADE_WEIGHT,
  MAX_SHELTER_WEIGHT,
  MAX_TRANSIT_WEIGHT,
  MAX_TREE_WEIGHT,
  type RouteWeights,
} from "./routing/cost";
import type { FactorKey } from "./routing/factors";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface PlaceUrlState {
  start: LatLng | null; // a manually set start; null means the live location
  dest: LatLng | null;
  // A looked-up place left on the map; no name, since the local lookup names it back.
  pin: LatLng | null;
  customHour: number | null; // null tracks the wall clock
  customDay: string | null; // "YYYY-MM-DD"; null is today
}

export interface RouteUrlState extends PlaceUrlState {
  weights: RouteWeights;
}

export interface ModeUrlState extends PlaceUrlState {
  mode: ModeId; // an unknown one reads as the default
  alt: number | null; // the chosen route card, by index; null while none is
  toggles: Toggles;
}

export interface Camera {
  center: LatLng;
  zoom: number;
}

// Every field is null when the link doesn't carry it, which must leave that part of the app alone.
export interface ViewUrlState {
  camera: Camera | null;
  overlays: readonly string[] | null; // overlay ids; the caller validates them against the registry
  // Explicit, since inferring from the camera would drop `layers` only some cities offer.
  city: string | null;
}

export const DEFAULT_WEIGHTS: RouteWeights = {
  tree: DEFAULT_TREE_WEIGHT,
  ferry: DEFAULT_FERRY_WEIGHT,
  landmark: DEFAULT_LANDMARK_WEIGHT,
  art: DEFAULT_ART_WEIGHT,
  highway: DEFAULT_HIGHWAY_WEIGHT,
  hill: DEFAULT_HILL_WEIGHT,
  commercial: DEFAULT_COMMERCIAL_WEIGHT,
  industrial: DEFAULT_INDUSTRIAL_WEIGHT,
  historic: DEFAULT_HISTORIC_WEIGHT,
  bridge: DEFAULT_BRIDGE_WEIGHT,
  shade: DEFAULT_SHADE_WEIGHT,
  shelter: DEFAULT_SHELTER_WEIGHT,
  transit: DEFAULT_TRANSIT_WEIGHT,
  allowFerries: true,
  // No key: not reader-settable. See INTERNAL_FLAGS in routing/cost.ts.
  allowTransit: true,
  allowSheds: true,
  // Off, or routes zigzag across streets to chase the shady side.
  allowCrossings: false,
};

const DEFAULT_PLACE_STATE: PlaceUrlState = {
  start: null,
  dest: null,
  pin: null,
  customHour: null,
  customDay: null,
};

export const DEFAULT_ROUTE_STATE: RouteUrlState = {
  ...DEFAULT_PLACE_STATE,
  weights: DEFAULT_WEIGHTS,
};

export const DEFAULT_MODE_STATE: ModeUrlState = {
  ...DEFAULT_PLACE_STATE,
  mode: DEFAULT_MODE.id,
  alt: null,
  toggles: DEFAULT_TOGGLES,
};

// An instruction, not state: stripped on arrival (`withoutDestQuery`) so it can't refire;
// the hash writer can't strip it because it writes nothing until a route exists.
const DEST_QUERY_KEY = "q";

const COORD_DIGITS = 6; // ~0.1 m
const WEIGHT_DIGITS = 2;
const ZOOM_DIGITS = 2;
const MAX_ZOOM = 22;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface WeightParam {
  key: string;
  field: FactorKey;
  min: number;
  max: number;
}

const WEIGHT_PARAMS: readonly WeightParam[] = [
  { key: "tree", field: "tree", min: 0, max: MAX_TREE_WEIGHT },
  { key: "ferry", field: "ferry", min: 0, max: MAX_FERRY_WEIGHT },
  { key: "landmark", field: "landmark", min: 0, max: MAX_LANDMARK_WEIGHT },
  { key: "art", field: "art", min: 0, max: MAX_ART_WEIGHT },
  { key: "highway", field: "highway", min: 0, max: MAX_HIGHWAY_WEIGHT },
  { key: "hill", field: "hill", min: 0, max: MAX_HILL_WEIGHT },
  {
    key: "commercial",
    field: "commercial",
    min: 0,
    max: MAX_COMMERCIAL_WEIGHT,
  },
  {
    key: "industrial",
    field: "industrial",
    min: 0,
    max: MAX_INDUSTRIAL_WEIGHT,
  },
  { key: "historic", field: "historic", min: 0, max: MAX_HISTORIC_WEIGHT },
  { key: "bridge", field: "bridge", min: 0, max: MAX_BRIDGE_WEIGHT },
  {
    key: "shade",
    field: "shade",
    min: -MAX_SHADE_WEIGHT,
    max: MAX_SHADE_WEIGHT,
  },
  { key: "shelter", field: "shelter", min: 0, max: MAX_SHELTER_WEIGHT },
  { key: "transit", field: "transit", min: 0, max: MAX_TRANSIT_WEIGHT },
];

// Both shells' keys are cleared together, or a stale `mode=` rides along on an Explorer link.
const PLACE_KEYS: readonly string[] = [
  "from",
  "to",
  "pin",
  DEST_QUERY_KEY,
  "time",
  "date",
];
const ROUTE_KEYS: readonly string[] = [
  ...PLACE_KEYS,
  ...WEIGHT_PARAMS.map((param) => param.key),
  "ferries",
  "sheds",
  "crossings",
];
const MODE_KEYS: readonly string[] = [
  ...PLACE_KEYS,
  "mode",
  "alt",
  "sun",
  "hills",
  "ferries", // Explorer's gate key, same encoding
];
const VIEW_KEYS: readonly string[] = ["at", "layers", "city"];

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatPoint({ lat, lng }: LatLng): string {
  return `${round(lat, COORD_DIGITS)},${round(lng, COORD_DIGITS)}`;
}

// A "lat,lng" pair, or null when it is absent, malformed, or off the globe.
function parsePoint(text: string | null): LatLng | null {
  if (text === null) {
    return null;
  }
  const [latText, lngText, ...rest] = text.split(",");
  if (rest.length > 0) {
    return null;
  }
  const lat = Number(latText);
  const lng = Number(lngText);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  ) {
    return null;
  }
  return { lat, lng };
}

// A number within bounds, or the default when the key is absent or unreadable.
function parseNumber(
  text: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  if (text === null) {
    return fallback;
  }
  const value = Number(text);
  return Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function parseChoice<Value extends string>(
  text: string | null,
  values: readonly Value[],
  fallback: Value,
): Value {
  return values.find((value) => value === text) ?? fallback;
}

function decodePlace(
  params: URLSearchParams,
  defaults: PlaceUrlState,
): PlaceUrlState {
  const hour = params.get("time");
  const day = params.get("date");
  return {
    start: parsePoint(params.get("from")) ?? defaults.start,
    dest: parsePoint(params.get("to")) ?? defaults.dest,
    pin: parsePoint(params.get("pin")) ?? defaults.pin,
    customHour:
      hour === null ? defaults.customHour : parseNumber(hour, 0, 24, 12),
    customDay: day !== null && DAY_PATTERN.test(day) ? day : defaults.customDay,
  };
}

function encodePoints(params: URLSearchParams, state: PlaceUrlState): void {
  if (state.start) {
    params.set("from", formatPoint(state.start));
  }
  if (state.dest) {
    params.set("to", formatPoint(state.dest));
  }
  if (state.pin) {
    params.set("pin", formatPoint(state.pin));
  }
}

function encodeClock(params: URLSearchParams, state: PlaceUrlState): void {
  if (state.customHour !== null) {
    params.set("time", String(round(state.customHour, WEIGHT_DIGITS)));
  }
  if (state.customDay !== null) {
    params.set("date", state.customDay);
  }
}

// Not clamped to the number of cards: nothing here knows how many a plan returned.
function parseIndex(
  text: string | null,
  fallback: number | null,
): number | null {
  if (text === null) {
    return fallback;
  } else {
    const index = Number(text);
    return Number.isInteger(index) && index >= 0 ? index : fallback;
  }
}

// `defaults` are the persisted preferences, so a link naming only a destination keeps the sliders.
export function decodeRoute(
  params: URLSearchParams,
  defaults: RouteUrlState = DEFAULT_ROUTE_STATE,
): RouteUrlState {
  const weights: RouteWeights = { ...defaults.weights };
  for (const { key, field, min, max } of WEIGHT_PARAMS) {
    weights[field] = parseNumber(
      params.get(key),
      min,
      max,
      defaults.weights[field],
    );
  }
  weights.allowFerries = params.has("ferries")
    ? params.get("ferries") !== "0"
    : defaults.weights.allowFerries;
  weights.allowSheds = params.has("sheds")
    ? params.get("sheds") !== "0"
    : defaults.weights.allowSheds;
  // Presence is the signal: `crossings=0` (before the flag was inverted) and `crossings=1` both
  // mean free; the value only rejects strings neither encoder wrote.
  const crossings = params.get("crossings");
  weights.allowCrossings =
    crossings === "0" || crossings === "1"
      ? true
      : defaults.weights.allowCrossings;
  return { ...decodePlace(params, defaults), weights };
}

export function encodeRoute(state: RouteUrlState): URLSearchParams {
  const params = new URLSearchParams();
  encodePoints(params, state);
  for (const { key, field } of WEIGHT_PARAMS) {
    const value = round(state.weights[field], WEIGHT_DIGITS);
    if (value !== round(DEFAULT_WEIGHTS[field], WEIGHT_DIGITS)) {
      params.set(key, String(value));
    }
  }
  if (!state.weights.allowFerries) {
    params.set("ferries", "0");
  }
  if (!state.weights.allowSheds) {
    params.set("sheds", "0");
  }
  if (state.weights.allowCrossings) {
    params.set("crossings", "1");
  }
  encodeClock(params, state);
  return params;
}

export function decodeModes(
  params: URLSearchParams,
  defaults: ModeUrlState = DEFAULT_MODE_STATE,
): ModeUrlState {
  const mode = params.get("mode");
  return {
    ...decodePlace(params, defaults),
    // Modes always routes at now, so a link carrying Explorer's clock is ignored.
    customHour: null,
    customDay: null,
    mode: mode !== null && isModeId(mode) ? mode : defaults.mode,
    alt: parseIndex(params.get("alt"), defaults.alt),
    toggles: {
      sun: parseChoice(params.get("sun"), SUN_VALUES, defaults.toggles.sun),
      hills: parseChoice(
        params.get("hills"),
        HILLS_VALUES,
        defaults.toggles.hills,
      ),
      ferries: params.has("ferries")
        ? params.get("ferries") !== "0"
        : defaults.toggles.ferries,
    },
  };
}

export function encodeModes(state: ModeUrlState): URLSearchParams {
  const params = new URLSearchParams();
  encodePoints(params, state);
  // The recipient fills missing keys from their own settings, so a pinned card pins the whole plan.
  const pinned = state.alt !== null;
  if (pinned || state.mode !== DEFAULT_MODE.id) {
    params.set("mode", state.mode);
  }
  if (state.alt !== null) {
    params.set("alt", String(state.alt));
  }
  if (pinned || state.toggles.sun !== DEFAULT_TOGGLES.sun) {
    params.set("sun", state.toggles.sun);
  }
  if (pinned || state.toggles.hills !== DEFAULT_TOGGLES.hills) {
    params.set("hills", state.toggles.hills);
  }
  if (pinned || !state.toggles.ferries) {
    params.set("ferries", state.toggles.ferries ? "1" : "0");
  }
  return params;
}

// An empty `layers` is a deliberate "every overlay off", distinct from an absent one.
export function decodeView(params: URLSearchParams): ViewUrlState {
  const at = params.get("at");
  const layers = params.get("layers");
  const [lat, lng, zoom] = (at ?? "").split(",");
  const center = at === null ? null : parsePoint(`${lat},${lng}`);
  const level = parseNumber(zoom ?? null, 0, MAX_ZOOM, Number.NaN);
  return {
    camera: center && Number.isFinite(level) ? { center, zoom: level } : null,
    overlays: layers === null ? null : layers.split(",").filter(Boolean),
    city: params.get("city"),
  };
}

export function encodeView(
  camera: Camera,
  overlays: readonly string[],
  city: string,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set(
    "at",
    `${formatPoint(camera.center)},${round(camera.zoom, ZOOM_DIGITS)}`,
  );
  params.set("layers", overlays.join(","));
  params.set("city", city);
  return params;
}

export function decodeDestQuery(params: URLSearchParams): string | null {
  const text = params.get(DEST_QUERY_KEY)?.trim() ?? "";
  return text === "" ? null : text;
}

export function withoutDestQuery(hash: string): string {
  const params = hashParams(hash);
  params.delete(DEST_QUERY_KEY);
  return formatHash(params);
}

export function hashParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.replace(/^#/, ""));
}

// Unescape commas and drop `=` on valueless keys; both read back identically and stay readable.
export function formatHash(params: URLSearchParams): string {
  const text = params
    .toString()
    .replaceAll("%2C", ",")
    .replace(/=(?=&|$)/g, "");
  return text ? `#${text}` : "";
}

// Keeps foreign keys like the About flag or a future version's.
export function replaceOwnKeys(hash: string, next: URLSearchParams): string {
  const params = hashParams(hash);
  for (const key of [...ROUTE_KEYS, ...MODE_KEYS, ...VIEW_KEYS]) {
    params.delete(key);
  }
  for (const [key, value] of next) {
    params.append(key, value);
  }
  return formatHash(params);
}

// The page's own path keeps the basePath the Pages deploy injects.
export function shareUrl(
  page: { origin: string; pathname: string; search: string },
  params: URLSearchParams,
): string {
  return `${page.origin}${page.pathname}${page.search}${formatHash(params)}`;
}

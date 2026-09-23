import { expect, test } from "bun:test";
import { type City, cityById } from "../cities";
import { isOverlayId } from "../overlays/registry";
import type { RouteWeights } from "../routing/cost";
import { FACTORS, type FactorKey } from "../routing/factors";
import { MODE_ICONS } from "./icons";
import {
  ALL_FACTORS,
  DEFAULT_MODE,
  DEFAULT_TOGGLES,
  effectiveWeights,
  type FactorAvailability,
  graphFactors,
  MODES,
  type Mode,
  modeById,
  modesForCity,
  type Toggles,
} from "./modes";

// These walk the table, so a new mode is held to the same rules.

const FACTOR_KEYS = new Set<string>(FACTORS.map(({ key }) => key));

function cityNamed(id: string): City {
  const found = cityById(id);
  if (found === null) {
    throw new Error(`the ${id} city is not in the manifest`);
  } else {
    return found;
  }
}

function spent(weights: RouteWeights): Partial<Record<FactorKey, number>> {
  return Object.fromEntries(
    FACTORS.map(({ key }) => [key, weights[key]]).filter(
      ([, weight]) => weight !== 0,
    ),
  );
}

const neutral = (mode = DEFAULT_MODE): RouteWeights =>
  effectiveWeights(mode, DEFAULT_TOGGLES, ALL_FACTORS);

test("every mode names factors this build has, at a fraction of their maxima", () => {
  const ids = new Set<string>();
  for (const mode of MODES) {
    expect(ids.has(mode.id), `${mode.id} is listed twice`).toBe(false);
    ids.add(mode.id);
    expect(mode.name.length).toBeGreaterThan(0);
    for (const [key, fraction] of Object.entries(mode.weights)) {
      expect(FACTOR_KEYS.has(key), `${mode.id} weights ${key}`).toBe(true);
      expect(fraction, `${mode.id} weights ${key}`).toBeGreaterThan(0);
      expect(fraction, `${mode.id} weights ${key}`).toBeLessThanOrEqual(1);
    }
    for (const key of mode.needs) {
      expect(FACTOR_KEYS.has(key), `${mode.id} needs ${key}`).toBe(true);
    }
    for (const overlay of mode.overlays) {
      expect(isOverlayId(overlay), `${mode.id} draws ${overlay}`).toBe(true);
    }
  }
});

// A mode that named one would be silently overruled by its toggle.
test("no mode names the sun or the hill factor", () => {
  for (const mode of MODES) {
    expect(mode.weights.shade, `${mode.id}`).toBeUndefined();
    expect(mode.weights.hill, `${mode.id}`).toBeUndefined();
  }
});

test("the default mode is the first chip", () => {
  expect(DEFAULT_MODE).toBe(MODES[0]);
  expect(DEFAULT_MODE.id).toBe("naturalist");
  expect(modeById("naturalist")).toBe(DEFAULT_MODE);
  expect(modeById("cartographer")).toBeNull();
});

// Effective weights: industrial's max is 5, every other factor's is 1.
test("each mode spends what the table says it spends", () => {
  const weights = Object.fromEntries(
    MODES.map((mode) => [mode.id, spent(neutral(mode))]),
  );
  expect(weights.naturalist).toEqual({
    tree: 1,
    bridge: 1,
    industrial: 5,
    transit: 3,
  });
  expect(weights.rain).toEqual({ shelter: 1, bridge: 1 });
  expect(weights.historic).toEqual({
    landmark: 1,
    art: 0.9,
    historic: 1,
    bridge: 1,
    ferry: 0.1,
    industrial: 5,
    transit: 3,
  });
  expect(weights.streetlife).toEqual({
    landmark: 0.75,
    art: 0.75,
    historic: 0.5,
    commercial: 1,
    bridge: 1,
    industrial: 5,
    transit: 3,
  });
});

test("scaffolding is the mode's stance, and crossings are never free", () => {
  for (const mode of MODES) {
    const weights = neutral(mode);
    expect(weights.allowSheds, `${mode.id}`).toBe(mode.allowSheds);
    expect(weights.allowCrossings, `${mode.id}`).toBe(false);
  }
  expect(modeById("rain")?.allowSheds).toBe(true);
  expect(modeById("naturalist")?.allowSheds).toBe(false);
});

test("the sun toggle is the whole of the signed shade weight", () => {
  const shade = (sun: Toggles["sun"]): number =>
    effectiveWeights(DEFAULT_MODE, { ...DEFAULT_TOGGLES, sun }, ALL_FACTORS)
      .shade;
  expect(shade("sun")).toBe(1);
  expect(shade("shade")).toBe(-1);
  expect(shade("neutral")).toBe(0);
});

test("the hills toggle steps from free to the top of the slider", () => {
  const hill = (hills: Toggles["hills"]): number =>
    effectiveWeights(DEFAULT_MODE, { ...DEFAULT_TOGGLES, hills }, ALL_FACTORS)
      .hill;
  expect(hill("any")).toBe(0);
  expect(hill("some")).toBe(2);
  expect(hill("none")).toBe(5);
});

test("every mode leaves the rail reachable and prices it with a weight", () => {
  for (const mode of MODES) {
    const weights = effectiveWeights(mode, DEFAULT_TOGGLES, ALL_FACTORS);
    expect(weights.allowTransit, mode.id).toBe(true);
  }
  expect(
    effectiveWeights(DEFAULT_MODE, DEFAULT_TOGGLES, ALL_FACTORS).transit,
  ).toBe(3);
  expect(
    effectiveWeights(modeById("rain") as Mode, DEFAULT_TOGGLES, ALL_FACTORS)
      .transit,
  ).toBe(0);
});

test("the ferry toggle is the gate, not a preference for boats", () => {
  const allowed = effectiveWeights(DEFAULT_MODE, DEFAULT_TOGGLES, ALL_FACTORS);
  expect(allowed.allowFerries).toBe(true);
  expect(allowed.ferry).toBe(0);
  const barred = effectiveWeights(
    DEFAULT_MODE,
    { ...DEFAULT_TOGGLES, ferries: false },
    ALL_FACTORS,
  );
  expect(barred.allowFerries).toBe(false);
});

test("a factor this place cannot answer is dropped, and the rest are not", () => {
  const withoutIndustry: FactorAvailability = {
    ...ALL_FACTORS,
    industrial: false,
    hill: false,
  };
  const weights = effectiveWeights(
    DEFAULT_MODE,
    { ...DEFAULT_TOGGLES, hills: "none" },
    withoutIndustry,
  );
  expect(spent(weights)).toEqual({ tree: 1, bridge: 1, transit: 3 });
  expect(weights.hill).toBe(0); // the toggle is off the table too, not just the mode's weights
});

test("a graph with nothing baked answers only the factors every city bakes", () => {
  const empty = graphFactors(null);
  expect(empty).toEqual({
    tree: true,
    shade: true,
    shelter: true,
    highway: true,
    landmark: false,
    art: false,
    historic: false,
    bridge: false,
    industrial: false,
    hill: false,
    commercial: false,
    ferry: false,
    transit: false,
  });
  const loaded = graphFactors({
    maxLandmark: 0.4,
    maxArt: 0,
    maxHistoric: 0.9,
    maxBridge: 0.8,
    maxIndustrial: 0.5,
    maxCommercial: 0,
    maxRelief: 0.2,
    ferryEdges: new Uint32Array([7]),
    boardEdges: new Uint32Array([9]),
  });
  expect(loaded.landmark).toBe(true);
  expect(loaded.art).toBe(false);
  expect(loaded.bridge).toBe(true);
  expect(loaded.hill).toBe(true);
  expect(loaded.commercial).toBe(false);
  expect(loaded.ferry).toBe(true);
  expect(loaded.transit).toBe(true);
});

test("a city offers the modes its layers can answer, with the layers it has", () => {
  const nyc = modesForCity(cityNamed("nyc"));
  expect(nyc.map((mode) => mode.id)).toEqual(MODES.map((mode) => mode.id));

  // No commercial or scaffolding data outside New York; Rain still routes on the canopy.
  const bay = modesForCity(cityNamed("sf"));
  expect(bay.map((mode) => mode.id)).toEqual([
    "naturalist",
    "rain",
    "historic",
  ]);
  expect(bay[1].overlays).toEqual([]);
  expect(nyc[1].overlays).toEqual(["scaffolding"]);
});

test("every mode has a glyph to draw its chip with", () => {
  for (const mode of MODES) {
    expect(MODE_ICONS[mode.id], mode.id).toBeDefined();
  }
  expect(Object.keys(MODE_ICONS).sort()).toEqual(
    MODES.map((mode) => mode.id).sort(),
  );
});

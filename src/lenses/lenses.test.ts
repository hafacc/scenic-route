import { expect, test } from "bun:test";
import { type City, cityById } from "../cities";
import { isOverlayId } from "../overlays/registry";
import type { RouteWeights } from "../routing/cost";
import { FACTORS, type FactorKey } from "../routing/factors";
import { LENS_ICONS } from "./icons";
import {
  ALL_FACTORS,
  DEFAULT_LENS,
  DEFAULT_TOGGLES,
  effectiveWeights,
  type FactorAvailability,
  graphFactors,
  LENSES,
  type Lens,
  lensById,
  lensesForCity,
  type Toggles,
} from "./lenses";

// These walk the table, so a new lens is held to the same rules.

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

const neutral = (lens = DEFAULT_LENS): RouteWeights =>
  effectiveWeights(lens, DEFAULT_TOGGLES, ALL_FACTORS);

test("every lens names factors this build has, at a fraction of their maxima", () => {
  const ids = new Set<string>();
  for (const lens of LENSES) {
    expect(ids.has(lens.id), `${lens.id} is listed twice`).toBe(false);
    ids.add(lens.id);
    expect(lens.name.length).toBeGreaterThan(0);
    for (const [key, fraction] of Object.entries(lens.weights)) {
      expect(FACTOR_KEYS.has(key), `${lens.id} weights ${key}`).toBe(true);
      expect(fraction, `${lens.id} weights ${key}`).toBeGreaterThan(0);
      expect(fraction, `${lens.id} weights ${key}`).toBeLessThanOrEqual(1);
    }
    for (const key of lens.needs) {
      expect(FACTOR_KEYS.has(key), `${lens.id} needs ${key}`).toBe(true);
    }
    for (const overlay of lens.overlays) {
      expect(isOverlayId(overlay), `${lens.id} draws ${overlay}`).toBe(true);
    }
  }
});

// A lens that named one would be silently overruled by its toggle.
test("no lens names the sun or the hill factor", () => {
  for (const lens of LENSES) {
    expect(lens.weights.shade, `${lens.id}`).toBeUndefined();
    expect(lens.weights.hill, `${lens.id}`).toBeUndefined();
  }
});

test("the default lens is the first chip", () => {
  expect(DEFAULT_LENS).toBe(LENSES[0]);
  expect(DEFAULT_LENS.id).toBe("naturalist");
  expect(lensById("naturalist")).toBe(DEFAULT_LENS);
  expect(lensById("cartographer")).toBeNull();
});

// Effective weights: industrial's max is 5, highway's and transit's 3, every other factor's 1.
test("each lens spends what the table says it spends", () => {
  const weights = Object.fromEntries(
    LENSES.map((lens) => [lens.id, spent(neutral(lens))]),
  );
  expect(weights.naturalist).toEqual({
    tree: 1,
    bridge: 1,
    highway: 3,
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

test("scaffolding is the lens's stance, and crossings are never free", () => {
  for (const lens of LENSES) {
    const weights = neutral(lens);
    expect(weights.allowSheds, `${lens.id}`).toBe(lens.allowSheds);
    expect(weights.allowCrossings, `${lens.id}`).toBe(false);
  }
  expect(lensById("rain")?.allowSheds).toBe(true);
  expect(lensById("naturalist")?.allowSheds).toBe(false);
});

test("the sun toggle is the whole of the signed shade weight", () => {
  const shade = (sun: Toggles["sun"]): number =>
    effectiveWeights(DEFAULT_LENS, { ...DEFAULT_TOGGLES, sun }, ALL_FACTORS)
      .shade;
  expect(shade("sun")).toBe(1);
  expect(shade("shade")).toBe(-1);
  expect(shade("neutral")).toBe(0);
});

test("the hills toggle steps from free to the top of the slider", () => {
  const hill = (hills: Toggles["hills"]): number =>
    effectiveWeights(DEFAULT_LENS, { ...DEFAULT_TOGGLES, hills }, ALL_FACTORS)
      .hill;
  expect(hill("any")).toBe(0);
  expect(hill("some")).toBe(2);
  expect(hill("none")).toBe(5);
});

test("every lens leaves the rail reachable and prices it with a weight", () => {
  for (const lens of LENSES) {
    const weights = effectiveWeights(lens, DEFAULT_TOGGLES, ALL_FACTORS);
    expect(weights.allowTransit, lens.id).toBe(true);
  }
  expect(
    effectiveWeights(DEFAULT_LENS, DEFAULT_TOGGLES, ALL_FACTORS).transit,
  ).toBe(3);
  expect(
    effectiveWeights(lensById("rain") as Lens, DEFAULT_TOGGLES, ALL_FACTORS)
      .transit,
  ).toBe(0);
});

test("the ferry toggle is the gate, not a preference for boats", () => {
  const allowed = effectiveWeights(DEFAULT_LENS, DEFAULT_TOGGLES, ALL_FACTORS);
  expect(allowed.allowFerries).toBe(true);
  expect(allowed.ferry).toBe(0);
  const barred = effectiveWeights(
    DEFAULT_LENS,
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
    DEFAULT_LENS,
    { ...DEFAULT_TOGGLES, hills: "none" },
    withoutIndustry,
  );
  expect(spent(weights)).toEqual({
    tree: 1,
    bridge: 1,
    highway: 3,
    transit: 3,
  });
  expect(weights.hill).toBe(0); // the toggle is off the table too, not just the lens's weights
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

test("a city offers the lenses its layers can answer, with the layers it has", () => {
  const nyc = lensesForCity(cityNamed("nyc"));
  expect(nyc.map((lens) => lens.id)).toEqual(LENSES.map((lens) => lens.id));

  // No commercial or scaffolding data outside New York; Rain still routes on the canopy.
  const bay = lensesForCity(cityNamed("sf"));
  expect(bay.map((lens) => lens.id)).toEqual([
    "naturalist",
    "rain",
    "historic",
  ]);
  expect(bay[1].overlays).toEqual([]);
  expect(nyc[1].overlays).toEqual(["scaffolding"]);
});

test("every lens has a glyph to draw its chip with", () => {
  for (const lens of LENSES) {
    expect(LENS_ICONS[lens.id], lens.id).toBeDefined();
  }
  expect(Object.keys(LENS_ICONS).sort()).toEqual(
    LENSES.map((lens) => lens.id).sort(),
  );
});

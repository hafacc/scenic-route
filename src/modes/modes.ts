import type { City } from "../cities";
import {
  ART_COLOR,
  HISTORIC_COLOR,
  LANDMARK_COLOR,
  LEGACY_COLOR,
  SHED_COLOR,
} from "../overlays/colors";
import type { OverlayId } from "../overlays/registry";
import {
  MAX_HILL_WEIGHT,
  MAX_SHADE_WEIGHT,
  type RouteWeights,
} from "../routing/cost";
import { FACTORS, type FactorKey } from "../routing/factors";
import type { RoutingGraph } from "../routing/graph";
import { CANOPY_HEX } from "../theme/palette";

export type ModeId = "naturalist" | "rain" | "historic" | "streetlife";

export interface Mode {
  id: ModeId;
  name: string;
  color: string; // chip fill and route colour, as a CSS hex
  // What the mode's own overlays draw their elements in, which is what its alternative routes are
  // coloured from. Day hues, as `color` is.
  palette: readonly string[];
  overlays: readonly OverlayId[];
  weights: Partial<Record<FactorKey, number>>; // fraction of the factor's max, 0..1
  allowSheds: boolean;
  needs: readonly FactorKey[]; // hidden in a city that cannot answer all of these
}

// Held fixed while alternatives are searched; never a back-off axis.
export interface Toggles {
  sun: "sun" | "shade" | "neutral";
  hills: "any" | "some" | "none";
  ferries: boolean;
}

// Every switch, so a fourth one is synced and stamped by construction rather than by remembering.
export const TOGGLE_KEYS: readonly (keyof Toggles)[] = [
  "sun",
  "hills",
  "ferries",
];

export const SUN_VALUES: readonly Toggles["sun"][] = [
  "sun",
  "shade",
  "neutral",
];
export const HILLS_VALUES: readonly Toggles["hills"][] = [
  "any",
  "some",
  "none",
];

export const DEFAULT_TOGGLES: Toggles = {
  sun: "neutral",
  hills: "any",
  ferries: true,
};

// 2 is where the Potrero measurement first stops using a 12% block.
const HILL_WEIGHTS: Readonly<Record<Toggles["hills"], number>> = {
  any: 0,
  some: 2,
  none: MAX_HILL_WEIGHT,
};
const SHADE_WEIGHTS: Readonly<Record<Toggles["sun"], number>> = {
  sun: MAX_SHADE_WEIGHT,
  shade: -MAX_SHADE_WEIGHT,
  neutral: 0,
};

export const MODES: readonly Mode[] = [
  {
    id: "naturalist",
    name: "Naturalist",
    color: "#0d9488", // teal-600, the canopy ramp's own mid stop
    // The deep half of the canopy ramp: its pale end is a wash over ground, not a line on it.
    palette: CANOPY_HEX.light.slice(3),
    overlays: ["canopy"],
    weights: { tree: 1, industrial: 1 },
    allowSheds: false,
    needs: ["tree"],
  },
  {
    id: "rain",
    name: "Rain",
    color: "#0284c7", // sky-600, the shelter slider's colour
    // Shelter is overhead cover of both kinds, so the canopy's own green belongs here as much as
    // the decks' orange, whether or not this city draws either.
    palette: [
      CANOPY_HEX.light[5], // teal-600, the canopy ramp's mid stop
      SHED_COLOR.light, // orange-600, the scaffolding decks
      "#0284c7", // sky-600, the shelter slider (FACTORS shelter)
    ],
    overlays: ["scaffolding"],
    weights: { shelter: 1 },
    allowSheds: true,
    needs: ["shelter"],
  },
  {
    id: "historic",
    name: "Historic",
    color: "#4338ca", // indigo-700, the historic overlay's colour
    palette: [
      HISTORIC_COLOR.light, // indigo-700, the historic-district wash
      LANDMARK_COLOR.light, // amber-500, the landmark dots
      ART_COLOR.light, // fuchsia-500, the public-art dots
      LEGACY_COLOR.light, // yellow-600, the old-business dots
    ],
    overlays: ["historic", "legacy", "landmarks", "art"],
    // A harbour crossing is a way of seeing a city that predates every other line on the map.
    weights: { historic: 1, landmark: 1, art: 0.9, ferry: 0.1, industrial: 1 },
    allowSheds: false,
    needs: ["historic"],
  },
  {
    id: "streetlife",
    name: "Street life",
    color: "#7c3aed", // violet-600, the commercial slider's family
    palette: [
      "#7c3aed", // violet-600, the commercial wash's family (COMMERCIAL_COLOR)
      LEGACY_COLOR.light, // yellow-600, the old-business dots
      LANDMARK_COLOR.light, // amber-500, the landmark dots
      ART_COLOR.light, // fuchsia-500, the public-art dots
    ],
    overlays: ["commercial", "legacy"],
    weights: {
      commercial: 1,
      landmark: 0.75,
      art: 0.75,
      historic: 0.5,
      industrial: 1,
    },
    allowSheds: true,
    needs: ["commercial"],
  },
];

export const DEFAULT_MODE: Mode = MODES[0];

export function modeById(id: string): Mode | null {
  return MODES.find((mode) => mode.id === id) ?? null;
}

export function isModeId(value: string): value is ModeId {
  return modeById(value) !== null;
}

export type FactorAvailability = Readonly<Record<FactorKey, boolean>>;

// Shelter is ungated because a city with no shed feed still prices the canopy overhead
// (`computeEdgeSheds` seeds the field before fetching), which is why Rain is offered outside NYC.
const UNGATED: ReadonlySet<FactorKey> = new Set<FactorKey>([
  "tree",
  "shade",
  "shelter",
  "highway",
]);

export const ALL_FACTORS: FactorAvailability = Object.fromEntries(
  FACTORS.map(({ key }) => [key, true]),
) as Record<FactorKey, boolean>;

type GraphMaxima = Pick<
  RoutingGraph,
  | "maxLandmark"
  | "maxArt"
  | "maxHistoric"
  | "maxIndustrial"
  | "maxCommercial"
  | "maxRelief"
  | "ferryEdges"
>;

// Exact: a city can ship a layer whose per-edge attribute is zero on every edge of it.
export function graphFactors(graph: GraphMaxima | null): FactorAvailability {
  return {
    ...ALL_FACTORS,
    landmark: (graph?.maxLandmark ?? 0) > 0,
    art: (graph?.maxArt ?? 0) > 0,
    historic: (graph?.maxHistoric ?? 0) > 0,
    industrial: (graph?.maxIndustrial ?? 0) > 0,
    hill: (graph?.maxRelief ?? 0) > 0,
    commercial: (graph?.maxCommercial ?? 0) > 0,
    ferry: (graph?.ferryEdges.length ?? 0) > 0,
  };
}

// What is known before a graph loads, from the city's authored layer list (`Factor.overlay`).
export function cityFactors(city: City): FactorAvailability {
  const offered = new Set<OverlayId>(city.overlays);
  const available: Record<FactorKey, boolean> = { ...ALL_FACTORS };
  for (const { key, overlay } of FACTORS) {
    if (!UNGATED.has(key) && overlay !== undefined) {
      available[key] = offered.has(overlay);
    }
  }
  return available;
}

const ZERO_FACTORS: Readonly<Record<FactorKey, number>> = Object.fromEntries(
  FACTORS.map(({ key }) => [key, 0]),
) as Record<FactorKey, number>;

// A factor the mode is silent about is zero, not its Explorer default.
export function effectiveWeights(
  mode: Mode,
  toggles: Toggles,
  available: FactorAvailability,
): RouteWeights {
  const weights: RouteWeights = {
    ...ZERO_FACTORS,
    allowFerries: toggles.ferries,
    allowSheds: mode.allowSheds,
    allowCrossings: false, // never: see DEFAULT_WEIGHTS
  };
  for (const { key, max } of FACTORS) {
    if (available[key]) {
      weights[key] = (mode.weights[key] ?? 0) * max;
    }
  }
  // The two toggles own their factors outright; no mode names either.
  if (available.shade) {
    weights.shade = SHADE_WEIGHTS[toggles.sun];
  }
  if (available.hill) {
    weights.hill = HILL_WEIGHTS[toggles.hills];
  }
  return weights;
}

// The reader's choice, or the city's first mode where this city does not offer it. Their choice is
// left alone rather than rewritten, so a city that has it again puts them back in it.
export function modeForCity(city: City, id: ModeId): Mode {
  const offered = modesForCity(city);
  return offered.find((mode) => mode.id === id) ?? offered[0] ?? DEFAULT_MODE;
}

export function modesForCity(city: City): Mode[] {
  const available = cityFactors(city);
  const offered = new Set<OverlayId>(city.overlays);
  return MODES.filter((mode) => mode.needs.every((key) => available[key])).map(
    (mode) => ({
      ...mode,
      overlays: mode.overlays.filter((id) => offered.has(id)),
    }),
  );
}

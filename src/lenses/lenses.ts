import type { City } from "../cities";
import {
  ART_COLOR,
  HISTORIC_COLOR,
  LANDMARK_COLOR,
  LEGACY_COLOR,
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

export type LensId = "naturalist" | "rain" | "historic" | "streetlife";

export interface Lens {
  id: LensId;
  name: string;
  color: string; // chip fill and route color, as a CSS hex
  // The colors the lens's overlays draw in, which its alternative routes take; day hues.
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

// Every switch, so a new one is synced and stamped by construction.
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

// Every lens asks for `bridge: 1`; a city with no span over water bakes it at 0, gating it off.
export const LENSES: readonly Lens[] = [
  {
    id: "naturalist",
    name: "Naturalist",
    color: "#0d9488", // teal-600, the canopy ramp's own mid stop
    // Routes keep the canopy ramp's deep half, since the genus wash has no single hue of its own.
    palette: CANOPY_HEX.light.slice(3),
    overlays: ["genus"],
    weights: { tree: 1, bridge: 1, highway: 1, industrial: 1, transit: 1 },
    allowSheds: false,
    needs: ["tree"],
  },
  {
    id: "rain",
    name: "Rain",
    color: "#0284c7", // sky-600, the shelter slider's color
    // Routes lie over the cover, so none wears a cover color: blues and violets, clear of sage and orange.
    palette: [
      "#4f46e5", // indigo-600
      "#7c3aed", // violet-600
      "#1e40af", // blue-800
    ],
    overlays: ["treecover", "scaffolding"],
    // Transit is unpriced, since a train is shelter, waiting included.
    weights: { shelter: 1, bridge: 1 },
    allowSheds: true,
    needs: ["shelter"],
  },
  {
    id: "historic",
    name: "Historic",
    color: HISTORIC_COLOR.light, // brick, the historic-district wash
    palette: [
      HISTORIC_COLOR.light,
      LANDMARK_COLOR.light,
      ART_COLOR.light,
      LEGACY_COLOR.light,
    ],
    overlays: ["historic", "legacy", "landmarks", "art"],
    weights: {
      historic: 1,
      landmark: 1,
      art: 0.9,
      bridge: 1,
      ferry: 0.1,
      industrial: 1,
      transit: 1,
    },
    allowSheds: false,
    needs: ["historic"],
  },
  {
    id: "streetlife",
    name: "Street life",
    color: "#7e1f97", // deep violet, a step darker than the commercial band
    palette: [
      "#7e1f97",
      LEGACY_COLOR.light,
      LANDMARK_COLOR.light,
      ART_COLOR.light,
    ],
    overlays: ["commercial", "legacy"],
    weights: {
      commercial: 1,
      landmark: 0.75,
      art: 0.75,
      historic: 0.5,
      bridge: 1,
      industrial: 1,
      transit: 1,
    },
    allowSheds: true,
    needs: ["commercial"],
  },
];

export const DEFAULT_LENS: Lens = LENSES[0];

export function lensById(id: string): Lens | null {
  return LENSES.find((lens) => lens.id === id) ?? null;
}

export function isLensId(value: string): value is LensId {
  return lensById(value) !== null;
}

export type FactorAvailability = Readonly<Record<FactorKey, boolean>>;

// Shelter is ungated since `computeEdgeSheds` seeds the canopy first, so Rain works outside NYC.
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
  | "maxBridge"
  | "maxIndustrial"
  | "maxCommercial"
  | "maxRelief"
  | "ferryEdges"
  | "boardEdges"
>;

// Exact: a city can ship a layer whose per-edge attribute is zero on every edge of it.
export function graphFactors(graph: GraphMaxima | null): FactorAvailability {
  return {
    ...ALL_FACTORS,
    landmark: (graph?.maxLandmark ?? 0) > 0,
    art: (graph?.maxArt ?? 0) > 0,
    historic: (graph?.maxHistoric ?? 0) > 0,
    bridge: (graph?.maxBridge ?? 0) > 0,
    industrial: (graph?.maxIndustrial ?? 0) > 0,
    hill: (graph?.maxRelief ?? 0) > 0,
    commercial: (graph?.maxCommercial ?? 0) > 0,
    ferry: (graph?.ferryEdges.length ?? 0) > 0,
    transit: (graph?.boardEdges.length ?? 0) > 0,
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

// A factor the lens is silent about is zero, not its Explorer default.
export function effectiveWeights(
  lens: Lens,
  toggles: Toggles,
  available: FactorAvailability,
): RouteWeights {
  const weights: RouteWeights = {
    ...ZERO_FACTORS,
    allowFerries: toggles.ferries,
    // The planner alone shuts the rail off, for the walking card it offers beside a ride.
    allowTransit: true,
    allowSheds: lens.allowSheds,
    allowCrossings: false, // never: see DEFAULT_WEIGHTS
  };
  for (const { key, max } of FACTORS) {
    if (available[key]) {
      weights[key] = (lens.weights[key] ?? 0) * max;
    }
  }
  // The two toggles own their factors outright; no lens names either.
  if (available.shade) {
    weights.shade = SHADE_WEIGHTS[toggles.sun];
  }
  if (available.hill) {
    weights.hill = HILL_WEIGHTS[toggles.hills];
  }
  return weights;
}

// The reader's choice isn't rewritten, so a city that offers it again restores it.
export function lensForCity(city: City, id: LensId): Lens {
  const offered = lensesForCity(city);
  return offered.find((lens) => lens.id === id) ?? offered[0] ?? DEFAULT_LENS;
}

export function lensesForCity(city: City): Lens[] {
  const available = cityFactors(city);
  const offered = new Set<OverlayId>(city.overlays);
  return LENSES.filter((lens) => lens.needs.every((key) => available[key])).map(
    (lens) => ({
      ...lens,
      overlays: lens.overlays.filter((id) => offered.has(id)),
    }),
  );
}

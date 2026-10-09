import {
  MdAccountBalance,
  MdConstruction,
  MdDirectionsBoat,
  MdDirectionsCar,
  MdFactory,
  MdMapsHomeWork,
  MdPalette,
  MdStorefront,
  MdTerrain,
  MdTraffic,
  MdWaterDrop,
  MdWbSunny,
  PiBoatFill,
  PiBridgeFill,
  PiTrainSimpleFill,
  PiTreeEvergreenFill,
} from "../icons/glyphs";
import type { IconSpec } from "../icons/types";
import {
  ART_COLOR,
  COMMERCIAL_COLOR,
  FERRY_COLOR,
  HIGHWAY_COLOR,
  HISTORIC_COLOR,
  INDUSTRIAL_COLOR,
  LANDMARK_COLOR,
} from "../overlays/colors";
import type { OverlayId } from "../overlays/registry";
import { CANOPY_HEX, ELEVATION_SUMMIT_HEX } from "../theme/palette";
import {
  type GateKey,
  type InternalFlag,
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
} from "./cost";

// Shared by the route panel and the settings page, so labels, colors and scales can't drift apart.

// `allowTransit` is excluded in ./cost.ts too: it's the planner's own flag, not a control.
export type { GateKey };
export type FactorKey = Exclude<keyof RouteWeights, GateKey | InternalFlag>;

export interface Factor {
  key: FactorKey;
  label: string;
  icon: IconSpec; // sized and tinted where it is drawn
  max: number;
  tint: string; // text color for the icon and chip
  color: string; // the slider's fill/thumb color, and a standout route card's; the map layer's day color
  signed?: boolean; // a bipolar −max..max slider (sun ↔ shade) rather than one-sided 0..max
  // For the settings page, which has no graph to say what a city can answer; absent means every city.
  overlay?: OverlayId;
}

export interface Gate {
  key: GateKey;
  label: string;
  icon: IconSpec; // sized and tinted where it is drawn
  // Absent where the gate needs no data of its own, so every city offers it.
  overlay?: OverlayId;
  on: string;
  off: string;
}

// A gate sits beside the slider it shares data with; crossings, with no slider, comes last.
export const GATES: readonly Gate[] = [
  {
    key: "allowSheds",
    label: "Allow scaffolding",
    icon: { glyph: MdConstruction },
    overlay: "scaffolding",
    on: "Scaffolding allowed — click to route around sidewalk sheds",
    off: "Scaffolding avoided — click to walk under sidewalk sheds again",
  },
  {
    key: "allowFerries",
    label: "Allow ferries",
    icon: { glyph: MdDirectionsBoat },
    overlay: "ferries",
    on: "Ferries allowed — click to route without them",
    off: "Ferries barred — click to allow ferry crossings",
  },
  {
    key: "allowCrossings",
    label: "Allow crossings",
    icon: { glyph: MdTraffic },
    on: "Crossings are free — click to stop the route crossing and crossing back",
    off: "Crossings are priced — click to let the route spend them to reach what it is after",
  },
];

export const FACTORS: readonly Factor[] = [
  {
    key: "tree",
    label: "Prefer tree cover",
    icon: { glyph: PiTreeEvergreenFill },
    max: MAX_TREE_WEIGHT,
    tint: "text-teal-600 dark:text-teal-400",
    color: CANOPY_HEX.light[5], // the canopy ramp's mid stop
  },
  {
    key: "shade",
    label: "Prefer sun or shade",
    icon: { glyph: MdWbSunny },
    max: MAX_SHADE_WEIGHT,
    signed: true,
    tint: "text-amber-600 dark:text-amber-400",
    color: "#f59e0b",
  },
  {
    key: "shelter",
    label: "Prefer shelter",
    icon: { glyph: MdWaterDrop },
    max: MAX_SHELTER_WEIGHT,
    // No overlay: trees or decks either one make it answerable (src/overlays/shelter.ts).
    tint: "text-sky-600 dark:text-sky-400",
    color: "#0284c7",
  },
  {
    key: "landmark",
    label: "Pass landmarks",
    icon: { glyph: MdAccountBalance },
    max: MAX_LANDMARK_WEIGHT,
    tint: "text-[#8e6704] dark:text-[#d7b16d]", // a darker ochre, since the layer's is 3:1 on white
    color: LANDMARK_COLOR.light,
    overlay: "landmarks",
  },
  {
    key: "art",
    label: "Pass public art",
    icon: { glyph: MdPalette },
    max: MAX_ART_WEIGHT,
    tint: "text-[#2552aa] dark:text-[#92b8fd]",
    color: ART_COLOR.light,
    overlay: "art",
  },
  {
    key: "historic",
    label: "Prefer historic areas",
    // Not the landmarks ochre, which prices passing one building rather than walking inside a district.
    icon: { glyph: MdMapsHomeWork },
    max: MAX_HISTORIC_WEIGHT,
    tint: "text-[#9c3a11] dark:text-[#d98f75]",
    color: HISTORIC_COLOR.light,
    overlay: "historic",
  },
  {
    key: "highway",
    label: "Avoid highways",
    icon: { glyph: MdDirectionsCar },
    max: MAX_HIGHWAY_WEIGHT,
    tint: "text-rose-600 dark:text-rose-400",
    color: HIGHWAY_COLOR.light,
  },
  {
    key: "industrial",
    label: "Avoid industrial areas",
    icon: { glyph: MdFactory },
    max: MAX_INDUSTRIAL_WEIGHT,
    tint: "text-pink-600 dark:text-pink-400",
    color: INDUSTRIAL_COLOR.light,
    overlay: "industrial",
  },
  {
    key: "hill",
    label: "Avoid hills",
    icon: { glyph: MdTerrain },
    max: MAX_HILL_WEIGHT,
    // A lighter night tint, since the summit stop is too dim for text on the dark panel.
    tint: "text-[#966c5c] dark:text-[#c29684]",
    color: ELEVATION_SUMMIT_HEX.light,
    overlay: "elevation",
  },
  {
    key: "commercial",
    label: "Prefer commercial streets",
    icon: { glyph: MdStorefront },
    max: MAX_COMMERCIAL_WEIGHT,
    tint: "text-[#8e3eae] dark:text-[#c28bdb]",
    color: COMMERCIAL_COLOR.light,
    overlay: "commercial",
  },
  {
    key: "bridge",
    label: "Cross bridges",
    icon: { glyph: PiBridgeFill },
    max: MAX_BRIDGE_WEIGHT,
    // Cyan beside the ferries' blue, deliberately distinct since only one of the two is a walk.
    tint: "text-cyan-600 dark:text-cyan-400",
    color: "#0891b2",
  },
  {
    key: "transit",
    label: "Avoid the subway",
    icon: { glyph: PiTrainSimpleFill },
    max: MAX_TRANSIT_WEIGHT,
    // The lines' own colors are the routes', which vary by line; this is the layer's chrome.
    tint: "text-slate-600 dark:text-slate-300",
    color: "#475569",
    overlay: "subway",
  },
  {
    key: "ferry",
    label: "Prefer ferries",
    icon: { glyph: PiBoatFill },
    max: MAX_FERRY_WEIGHT,
    tint: "text-blue-600 dark:text-blue-400",
    color: FERRY_COLOR.light,
    overlay: "ferries",
  },
];

export const factorPercent = (factor: Factor, weight: number): number =>
  Math.round((weight / factor.max) * 100);

// The slider's own conversion, so a default can be checked against the grid it is drawn on.
export const factorWeight = (factor: Factor, percent: number): number =>
  (percent / 100) * factor.max;

// No percent sign: these are read against each other, not as quantities.
export function factorReading(factor: Factor, weight: number): string {
  const value = factorPercent(factor, weight);
  if (!factor.signed) {
    return `${value}`;
  } else if (value === 0) {
    return "off";
  } else {
    return value > 0 ? `${value} sun` : `${-value} shade`;
  }
}

// Coarse steps so the same drag lands on the same number twice; signed gets 10 for twenty per side.
const STEP = 5;
const SIGNED_STEP = 10;

export function stepFor(factor: Factor): number {
  return factor.signed ? SIGNED_STEP : STEP;
}

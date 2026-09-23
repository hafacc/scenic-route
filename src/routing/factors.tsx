"use client";

import type { ComponentType, CSSProperties } from "react";
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
} from "react-icons/md";
import {
  PiBoatFill,
  PiBridgeFill,
  PiTrainSimpleFill,
  PiTreeEvergreenFill,
} from "react-icons/pi";
import type { OverlayId } from "../overlays/registry";
import {
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
  type GateKey,
  type InternalFlag,
  type RouteWeights,
} from "./cost";

// Shared by the route panel and the settings page, so labels, colors and scales can't drift apart.

// `allowTransit` is excluded in ./cost.ts too: it's the planner's own flag, not a control.
export type { GateKey };
export type FactorKey = Exclude<keyof RouteWeights, GateKey | InternalFlag>;

export interface Factor {
  key: FactorKey;
  label: string;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  max: number;
  tint: string; // text color for the icon and chip
  color: string; // the slider's fill/thumb color (a CSS hex; matches the map overlay)
  signed?: boolean; // a bipolar −max..max slider (sun ↔ shade) rather than one-sided 0..max
  // For the settings page, which has no graph to say what a city can answer; absent means every city.
  overlay?: OverlayId;
}

export interface Gate {
  key: GateKey;
  label: string;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
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
    Icon: MdConstruction,
    overlay: "scaffolding",
    on: "Scaffolding allowed — click to route around sidewalk sheds",
    off: "Scaffolding avoided — click to walk under sidewalk sheds again",
  },
  {
    key: "allowFerries",
    label: "Allow ferries",
    Icon: MdDirectionsBoat,
    overlay: "ferries",
    on: "Ferries allowed — click to route without them",
    off: "Ferries barred — click to allow ferry crossings",
  },
  {
    key: "allowCrossings",
    label: "Allow crossings",
    Icon: MdTraffic,
    on: "Crossings are free — click to stop the route crossing and crossing back",
    off: "Crossings are priced — click to let the route spend them to reach what it is after",
  },
];

export const FACTORS: readonly Factor[] = [
  {
    key: "tree",
    label: "Prefer tree cover",
    Icon: PiTreeEvergreenFill,
    max: MAX_TREE_WEIGHT,
    tint: "text-brand-600 dark:text-brand-400",
    color: "#059669",
  },
  {
    key: "shade",
    label: "Prefer sun or shade",
    Icon: MdWbSunny,
    max: MAX_SHADE_WEIGHT,
    signed: true,
    tint: "text-amber-600 dark:text-amber-400",
    color: "#f59e0b",
  },
  {
    key: "shelter",
    label: "Prefer shelter",
    Icon: MdWaterDrop,
    max: MAX_SHELTER_WEIGHT,
    // A city with no shed feed and nothing underground has nothing to shelter under.
    overlay: "scaffolding",
    tint: "text-sky-600 dark:text-sky-400",
    color: "#0284c7",
  },
  {
    key: "landmark",
    label: "Pass landmarks",
    Icon: MdAccountBalance,
    max: MAX_LANDMARK_WEIGHT,
    tint: "text-amber-600 dark:text-amber-400",
    color: "#f59e0b",
    overlay: "landmarks",
  },
  {
    key: "art",
    label: "Pass public art",
    Icon: MdPalette,
    max: MAX_ART_WEIGHT,
    tint: "text-fuchsia-600 dark:text-fuchsia-400",
    color: "#d946ef",
    overlay: "art",
  },
  {
    key: "historic",
    label: "Prefer historic areas",
    // Not the landmarks amber, which prices passing one building rather than walking inside a district.
    Icon: MdMapsHomeWork,
    max: MAX_HISTORIC_WEIGHT,
    tint: "text-indigo-600 dark:text-indigo-400",
    color: "#4338ca",
    overlay: "historic",
  },
  {
    key: "highway",
    label: "Avoid highways",
    Icon: MdDirectionsCar,
    max: MAX_HIGHWAY_WEIGHT,
    tint: "text-rose-600 dark:text-rose-400",
    color: "#ef4444",
  },
  {
    key: "industrial",
    label: "Avoid industrial areas",
    Icon: MdFactory,
    max: MAX_INDUSTRIAL_WEIGHT,
    tint: "text-pink-600 dark:text-pink-400",
    color: "#db2777",
    overlay: "industrial",
  },
  {
    key: "hill",
    label: "Avoid hills",
    Icon: MdTerrain,
    max: MAX_HILL_WEIGHT,
    tint: "text-amber-700 dark:text-amber-500",
    color: "#b45309",
    overlay: "elevation",
  },
  {
    key: "commercial",
    label: "Prefer commercial streets",
    Icon: MdStorefront,
    max: MAX_COMMERCIAL_WEIGHT,
    tint: "text-violet-600 dark:text-violet-400",
    color: "#6d28d9",
    overlay: "commercial",
  },
  {
    key: "bridge",
    label: "Cross bridges",
    Icon: PiBridgeFill,
    max: MAX_BRIDGE_WEIGHT,
    // Cyan beside the ferries' blue, deliberately distinct since only one of the two is a walk.
    tint: "text-cyan-600 dark:text-cyan-400",
    color: "#0891b2",
  },
  {
    key: "transit",
    label: "Avoid the subway",
    Icon: PiTrainSimpleFill,
    max: MAX_TRANSIT_WEIGHT,
    // The lines' own colors are the routes', which vary by line; this is the layer's chrome.
    tint: "text-slate-600 dark:text-slate-300",
    color: "#475569",
    overlay: "subway",
  },
  {
    key: "ferry",
    label: "Prefer ferries",
    Icon: PiBoatFill,
    max: MAX_FERRY_WEIGHT,
    tint: "text-blue-600 dark:text-blue-400",
    color: "#2563eb",
    overlay: "ferries",
  },
];

export const factorPercent = (factor: Factor, weight: number): number =>
  Math.round((weight / factor.max) * 100);

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

export function FactorSlider({
  id,
  factor,
  weight,
  disabled,
  className,
  onChange,
}: {
  id?: string;
  factor: Factor;
  weight: number;
  disabled?: boolean;
  className?: string;
  onChange: (weight: number) => void;
}) {
  const value = factorPercent(factor, weight);
  return (
    <input
      id={id}
      type="range"
      min={factor.signed ? -100 : 0}
      max={100}
      step={stepFor(factor)}
      value={value}
      disabled={disabled}
      onChange={(event) =>
        onChange(
          (Number.parseInt(event.target.value, 10) / 100) * factor.max,
        )
      }
      aria-label={factor.label}
      className={`scenery-slider ${className ?? ""}`}
      style={
        {
          "--fill": factor.color,
          // A signed slider fills from the center, so map −100..100 to a 0..100 track.
          "--pct": factor.signed ? `${(value + 100) / 2}%` : `${value}%`,
        } as CSSProperties
      }
    />
  );
}

import { MODES, type ModeId, TOGGLE_KEYS, type Toggles } from "../modes/modes";
import type { OverlayId } from "../overlays/registry";
import { GATE_KEYS } from "../routing/cost";
import { FACTORS, type FactorKey } from "../routing/factors";
import { DEFAULT_SETTINGS, type Settings } from "./store";

// Local-first: localStorage is this device's truth, and signing in merges each field by latest edit.
// Clock skew can misorder edits seconds apart, which is acceptable at settings stakes.

// A field absent here isn't synced; gates are spread from GATE_KEYS so a new one can't be forgotten.
const FIELDS = [
  "layerOrder",
  "hiddenLayers",
  "factorOrder",
  "hiddenFactors",
  "hiddenGates",
  ...GATE_KEYS,
  "mode",
  "coverage",
] as const;

type SyncedField = (typeof FIELDS)[number];

const weightPath = (key: FactorKey): string => `weights.${key}`;
const togglePath = (key: keyof Toggles): string => `toggles.${key}`;
const modeLayersPath = (id: ModeId): string => `modeLayers.${id}`;

// Local wins ties, so signing in never moves anything the reader hasn't touched elsewhere.
function later(
  local: Readonly<Record<string, number>>,
  remote: Readonly<Record<string, number>>,
  path: string,
): "local" | "remote" {
  return (remote[path] ?? -1) > (local[path] ?? -1) ? "remote" : "local";
}

export function mergeSettings(local: Settings, remote: Settings): Settings {
  const merged: Settings = { ...local, updatedAt: { ...local.updatedAt } };
  const stamps: Record<string, number> = { ...local.updatedAt };

  for (const field of FIELDS) {
    if (later(local.updatedAt, remote.updatedAt, field) === "remote") {
      (merged as Record<SyncedField, unknown>)[field] = remote[field];
      stamps[field] = remote.updatedAt[field];
    }
  }

  const weights: Partial<Record<FactorKey, number>> = { ...local.weights };
  for (const { key } of FACTORS) {
    const path = weightPath(key);
    if (later(local.updatedAt, remote.updatedAt, path) === "remote") {
      const weight = remote.weights[key];
      if (weight === undefined) {
        delete weights[key];
      } else {
        weights[key] = weight;
      }
      stamps[path] = remote.updatedAt[path];
    }
  }

  merged.weights = weights;

  // Per switch, so two devices moving different switches both keep theirs.
  const toggles: Toggles = { ...local.toggles };
  for (const key of TOGGLE_KEYS) {
    const path = togglePath(key);
    if (later(local.updatedAt, remote.updatedAt, path) === "remote") {
      (toggles as Record<keyof Toggles, unknown>)[key] = remote.toggles[key];
      stamps[path] = remote.updatedAt[path];
    }
  }
  merged.toggles = toggles;

  // Per mode, since hiding a layer in one mode says nothing about another.
  const modeLayers: Partial<Record<ModeId, readonly OverlayId[]>> = {
    ...local.modeLayers,
  };
  for (const { id } of MODES) {
    const path = modeLayersPath(id);
    if (later(local.updatedAt, remote.updatedAt, path) === "remote") {
      const hidden = remote.modeLayers[id];
      if (hidden === undefined) {
        delete modeLayers[id];
      } else {
        modeLayers[id] = hidden;
      }
      stamps[path] = remote.updatedAt[path];
    }
  }
  merged.modeLayers = modeLayers;

  merged.updatedAt = stamps;
  return merged;
}

// Possibly written by a newer build, so unrecognized fields are dropped as in ./store.ts.
export function settingsFromRemote(
  document: unknown,
  read: (stored: Partial<Settings>) => Settings,
): Settings {
  if (typeof document !== "object" || document === null) {
    return DEFAULT_SETTINGS;
  } else {
    return read(document as Partial<Settings>);
  }
}

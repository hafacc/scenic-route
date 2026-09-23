"use client";

import {
  DEFAULT_MODE,
  DEFAULT_TOGGLES,
  HILLS_VALUES,
  isModeId,
  type ModeId,
  SUN_VALUES,
  type Toggles,
} from "../modes/modes";
import { OVERLAYS, type OverlayId } from "../overlays/registry";
import {
  FACTORS,
  type FactorKey,
  GATES,
  type GateKey,
} from "../routing/factors";
import { COVERAGE, DEFAULT_COVERAGE } from "./offline";

// Not in the URL, since a shared link mustn't reorder the recipient's menu.

const KEY = "scenic-route:settings.v1";

export interface Settings {
  // Empty means the registry's order.
  layerOrder: readonly OverlayId[];
  hiddenLayers: readonly OverlayId[];
  // A missing factor has never been moved and takes the built-in default.
  weights: Partial<Record<FactorKey, number>>;
  allowFerries: boolean;
  allowSheds: boolean;
  allowCrossings: boolean;
  // Empty is the table's order in src/routing/factors.tsx.
  factorOrder: readonly FactorKey[];
  // Hidden factors still price the route.
  hiddenFactors: readonly FactorKey[];
  mode: ModeId;
  toggles: Toggles;
  // Overlays switched off per mode; the mode still walks by its own weights.
  modeLayers: Partial<Record<ModeId, readonly OverlayId[]>>;
  // Hidden gates keep gating.
  hiddenGates: readonly GateKey[];
  // A ./offline.ts coverage id; the service worker holds and enforces its own copy.
  coverage: string;
  // Keyed by field name or `weights.<factor>`; drives the per-field merge in ./sync.ts.
  updatedAt: Readonly<Record<string, number>>;
}

export const DEFAULT_SETTINGS: Settings = {
  layerOrder: [],
  hiddenLayers: [],
  weights: {},
  allowFerries: true,
  allowSheds: true,
  allowCrossings: false,
  factorOrder: [],
  hiddenFactors: [],
  hiddenGates: [],
  mode: DEFAULT_MODE.id,
  toggles: DEFAULT_TOGGLES,
  modeLayers: {},
  coverage: DEFAULT_COVERAGE,
  updatedAt: {},
};

const REGISTRY_ORDER: readonly OverlayId[] = OVERLAYS.map(({ id }) => id);

// Pre-document keys, folded in once and never deleted or written; transit postdates them.
const LEGACY_WEIGHT_KEYS: Partial<Record<FactorKey, string>> = {
  tree: "scenic-route:tree-weight",
  ferry: "scenic-route:ferry-weight",
  landmark: "scenic-route:landmark-weight",
  art: "scenic-route:art-weight",
  highway: "scenic-route:highway-weight",
  hill: "scenic-route:hill-weight",
  commercial: "scenic-route:commercial-weight",
  industrial: "scenic-route:industrial-weight",
  historic: "scenic-route:historic-weight",
  shade: "scenic-route:shade-weight",
  shelter: "scenic-route:shelter-weight",
};
const LEGACY_FERRY_GATE = "scenic-route:allow-ferries";
const LEGACY_SHED_GATE = "scenic-route:allow-sheds";

// Filtered per entry, since an unknown id usually means the settings came from a newer build.
const OVERLAY_IDS = new Set<string>(REGISTRY_ORDER);
const FACTOR_KEYS = new Set<string>(FACTORS.map(({ key }) => key));

function overlayIds(value: unknown): OverlayId[] {
  return Array.isArray(value)
    ? (value.filter(
        (id) => typeof id === "string" && OVERLAY_IDS.has(id),
      ) as OverlayId[])
    : [];
}

function factorKeys(value: unknown): FactorKey[] {
  return Array.isArray(value)
    ? (value.filter(
        (key) => typeof key === "string" && FACTOR_KEYS.has(key),
      ) as FactorKey[])
    : [];
}

const GATE_KEYS = new Set<string>(GATES.map(({ key }) => key));

// Hidden gates stored under the pre-inversion name, which would otherwise reappear on upgrade.
const RENAMED_GATES: Readonly<Record<string, GateKey>> = {
  fewerCrossings: "allowCrossings",
};

function gateKeys(value: unknown): GateKey[] {
  if (!Array.isArray(value)) {
    return [];
  } else {
    const keys: GateKey[] = [];
    for (const key of value) {
      if (typeof key !== "string") {
        continue;
      }
      const current = RENAMED_GATES[key];
      if (current !== undefined && !keys.includes(current)) {
        keys.push(current);
      } else if (GATE_KEYS.has(key) && !keys.includes(key as GateKey)) {
        keys.push(key as GateKey);
      }
    }
    return keys;
  }
}

// `fewerCrossings: false` was how "crossings are free" was stored before the flag was inverted.
function allowCrossingsIn(stored: Partial<Settings>): boolean {
  const legacy = (stored as { fewerCrossings?: unknown }).fewerCrossings;
  if (stored.allowCrossings === undefined && typeof legacy === "boolean") {
    return !legacy;
  } else {
    return stored.allowCrossings === true;
  }
}

function storedMode(value: unknown): ModeId {
  return typeof value === "string" && isModeId(value) ? value : DEFAULT_MODE.id;
}

// Per switch, so an unreadable one costs only its own position.
function storedToggles(value: unknown): Toggles {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return DEFAULT_TOGGLES;
  } else {
    const { sun, hills, ferries } = value as Partial<Toggles>;
    return {
      sun: SUN_VALUES.find((state) => state === sun) ?? DEFAULT_TOGGLES.sun,
      hills:
        HILLS_VALUES.find((state) => state === hills) ?? DEFAULT_TOGGLES.hills,
      ferries: typeof ferries === "boolean" ? ferries : DEFAULT_TOGGLES.ferries,
    };
  }
}

function storedModeLayers(
  value: unknown,
): Partial<Record<ModeId, readonly OverlayId[]>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  } else {
    const layers: Partial<Record<ModeId, readonly OverlayId[]>> = {};
    for (const [id, hidden] of Object.entries(value)) {
      if (isModeId(id)) {
        layers[id] = overlayIds(hidden);
      }
    }
    return layers;
  }
}

function stamps(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  } else {
    return Object.fromEntries(
      Object.entries(value).filter(([, at]) => Number.isFinite(at)),
    );
  }
}

function factorWeights(value: unknown): Partial<Record<FactorKey, number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  } else {
    return Object.fromEntries(
      Object.entries(value).filter(
        ([key, weight]) => FACTOR_KEYS.has(key) && Number.isFinite(weight),
      ),
    );
  }
}

interface LegacyPrefs {
  weights: Partial<Record<FactorKey, number>>;
  allowFerries: boolean;
  allowSheds: boolean;
  found: boolean; // whether any old key was present, so the fold is worth writing back
}

function legacyPrefs(legacy: (key: string) => string | null): LegacyPrefs {
  const weights: Partial<Record<FactorKey, number>> = {};
  for (const [key, storageKey] of Object.entries(LEGACY_WEIGHT_KEYS)) {
    const stored = storageKey === undefined ? null : legacy(storageKey);
    const parsed = stored === null ? Number.NaN : Number.parseFloat(stored);
    if (Number.isFinite(parsed)) {
      weights[key as FactorKey] = parsed;
    }
  }
  const ferryGate = legacy(LEGACY_FERRY_GATE);
  const shedGate = legacy(LEGACY_SHED_GATE);
  return {
    weights,
    allowFerries: ferryGate !== "false",
    allowSheds: shedGate !== "false",
    found:
      Object.keys(weights).length > 0 ||
      ferryGate !== null ||
      shedGate !== null,
  };
}

// Separate from `read` so the migration can be tested without a browser; `legacy` is `getItem`.
export function settingsFrom(
  stored: Partial<Settings>,
  legacy: (key: string) => string | null,
): { settings: Settings; migrated: boolean } {
  const { layerOrder, hiddenLayers, weights, hiddenFactors } = stored;
  // Only an absent weights field means pre-document; unreadable weights mean a newer build, not a fold.
  const folded = weights === undefined ? legacyPrefs(legacy) : null;
  return {
    settings: {
      layerOrder: overlayIds(layerOrder),
      hiddenLayers: overlayIds(hiddenLayers),
      weights: folded ? folded.weights : factorWeights(weights),
      allowFerries: folded
        ? folded.allowFerries
        : stored.allowFerries !== false,
      allowSheds: folded ? folded.allowSheds : stored.allowSheds !== false,
      // Absent reads as off, unlike the two gates above; the pre-inversion `fewerCrossings` is flipped.
      allowCrossings: allowCrossingsIn(stored),
      factorOrder: factorKeys(stored.factorOrder),
      hiddenFactors: factorKeys(hiddenFactors),
      hiddenGates: gateKeys(stored.hiddenGates),
      mode: storedMode(stored.mode),
      toggles: storedToggles(stored.toggles),
      modeLayers: storedModeLayers(stored.modeLayers),
      coverage: COVERAGE.some(({ id }) => id === stored.coverage)
        ? (stored.coverage as string)
        : DEFAULT_COVERAGE,
      updatedAt: stamps(stored.updatedAt),
    },
    migrated: folded?.found ?? false,
  };
}

// Probed by access, since a window can exist with storage that throws or no `localStorage` at all.
function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

// Absent and unreadable both read as empty, so the migration still runs.
function document(raw: string | null): Partial<Settings> {
  try {
    return raw === null ? {} : ((JSON.parse(raw) ?? {}) as Partial<Settings>);
  } catch {
    return {};
  }
}

// Same validation for a remote document, but this device's legacy keys have no say in it.
export function settingsFromDocument(stored: Partial<Settings>): Settings {
  return settingsFrom(stored, () => null).settings;
}

// A newer build's document must degrade rather than break.
function read(): Settings {
  const held = store();
  if (held === null) {
    return DEFAULT_SETTINGS;
  }
  // Guarded whole, since blocked storage can throw on the first `getItem`, not just the parse.
  try {
    const { settings, migrated } = settingsFrom(
      document(held.getItem(KEY)),
      (key) => held.getItem(key),
    );
    if (migrated) {
      write(settings);
    }
    return settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function write(next: Settings): void {
  try {
    store()?.setItem(KEY, JSON.stringify(next));
  } catch {
    // A full or blocked store costs persistence, not the session.
  }
}

let current: Settings = read();
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) {
    listener();
  }
}

if (typeof addEventListener === "function") {
  addEventListener("storage", (event) => {
    if (event.key === KEY) {
      current = read();
      announce();
    }
  });
}

export function settings(): Settings {
  return current;
}

// Stamped per factor and per switch, read off the values since callers write the whole object back.
function stamped(patch: Partial<Settings>, at: number): Record<string, number> {
  const marks: Record<string, number> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (field === "updatedAt") {
    } else if (field === "weights") {
      for (const [key, weight] of Object.entries(value as object)) {
        if (weight !== current.weights[key as FactorKey]) {
          marks[`weights.${key}`] = at;
        }
      }
    } else if (field === "toggles") {
      for (const [key, state] of Object.entries(value as object)) {
        if (state !== current.toggles[key as keyof Toggles]) {
          marks[`toggles.${key}`] = at;
        }
      }
    } else if (field === "modeLayers") {
      // Compared by contents, since every list in the rewritten map is a fresh array.
      for (const [id, hidden] of Object.entries(value as object)) {
        const before = current.modeLayers[id as ModeId] ?? [];
        if ((hidden as readonly OverlayId[]).join() !== before.join()) {
          marks[`modeLayers.${id}`] = at;
        }
      }
    } else {
      marks[field] = at;
    }
  }
  return marks;
}

export function updateSettings(
  patch: Partial<Settings>,
  at = Date.now(),
): void {
  current = {
    ...current,
    ...patch,
    updatedAt: { ...current.updatedAt, ...stamped(patch, at) },
  };
  write(current);
  announce();
}

// Already stamped; restamping would make every sign-in look like a fresh edit.
export function adoptSettings(next: Settings): void {
  current = next;
  write(current);
  announce();
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Ids the build dropped go; new ones land beside their surviving neighbors, not at the end.
export function mergeOrder<Key extends string>(
  stored: readonly Key[],
  registry: readonly Key[],
): Key[] {
  const known = new Set(registry);
  const merged = stored.filter((id) => known.has(id));
  const placed = new Set(merged);
  let anchor = -1;
  for (const id of registry) {
    if (placed.has(id)) {
      anchor = merged.indexOf(id);
    } else {
      anchor += 1;
      merged.splice(anchor, 0, id);
      placed.add(id);
    }
  }
  return merged;
}

export function orderedOverlays(
  offered: readonly OverlayId[],
  { layerOrder, hiddenLayers }: Pick<Settings, "layerOrder" | "hiddenLayers">,
): OverlayId[] {
  const hidden = new Set(hiddenLayers);
  const wanted = new Set(offered);
  return layerMenuOrder(layerOrder).filter(
    (id) => wanted.has(id) && !hidden.has(id),
  );
}

export function layerMenuOrder(stored: readonly OverlayId[]): OverlayId[] {
  return mergeOrder(stored, REGISTRY_ORDER);
}

// Hiding isn't applied, since the settings page shows hidden ones grayed.
export function factorRunOrder(stored: readonly FactorKey[]): FactorKey[] {
  return mergeOrder(
    stored,
    FACTORS.map(({ key }) => key),
  );
}

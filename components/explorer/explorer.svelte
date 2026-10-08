<script lang="ts">
import {
  applyExclusivity,
  isOverlayId,
  type OverlayId,
} from "../../src/overlays/registry";
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
  MAX_FERRY_WEIGHT,
  MAX_HIGHWAY_WEIGHT,
  MAX_HILL_WEIGHT,
  MAX_INDUSTRIAL_WEIGHT,
  MAX_SHADE_WEIGHT,
  MAX_SHELTER_WEIGHT,
  MAX_TRANSIT_WEIGHT,
  MAX_TREE_WEIGHT,
  type RouteWeights,
} from "../../src/routing/cost";
import type { FactorKey, GateKey } from "../../src/routing/factors";
import {
  settings as storedSettings,
  updateSettings,
} from "../../src/settings/store";
import {
  DEFAULT_WEIGHTS,
  decodeRoute,
  decodeView,
  type PlaceUrlState,
  type RouteUrlState,
} from "../../src/url-state";
import MapShell from "../map-shell.svelte";
import type { RoutingContext, ShellDeck } from "../shell-types";
import { useSettings } from "../use-settings.svelte";
import ExplorerControls from "./explorer-controls.svelte";
import ExplorerPanels from "./explorer-panels.svelte";
import { shownOverlays, toggleOverlay } from "./overlays";

const OVERLAY_KEY = "scenic-route:overlay";

// What a URL key overrides and a missing one leaves in place.
function storedWeights(): RouteWeights {
  const { weights, allowFerries, allowSheds, allowCrossings } =
    storedSettings();
  const read = (key: FactorKey, fallback: number, min: number, max: number) => {
    const stored = weights[key];
    return stored === undefined
      ? fallback
      : Math.min(max, Math.max(min, stored));
  };
  return {
    tree: read("tree", DEFAULT_TREE_WEIGHT, 0, MAX_TREE_WEIGHT),
    ferry: read("ferry", DEFAULT_FERRY_WEIGHT, 0, MAX_FERRY_WEIGHT),
    landmark: read("landmark", DEFAULT_LANDMARK_WEIGHT, 0, 1),
    art: read("art", DEFAULT_ART_WEIGHT, 0, 1),
    highway: read("highway", DEFAULT_HIGHWAY_WEIGHT, 0, MAX_HIGHWAY_WEIGHT),
    hill: read("hill", DEFAULT_HILL_WEIGHT, 0, MAX_HILL_WEIGHT),
    commercial: read("commercial", DEFAULT_COMMERCIAL_WEIGHT, 0, 1),
    industrial: read(
      "industrial",
      DEFAULT_INDUSTRIAL_WEIGHT,
      0,
      MAX_INDUSTRIAL_WEIGHT,
    ),
    historic: read("historic", DEFAULT_HISTORIC_WEIGHT, 0, 1),
    bridge: read("bridge", DEFAULT_BRIDGE_WEIGHT, 0, 1),
    shade: read(
      "shade",
      DEFAULT_SHADE_WEIGHT,
      -MAX_SHADE_WEIGHT,
      MAX_SHADE_WEIGHT,
    ),
    shelter: read("shelter", DEFAULT_SHELTER_WEIGHT, 0, MAX_SHELTER_WEIGHT),
    transit: read("transit", DEFAULT_TRANSIT_WEIGHT, 0, MAX_TRANSIT_WEIGHT),
    allowFerries,
    // Never a stored preference: the planner owns it (routing/cost.ts, INTERNAL_FLAGS).
    allowTransit: true,
    allowSheds,
    allowCrossings,
  };
}

// A weight nobody has moved stays out of the document and keeps its built-in default.
function persistWeight(key: FactorKey, weight: number): void {
  updateSettings({ weights: { ...storedSettings().weights, [key]: weight } });
}

// null when nothing was ever stored; an empty string is a deliberate all-off.
function storedOverlays(): string[] | null {
  try {
    const stored = window.localStorage.getItem(OVERLAY_KEY);
    return stored === null ? null : stored.split(",");
  } catch {
    // Storage can be blocked, which reads as nothing stored.
    return null;
  }
}

// Canopy starts on because it is all a signed-out visitor has.
let chosenOverlays = $state.raw<ReadonlySet<OverlayId>>(
  new Set<OverlayId>(["canopy"]),
);
const settings = useSettings();
// Its own derived, so a moved slider being stored doesn't redraw the layers.
const hiddenLayers = $derived(settings.current.hiddenLayers);
// Called inside the shell's own derived, whose city it is; nothing prunes the choice itself.
function activeOverlays({ city }: RoutingContext): ReadonlySet<OverlayId> {
  return shownOverlays(chosenOverlays, city, hiddenLayers);
}
// Replaced whole on every change, since the search compares it by identity and posts it to the worker.
let weights = $state.raw<RouteWeights>(DEFAULT_WEIGHTS);

function chooseOverlays(next: ReadonlySet<OverlayId>): void {
  chosenOverlays = next;
  try {
    window.localStorage.setItem(OVERLAY_KEY, [...next].join(","));
  } catch {
    // A full or blocked store costs persistence, not the session.
  }
}

function handleToggleOverlay(id: OverlayId): void {
  chooseOverlays(toggleOverlay(chosenOverlays, id));
}

function handleWeight(key: FactorKey, weight: number): void {
  weights = { ...weights, [key]: weight };
  persistWeight(key, weight);
}

function handleGate(key: GateKey, on: boolean): void {
  weights = { ...weights, [key]: on };
  updateSettings({ [key]: on });
}

// A key in the link wins; a missing one keeps what the sliders were last left at.
function handleLink(params: URLSearchParams): PlaceUrlState {
  const stored: RouteUrlState = {
    start: null,
    dest: null,
    pin: null,
    weights: storedWeights(),
    customHour: null,
    customDay: null,
  };
  const route = decodeRoute(params, stored);
  weights = route.weights;
  const linked = decodeView(params).overlays;
  if (linked) {
    // Unknown ids (e.g. a stale "trees") are dropped, and exclusivity applies as in the toggle.
    const shown = new Set(applyExclusivity(linked.filter(isOverlayId)));
    // Stored, since the hash drops view keys once read and a reload should show these again.
    chooseOverlays(shown);
  } else {
    const stored = storedOverlays();
    if (stored) {
      chosenOverlays = new Set(applyExclusivity(stored.filter(isOverlayId)));
    }
  }
  return route;
}
</script>

{#snippet controls(
  shell: ShellDeck,
)}
  <ExplorerControls
    {shell}
    {weights}
    {activeOverlays}
    onToggleOverlay={handleToggleOverlay}
  />
{/snippet}
{#snippet panels(
  shell: ShellDeck,
)}
  <ExplorerPanels
    {shell}
    {weights}
    onWeight={handleWeight}
    onGate={handleGate}
  />
{/snippet}

<MapShell {weights} {activeOverlays} onLink={handleLink} {controls} {panels} />

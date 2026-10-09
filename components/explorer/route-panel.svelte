<script lang="ts">
import type { Snippet } from "svelte";
import type { City } from "../../src/cities";
import type { GeocodeResult } from "../../src/geocode";
import {
  FiChevronDown,
  FiChevronUp,
  FiCloudOff,
  FiCrosshair,
  FiEyeOff,
  FiLoader,
  FiX,
  MdOutlineDirectionsWalk,
  MdSwapVert,
} from "../../src/icons/glyphs";
import type {
  CardSummary,
  FerrySummary,
  RideSummary,
} from "../../src/lenses/cards";
import { cardLine } from "../../src/lenses/cards";
import type { FactorAvailability } from "../../src/lenses/lenses";
import type { Maneuver } from "../../src/routing/directions";
import {
  FACTORS,
  type Factor,
  type FactorKey,
  factorPercent,
  factorReading,
  GATES,
  type GateKey,
} from "../../src/routing/factors";
import type { NavProgress } from "../../src/routing/nav-progress";
import type { RouteFactors } from "../../src/routing/search";
import { factorRunOrder } from "../../src/settings/store";
import EndpointFields from "../endpoint-fields.svelte";
import FactorSlider from "../factor-slider.svelte";
import Icon from "../icon.svelte";
import CardLine from "../lenses/card-line.svelte";
import ManeuverList from "../maneuver-list.svelte";
import MinimizedPanel from "../minimized-panel.svelte";
import { PANEL_CARD, PANEL_WRAPPER } from "../panel-shell";
import type { DestPrefill } from "../shell-types";
import { useSettings } from "../use-settings.svelte";

interface RoutePanelProps {
  city: City;
  startLabel: string | null;
  destLabel: string | null;
  startSet: boolean;
  destSet: boolean;
  needsStart: boolean;
  // A fix in another city doesn't count: routing stays within one city.
  hasLiveLocation: boolean;
  pickTarget: "start" | "dest" | null;
  status: "idle" | "loading" | "ready" | "error";
  errorMessage: string | null;
  summary: {
    walkMeters: number; // meters, excluding any ferry crossing
    travelSeconds: number;
    rides: readonly RideSummary[];
    ferries: readonly FerrySummary[];
    factors: RouteFactors;
  } | null;
  treeWeight: number;
  ferryWeight: number;
  allowFerries: boolean;
  transitWeight: number;
  landmarkWeight: number;
  artWeight: number;
  highwayWeight: number;
  hillWeight: number;
  // Read off the graph. Absent sliders gray out; absent gates hide, as a toggle implies both.
  graphAvailable: FactorAvailability;
  shedFeed: boolean;
  shelterHere: boolean;
  commercialWeight: number;
  industrialWeight: number;
  historicWeight: number;
  bridgeWeight: number;
  shadeWeight: number; // signed: −1 shade, +1 sun, 0 off
  // Every city bakes these, so this means a fetch failed, not missing data.
  shadeDataLost: boolean;
  shelterWeight: number;
  allowSheds: boolean;
  allowCrossings: boolean;
  directions: Maneuver[] | null;
  progress: NavProgress | null;
  directionsOpen: boolean;
  minimized: boolean;
  onTreeWeight: (weight: number) => void;
  onFerryWeight: (weight: number) => void;
  onTransitWeight: (weight: number) => void;
  onLandmarkWeight: (weight: number) => void;
  onArtWeight: (weight: number) => void;
  onHighwayWeight: (weight: number) => void;
  onHillWeight: (weight: number) => void;
  onCommercialWeight: (weight: number) => void;
  onIndustrialWeight: (weight: number) => void;
  onHistoricWeight: (weight: number) => void;
  onBridgeWeight: (weight: number) => void;
  onShadeWeight: (weight: number) => void;
  onShelterWeight: (weight: number) => void;
  onGate: (key: GateKey, on: boolean) => void;
  onStartSelect: (result: GeocodeResult) => void;
  onDestSelect: (result: GeocodeResult) => void;
  // Candidates for a link's destination text that didn't resolve to one place.
  destPrefill: DestPrefill | null;
  onStartClear: () => void;
  onDestClear: () => void;
  // A pure slot swap; the route is searched again because costs are directional.
  onSwap: () => void;
  onUseCurrentLocation: () => void;
  onArmStart: () => void;
  onArmDest: () => void;
  onToggleDirections: () => void;
  // Built by the app, which alone holds the graph and the raw endpoints.
  exportAction: Snippet | null;
  onToggleMinimize: () => void;
  onSettings: (section?: string) => void;
  onClose: () => void;
}

interface FactorState {
  weight: number;
  onChange: (weight: number) => void;
  // false drops the factor entirely, unlike `disabled`, a live control switched off.
  available?: boolean;
  disabled?: boolean;
  // Data that exists but didn't load; the control goes dead with the reason shown.
  lost?: string;
}

type PanelFactor = Factor & FactorState;

function summaryOf(summary: {
  walkMeters: number;
  travelSeconds: number;
  rides: readonly RideSummary[];
  ferries: readonly FerrySummary[];
}): CardSummary {
  return {
    travelSeconds: summary.travelSeconds,
    walkMeters: summary.walkMeters,
    ferries: summary.ferries,
    rides: summary.rides,
  };
}

const {
  city,
  startLabel,
  destLabel,
  startSet,
  destSet,
  needsStart,
  hasLiveLocation,
  pickTarget,
  status,
  errorMessage,
  summary,
  treeWeight,
  ferryWeight,
  allowFerries,
  transitWeight,
  landmarkWeight,
  artWeight,
  highwayWeight,
  hillWeight,
  graphAvailable,
  shedFeed,
  shelterHere,
  commercialWeight,
  industrialWeight,
  historicWeight,
  bridgeWeight,
  shadeWeight,
  shadeDataLost,
  shelterWeight,
  allowSheds,
  allowCrossings,
  directions,
  progress,
  directionsOpen,
  minimized,
  onTreeWeight,
  onFerryWeight,
  onTransitWeight,
  onLandmarkWeight,
  onArtWeight,
  onHighwayWeight,
  onHillWeight,
  onCommercialWeight,
  onIndustrialWeight,
  onHistoricWeight,
  onBridgeWeight,
  onShadeWeight,
  onShelterWeight,
  onGate,
  onStartSelect,
  onDestSelect,
  destPrefill,
  onStartClear,
  onDestClear,
  onSwap,
  onUseCurrentLocation,
  onArmStart,
  onArmDest,
  onToggleDirections,
  exportAction,
  onToggleMinimize,
  onSettings,
  onClose,
}: RoutePanelProps = $props();

const settings = useSettings();
const hidden = $derived(new Set(settings.current.hiddenFactors));
const hiddenGate = $derived(new Set(settings.current.hiddenGates));
const gateTint: Record<GateKey, string> = {
  allowFerries: "text-blue-600 dark:text-blue-400",
  allowSheds: "text-orange-600 dark:text-orange-400",
  allowCrossings: "text-teal-600 dark:text-teal-400",
};
const gateOpen: Record<GateKey, boolean> = $derived({
  allowFerries,
  allowSheds,
  allowCrossings,
});
// Crossings aren't a dataset, so the gate is offered everywhere.
const gateHere: Record<GateKey, boolean> = $derived({
  allowFerries: graphAvailable.ferry,
  allowSheds: shedFeed,
  allowCrossings: true,
});
// What the reader last asked of the sliders; opening the directions withdraws it.
let sceneryWanted = $state.raw(false);
// Only one of the sliders and the directions list opens, or the panel runs off the screen.
const sceneryOpen = $derived(sceneryWanted && !directionsOpen);
const toggleScenery = (): void => {
  const opening = !sceneryOpen;
  sceneryWanted = opening;
  if (opening && directionsOpen) {
    onToggleDirections();
  }
};
const toggleDirections = (): void => {
  sceneryWanted = false;
  onToggleDirections();
};
const factorState: Record<FactorKey, FactorState> = $derived({
  tree: { weight: treeWeight, onChange: onTreeWeight },
  shade: {
    weight: shadeWeight,
    onChange: onShadeWeight,
    // The sun fractions are their own artifact, so this can fail with a healthy graph.
    lost: shadeDataLost
      ? "Shade data could not be loaded — this route ignores sun and shade."
      : undefined,
  },
  shelter: {
    weight: shelterWeight,
    onChange: onShelterWeight,
    // Trees shelter where no shed stands; the scaffolding gate below still asks for the feed.
    available: shelterHere,
  },
  landmark: {
    weight: landmarkWeight,
    onChange: onLandmarkWeight,
    available: graphAvailable.landmark,
  },
  art: {
    weight: artWeight,
    onChange: onArtWeight,
    available: graphAvailable.art,
  },
  historic: {
    weight: historicWeight,
    onChange: onHistoricWeight,
    available: graphAvailable.historic,
  },
  bridge: {
    weight: bridgeWeight,
    onChange: onBridgeWeight,
    available: graphAvailable.bridge,
  },
  highway: { weight: highwayWeight, onChange: onHighwayWeight },
  industrial: {
    weight: industrialWeight,
    onChange: onIndustrialWeight,
    available: graphAvailable.industrial,
  },
  hill: {
    weight: hillWeight,
    onChange: onHillWeight,
    available: graphAvailable.hill,
  },
  commercial: {
    weight: commercialWeight,
    onChange: onCommercialWeight,
    available: graphAvailable.commercial,
  },
  transit: {
    weight: transitWeight,
    onChange: onTransitWeight,
    available: graphAvailable.transit,
  },
  ferry: {
    weight: ferryWeight,
    onChange: onFerryWeight,
    available: graphAvailable.ferry,
    // Inert but visible while the gate is off, since the reader chose it and can undo it.
    disabled: !allowFerries,
  },
});
// In the reader's order, the same list the settings page shows.
const allFactors: PanelFactor[] = $derived(
  factorRunOrder(settings.current.factorOrder).flatMap((key) => {
    const factor = FACTORS.find((entry) => entry.key === key);
    return factor ? [{ ...factor, ...factorState[key] }] : [];
  }),
);
// Filtered once so the sliders, the peek row and the summary chips agree.
const offered = $derived(
  allFactors.filter((factor) => factor.available !== false),
);
const factors = $derived(offered.filter((factor) => !hidden.has(factor.key)));
// A hidden factor at non-zero weight still bends the route; a grayed-out one prices nothing.
const hiddenApplying = $derived(
  offered.filter(
    (factor) =>
      hidden.has(factor.key) &&
      factor.weight !== 0 &&
      !factor.disabled &&
      factor.lost === undefined,
  ).length +
    // Gates aren't weighted, so what counts is a shut one the reader can't see.
    GATES.filter(
      (gate) =>
        hiddenGate.has(gate.key) && !gateOpen[gate.key] && gateHere[gate.key],
    ).length,
);

// Chips show only what acts on this route; the expanded list stays complete to raise a zero.
const actingFactors = $derived(factors.filter((factor) => factor.weight !== 0));
// No chip for presence-only ferry, or for shelter, whose tree half rests on about four trees.
const factorChips = $derived(
  actingFactors.filter(
    (factor) =>
      factor.key !== "ferry" &&
      factor.key !== "shelter" &&
      // A ride carries no scenery, so the transit mean is 0 on every route by construction.
      factor.key !== "transit",
  ),
);
// Missing data the reader asked for: the route shown is not the route asked for.
const ignoredFactors = $derived(
  factors.filter((factor) => factor.lost !== undefined && factor.weight !== 0),
);
const pickHint = $derived(
  pickTarget === "start"
    ? "Tap the map to set your start"
    : pickTarget === "dest"
      ? "Tap the map to set your destination"
      : null,
);

const peekNext = $derived(
  status === "ready" && progress && directions
    ? {
        maneuver: directions[progress.nextManeuver],
        distanceMeters: progress.distanceToNextMeters,
        current: directions[progress.currentManeuver] ?? null,
      }
    : null,
);
const fallback = $derived(
  status === "ready" && summary
    ? cardLine(summaryOf(summary), "distance")
    : "Walking directions",
);

const chipScore = (routeFactors: RouteFactors, factor: PanelFactor): number =>
  Math.round(routeFactors[factor.key as keyof RouteFactors] * 100);

const directionsLabel = $derived(
  directionsOpen ? "Hide directions" : "Get directions",
);
const shownGates = $derived(
  GATES.filter((gate) => gateHere[gate.key] && !hiddenGate.has(gate.key)),
);
const hiddenTitle = $derived(
  `${hiddenApplying} hidden preference${hiddenApplying === 1 ? "" : "s"} still ${hiddenApplying === 1 ? "applies" : "apply"} to this route — open settings`,
);
const hiddenLabel = $derived(
  `${hiddenApplying} hidden preference${hiddenApplying === 1 ? "" : "s"} still applying. Open settings.`,
);
</script>

{#snippet glyph(
  factor: PanelFactor,
)}
  <Icon icon={factor.icon.glyph} class="h-3.5 w-3.5" aria-hidden="true" />
{/snippet}

{#snippet crosshair()}
  <Icon icon={FiCrosshair} class="h-3.5 w-3.5" aria-hidden="true" />
{/snippet}

{#snippet eyeOff()}
  <Icon icon={FiEyeOff} class="h-3.5 w-3.5" aria-hidden="true" />
{/snippet}

{#snippet loader()}
  <Icon icon={FiLoader} class="h-4 w-4 animate-spin" aria-hidden="true" />
{/snippet}

{#snippet cloudOff()}
  <Icon
    icon={FiCloudOff}
    class="mt-0.5 h-3.5 w-3.5 shrink-0"
    aria-hidden="true"
  />
{/snippet}

{#snippet walkIcon()}
  <Icon icon={MdOutlineDirectionsWalk} class="h-4 w-4" aria-hidden="true" />
{/snippet}

{#if minimized}
  <MinimizedPanel next={peekNext} {fallback} onExpand={onToggleMinimize} />
{:else}
  <div class={PANEL_WRAPPER}>
    <div class={`${PANEL_CARD} p-4`}>
      <div class="flex items-center justify-between gap-2">
        <p
          class="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400"
        >
          Walking directions
        </p>
        <div class="flex items-center gap-1">
          {#each shownGates as gate (gate.key)}
            <button
              type="button"
              onclick={() => onGate(gate.key, !gateOpen[gate.key])}
              aria-label={gate.label}
              aria-pressed={gateOpen[gate.key]}
              title={gateOpen[gate.key] ? gate.on : gate.off}
              class={`-m-1 grid h-8 w-8 place-items-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-700 ${gateOpen[gate.key] ? gateTint[gate.key] : "text-slate-400"}`}
            >
              <Icon icon={gate.icon.glyph} />
            </button>
          {/each}
          <!-- Disabled, not hidden, so the gates don't slide sideways. -->
          <button
            type="button"
            onclick={onSwap}
            disabled={!startSet && !destSet}
            aria-label="Swap start and destination"
            title="Swap start and destination"
            class="-m-1 grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-slate-700"
          >
            <Icon icon={MdSwapVert} class="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onclick={onToggleMinimize}
            aria-label="Minimize directions"
            class="-m-1 grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            <Icon icon={FiChevronDown} />
          </button>
          <button
            type="button"
            onclick={onClose}
            aria-label="Close directions"
            class="-m-1 grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            <Icon icon={FiX} />
          </button>
        </div>
      </div>

      <div class="mt-3 space-y-2">
        <EndpointFields
          {city}
          {startLabel}
          {destLabel}
          {startSet}
          {destSet}
          {hasLiveLocation}
          {pickTarget}
          {destPrefill}
          {onStartSelect}
          {onDestSelect}
          {onStartClear}
          {onDestClear}
          {onUseCurrentLocation}
          {onArmStart}
          {onArmDest}
        />
      </div>

      {#if pickHint}
        <p
          class="mt-2 flex items-center gap-1.5 text-xs font-medium text-brand-600 dark:text-brand-400"
        >
          {@render crosshair()}{pickHint}
        </p>
      {/if}

      <div
        class={`mt-4 flex flex-col ${sceneryOpen ? "min-h-0 shrink" : "shrink-0"}`}
      >
        <div class="flex w-full shrink-0 items-center gap-2">
          <button
            type="button"
            onclick={toggleScenery}
            aria-expanded={sceneryOpen}
            aria-label={sceneryOpen ? "Hide scenery sliders" : "Adjust scenery"}
            class="flex min-w-0 flex-1 items-center justify-between gap-2"
          >
            <span
              class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
            >
              Scenery
            </span>
            {#if sceneryOpen}
              <Icon
                icon={FiChevronUp}
                class="h-4 w-4 text-slate-400"
                aria-hidden="true"
              />
            {:else}
              <Icon
                icon={FiChevronDown}
                class="h-4 w-4 text-slate-400"
                aria-hidden="true"
              />
            {/if}
          </button>
          <!-- The only on-screen sign that a hidden preference still bends the route. -->
          {#if hiddenApplying > 0}
            <button
              type="button"
              onclick={() => onSettings("routing")}
              title={hiddenTitle}
              aria-label={hiddenLabel}
              class="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-slate-400 hover:bg-slate-100 dark:text-slate-500 dark:hover:bg-slate-700"
            >
              {@render eyeOff()}{hiddenApplying}
            </button>
          {/if}
        </div>

        <!-- Its own row, outside the button, so a sideways drag scrolls rather than expands. -->
        {#if !sceneryOpen}
          <div class="chip-row mt-1 shrink-0 gap-2">
            {#each actingFactors as factor (factor.key)}
              <span
                class={`flex items-center gap-0.5 text-[11px] font-semibold tabular-nums ${factor.disabled || factor.lost ? "opacity-40" : factor.tint}`}
              >
                {@render glyph(factor)}{factorPercent(factor, factor.weight)}
              </span>
            {:else}
              <span
                class="text-[11px] font-medium text-slate-400 dark:text-slate-500"
              >
                Scenery off
              </span>
            {/each}
          </div>
        {/if}

        {#if sceneryOpen}
          <div
            class="mt-2 min-h-0 shrink space-y-3 overflow-y-auto overscroll-contain"
          >
            {#each factors as factor (factor.key)}
              <label
                for={`scenery-${factor.key}`}
                class={`block ${factor.disabled || factor.lost ? "pointer-events-none opacity-40" : ""}`}
              >
                <span
                  class="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400"
                >
                  <span class="flex items-center gap-1.5">
                    <Icon
                      icon={factor.icon.glyph}
                      class={`h-3.5 w-3.5 ${factor.tint}`}
                      aria-hidden="true"
                    />{factor.label}
                  </span>
                  <span class="tabular-nums">
                    {factorReading(factor, factor.weight)}
                  </span>
                </span>
                <FactorSlider
                  id={`scenery-${factor.key}`}
                  {factor}
                  weight={factor.weight}
                  disabled={factor.disabled || factor.lost !== undefined}
                  onChange={factor.onChange}
                  class="mt-1.5 w-full"
                />
                {#if factor.lost}
                  <span
                    class="mt-1 block text-[11px] text-slate-500 dark:text-slate-400"
                  >
                    {factor.lost}
                  </span>
                {/if}
              </label>
            {/each}
          </div>
        {/if}
      </div>

      {#if needsStart}
        <p class="mt-3 text-center text-xs text-slate-400 dark:text-slate-500">
          Set a start point or wait for your location to load
        </p>
      {/if}

      {#if status === "loading"}
        <p
          class="mt-3 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400"
        >
          {@render loader()}Finding a route…
        </p>
      {/if}
      {#if status === "ready" && summary}
        <div class="mt-3">
          <CardLine summary={summaryOf(summary)} order="distance" />
          {#each ignoredFactors as factor (factor.key)}
            <p
              class="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-500"
            >
              {@render cloudOff()}{factor.lost}
            </p>
          {/each}
          {#if factorChips.length > 0}
            <div class="chip-row mt-1.5 gap-x-3">
              {#each factorChips as factor (factor.key)}
                <span
                  class={`inline-flex items-center gap-1 text-xs font-semibold ${factor.tint}`}
                >
                  {@render glyph(factor)}{chipScore(summary.factors, factor)}
                </span>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      {#if status === "error" && errorMessage}
        <p class="mt-3 text-sm font-medium text-rose-600 dark:text-rose-400">
          {errorMessage}
        </p>
      {/if}

      {#if status === "ready" && directions && directions.length > 0}
        <!-- Here rather than in the toolbar, since only here does a computed route exist. -->
        <div class="mt-3 flex items-stretch gap-2">
          <button
            type="button"
            onclick={toggleDirections}
            aria-expanded={directionsOpen}
            class="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-800"
          >
            {@render walkIcon()}{directionsLabel}
          </button>
          {@render exportAction?.()}
        </div>
        {#if directionsOpen}
          <ManeuverList
            {directions}
            {progress}
            class="mt-2 min-h-0 shrink space-y-1 overflow-y-auto overscroll-contain"
          />
        {/if}
      {/if}
    </div>
  </div>
{/if}

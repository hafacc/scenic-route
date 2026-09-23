"use client";

import { type ReactNode, useEffect, useState } from "react";
import {
  FiChevronDown,
  FiChevronUp,
  FiCloudOff,
  FiCrosshair,
  FiEyeOff,
  FiLoader,
  FiX,
} from "react-icons/fi";
import { MdOutlineDirectionsWalk, MdSwapVert } from "react-icons/md";
import type { City } from "../../src/cities";
import type { GeocodeResult } from "../../src/geocode";
import type {
  CardSummary,
  FerrySummary,
  RideSummary,
} from "../../src/modes/cards";
import { cardLine } from "../../src/modes/cards";
import type { FactorAvailability } from "../../src/modes/modes";
import type { Maneuver } from "../../src/routing/directions";
import {
  FACTORS,
  type Factor,
  type FactorKey,
  FactorSlider,
  factorPercent,
  factorReading,
  GATES,
  type GateKey,
} from "../../src/routing/factors";
import type { NavProgress } from "../../src/routing/nav-progress";
import type { RouteFactors } from "../../src/routing/search";
import { factorRunOrder } from "../../src/settings/store";
import type { DestPrefill } from "../location-field";
import { ManeuverList } from "../maneuvers";
import { CardLine } from "../modes/route-cards";
import {
  EndpointFields,
  MinimizedPanel,
  PANEL_CARD,
  PANEL_WRAPPER,
} from "../panel-shell";
import { useSettings } from "../use-settings";

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
  exportAction: ReactNode;
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

export default function RoutePanel({
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
}: RoutePanelProps) {
  const { factorOrder, hiddenFactors, hiddenGates } = useSettings();
  const hidden = new Set(hiddenFactors);
  const hiddenGate = new Set(hiddenGates);
  const gateTint: Record<GateKey, string> = {
    allowFerries: "text-blue-600 dark:text-blue-400",
    allowSheds: "text-orange-600 dark:text-orange-400",
    allowCrossings: "text-teal-600 dark:text-teal-400",
  };
  const gateOpen: Record<GateKey, boolean> = {
    allowFerries,
    allowSheds,
    allowCrossings,
  };
  // Crossings aren't a dataset, so the gate is offered everywhere.
  const gateHere: Record<GateKey, boolean> = {
    allowFerries: graphAvailable.ferry,
    allowSheds: shedFeed,
    allowCrossings: true,
  };
  const [sceneryOpen, setSceneryOpen] = useState(false);
  // Only one of the sliders and the directions list opens, or the panel runs off the screen.
  useEffect(() => {
    if (directionsOpen) {
      setSceneryOpen(false);
    }
  }, [directionsOpen]);
  const toggleScenery = () => {
    const opening = !sceneryOpen;
    setSceneryOpen(opening);
    if (opening && directionsOpen) {
      onToggleDirections();
    }
  };
  const factorState: Record<FactorKey, FactorState> = {
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
      available: shedFeed,
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
  };
  // In the reader's order, the same list the settings page shows.
  const allFactors: PanelFactor[] = factorRunOrder(factorOrder).flatMap(
    (key) => {
      const factor = FACTORS.find((entry) => entry.key === key);
      return factor ? [{ ...factor, ...factorState[key] }] : [];
    },
  );
  // Filtered once so the sliders, the peek row and the summary chips agree.
  const offered = allFactors.filter((factor) => factor.available !== false);
  const factors = offered.filter((factor) => !hidden.has(factor.key));
  // A hidden factor at non-zero weight still bends the route; a grayed-out one prices nothing.
  const hiddenApplying =
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
    ).length;

  // Chips show only what acts on this route; the expanded list stays complete to raise a zero.
  const actingFactors = factors.filter((factor) => factor.weight !== 0);
  // No chip for presence-only ferry, or for shelter, whose tree half rests on about four trees.
  const factorChips = actingFactors.filter(
    (factor) =>
      factor.key !== "ferry" &&
      factor.key !== "shelter" &&
      // A ride carries no scenery, so the transit mean is 0 on every route by construction.
      factor.key !== "transit",
  );
  // Missing data the reader asked for: the route shown is not the route asked for.
  const ignoredFactors = factors.filter(
    (factor) => factor.lost !== undefined && factor.weight !== 0,
  );
  const pickHint =
    pickTarget === "start"
      ? "Tap the map to set your start"
      : pickTarget === "dest"
        ? "Tap the map to set your destination"
        : null;

  if (minimized) {
    const peekNext =
      status === "ready" && progress && directions
        ? {
            maneuver: directions[progress.nextManeuver],
            distanceMeters: progress.distanceToNextMeters,
            current: directions[progress.currentManeuver] ?? null,
          }
        : null;
    return (
      <MinimizedPanel
        next={peekNext}
        fallback={
          status === "ready" && summary
            ? cardLine(summaryOf(summary), "distance")
            : "Walking directions"
        }
        onExpand={onToggleMinimize}
      />
    );
  }

  return (
    <div className={PANEL_WRAPPER}>
      <div className={`${PANEL_CARD} p-4`}>
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">
            Walking directions
          </p>
          <div className="flex items-center gap-1">
            {GATES.filter(
              (gate) => gateHere[gate.key] && !hiddenGate.has(gate.key),
            ).map((gate) => (
              <button
                key={gate.key}
                type="button"
                onClick={() => onGate(gate.key, !gateOpen[gate.key])}
                aria-label={gate.label}
                aria-pressed={gateOpen[gate.key]}
                title={gateOpen[gate.key] ? gate.on : gate.off}
                className={`-m-1 grid h-8 w-8 place-items-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-700 ${
                  gateOpen[gate.key] ? gateTint[gate.key] : "text-slate-400"
                }`}
              >
                <gate.Icon />
              </button>
            ))}
            {/* Disabled, not hidden, so the gates don't slide sideways. */}
            <button
              type="button"
              onClick={onSwap}
              disabled={!startSet && !destSet}
              aria-label="Swap start and destination"
              title="Swap start and destination"
              className="-m-1 grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-slate-700"
            >
              <MdSwapVert className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onToggleMinimize}
              aria-label="Minimize directions"
              className="-m-1 grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              <FiChevronDown />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close directions"
              className="-m-1 grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              <FiX />
            </button>
          </div>
        </div>

        <div className="mt-3 space-y-2">
          <EndpointFields
            city={city}
            startLabel={startLabel}
            destLabel={destLabel}
            startSet={startSet}
            destSet={destSet}
            hasLiveLocation={hasLiveLocation}
            pickTarget={pickTarget}
            destPrefill={destPrefill}
            onStartSelect={onStartSelect}
            onDestSelect={onDestSelect}
            onStartClear={onStartClear}
            onDestClear={onDestClear}
            onUseCurrentLocation={onUseCurrentLocation}
            onArmStart={onArmStart}
            onArmDest={onArmDest}
          />
        </div>

        {pickHint ? (
          <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-brand-600 dark:text-brand-400">
            <FiCrosshair className="h-3.5 w-3.5" aria-hidden="true" />
            {pickHint}
          </p>
        ) : null}

        <div
          className={`mt-4 flex flex-col ${
            sceneryOpen ? "min-h-0 shrink" : "shrink-0"
          }`}
        >
          <div className="flex w-full shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={toggleScenery}
              aria-expanded={sceneryOpen}
              aria-label={
                sceneryOpen ? "Hide scenery sliders" : "Adjust scenery"
              }
              className="flex min-w-0 flex-1 items-center justify-between gap-2"
            >
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Scenery
              </span>
              {sceneryOpen ? (
                <FiChevronUp
                  className="h-4 w-4 text-slate-400"
                  aria-hidden="true"
                />
              ) : (
                <FiChevronDown
                  className="h-4 w-4 text-slate-400"
                  aria-hidden="true"
                />
              )}
            </button>
            {/* The only on-screen sign that a hidden preference still bends the route. */}
            {hiddenApplying > 0 ? (
              <button
                type="button"
                onClick={() => onSettings("routing")}
                title={`${hiddenApplying} hidden preference${hiddenApplying === 1 ? "" : "s"} still ${hiddenApplying === 1 ? "applies" : "apply"} to this route — open settings`}
                aria-label={`${hiddenApplying} hidden preference${hiddenApplying === 1 ? "" : "s"} still applying. Open settings.`}
                className="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-slate-400 hover:bg-slate-100 dark:text-slate-500 dark:hover:bg-slate-700"
              >
                <FiEyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                {hiddenApplying}
              </button>
            ) : null}
          </div>

          {/* Its own row, outside the button, so a sideways drag scrolls rather than expands. */}
          {sceneryOpen ? null : (
            <div className="chip-row mt-1 shrink-0 gap-2">
              {actingFactors.length > 0 ? (
                actingFactors.map((factor) => (
                  <span
                    key={factor.key}
                    className={`flex items-center gap-0.5 text-[11px] font-semibold tabular-nums ${
                      factor.disabled || factor.lost
                        ? "opacity-40"
                        : factor.tint
                    }`}
                  >
                    <factor.Icon className="h-3.5 w-3.5" aria-hidden={true} />
                    {factorPercent(factor, factor.weight)}
                  </span>
                ))
              ) : (
                <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500">
                  Scenery off
                </span>
              )}
            </div>
          )}

          {sceneryOpen ? (
            <div className="mt-2 min-h-0 shrink space-y-3 overflow-y-auto overscroll-contain">
              {factors.map((factor) => (
                <label
                  key={factor.key}
                  htmlFor={`scenery-${factor.key}`}
                  className={`block ${
                    factor.disabled || factor.lost
                      ? "pointer-events-none opacity-40"
                      : ""
                  }`}
                >
                  <span className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
                    <span className="flex items-center gap-1.5">
                      <factor.Icon
                        className={`h-3.5 w-3.5 ${factor.tint}`}
                        aria-hidden={true}
                      />
                      {factor.label}
                    </span>
                    <span className="tabular-nums">
                      {factorReading(factor, factor.weight)}
                    </span>
                  </span>
                  <FactorSlider
                    id={`scenery-${factor.key}`}
                    factor={factor}
                    weight={factor.weight}
                    disabled={factor.disabled || factor.lost !== undefined}
                    onChange={factor.onChange}
                    className="mt-1.5 w-full"
                  />
                  {factor.lost ? (
                    <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">
                      {factor.lost}
                    </span>
                  ) : null}
                </label>
              ))}
            </div>
          ) : null}
        </div>

        {needsStart ? (
          <p className="mt-3 text-center text-xs text-slate-400 dark:text-slate-500">
            Set a start point or wait for your location to load
          </p>
        ) : null}

        {status === "loading" ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <FiLoader className="h-4 w-4 animate-spin" aria-hidden="true" />
            Finding a route…
          </p>
        ) : null}
        {status === "ready" && summary ? (
          <div className="mt-3">
            <CardLine summary={summaryOf(summary)} order="distance" />
            {ignoredFactors.map((factor) => (
              <p
                key={factor.key}
                className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-500"
              >
                <FiCloudOff
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  aria-hidden="true"
                />
                {factor.lost}
              </p>
            ))}
            {factorChips.length > 0 ? (
              <div className="chip-row mt-1.5 gap-x-3">
                {factorChips.map((factor) => (
                  <span
                    key={factor.key}
                    className={`inline-flex items-center gap-1 text-xs font-semibold ${factor.tint}`}
                  >
                    <factor.Icon className="h-3.5 w-3.5" aria-hidden={true} />
                    {Math.round(
                      summary.factors[factor.key as keyof RouteFactors] * 100,
                    )}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {status === "error" && errorMessage ? (
          <p className="mt-3 text-sm font-medium text-rose-600 dark:text-rose-400">
            {errorMessage}
          </p>
        ) : null}

        {status === "ready" && directions && directions.length > 0 ? (
          <>
            {/* Here rather than in the toolbar, since only here does a computed route exist. */}
            <div className="mt-3 flex items-stretch gap-2">
              <button
                type="button"
                onClick={onToggleDirections}
                aria-expanded={directionsOpen}
                className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-800"
              >
                <MdOutlineDirectionsWalk
                  className="h-4 w-4"
                  aria-hidden="true"
                />
                {directionsOpen ? "Hide directions" : "Get directions"}
              </button>
              {exportAction}
            </div>
            {directionsOpen ? (
              <ManeuverList
                directions={directions}
                progress={progress}
                className="mt-2 min-h-0 shrink space-y-1 overflow-y-auto overscroll-contain"
              />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

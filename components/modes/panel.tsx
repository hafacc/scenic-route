"use client";

import type { ReactNode } from "react";
import {
  FiChevronDown,
  FiChevronLeft,
  FiCrosshair,
  FiSearch,
  FiX,
} from "react-icons/fi";
import { MdOutlineDirectionsWalk } from "react-icons/md";
import type { City } from "../../src/cities";
import type { GeocodeResult } from "../../src/geocode";
import { cardLine } from "../../src/modes/cards";
import type {
  FactorAvailability,
  Mode,
  ModeId,
  Toggles,
} from "../../src/modes/modes";
import type { Maneuver } from "../../src/routing/directions";
import type { NavProgress } from "../../src/routing/nav-progress";
import LocationField, { type DestPrefill } from "../location-field";
import { ManeuverList } from "../maneuvers";
import {
  EndpointFields,
  MinimizedPanel,
  PANEL_CARD,
  PANEL_WRAPPER,
} from "../panel-shell";
import ModeBar from "./mode-bar";
import RouteCards, {
  CardChips,
  CardLegs,
  CardLine,
  CardNumber,
  type CardView,
  GhostCard,
} from "./route-cards";

const HEADER_BUTTON =
  "grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 transition hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-slate-700";

const MODES_CARD = `${PANEL_CARD} relative gap-2 p-3`;

// Half the screen, since a taller card hides the lines its rows describe.
const PHONE_HALF =
  "max-md:max-h-[calc(50dvh-max(0.75rem,env(safe-area-inset-bottom)))]!";

interface ModesPanelProps {
  city: City;
  modes: readonly Mode[];
  mode: Mode;
  onMode: (id: ModeId) => void;
  toggles: Toggles;
  available: FactorAvailability;
  onToggles: (toggles: Toggles) => void;
  routing: boolean;
  foundLabel: string | null;
  onSearchSelect: (result: GeocodeResult) => void;
  onSearchClear: () => void;
  onSearchDirections: () => void;
  onClose: () => void;
  startLabel: string | null;
  destLabel: string | null;
  startSet: boolean;
  destSet: boolean;
  needsStart: boolean;
  hasLiveLocation: boolean;
  pickTarget: "start" | "dest" | null;
  destPrefill: DestPrefill | null;
  status: "idle" | "loading" | "ready" | "error";
  errorMessage: string | null;
  // Cards are replaced only when the sweep lands, so this marks the ones on screen as stale.
  planning: boolean;
  planningLine: string | null;
  cards: readonly CardView[];
  selected: number | null;
  directions: Maneuver[] | null;
  progress: NavProgress | null;
  minimized: boolean;
  exportAction: ReactNode;
  onSelect: (index: number) => void;
  onHover: (index: number | null) => void;
  onBack: () => void;
  onStartSelect: (result: GeocodeResult) => void;
  onDestSelect: (result: GeocodeResult) => void;
  onStartClear: () => void;
  onDestClear: () => void;
  onSwap: () => void;
  onArmStart: () => void;
  onArmDest: () => void;
  onToggleMinimize: () => void;
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close directions"
      title="Close directions"
      className="absolute top-0 right-0 z-10 grid h-7 w-7 -translate-y-1/3 translate-x-1/3 place-items-center rounded-full bg-white text-slate-500 shadow-md ring-1 ring-black/5 transition hover:text-slate-700 dark:bg-slate-700 dark:text-slate-300 dark:ring-white/10 dark:hover:text-white"
    >
      <FiX className="h-[18px] w-[18px]" aria-hidden="true" />
    </button>
  );
}

// Nothing else may live in this row, or the header would start lower than the other states.
export default function ModesPanel({
  city,
  modes,
  mode,
  onMode,
  toggles,
  available,
  onToggles,
  routing,
  foundLabel,
  onSearchSelect,
  onSearchClear,
  onSearchDirections,
  onClose,
  startLabel,
  destLabel,
  startSet,
  destSet,
  needsStart,
  hasLiveLocation,
  pickTarget,
  destPrefill,
  status,
  errorMessage,
  planning,
  planningLine,
  cards,
  selected,
  directions,
  progress,
  minimized,
  exportAction,
  onSelect,
  onHover,
  onBack,
  onStartSelect,
  onDestSelect,
  onStartClear,
  onDestClear,
  onSwap,
  onArmStart,
  onArmDest,
  onToggleMinimize,
}: ModesPanelProps) {
  const modeBar = (
    <ModeBar
      modes={modes}
      mode={mode.id}
      toggles={toggles}
      available={available}
      onMode={onMode}
      onToggles={onToggles}
    />
  );

  if (minimized) {
    const next =
      status === "ready" && progress && directions
        ? {
            maneuver: directions[progress.nextManeuver],
            distanceMeters: progress.distanceToNextMeters,
            current: directions[progress.currentManeuver] ?? null,
          }
        : null;
    return (
      <MinimizedPanel
        next={next}
        fallback={
          selected !== null && cards[selected]
            ? cardLine(cards[selected].summary)
            : "Walking directions"
        }
        header={
          <div className="flex shrink-0 items-center md:hidden">{modeBar}</div>
        }
        cardClassName={MODES_CARD}
        corner={<CloseButton onClose={onClose} />}
        onExpand={onToggleMinimize}
      />
    );
  }

  const chosen = selected !== null ? cards[selected] : null;
  const chosenLegs = chosen ? <CardLegs summary={chosen.summary} /> : null;
  const pickHint =
    pickTarget === "start"
      ? "Tap the map to set your start"
      : pickTarget === "dest"
        ? "Tap the map to set your destination"
        : null;
  // Held rather than cleared, so a change never blanks the list it is about to refill.
  const recomputing = planning && cards.length > 0;
  const ghost = (planning || status === "loading") && cards.length === 0;

  return (
    <div className={PANEL_WRAPPER}>
      <div className={`${MODES_CARD} ${routing ? PHONE_HALF : ""}`}>
        {routing ? <CloseButton onClose={onClose} /> : null}
        {/* The switches don't scroll: hiding them hides the state the routes were found under. */}
        <div className="flex shrink-0 items-center md:hidden">{modeBar}</div>

        {chosen ? (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to the other routes"
              title="Back to the other routes"
              className={HEADER_BUTTON}
            >
              <FiChevronLeft className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
            <CardNumber index={selected ?? 0} color={chosen.color} />
            {/* At 375 px the legs don't fit beside the two numbers, so they join the chips row. */}
            <span className="min-w-0 flex-1">
              <CardLine summary={chosen.summary} legs="row" />
              {chosen.chips.length > 0 || chosenLegs !== null ? (
                <CardChips chips={chosen.chips} lead={chosenLegs} />
              ) : null}
            </span>
            {exportAction}
            <button
              type="button"
              onClick={onToggleMinimize}
              aria-label="Minimize directions"
              title="Minimize directions"
              className={HEADER_BUTTON}
            >
              <FiChevronDown className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
          </div>
        ) : routing ? (
          <>
            <div className="shrink-0">
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
                onUseCurrentLocation={onStartClear}
                onArmStart={onArmStart}
                onArmDest={onArmDest}
                onSwap={onSwap}
              />
            </div>

            {pickHint ? (
              <p className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-brand-600 dark:text-brand-400">
                <FiCrosshair className="h-3.5 w-3.5" aria-hidden="true" />
                {pickHint}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <div className="shrink-0">
              <LocationField
                city={city}
                label={foundLabel}
                placeholder="Where to?"
                leadingIcon={
                  <FiSearch className="h-4 w-4" aria-hidden="true" />
                }
                armed={pickTarget === "dest"}
                canClear={foundLabel !== null}
                clearLabel="Clear the search"
                pickLabel="Pick destination on the map"
                onSelect={onSearchSelect}
                onClear={onSearchClear}
                onArmPick={onArmDest}
              />
            </div>
            {foundLabel !== null ? (
              <button
                type="button"
                onClick={onSearchDirections}
                className="flex h-10 w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-800"
              >
                <MdOutlineDirectionsWalk
                  className="h-4 w-4"
                  aria-hidden="true"
                />
                Get directions
              </button>
            ) : null}
          </>
        )}

        {routing && needsStart ? (
          <p className="shrink-0 text-center text-xs text-slate-400 dark:text-slate-500">
            Set a start point or wait for your location to load
          </p>
        ) : null}

        {status === "error" && errorMessage ? (
          <p className="shrink-0 text-sm font-medium text-rose-600 dark:text-rose-400">
            {errorMessage}
          </p>
        ) : null}

        {chosen === null &&
        status !== "error" &&
        (cards.length > 0 || ghost) ? (
          // The rows' hover fill reaches 8 px into the card's padding while their text stays on it.
          <div className="relative -mx-2 flex min-h-0 shrink flex-col">
            {recomputing ? <span className="scenic-progress" /> : null}
            {ghost ? (
              <GhostCard line={planningLine} color={mode.color} />
            ) : (
              <RouteCards
                cards={cards}
                selected={selected}
                dimmed={recomputing}
                onSelect={onSelect}
                onHover={onHover}
              />
            )}
          </div>
        ) : null}

        {chosen !== null && directions && directions.length > 0 ? (
          <ManeuverList
            directions={directions}
            progress={progress}
            className="min-h-0 shrink space-y-1 overflow-y-auto overscroll-contain"
          />
        ) : null}

        <p className="sr-only" aria-live="polite">
          {planning
            ? "Recomputing"
            : cards.length > 0
              ? `${cards.length} routes found`
              : ""}
        </p>
      </div>
    </div>
  );
}

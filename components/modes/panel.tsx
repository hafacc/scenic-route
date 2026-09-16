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

// The icon buttons the card's own header rows are made of: the back chevron, the minimize and the
// handoff to Google all wear this.
const HEADER_BUTTON =
  "grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 transition hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-slate-700";

// The card's own padding, 12 on all four sides, and 8 between every row it stacks.
const MODES_CARD = `${PANEL_CARD} relative gap-2 p-3`;

// Half the screen, once a route is being asked about or read: the map is the other half of the
// answer, and a card that grows to fill a phone hides the very lines its rows are about. The list
// inside — cards or maneuvers — scrolls within it, as it already does under the desktop cap.
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
  // Whether the card is asking where to go or answering it. A destination is what turns one into the
  // other: this is the Google Maps flow, where finding a place and walking to it are two screens.
  routing: boolean;
  foundLabel: string | null; // the place the search box has on the map, if any
  onSearchSelect: (result: GeocodeResult) => void;
  onSearchClear: () => void;
  onSearchDirections: () => void;
  onClose: () => void; // back to the search, the route dropped
  startLabel: string | null;
  destLabel: string | null;
  startSet: boolean;
  destSet: boolean;
  needsStart: boolean; // no location and no manual start yet, so nothing can be routed
  hasLiveLocation: boolean;
  pickTarget: "start" | "dest" | null;
  destPrefill: DestPrefill | null;
  status: "idle" | "loading" | "ready" | "error";
  errorMessage: string | null;
  // A sweep is running. Its cards replace these only when it lands, so what this changes is whether
  // the ones on screen are the current answer.
  planning: boolean;
  // The max-scenic route's summary, which the ghost card wears until the plan lands.
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

// Hung off the card's top-right corner and moved a little inward, the swap button's treatment on the
// other edge: the close takes neither a row nor a column, and it is the same thing on both sizes.
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

// The mode row and the switches head the card on a phone; on a wide screen they float above the map
// instead (deck.tsx), which is why the bar below is hidden at md — and why nothing else may live in
// that row: a state whose header held one more thing would start lower than the others do.
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
        // The mode stays switchable with the card shrunk away: a mode is not something the peek bar
        // is a peek at, and reopening the card to change it is the long way round. It is the card's
        // own first row, as in every other state — on a wide screen the row floats above the map
        // instead, which leaves the peek row alone in the card.
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
  // The cards on screen answer the last sweep, not the one running; they are held rather than
  // cleared so a mode, a switch or an endpoint never blanks the list it is about to refill.
  const recomputing = planning && cards.length > 0;
  // The first sweep of all: the loading state and the sweep are one thing to the reader.
  const ghost = (planning || status === "loading") && cards.length === 0;

  return (
    <div className={PANEL_WRAPPER}>
      <div className={`${MODES_CARD} ${routing ? PHONE_HALF : ""}`}>
        {routing ? <CloseButton onClose={onClose} /> : null}
        {/* The chips scroll under a right-hand cluster that does not: the switches are three fixed
            things, and a row that scrolls them away hides the state the routes were found under. */}
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
            {/* A boat pill and a line bullet do not fit beside the two numbers at 375 px, and the
                header ellipsed them away. The numbers stay on the first row and the legs join the
                chips on the second, which scrolls rather than truncating. */}
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
            {/* The destination field of the other screen, asked before there is a route: the same
                box, the same suggestions, so finding a place reads as the start of going there. */}
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

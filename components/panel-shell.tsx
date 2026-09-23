"use client";

import type { ReactNode } from "react";
import { FiNavigation, FiSearch } from "react-icons/fi";
import { MdSwapVert } from "react-icons/md";
import type { City } from "../src/cities";
import type { GeocodeResult } from "../src/geocode";
import LocationField, { type DestPrefill } from "./location-field";
import { PeekBar, type PeekNext } from "./maneuvers";

// What both decks' bottom cards are made of. The two panels differ in everything they hold and in
// nothing that holds it, so the box, the slim bar it shrinks to and the two endpoint fields live
// here and each deck arranges its own contents inside them.

// Full-width and centered on small screens; on sm+ it is a tall panel, so it right-aligns rather
// than covering the middle of the map.
export const PANEL_WRAPPER =
  "fixed bottom-0 left-1/2 z-[1000] w-full max-w-md -translate-x-1/2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:left-auto sm:right-4 sm:translate-x-0 sm:px-0";

// Capped against the viewport and laid out as a column: the fields, the headings and the buttons
// stay put while whichever tall section is open scrolls inside. `dvh` rather than `vh` because on a
// phone `100vh` is the viewport with the browser chrome RETRACTED, which overflows by exactly the
// chrome's height whenever it is showing. The 4rem is the toolbar row this must stay clear of. No
// `overflow` here — the location fields open their suggestions upward, out of it. The padding is
// each deck's own: Explorer keeps 16, Modes packs its rows on a 12 grid.
export const PANEL_CARD =
  "flex max-h-[calc(100dvh-env(safe-area-inset-top)-4rem-max(0.75rem,env(safe-area-inset-bottom)))] flex-col rounded-2xl bg-white/85 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10";

// The panel shrunk to a slim bar. While navigating it shows the next maneuver and the distance to
// it; otherwise whatever the deck has to say about the route.
export function MinimizedPanel({
  next,
  fallback,
  header,
  cardClassName,
  corner,
  onExpand,
}: {
  next: PeekNext | null;
  fallback: string;
  // A deck whose controls outlive the card they were in: Modes keeps its mode row above the peek
  // row, so the walk can be re-planned without expanding the card again.
  header?: ReactNode;
  // The deck's own card chrome, given with a header: the two rows are then ONE card — the directions
  // card collapsed — rather than a floating pill above a floating bar.
  cardClassName?: string;
  corner?: ReactNode; // hung off the card's own corner, as the close is off the open one's
  onExpand: () => void;
}) {
  if (header === undefined || cardClassName === undefined) {
    return (
      <div className={PANEL_WRAPPER}>
        <div className="relative">
          <PeekBar next={next} fallback={fallback} onExpand={onExpand} />
          {corner}
        </div>
      </div>
    );
  } else {
    return (
      <div className={PANEL_WRAPPER}>
        <div className={cardClassName}>
          {corner}
          {header}
          <PeekBar next={next} fallback={fallback} bare onExpand={onExpand} />
        </div>
      </div>
    );
  }
}

interface EndpointFieldsProps {
  city: City;
  startLabel: string | null;
  destLabel: string | null;
  startSet: boolean;
  destSet: boolean;
  hasLiveLocation: boolean;
  pickTarget: "start" | "dest" | null;
  // A link's textual destination that resolved to nothing certain, typed into the destination box
  // with the answers already found for it, for the reader to pick from.
  destPrefill: DestPrefill | null;
  onStartSelect: (result: GeocodeResult) => void;
  onDestSelect: (result: GeocodeResult) => void;
  onStartClear: () => void;
  onDestClear: () => void;
  onUseCurrentLocation: () => void;
  onArmStart: () => void;
  onArmDest: () => void;
  // Where the two ends may be exchanged from the fields themselves. The button then rides the right
  // edge of the pair rather than taking a column beside them, so the boxes keep the whole width.
  onSwap?: () => void;
}

// The two ends, in the order they are walked. Without a swap they are a fragment for the panel to
// stack as it likes; with one they are a box, because the button hangs off the seam between them.
export function EndpointFields({
  city,
  startLabel,
  destLabel,
  startSet,
  destSet,
  hasLiveLocation,
  pickTarget,
  destPrefill,
  onStartSelect,
  onDestSelect,
  onStartClear,
  onDestClear,
  onUseCurrentLocation,
  onArmStart,
  onArmDest,
  onSwap,
}: EndpointFieldsProps) {
  const fields = (
    <>
      <LocationField
        city={city}
        label={startLabel}
        placeholder={hasLiveLocation ? "My location" : "Pick a starting point"}
        leadingIcon={<FiNavigation className="h-4 w-4" aria-hidden="true" />}
        armed={pickTarget === "start"}
        canClear={startSet}
        clearLabel="Reset start to your location"
        pickLabel="Pick start on the map"
        onSelect={onStartSelect}
        onClear={onStartClear}
        onArmPick={onArmStart}
        currentLocationLabel={hasLiveLocation ? "My location" : null}
        onUseCurrentLocation={onUseCurrentLocation}
      />
      <LocationField
        city={city}
        label={destLabel}
        placeholder="Where to?"
        leadingIcon={<FiSearch className="h-4 w-4" aria-hidden="true" />}
        armed={pickTarget === "dest"}
        canClear={destSet}
        clearLabel="Clear destination"
        pickLabel="Pick destination on the map"
        onSelect={onDestSelect}
        onClear={onDestClear}
        onArmPick={onArmDest}
        prefill={destPrefill}
      />
    </>
  );

  if (onSwap === undefined) {
    return fields;
  } else {
    return (
      // Centered on the seam between the two boxes and hung half outside them, into the card's own
      // padding: it sits clear of each field's own buttons, which are centered in their rows.
      <div className="relative space-y-2">
        {fields}
        <button
          type="button"
          onClick={onSwap}
          aria-label="Swap start and destination"
          title="Swap start and destination"
          className="absolute top-1/2 right-0 z-10 grid h-7 w-7 -translate-y-1/2 translate-x-1/3 place-items-center rounded-full bg-white text-slate-500 shadow-md ring-1 ring-black/5 transition hover:text-slate-700 dark:bg-slate-700 dark:text-slate-300 dark:ring-white/10 dark:hover:text-white"
        >
          <MdSwapVert className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    );
  }
}

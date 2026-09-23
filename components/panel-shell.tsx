"use client";

import type { ReactNode } from "react";
import { FiNavigation, FiSearch } from "react-icons/fi";
import { MdSwapVert } from "react-icons/md";
import type { City } from "../src/cities";
import type { GeocodeResult } from "../src/geocode";
import LocationField, { type DestPrefill } from "./location-field";
import { PeekBar, type PeekNext } from "./maneuvers";

export const PANEL_WRAPPER =
  "fixed bottom-0 left-1/2 z-[1000] w-full max-w-md -translate-x-1/2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:left-auto sm:right-4 sm:translate-x-0 sm:px-0";

// `100vh` overflows under browser chrome; 4rem clears the toolbar; no `overflow` for suggestions.
export const PANEL_CARD =
  "flex max-h-[calc(100dvh-env(safe-area-inset-top)-4rem-max(0.75rem,env(safe-area-inset-bottom)))] flex-col rounded-2xl bg-white/85 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10";

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
  header?: ReactNode;
  cardClassName?: string;
  corner?: ReactNode;
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
  // Candidates for a link's destination text that didn't resolve to one place.
  destPrefill: DestPrefill | null;
  onStartSelect: (result: GeocodeResult) => void;
  onDestSelect: (result: GeocodeResult) => void;
  onStartClear: () => void;
  onDestClear: () => void;
  onUseCurrentLocation: () => void;
  onArmStart: () => void;
  onArmDest: () => void;
  onSwap?: () => void;
}

// Without a swap this is a fragment; with one it is a box, since the button hangs on the seam.
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
      // Hung half outside the boxes into the card padding, clear of each field's own buttons.
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

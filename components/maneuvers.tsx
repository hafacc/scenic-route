"use client";

import { useEffect, useRef } from "react";
import { FiChevronUp } from "react-icons/fi";
import {
  MdAccountBalance,
  MdArrowUpward,
  MdDirectionsBoat,
  MdElevator,
  MdFlag,
  MdLogout,
  MdOutlineDirectionsWalk,
  MdPalette,
  MdStairs,
  MdSwapHoriz,
  MdTransferWithinAStation,
  MdTurnLeft,
  MdTurnRight,
  MdTurnSlightLeft,
  MdTurnSlightRight,
  MdUTurnLeft,
} from "react-icons/md";
import {
  formatDistance,
  formatDuration,
  type Maneuver,
} from "../src/routing/directions";
import type { NavProgress } from "../src/routing/nav-progress";
import { LinePill } from "./modes/route-cards";

// A ride's bubble is not an icon in a disc: it is the line's own bullet, at the size the disc was.
const RIDE_BUBBLE =
  "flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-bold leading-none";

export function maneuverIcon(maneuver: Maneuver) {
  const props = { className: "h-4 w-4", "aria-hidden": true } as const;
  if (maneuver.kind === "landmark") {
    return <MdAccountBalance {...props} />;
  }
  if (maneuver.kind === "art") {
    return <MdPalette {...props} />;
  }
  if (maneuver.kind === "cross") {
    return <MdSwapHoriz {...props} />;
  }
  if (maneuver.kind === "arrive") {
    return <MdFlag {...props} />;
  }
  if (maneuver.kind === "ferry") {
    return <MdDirectionsBoat {...props} />;
  }
  if (maneuver.kind === "station") {
    // Off a train, from one train to the next, or through the doors of the station itself — three
    // different acts, and the only thing a reader has to tell them apart at a glance.
    if (maneuver.station === "alight") {
      return <MdLogout {...props} />;
    }
    if (maneuver.station === "change") {
      return <MdTransferWithinAStation {...props} />;
    }
    if (maneuver.door === "elevator") {
      return <MdElevator {...props} />;
    }
    return <MdStairs {...props} />;
  }
  if (maneuver.kind === "continue") {
    return <MdArrowUpward {...props} />;
  }
  if (maneuver.kind === "turn") {
    switch (maneuver.turn) {
      case "left":
        return <MdTurnLeft {...props} />;
      case "right":
        return <MdTurnRight {...props} />;
      case "slight left":
        return <MdTurnSlightLeft {...props} />;
      case "slight right":
        return <MdTurnSlightRight {...props} />;
      case "around":
        return <MdUTurnLeft {...props} />;
      default:
        return <MdOutlineDirectionsWalk {...props} />;
    }
  }
  return <MdOutlineDirectionsWalk {...props} />;
}

// The dimmed rows stop exactly where the highlight begins. Asking nextManeuver rather than
// currentManeuver is what keeps the arrive row, where the two are clamped together, from being
// dimmed and highlighted at once.
export function maneuverState(
  progress: NavProgress | null,
  index: number,
): "passed" | "next" | "ahead" {
  if (progress === null) {
    return "ahead";
  } else if (index === progress.nextManeuver) {
    return "next";
  } else if (index < progress.nextManeuver) {
    return "passed";
  } else {
    return "ahead";
  }
}

export function ManeuverList({
  directions,
  progress,
  className,
}: {
  directions: Maneuver[];
  progress: NavProgress | null; // live position along the route, or null when off-route/unlocated
  className: string;
}) {
  // The highlighted maneuver row is scrolled into view whenever the next maneuver advances.
  const highlightRef = useRef<HTMLLIElement | null>(null);
  const nextIndex = progress ? progress.nextManeuver : null;
  useEffect(() => {
    if (nextIndex !== null) {
      highlightRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [nextIndex]);

  return (
    <ol className={className}>
      {directions.map((maneuver, index) => {
        const state = maneuverState(progress, index);
        const isNext = state === "next";
        const isPassed = state === "passed";
        // Passed landmarks and artwork wear their overlay color, so the turn-by-turn reads
        // as the same palette as the map.
        const bubbleClass =
          maneuver.kind === "landmark"
            ? "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300"
            : maneuver.kind === "art"
              ? "bg-fuchsia-50 text-fuchsia-600 dark:bg-fuchsia-500/15 dark:text-fuchsia-300"
              : "bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300";
        const textClass =
          maneuver.kind === "landmark"
            ? "text-amber-700 dark:text-amber-300"
            : maneuver.kind === "art"
              ? "text-fuchsia-700 dark:text-fuchsia-300"
              : "text-slate-700 dark:text-slate-200";
        return (
          <li
            key={`${maneuver.kind}-${maneuver.stepRange[0]}-${maneuver.stepRange[1]}-${maneuver.text}`}
            ref={isNext ? highlightRef : null}
            className={`flex items-center gap-3 rounded-lg px-2 py-1.5 ${
              isNext ? "bg-brand-100 font-medium dark:bg-brand-500/25" : ""
            } ${isPassed ? "opacity-50" : ""}`}
          >
            {maneuver.ride ? (
              <LinePill ride={maneuver.ride} className={RIDE_BUBBLE} />
            ) : (
              <span
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${bubbleClass}`}
              >
                {maneuverIcon(maneuver)}
              </span>
            )}
            <span className={`min-w-0 flex-1 text-sm ${textClass}`}>
              {maneuver.text}
            </span>
            {maneuver.kind === "ferry" || maneuver.kind === "transit" ? (
              <span className="shrink-0 text-xs font-medium text-slate-400 dark:text-slate-500">
                {formatDuration(maneuver.durationSeconds ?? 0)}
              </span>
            ) : maneuver.lengthMeters > 0 ? (
              <span className="shrink-0 text-xs font-medium text-slate-400 dark:text-slate-500">
                {formatDistance(maneuver.lengthMeters)}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

// The slim bar the panel collapses to while navigating: the next maneuver, or the route summary
// where there is no live position to place the walker on.
export interface PeekNext {
  maneuver: Maneuver; // what to do next
  distanceMeters: number; // how far off it is, on foot
  // What the walker is doing now. Only a ride changes what the bar says, and it changes it entirely:
  // there is no walking left between here and getting off, and underground there is no fix either.
  current: Maneuver | null;
}

// The bar's own chrome, for a deck that floats it alone; a deck that keeps it as a row of its own
// card hands it `bare` and the card carries the chrome instead.
const PEEK_CHROME =
  "rounded-2xl bg-white/85 px-4 py-3 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10";

export function PeekBar({
  next,
  fallback,
  bare,
  onExpand,
}: {
  next: PeekNext | null;
  fallback: string;
  bare?: boolean;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label="Expand directions"
      className={`flex min-h-10 w-full items-center justify-between gap-2 text-left ${bare ? "" : PEEK_CHROME}`}
    >
      {next ? (
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
            {maneuverIcon(next.maneuver)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
              {next.maneuver.text}
            </span>
            <span className="block text-xs font-medium text-slate-400 dark:text-slate-500">
              {next.current?.kind === "transit"
                ? `after ${next.current.stops ?? 0} stop${next.current.stops === 1 ? "" : "s"} · ${formatDuration(next.current.durationSeconds ?? 0)}`
                : `in ${formatDistance(next.distanceMeters)}`}
            </span>
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
          {fallback}
        </span>
      )}
      <FiChevronUp
        className="h-5 w-5 shrink-0 text-slate-400"
        aria-hidden="true"
      />
    </button>
  );
}

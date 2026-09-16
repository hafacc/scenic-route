"use client";

import { useEffect, useRef } from "react";
import { FiChevronUp } from "react-icons/fi";
import {
  MdAccountBalance,
  MdArrowUpward,
  MdDirectionsBoat,
  MdFlag,
  MdOutlineDirectionsWalk,
  MdPalette,
  MdSwapHoriz,
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
        const isNext = progress !== null && index === progress.nextManeuver;
        const isPassed = progress !== null && index < progress.currentManeuver;
        // Passed landmarks and artwork wear their overlay colour, so the turn-by-turn reads
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
            <span
              className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${bubbleClass}`}
            >
              {maneuverIcon(maneuver)}
            </span>
            <span className={`min-w-0 flex-1 text-sm ${textClass}`}>
              {maneuver.text}
            </span>
            {maneuver.kind === "ferry" ? (
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
export function PeekBar({
  next,
  fallback,
  onExpand,
}: {
  next: { maneuver: Maneuver; distanceMeters: number } | null;
  fallback: string;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label="Expand directions"
      className="flex w-full items-center justify-between gap-2 rounded-2xl bg-white/85 px-4 py-3 text-left shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10"
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
              in {formatDistance(next.distanceMeters)}
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

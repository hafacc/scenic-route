"use client";

import { useEffect, useRef, useState } from "react";
import { MdAccessTime, MdCalendarMonth } from "react-icons/md";
import {
  formatDay,
  getDateMode,
  getResolvedDay,
  getResolvedHour,
  getTimeMode,
  parseDay,
  setCustomDay,
  setCustomHour,
  setDateMode,
  setPickerOpen,
  setTimeMode,
  subscribeRouteTime,
} from "../src/route-time/store";
import { SHED_EPOCH_DAY } from "../src/routing/sheds";

const STEP_HOUR = 0.25;
// The same full day year-round, since the clock drives more than shade.
const MIN_HOUR = 0;
const MAX_HOUR = 23.75;
// Sun and phenology repeat yearly; the past reaches SHED_EPOCH_DAY for scaffolding history.
const FUTURE_YEARS = 1;

const ICON_ON = "h-4 w-4 text-brand-600 dark:text-brand-400";
const ICON_OFF = "h-4 w-4 text-slate-500 dark:text-slate-400";
const PILL_ON =
  "rounded-full bg-brand-500 px-2.5 py-1 text-xs font-medium text-white";
const PILL_OFF =
  "rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600";

// Format a float hour as a 12-hour clock label like "3:00 PM".
function formatHour(hour: number): string {
  const totalMinutes = Math.round(hour * 60);
  const clockHour = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const period = clockHour >= 12 ? "PM" : "AM";
  const displayHour = clockHour % 12 === 0 ? 12 : clockHour % 12;
  return `${displayHour}:${String(minutes).padStart(2, "0")} ${period}`;
}

// The pinned day, e.g. "Dec 21", with the year only when it isn't this one.
function formatDayLabel(day: string): string {
  const date = parseDay(day);
  const year =
    date.getFullYear() === new Date().getFullYear() ? undefined : "numeric";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year,
  });
}

function dayFromNow(years: number): string {
  const today = new Date();
  return formatDay(
    new Date(today.getFullYear() + years, today.getMonth(), today.getDate()),
  );
}

export default function ClockControl() {
  const [open, setOpen] = useState(false);
  const [dayOpen, setDayOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [, bump] = useState(0);
  useEffect(() => subscribeRouteTime(() => bump((value) => value + 1)), []);

  // Lets time-dependent overlays prefetch the day's tiles while scrubbing.
  useEffect(() => {
    setPickerOpen(open);
    return () => setPickerOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDocClick = (event: MouseEvent): void => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const custom = getTimeMode() === "custom";
  const hour = getResolvedHour();
  const pinnedDay = getDateMode() === "custom";
  const day = getResolvedDay();

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Date and time"
        title="Date and time"
        className="grid h-10 w-10 place-items-center rounded-full bg-white/85 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white dark:bg-slate-800/80 dark:ring-white/10 dark:hover:bg-slate-800"
      >
        <MdAccessTime
          className={custom || pinnedDay ? ICON_ON : ICON_OFF}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className="toolbar-menu absolute right-0 mt-2 w-64 origin-top-right rounded-2xl bg-white/95 p-3 shadow-2xl ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/95 dark:ring-white/10">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Time of day
            </span>
            <span className="text-xs font-medium tabular-nums text-slate-700 dark:text-slate-200">
              {pinnedDay ? `${formatDayLabel(day)}, ` : ""}
              {formatHour(hour)}
            </span>
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              // "Now" is this instant, not this time of day on the pinned date.
              onClick={() => {
                setTimeMode("now");
                setDateMode("today");
              }}
              aria-pressed={!custom && !pinnedDay}
              className={custom || pinnedDay ? PILL_OFF : PILL_ON}
            >
              Now
            </button>
            <button
              type="button"
              onClick={() => setDayOpen((value) => !value)}
              aria-expanded={dayOpen}
              aria-label="Pick a date"
              title="Pick a date"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-100 transition hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600"
            >
              <MdCalendarMonth
                className={pinnedDay ? ICON_ON : ICON_OFF}
                aria-hidden="true"
              />
            </button>
            <input
              type="range"
              min={MIN_HOUR}
              max={MAX_HOUR}
              step={STEP_HOUR}
              value={hour}
              onChange={(event) =>
                setCustomHour(Number.parseFloat(event.target.value))
              }
              aria-label="Time of day"
              className="min-w-0 flex-1 accent-slate-600 dark:accent-slate-400"
            />
          </div>
          {dayOpen ? (
            <div className="mt-2.5 flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => setDateMode("today")}
                aria-pressed={!pinnedDay}
                className={pinnedDay ? PILL_OFF : PILL_ON}
              >
                Today
              </button>
              <input
                type="date"
                value={day}
                min={SHED_EPOCH_DAY}
                max={dayFromNow(FUTURE_YEARS)}
                onChange={(event) => {
                  const picked = event.target.value;
                  if (picked) {
                    setCustomDay(picked);
                  } else {
                    setDateMode("today");
                  }
                }}
                aria-label="Date"
                className="min-w-0 flex-1 rounded-lg bg-slate-100 px-2 py-1 text-xs tabular-nums text-slate-700 dark:bg-slate-700 dark:text-slate-200 dark:[color-scheme:dark]"
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

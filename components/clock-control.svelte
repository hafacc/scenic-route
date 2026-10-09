<script lang="ts">
import { onDestroy } from "svelte";
import { MdAccessTime, MdCalendarMonth } from "../src/icons/glyphs";
import {
  formatDay,
  getDateMode,
  getResolvedDay,
  getResolvedHour,
  getTimeMode,
  parseDay,
  readDayPick,
  setCustomDay,
  setCustomHour,
  setDateMode,
  setPickerOpen,
  setTimeMode,
  subscribeRouteTime,
} from "../src/route-time/store";
import { SHED_EPOCH_DAY } from "../src/routing/sheds";
import { dismiss } from "./dismiss";
import { fromStore } from "./external-store.svelte";
import Icon from "./icon.svelte";

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

let open = $state.raw(false);
let dayOpen = $state.raw(false);
// Each is read where it is shown, so a menu that opens reads the clock again.
const timeMode = fromStore(subscribeRouteTime, getTimeMode);
const hour = fromStore(subscribeRouteTime, getResolvedHour);
const dateMode = fromStore(subscribeRouteTime, getDateMode);
const day = fromStore(subscribeRouteTime, getResolvedDay);

// The store is told too, so time-dependent overlays prefetch the day's tiles while scrubbing.
function setOpen(next: boolean): void {
  open = next;
  setPickerOpen(next);
}

onDestroy(() => setPickerOpen(false));

function now(): void {
  setTimeMode("now");
  setDateMode("today");
}

// Re-read when the date row toggles, a change the store never announces.
function shownHour(): number {
  void dayOpen;
  return hour.current;
}

const custom = $derived(timeMode.current === "custom");
const pinnedDay = $derived(dateMode.current === "custom");

// True while a key press in the date field is handled: an empty value then is typing, not the picker's Clear.
let keying = false;

// A timer, not `keyup`, ends it: the edit lands within the press, and a key let go elsewhere is never heard.
function markKeying(): void {
  keying = true;
  setTimeout(() => {
    keying = false;
  });
}

// What the field asks for is applied; only a cleared one is refilled, as the store's day may not have moved.
function applyDay(field: HTMLInputElement, partial: boolean): void {
  const pick = readDayPick(
    field.value,
    partial,
    SHED_EPOCH_DAY,
    dayFromNow(FUTURE_YEARS),
  );
  if (pick.kind === "day") {
    setCustomDay(pick.day);
  } else if (pick.kind === "today") {
    setDateMode("today");
    field.value = getResolvedDay();
  }
}

// An empty field is today again unless a key press emptied it: that is typing, not the picker's Clear.
function pickDay(event: Event & { currentTarget: HTMLInputElement }): void {
  applyDay(event.currentTarget, keying);
}

// Set by `bind:this`; pressing either takes the field away.
let menuToggle = $state.raw<HTMLButtonElement | null>(null);
let dayToggle = $state.raw<HTMLButtonElement | null>(null);

// Left fully empty the field is today again; left part-typed (`badInput`) or out of range it is put back.
function settleDay(
  event: FocusEvent & { currentTarget: HTMLInputElement },
): void {
  const field = event.currentTarget;
  const target = event.relatedTarget;
  // A blur from the menu closing, or from the press that toggles the field away, changes no pin.
  const going =
    !open || !dayOpen || target === menuToggle || target === dayToggle;
  if (!going) {
    applyDay(field, field.validity.badInput);
  }
  field.value = getResolvedDay();
}
</script>

<div {@attach open && dismiss(() => setOpen(false))} class="relative">
  <button
    bind:this={menuToggle}
    type="button"
    onclick={() => setOpen(!open)}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label="Date and time"
    title="Date and time"
    class="grid h-10 w-10 place-items-center rounded-full bg-white/85 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white dark:bg-slate-800/80 dark:ring-white/10 dark:hover:bg-slate-800"
  >
    <Icon
      icon={MdAccessTime}
      class={custom || pinnedDay ? ICON_ON : ICON_OFF}
      aria-hidden="true"
    />
  </button>
  {#if open}
    <div
      class="toolbar-menu absolute right-0 mt-2 w-64 origin-top-right rounded-2xl bg-white/95 p-3 shadow-2xl ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/95 dark:ring-white/10"
    >
      <div class="mb-2 flex items-center justify-between gap-2">
        <span
          class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
        >
          Time of day
        </span>
        <span
          class="text-xs font-medium tabular-nums text-slate-700 dark:text-slate-200"
        >
          {pinnedDay ? `${formatDayLabel(day.current)}, ` : ""}{formatHour(shownHour())}
        </span>
      </div>
      <div class="flex items-center gap-2.5">
        <!-- "Now" is this instant, not this time of day on the pinned date. -->
        <button
          type="button"
          onclick={now}
          aria-pressed={!custom && !pinnedDay}
          class={custom || pinnedDay ? PILL_OFF : PILL_ON}
        >
          Now
        </button>
        <button
          bind:this={dayToggle}
          type="button"
          onclick={() => (dayOpen = !dayOpen)}
          aria-expanded={dayOpen}
          aria-label="Pick a date"
          title="Pick a date"
          class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-100 transition hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600"
        >
          <Icon
            icon={MdCalendarMonth}
            class={pinnedDay ? ICON_ON : ICON_OFF}
            aria-hidden="true"
          />
        </button>
        <input
          type="range"
          min={MIN_HOUR}
          max={MAX_HOUR}
          step={STEP_HOUR}
          value={shownHour()}
          oninput={(event) => setCustomHour(Number.parseFloat(event.currentTarget.value))}
          aria-label="Time of day"
          class="min-w-0 flex-1 accent-slate-600 dark:accent-slate-400"
        >
      </div>
      {#if dayOpen}
        <div class="mt-2.5 flex items-center gap-2.5">
          <button
            type="button"
            onclick={() => setDateMode("today")}
            aria-pressed={!pinnedDay}
            class={pinnedDay ? PILL_OFF : PILL_ON}
          >
            Today
          </button>
          <input
            type="date"
            value={day.current}
            min={SHED_EPOCH_DAY}
            max={dayFromNow(FUTURE_YEARS)}
            oninput={pickDay}
            onblur={settleDay}
            onkeydown={markKeying}
            aria-label="Date"
            class="min-w-0 flex-1 rounded-lg bg-slate-100 px-2 py-1 text-xs tabular-nums text-slate-700 dark:bg-slate-700 dark:text-slate-200 dark:[color-scheme:dark]"
          >
        </div>
      {/if}
    </div>
  {/if}
</div>

// Time and day are independent axes, so midwinter at the live time of day is expressible.
export type TimeMode = "now" | "custom";
export type DateMode = "today" | "custom";

let mode: TimeMode = "now";
let customHour = 12; // local clock hour (float) used in "custom" mode
let dateMode: DateMode = "today";
let customDay = formatDay(new Date()); // local calendar day used in "custom" date mode
let pickerOpen = false; // the user may be scrubbing time
const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

// The sun moves ~0.25°/min, so tick each minute while tracking "now" with a listener.
function updateTicker(): void {
  const shouldRun = mode === "now" && listeners.size > 0;
  if (shouldRun && ticker === null) {
    ticker = setInterval(notify, 60_000);
  } else if (!shouldRun && ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

export function getTimeMode(): TimeMode {
  return mode;
}

export function setTimeMode(next: TimeMode): void {
  if (next === mode) {
    return;
  }
  mode = next;
  updateTicker();
  notify();
}

export function getCustomHour(): number {
  return customHour;
}

export function setCustomHour(hour: number): void {
  if (mode === "custom" && hour === customHour) {
    return;
  }
  customHour = hour;
  mode = "custom";
  updateTicker();
  notify();
}

// The form <input type="date"> reads and writes.
export function formatDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// `new Date(day)` would read the string as UTC.
export function parseDay(day: string): Date {
  return new Date(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10)),
  );
}

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

// A date field reports every keystroke: empty mid-entry, and year 0002 on the way to 2026.
export function dayInRange(
  day: string,
  earliest: string,
  latest: string,
): string | null {
  // The shape first: `parseDay` reads fixed columns, and "20260-01-15" orders inside the range as text.
  if (!DAY_SHAPE.test(day)) {
    return null;
  }
  const date = parseDay(day);
  // A day the calendar lacks rolls over into the next month.
  const real = formatDay(date) === day;
  return real && day >= earliest && day <= latest ? day : null;
}

// What a date field's state asks for: a day to pin, today again, or nothing yet.
export type DayPick =
  | { kind: "day"; day: string }
  | { kind: "today" }
  | { kind: "wait" };

// An empty value is a cleared field or one part-typed; the caller says which, by key press on input and `badInput` on blur.
export function readDayPick(
  value: string,
  partial: boolean,
  earliest: string,
  latest: string,
): DayPick {
  if (value === "") {
    return partial ? { kind: "wait" } : { kind: "today" };
  }
  const day = dayInRange(value, earliest, latest);
  // Out of range or malformed is not a pick; the field is put back when it is left.
  return day === null ? { kind: "wait" } : { kind: "day", day };
}

export function getDateMode(): DateMode {
  return dateMode;
}

export function setDateMode(next: DateMode): void {
  if (next === dateMode) {
    return;
  }
  dateMode = next;
  notify();
}

export function getResolvedDay(): string {
  return dateMode === "custom" ? customDay : formatDay(new Date());
}

export function setCustomDay(day: string): void {
  if (dateMode === "custom" && day === customDay) {
    return;
  }
  customDay = day;
  dateMode = "custom";
  notify();
}

// Null on a tracking axis, so it's absent from a link.
export function getPinnedTime(): { hour: number | null; day: string | null } {
  return {
    hour: mode === "custom" ? customHour : null,
    day: dateMode === "custom" ? customDay : null,
  };
}

export function getResolvedDate(): Date {
  const now = new Date();
  if (mode === "now" && dateMode === "today") {
    return now;
  }
  const day = dateMode === "custom" ? parseDay(customDay) : now;
  const minutes =
    mode === "custom"
      ? Math.round(customHour * 60)
      : now.getHours() * 60 + now.getMinutes();
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
}

export function getResolvedHour(): number {
  if (mode === "custom") {
    return customHour;
  }
  const now = new Date();
  return now.getHours() + now.getMinutes() / 60;
}

// Overlays prefetch the day's tiles while it's open and drop them when it closes.
export function isPickerOpen(): boolean {
  return pickerOpen;
}

export function setPickerOpen(open: boolean): void {
  if (open === pickerOpen) {
    return;
  }
  pickerOpen = open;
  notify();
}

export function subscribeRouteTime(listener: () => void): () => void {
  listeners.add(listener);
  updateTicker();
  return () => {
    listeners.delete(listener);
    updateTicker();
  };
}

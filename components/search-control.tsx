"use client";

import { useEffect, useId, useRef, useState } from "react";
import { FiSearch, FiX } from "react-icons/fi";
import { MdDirectionsWalk } from "react-icons/md";
import { type City, cityInSentence, containsPoint } from "../src/cities";
import { type GeocodeResult, searchPlaces } from "../src/geocode";
import { awaitNameIndex } from "../src/search/name-search";
import type { LatLng } from "../src/url-state";
import ResultList, {
  resultListKeyDown,
  SEARCH_DEBOUNCE_MS,
} from "./result-list";

// Copied verbatim from the route panel's wrapper and card; keep them in step.
const PANEL =
  "fixed bottom-0 left-1/2 z-[1000] w-full max-w-md -translate-x-1/2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:left-auto sm:right-4 sm:translate-x-0 sm:px-0";
const CARD =
  "flex max-h-[calc(100dvh-env(safe-area-inset-top)-4rem-max(0.75rem,env(safe-area-inset-bottom)))] flex-col rounded-2xl bg-white/85 p-4 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10";
const ICON_ON = "h-4 w-4 text-brand-600 dark:text-brand-400";
const ICON_OFF = "h-4 w-4 text-slate-500 dark:text-slate-400";
const CHROME =
  "bg-white/85 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10";
const CHROME_OPEN =
  "bg-brand-50/90 shadow-lg ring-1 ring-brand-500/30 backdrop-blur-md dark:bg-brand-500/20 dark:ring-brand-400/30";

// `results` is null while the index hasn't arrived, unlike "no such place".
interface Answer {
  query: string;
  results: GeocodeResult[] | null;
  outside: boolean;
}

interface SearchControlProps {
  city: City;
  open: boolean;
  pinned: boolean;
  center: () => LatLng | null;
  onOpenChange: (open: boolean) => void;
  onSelect: (result: GeocodeResult) => void;
  onDirections: () => void;
  onClear: () => void;
}

export default function SearchControl({
  city,
  open,
  pinned,
  center,
  onOpenChange,
  onSelect,
  onDirections,
  onClear,
}: SearchControlProps) {
  // Kept above the panel to survive a close; `label` fills the box without triggering a search.
  const [label, setLabel] = useState<string | null>(null);

  return (
    <>
      {/* left-[3.75rem]: the 12px inset, the follow toggle's 40px, and an 8px gap. */}
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-label="Search for a place"
        title="Search for a place"
        className={`absolute top-3 left-[3.75rem] z-[1000] grid h-10 w-10 place-items-center rounded-full transition ${
          open
            ? CHROME_OPEN
            : `hover:bg-white dark:hover:bg-slate-800 ${CHROME}`
        }`}
      >
        <FiSearch
          className={open || pinned ? ICON_ON : ICON_OFF}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className={PANEL}>
          <div className={CARD}>
            <SearchPanel
              city={city}
              pinned={pinned}
              center={center}
              label={label}
              onLabelChange={setLabel}
              onOpenChange={onOpenChange}
              onSelect={onSelect}
              onDirections={onDirections}
              onClear={onClear}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

interface SearchPanelProps {
  city: City;
  pinned: boolean;
  center: () => LatLng | null;
  label: string | null;
  onLabelChange: (label: string | null) => void;
  onOpenChange: (open: boolean) => void;
  onSelect: (result: GeocodeResult) => void;
  onDirections: () => void;
  onClear: () => void;
}

function SearchPanel({
  city,
  pinned,
  center,
  label,
  onLabelChange,
  onOpenChange,
  onSelect,
  onDirections,
  onClear,
}: SearchPanelProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onOpenChange]);

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">
          Find a place
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {/* Disabled rather than hidden, so the close button doesn't move under a finger. */}
          <button
            type="button"
            onClick={onDirections}
            disabled={!pinned}
            aria-label="Walking directions to this place"
            title="Walking directions to this place"
            className="-m-1 grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-slate-700"
          >
            <MdDirectionsWalk className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close search"
            className="-m-1 grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            <FiX />
          </button>
        </div>
      </div>
      <PlaceSearch
        city={city}
        center={center}
        label={label}
        placeholder="Search for a place"
        autoFocus
        className="mt-3"
        onSelect={(result) => {
          onLabelChange(result.displayName);
          onSelect(result);
        }}
        onClear={() => {
          onLabelChange(null);
          onClear();
        }}
      />
    </>
  );
}

interface PlaceSearchProps {
  city: City;
  center: () => LatLng | null;
  label: string | null;
  placeholder: string;
  autoFocus: boolean;
  className?: string;
  onSelect: (result: GeocodeResult) => void;
  onClear: () => void;
}

// None of this state may outlive the box, or leftover words reload a released index.
export function PlaceSearch({
  city,
  center,
  label,
  placeholder,
  autoFocus,
  className,
  onSelect,
  onClear,
}: PlaceSearchProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [listOpen, setListOpen] = useState<boolean>(false);
  const input = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  // biome-ignore lint/correctness/useExhaustiveDependencies: on mount only, whatever the flag says later
  useEffect(() => {
    if (autoFocus) {
      input.current?.focus();
    }
  }, []);

  // A stale answer is dropped; an unloaded index answers null and the draft reruns once it lands.
  useEffect(() => {
    const query = draft?.trim() ?? "";
    if (!query) {
      setAnswer(null);
      setActiveIndex(-1);
      return;
    }
    let stale = false;
    const show = (results: GeocodeResult[] | null, outside: boolean): void => {
      if (!stale) {
        setAnswer({ query, results, outside });
        setActiveIndex(-1);
        setListOpen(true);
      }
    };
    const timer = window.setTimeout(() => {
      const at = center();
      const outside = at !== null && !containsPoint(city, at);
      searchPlaces(query)
        .then(async (results) => {
          show(results, outside);
          if (results === null) {
            await awaitNameIndex(city.id);
            if (!stale) {
              show(await searchPlaces(query), outside);
            }
          }
        })
        .catch(() => {});
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [draft, city, center]);

  const value = draft ?? label ?? "";
  const results = answer?.results ?? null;

  // Unlike the route fields, a pick leaves the box open; the blur drops the phone keyboard.
  const select = (result: GeocodeResult): void => {
    setDraft(null);
    setListOpen(false);
    setActiveIndex(-1);
    input.current?.blur();
    onSelect(result);
  };

  // The pin has no handle on the map, so this and the next search are the only ways to clear it.
  const clear = (): void => {
    onClear();
    setDraft(null);
    setAnswer(null);
    setActiveIndex(-1);
    setListOpen(false);
    input.current?.focus();
  };

  const rows = listOpen && results !== null ? results : [];

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    resultListKeyDown(event, rows, activeIndex, setActiveIndex, select);
  };

  // Never both a list and the stand-in row: a coverage warning over matches contradicts itself.
  const notice =
    answer === null
      ? null
      : answer.outside
        ? `Search covers ${cityInSentence(city)} — the map has no data here.`
        : results === null
          ? "Still loading this region's places…"
          : results.length === 0
            ? `No matches in ${cityInSentence(city)}.`
            : null;

  return (
    <>
      <div className={`relative shrink-0 ${className ?? ""}`}>
        <span className="pointer-events-none absolute inset-y-0 left-3 grid place-items-center">
          <FiSearch className={ICON_ON} aria-hidden="true" />
        </span>
        <input
          ref={input}
          type="text"
          value={value}
          onChange={(event) => setDraft(event.target.value)}
          // Selects all: the next thing typed is a new search, not an edit.
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
          autoComplete="off"
          role="combobox"
          aria-expanded={notice !== null || rows.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
          }
          className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-10 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-brand-500 dark:focus:bg-slate-900 dark:focus:ring-brand-500/20"
        />
        {value ? (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear the search"
            className="absolute inset-y-0 right-1.5 my-auto grid h-7 w-7 place-items-center rounded-full text-slate-400 transition hover:text-slate-600 dark:hover:text-slate-200"
          >
            <FiX className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {notice !== null || rows.length > 0 ? (
        <ResultList
          listId={listId}
          results={rows}
          activeIndex={activeIndex}
          onHover={setActiveIndex}
          onPick={select}
          notice={notice}
          className="mt-2 min-h-0 shrink"
        />
      ) : null}
    </>
  );
}

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { FiCrosshair, FiNavigation, FiX } from "react-icons/fi";
import { type City, cityInSentence } from "../src/cities";
import { type GeocodeResult, searchPlaces } from "../src/geocode";
import { awaitNameIndex } from "../src/search/name-search";
import ResultList, {
  resultListKeyDown,
  SEARCH_DEBOUNCE_MS,
} from "./result-list";

// px, before the room above the field is taken into account.
const MAX_SUGGESTION_HEIGHT = 256;
// px of clearance above the list.
const SUGGESTION_MARGIN = 8;
const BLUR_CLOSE_MS = 120;

// An empty list while the index loads would tell an early typist the place doesn't exist.
type Suggestions =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "answered"; results: GeocodeResult[] };

const IDLE: Suggestions = { kind: "idle" };
const NONE: readonly GeocodeResult[] = [];

export interface DestPrefill {
  text: string;
  results: GeocodeResult[];
}

interface LocationFieldProps {
  city: City;
  label: string | null;
  placeholder: string;
  leadingIcon: React.ReactNode;
  armed: boolean;
  canClear: boolean;
  clearLabel: string;
  pickLabel: string;
  onSelect: (result: GeocodeResult) => void;
  onClear: () => void;
  onArmPick: () => void;
  // When both are set, a "My location" row is prepended and the list opens on focus even when empty.
  currentLocationLabel?: string | null;
  onUseCurrentLocation?: () => void;
  // Passed in, as a cold search misses the unloaded index; unfocused so no keyboard hides them.
  prefill?: DestPrefill | null;
}

export default function LocationField({
  city,
  label,
  placeholder,
  leadingIcon,
  armed,
  canClear,
  clearLabel,
  pickLabel,
  onSelect,
  onClear,
  onArmPick,
  currentLocationLabel,
  onUseCurrentLocation,
  prefill,
}: LocationFieldProps) {
  // null means not editing, so the box mirrors the committed label.
  const [draft, setDraft] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestions>(IDLE);
  const list = useRef<HTMLUListElement | null>(null);
  const [roomAbove, setRoomAbove] = useState<number>(MAX_SUGGESTION_HEIGHT);
  const listId = useId();

  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [open, setOpen] = useState<boolean>(false);

  // Retiring a prefill clears its words so the committed label shows through.
  useEffect(() => {
    if (prefill) {
      setDraft(prefill.text);
      setSuggestions({ kind: "answered", results: prefill.results });
      setActiveIndex(-1);
      setOpen(true);
    } else {
      setDraft(null);
      setSuggestions(IDLE);
      setActiveIndex(-1);
      setOpen(false);
    }
  }, [prefill]);

  const value = draft ?? label ?? "";
  const results: readonly GeocodeResult[] =
    suggestions.kind === "answered" ? suggestions.results : NONE;
  const showCurrentRow = Boolean(currentLocationLabel && onUseCurrentLocation);

  // Never both: a no-match bar printed over matches contradicts itself.
  const notice =
    suggestions.kind === "idle"
      ? null
      : suggestions.kind === "loading"
        ? "Still loading this region's places…"
        : results.length === 0
          ? `No matches in ${cityInSentence(city)}.`
          : null;

  const dropdownOpen =
    open && (showCurrentRow || notice !== null || results.length > 0);

  // Remeasured on open and content change, since the field moves as the panel resizes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the deps are what moves the anchor
  useEffect(() => {
    const anchor = list.current?.parentElement;
    if (!anchor) {
      return;
    }
    const above = anchor.getBoundingClientRect().top - SUGGESTION_MARGIN;
    setRoomAbove(Math.max(0, Math.min(MAX_SUGGESTION_HEIGHT, above)));
  }, [dropdownOpen, results.length, notice]);

  // A stale answer is dropped; an unloaded index answers null and the draft reruns once it lands.
  useEffect(() => {
    const trimmed = draft?.trim() ?? "";
    if (!trimmed) {
      setSuggestions(IDLE);
      setActiveIndex(-1);
      return;
    }
    let stale = false;
    const show = (hits: GeocodeResult[] | null): void => {
      if (!stale) {
        setSuggestions(
          hits === null
            ? { kind: "loading" }
            : { kind: "answered", results: hits },
        );
        setActiveIndex(-1);
        setOpen(true);
      }
    };
    const timer = window.setTimeout(() => {
      searchPlaces(trimmed)
        .then(async (hits) => {
          show(hits);
          if (hits === null) {
            await awaitNameIndex(city.id);
            if (!stale) {
              show(await searchPlaces(trimmed));
            }
          }
        })
        .catch(() => {});
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [draft, city]);

  // Every commit path snaps the draft back to null so the box shows the freshly committed label.
  const commit = (): void => {
    setDraft(null);
    setSuggestions(IDLE);
    setActiveIndex(-1);
    setOpen(false);
  };

  const select = (result: GeocodeResult): void => {
    commit();
    onSelect(result);
  };

  const useCurrentLocation = (): void => {
    commit();
    onUseCurrentLocation?.();
  };

  const clear = (): void => {
    commit();
    onClear();
  };

  // Arming a map pick abandons any in-progress typing so the picked point's label fills the box.
  const armPick = (): void => {
    commit();
    onArmPick();
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    const handled =
      open &&
      resultListKeyDown(event, results, activeIndex, setActiveIndex, select);
    if (!handled && event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-3 grid place-items-center text-slate-400">
        {leadingIcon}
      </span>
      <input
        type="text"
        value={value}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), BLUR_CLOSE_MS)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={dropdownOpen}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
        }
        className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-16 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-brand-500 dark:focus:bg-slate-900 dark:focus:ring-brand-500/20"
      />
      <div className="absolute inset-y-0 right-1.5 flex items-center gap-0.5">
        {canClear ? (
          <button
            type="button"
            onClick={clear}
            aria-label={clearLabel}
            className="grid h-7 w-7 place-items-center rounded-full text-slate-400 transition hover:text-slate-600 dark:hover:text-slate-200"
          >
            <FiX className="h-4 w-4" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={armPick}
          aria-label={pickLabel}
          aria-pressed={armed}
          className={`grid h-7 w-7 place-items-center rounded-full transition ${
            armed
              ? "bg-brand-100 text-brand-600 dark:bg-brand-500/20 dark:text-brand-300"
              : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          }`}
        >
          <FiCrosshair className="h-4 w-4" />
        </button>
      </div>
      {dropdownOpen ? (
        // Opens upward out of the route panel; the cap is measured because the field moves.
        <ResultList
          listId={listId}
          listRef={list}
          results={results}
          activeIndex={activeIndex}
          onHover={setActiveIndex}
          onPick={select}
          notice={notice}
          leadingAction={
            showCurrentRow && currentLocationLabel
              ? {
                  icon: (
                    <FiNavigation
                      className="h-4 w-4 shrink-0"
                      aria-hidden="true"
                    />
                  ),
                  label: currentLocationLabel,
                  onPick: useCurrentLocation,
                  tone: "brand",
                }
              : null
          }
          style={{ maxHeight: roomAbove }}
          className="absolute bottom-full left-0 z-10 mb-1 w-full rounded-xl bg-white p-1 shadow-xl ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10"
        />
      ) : null}
    </div>
  );
}

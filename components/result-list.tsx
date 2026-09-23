"use client";

import type {
  CSSProperties,
  Dispatch,
  KeyboardEvent,
  ReactNode,
  Ref,
  SetStateAction,
} from "react";
import type { GeocodeResult } from "../src/geocode";
import ResultGlyph from "./result-glyph";

export const SEARCH_DEBOUNCE_MS = 300;

const ROW =
  "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm";
const IDLE =
  "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700/60";
const ACTIVE =
  "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300";
const BRAND =
  "font-medium text-brand-700 hover:bg-slate-50 dark:text-brand-300 dark:hover:bg-slate-700/60";

// Kept out of the option ids and keyboard cycle, or Enter would stop picking the first match.
export interface LeadingAction {
  icon: ReactNode;
  label: string;
  onPick: () => void;
  tone?: "brand";
}

interface ResultListProps {
  listId: string;
  results: readonly GeocodeResult[];
  activeIndex: number; // -1 = none
  onHover: (index: number) => void;
  onPick: (result: GeocodeResult) => void;
  notice?: string | null;
  leadingAction?: LeadingAction | null;
  className: string;
  style?: CSSProperties;
  listRef?: Ref<HTMLUListElement>;
}

export default function ResultList({
  listId,
  results,
  activeIndex,
  onHover,
  onPick,
  notice,
  leadingAction,
  className,
  style,
  listRef,
}: ResultListProps) {
  return (
    <ul
      ref={listRef}
      id={listId}
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA in HTML allows it
      role="listbox"
      style={style}
      className={`space-y-0.5 overflow-y-auto overscroll-contain ${className}`}
    >
      {leadingAction ? (
        // A listbox owns its options directly, so each `li` wrapper is `role="none"`.
        <li role="none">
          <button
            type="button"
            // Keep focus, or a blur races the field's close timer and swallows the pick.
            onMouseDown={(event) => event.preventDefault()}
            onClick={leadingAction.onPick}
            className={`${ROW} ${leadingAction.tone === "brand" ? BRAND : IDLE}`}
          >
            {leadingAction.icon}
            {leadingAction.label}
          </button>
        </li>
      ) : null}
      {notice ? (
        <li
          role="none"
          className="px-2 py-2 text-sm text-slate-500 dark:text-slate-400"
        >
          {notice}
        </li>
      ) : (
        results.map((result, index) => (
          <li key={result.placeId} role="none">
            <button
              type="button"
              role="option"
              id={`${listId}-${index}`}
              aria-selected={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(result)}
              onMouseEnter={() => onHover(index)}
              className={`${ROW} ${index === activeIndex ? ACTIVE : IDLE}`}
            >
              <ResultGlyph type={result.type} />
              <span className="truncate">{result.displayName}</span>
            </button>
          </li>
        ))
      )}
    </ul>
  );
}

// Returns whether the key was handled, so a caller can handle Escape its own way.
export function resultListKeyDown(
  event: KeyboardEvent<HTMLElement>,
  results: readonly GeocodeResult[],
  activeIndex: number,
  setActive: Dispatch<SetStateAction<number>>,
  pick: (result: GeocodeResult) => void,
): boolean {
  if (results.length === 0) {
    return false;
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    setActive((index) => (index + 1) % results.length);
    return true;
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setActive((index) => (index - 1 + results.length) % results.length);
    return true;
  } else if (event.key === "Enter") {
    const chosen = results[activeIndex] ?? results[0];
    if (chosen) {
      event.preventDefault();
      pick(chosen);
      return true;
    } else {
      return false;
    }
  } else {
    return false;
  }
}

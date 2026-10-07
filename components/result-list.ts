// What result-list.svelte shares beside the component.
import { type GeocodeResult, searchPlaces } from "../src/geocode";
import type { IconData } from "../src/icons/types";
import { awaitNameIndex } from "../src/search/name-search";

const SEARCH_DEBOUNCE_MS = 300;

// Kept out of the option ids and keyboard cycle, or Enter would stop picking the first match.
export interface LeadingAction {
  icon: IconData;
  label: string;
  onPick: () => void;
  tone?: "brand";
}

// Returns the row an arrow moved to, or null when the active row stays where it is.
export function resultListKeyDown(
  event: KeyboardEvent,
  results: readonly GeocodeResult[],
  activeIndex: number,
  pick: (result: GeocodeResult) => void,
): number | null {
  if (results.length === 0) {
    return null;
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    return (activeIndex + 1) % results.length;
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    // From no active row the list is entered at its end.
    return activeIndex <= 0 ? results.length - 1 : activeIndex - 1;
  } else if (event.key === "Enter") {
    const chosen = results[activeIndex] ?? results[0];
    if (chosen) {
      event.preventDefault();
      pick(chosen);
    }
    return null;
  } else {
    return null;
  }
}

// Null is an index still loading, which a second answer follows; "failed" is one that never arrived.
export type SearchAnswer = GeocodeResult[] | "failed" | null;

export const SEARCH_FAILED =
  "Couldn't load this region's places. Check your connection.";

// Answers after a pause in typing.
export function searchSoon(
  query: string,
  cityId: string,
  answer: (results: SearchAnswer) => void,
): () => void {
  let stale = false;
  const show = (results: SearchAnswer): void => {
    if (!stale) {
      answer(results);
    }
  };
  const timer = window.setTimeout(() => {
    searchPlaces(query)
      .then(async (results) => {
        show(results);
        if (results === null) {
          const loaded = await awaitNameIndex(cityId);
          if (!stale) {
            // Asking a failed index again would only start the load over and answer null.
            show(loaded ? await searchPlaces(query) : "failed");
          }
        }
      })
      .catch(() => {});
  }, SEARCH_DEBOUNCE_MS);
  // A stale answer is dropped, so a slow search never overwrites a newer one.
  return () => {
    stale = true;
    window.clearTimeout(timer);
  };
}

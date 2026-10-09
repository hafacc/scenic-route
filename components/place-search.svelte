<script lang="ts">
import { onMount } from "svelte";
import { type City, cityInSentence, containsPoint } from "../src/cities";
import type { GeocodeResult } from "../src/geocode";
import { FiSearch, FiX } from "../src/icons/glyphs";
import type { LatLng } from "../src/url-state";
import Icon from "./icon.svelte";
import {
  resultListKeyDown,
  SEARCH_FAILED,
  type SearchAnswer,
  searchSoon,
} from "./result-list";
import ResultList from "./result-list.svelte";

const ICON_ON = "h-4 w-4 text-brand-600 dark:text-brand-400";

// `results` is null while the index hasn't arrived, unlike "no such place".
interface Answer {
  query: string;
  results: SearchAnswer;
  outside: boolean;
}

interface PlaceSearchProps {
  city: City;
  center: () => LatLng | null;
  label: string | null;
  placeholder: string;
  focusOnOpen: boolean;
  class?: string;
  onSelect: (result: GeocodeResult) => void;
  onClear: () => void;
}

// None of this state may outlive the box, or leftover words reload a released index.
const {
  city,
  center,
  label,
  placeholder,
  focusOnOpen,
  class: className,
  onSelect,
  onClear,
}: PlaceSearchProps = $props();

let draft = $state.raw<string | null>(null);
let answer = $state.raw<Answer | null>(null);
let activeIndex = $state.raw<number>(-1);
let listOpen = $state.raw<boolean>(false);
let input = $state.raw<HTMLInputElement | null>(null);
const listId = $props.id();

onMount(() => {
  if (focusOnOpen) {
    input?.focus();
  }
});

// A null answer says the index is still loading; the search answers again once it lands.
$effect(() => {
  const query = draft?.trim() ?? "";
  if (!query) {
    answer = null;
    activeIndex = -1;
    return;
  }
  return searchSoon(query, city.id, (results) => {
    const at = center();
    answer = {
      query,
      results,
      outside: at !== null && !containsPoint(city, at),
    };
    activeIndex = -1;
    listOpen = true;
  });
});

const value = $derived(draft ?? label ?? "");
const found = $derived(answer?.results ?? null);
const results = $derived(found === "failed" ? null : found);

// Unlike the route fields, a pick leaves the box open; the blur drops the phone keyboard.
const select = (result: GeocodeResult): void => {
  draft = null;
  listOpen = false;
  activeIndex = -1;
  input?.blur();
  onSelect(result);
};

// The pin has no handle on the map, so this and the next search are the only ways to clear it.
const clear = (): void => {
  onClear();
  draft = null;
  answer = null;
  activeIndex = -1;
  listOpen = false;
  input?.focus();
};

const rows = $derived(listOpen && results !== null ? results : []);

const handleKeyDown = (event: KeyboardEvent): void => {
  const moved = resultListKeyDown(event, rows, activeIndex, select);
  if (moved !== null) {
    activeIndex = moved;
  }
};

const handleInput = (event: Event & { currentTarget: HTMLInputElement }) => {
  draft = event.currentTarget.value;
};

// Never both a list and the stand-in row: a coverage warning over matches contradicts itself.
const notice = $derived(
  answer === null
    ? null
    : answer.outside
      ? `Search covers ${cityInSentence(city)} — the map has no data here.`
      : found === "failed"
        ? SEARCH_FAILED
        : results === null
          ? "Still loading this region's places…"
          : results.length === 0
            ? `No matches in ${cityInSentence(city)}.`
            : null,
);
</script>

<div class={`relative shrink-0 ${className ?? ""}`}>
  <span
    class="pointer-events-none absolute inset-y-0 left-3 grid place-items-center"
  >
    <Icon icon={FiSearch} class={ICON_ON} aria-hidden="true" />
  </span>
  <!-- Selects all on focus: the next thing typed is a new search, not an edit. -->
  <input
    bind:this={input}
    type="text"
    {value}
    oninput={handleInput}
    onfocus={(event) => event.currentTarget.select()}
    onkeydown={handleKeyDown}
    {placeholder}
    aria-label={placeholder}
    autocomplete="off"
    role="combobox"
    aria-expanded={notice !== null || rows.length > 0}
    aria-controls={listId}
    aria-autocomplete="list"
    aria-activedescendant={activeIndex >= 0
      ? `${listId}-${activeIndex}`
      : undefined}
    class="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-10 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-brand-500 dark:focus:bg-slate-900 dark:focus:ring-brand-500/20"
  >
  {#if value}
    <button
      type="button"
      onclick={clear}
      aria-label="Clear the search"
      class="absolute inset-y-0 right-1.5 my-auto grid h-7 w-7 place-items-center rounded-full text-slate-400 transition hover:text-slate-600 dark:hover:text-slate-200"
    >
      <Icon icon={FiX} class="h-4 w-4" />
    </button>
  {/if}
</div>

{#if notice !== null || rows.length > 0}
  <ResultList
    {listId}
    results={rows}
    {activeIndex}
    onHover={(index) => (activeIndex = index)}
    onPick={select}
    {notice}
    class="mt-2 min-h-0 shrink"
  />
{/if}

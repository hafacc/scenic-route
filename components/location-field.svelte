<script lang="ts">
import { type City, cityInSentence } from "../src/cities";
import type { GeocodeResult } from "../src/geocode";
import { FiCrosshair, FiNavigation, FiX } from "../src/icons/glyphs";
import type { IconData } from "../src/icons/types";
import Icon from "./icon.svelte";
import { resultListKeyDown, SEARCH_FAILED, searchSoon } from "./result-list";
import ResultList from "./result-list.svelte";
import type { DestPrefill } from "./shell-types";

// px, before the room above the field is taken into account.
const MAX_SUGGESTION_HEIGHT = 256;
// px of clearance above the list.
const SUGGESTION_MARGIN = 8;
const BLUR_CLOSE_MS = 120;

// An empty list while the index loads would tell an early typist the place doesn't exist.
type Suggestions =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "answered"; results: GeocodeResult[] };

const IDLE: Suggestions = { kind: "idle" };
const NONE: readonly GeocodeResult[] = [];

const ARMED =
  "bg-brand-100 text-brand-600 dark:bg-brand-500/20 dark:text-brand-300";
const UNARMED = "text-slate-400 hover:text-slate-600 dark:hover:text-slate-200";

interface LocationFieldProps {
  city: City;
  label: string | null;
  placeholder: string;
  leadingIcon: IconData;
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

const {
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
}: LocationFieldProps = $props();

// null means not editing, so the box mirrors the committed label.
let draft = $state.raw<string | null>(null);
let suggestions = $state.raw<Suggestions>(IDLE);
let roomAbove = $state.raw<number>(MAX_SUGGESTION_HEIGHT);
const listId = $props.id();

let activeIndex = $state.raw<number>(-1);
let open = $state.raw<boolean>(false);

// An effect, not derived: a prefill arriving or retiring overwrites what typing has since changed.
$effect(() => {
  if (prefill) {
    draft = prefill.text;
    suggestions = { kind: "answered", results: prefill.results };
    activeIndex = -1;
    open = true;
  } else {
    // Its words go too, so the committed label shows through.
    draft = null;
    suggestions = IDLE;
    activeIndex = -1;
    open = false;
  }
});

const value = $derived(draft ?? label ?? "");
const results: readonly GeocodeResult[] = $derived(
  suggestions.kind === "answered" ? suggestions.results : NONE,
);
const showCurrentRow = $derived(
  Boolean(currentLocationLabel && onUseCurrentLocation),
);

// Never both: a no-match bar printed over matches contradicts itself.
const notice = $derived(
  suggestions.kind === "idle"
    ? null
    : suggestions.kind === "loading"
      ? "Still loading this region's places…"
      : suggestions.kind === "failed"
        ? SEARCH_FAILED
        : results.length === 0
          ? `No matches in ${cityInSentence(city)}.`
          : null,
);

const dropdownOpen = $derived(
  open && (showCurrentRow || notice !== null || results.length > 0),
);

// Remeasured on open and content change, since the field moves as the panel resizes.
$effect(() => {
  // Read for the rerun alone: the height they change is the DOM's, which is not tracked.
  void results.length;
  void notice;
  if (!dropdownOpen) {
    return;
  }
  // The list only exists while the dropdown is open, so it is looked up rather than bound.
  const anchor = document.getElementById(listId)?.parentElement;
  if (anchor) {
    const above = anchor.getBoundingClientRect().top - SUGGESTION_MARGIN;
    roomAbove = Math.max(0, Math.min(MAX_SUGGESTION_HEIGHT, above));
  }
});

// A null answer says the index is still loading; the search answers again once it lands.
$effect(() => {
  const trimmed = draft?.trim() ?? "";
  if (!trimmed) {
    suggestions = IDLE;
    activeIndex = -1;
    return;
  }
  return searchSoon(trimmed, city.id, (hits) => {
    suggestions =
      hits === null
        ? { kind: "loading" }
        : hits === "failed"
          ? { kind: "failed" }
          : { kind: "answered", results: hits };
    activeIndex = -1;
    open = true;
  });
});

// Every commit path snaps the draft back to null so the box shows the freshly committed label.
const commit = (): void => {
  draft = null;
  suggestions = IDLE;
  activeIndex = -1;
  open = false;
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

const handleKeyDown = (event: KeyboardEvent): void => {
  if (event.key === "Escape") {
    open = false;
  } else if (open) {
    const moved = resultListKeyDown(event, results, activeIndex, select);
    if (moved !== null) {
      activeIndex = moved;
    }
  }
};

const handleInput = (event: Event & { currentTarget: HTMLInputElement }) => {
  draft = event.currentTarget.value;
};

const handleBlur = (): void => {
  window.setTimeout(() => {
    open = false;
  }, BLUR_CLOSE_MS);
};

const leadingAction = $derived(
  showCurrentRow && currentLocationLabel
    ? {
        icon: FiNavigation,
        label: currentLocationLabel,
        onPick: useCurrentLocation,
        tone: "brand" as const,
      }
    : null,
);
</script>

<div class="relative">
  <span
    class="pointer-events-none absolute inset-y-0 left-3 grid place-items-center text-slate-400"
  >
    <Icon icon={leadingIcon} class="h-4 w-4" aria-hidden="true" />
  </span>
  <input
    type="text"
    {value}
    oninput={handleInput}
    onfocus={() => (open = true)}
    onblur={handleBlur}
    onkeydown={handleKeyDown}
    {placeholder}
    aria-label={placeholder}
    autocomplete="off"
    role="combobox"
    aria-expanded={dropdownOpen}
    aria-controls={listId}
    aria-autocomplete="list"
    aria-activedescendant={activeIndex >= 0
      ? `${listId}-${activeIndex}`
      : undefined}
    class="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-16 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-brand-500 dark:focus:bg-slate-900 dark:focus:ring-brand-500/20"
  >
  <div class="absolute inset-y-0 right-1.5 flex items-center gap-0.5">
    {#if canClear}
      <button
        type="button"
        onclick={clear}
        aria-label={clearLabel}
        class="grid h-7 w-7 place-items-center rounded-full text-slate-400 transition hover:text-slate-600 dark:hover:text-slate-200"
      >
        <Icon icon={FiX} class="h-4 w-4" />
      </button>
    {/if}
    <button
      type="button"
      onclick={armPick}
      aria-label={pickLabel}
      aria-pressed={armed}
      class={`grid h-7 w-7 place-items-center rounded-full transition ${armed ? ARMED : UNARMED}`}
    >
      <Icon icon={FiCrosshair} class="h-4 w-4" />
    </button>
  </div>
  {#if dropdownOpen}
    <!-- Opens upward out of the route panel; the cap is measured because the field moves. -->
    <ResultList
      {listId}
      {results}
      {activeIndex}
      onHover={(index) => (activeIndex = index)}
      onPick={select}
      {notice}
      {leadingAction}
      style={`max-height: ${roomAbove}px;`}
      class="absolute bottom-full left-0 z-10 mb-1 w-full rounded-xl bg-white p-1 shadow-xl ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10"
    />
  {/if}
</div>

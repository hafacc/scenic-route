<script lang="ts">
import type { City } from "../src/cities";
import type { GeocodeResult } from "../src/geocode";
import { FiSearch } from "../src/icons/glyphs";
import type { LatLng } from "../src/url-state";
import Icon from "./icon.svelte";
import { PANEL_CARD, PANEL_WRAPPER } from "./panel-shell";
import SearchPanel from "./search-panel.svelte";

const ICON_ON = "h-4 w-4 text-brand-600 dark:text-brand-400";
const ICON_OFF = "h-4 w-4 text-slate-500 dark:text-slate-400";
const CHROME =
  "bg-white/85 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10";
const CHROME_OPEN =
  "bg-brand-50/90 shadow-lg ring-1 ring-brand-500/30 backdrop-blur-md dark:bg-brand-500/20 dark:ring-brand-400/30";

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

const {
  city,
  open,
  pinned,
  center,
  onOpenChange,
  onSelect,
  onDirections,
  onClear,
}: SearchControlProps = $props();

// Kept above the panel to survive a close; `label` fills the box without triggering a search.
let label = $state.raw<string | null>(null);

const chrome = $derived(
  open ? CHROME_OPEN : `hover:bg-white dark:hover:bg-slate-800 ${CHROME}`,
);
</script>

<!-- left-[3.75rem]: the 12px inset, the follow toggle's 40px, and an 8px gap. -->
<button
  type="button"
  onclick={() => onOpenChange(!open)}
  aria-expanded={open}
  aria-label="Search for a place"
  title="Search for a place"
  class={`absolute top-3 left-[3.75rem] z-[1000] grid h-10 w-10 place-items-center rounded-full transition ${chrome}`}
>
  <Icon
    icon={FiSearch}
    class={open || pinned ? ICON_ON : ICON_OFF}
    aria-hidden="true"
  />
</button>
{#if open}
  <div class={PANEL_WRAPPER}>
    <div class={`${PANEL_CARD} p-4`}>
      <SearchPanel
        {city}
        {pinned}
        {center}
        {label}
        onLabelChange={(next) => (label = next)}
        {onOpenChange}
        {onSelect}
        {onDirections}
        {onClear}
      />
    </div>
  </div>
{/if}

<script lang="ts">
import type { City } from "../src/cities";
import type { GeocodeResult } from "../src/geocode";
import { FiX, MdDirectionsWalk } from "../src/icons/glyphs";
import type { LatLng } from "../src/url-state";
import Icon from "./icon.svelte";
import PlaceSearch from "./place-search.svelte";

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

const {
  city,
  pinned,
  center,
  label,
  onLabelChange,
  onOpenChange,
  onSelect,
  onDirections,
  onClear,
}: SearchPanelProps = $props();

function closeOnEscape(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    onOpenChange(false);
  }
}

const select = (result: GeocodeResult): void => {
  onLabelChange(result.displayName);
  onSelect(result);
};

const clear = (): void => {
  onLabelChange(null);
  onClear();
};
</script>

<svelte:document onkeydown={closeOnEscape} />

<div class="flex items-center justify-between gap-2">
  <p
    class="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400"
  >
    Find a place
  </p>
  <div class="flex shrink-0 items-center gap-1">
    <!-- Disabled rather than hidden, so the close button doesn't move under a finger. -->
    <button
      type="button"
      onclick={onDirections}
      disabled={!pinned}
      aria-label="Walking directions to this place"
      title="Walking directions to this place"
      class="-m-1 grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-slate-700"
    >
      <Icon icon={MdDirectionsWalk} class="h-4 w-4" aria-hidden="true" />
    </button>
    <button
      type="button"
      onclick={() => onOpenChange(false)}
      aria-label="Close search"
      class="-m-1 grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
    >
      <Icon icon={FiX} />
    </button>
  </div>
</div>
<PlaceSearch
  {city}
  {center}
  {label}
  placeholder="Search for a place"
  focusOnOpen
  class="mt-3"
  onSelect={select}
  onClear={clear}
/>

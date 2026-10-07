<script lang="ts">
import { CITIES, type City } from "../src/cities";
import {
  FiCheck,
  FiMap,
  FiSearch,
  FiX,
  GiSuspensionBridge,
  GiTorch,
} from "../src/icons/glyphs";
import type { IconData } from "../src/icons/types";
import Icon from "./icon.svelte";
import Sheet from "./sheet.svelte";
import { SHEET_SCROLL } from "./sheet-shell";

// Whole strings, since a line break inside markup text would reach the DOM.
const ONE_REGION =
  "One region is active at a time — switching swaps the map, the overlays and the routing graph.";

const ROW =
  "flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-slate-100 dark:hover:bg-slate-700";
const ROW_CURRENT = "bg-slate-100 dark:bg-slate-700/70";

// The torch stands in for the Statue of Liberty, which the icon sets have no glyph for.
const CITY_ICONS: Record<string, IconData> = {
  nyc: GiTorch,
  sf: GiSuspensionBridge,
};

interface CityDialogProps {
  city: City;
  onSelect: (city: City) => void;
  onClose: () => void;
}

const OVERLAY_LABELS: Record<string, string> = {
  canopy: "Tree cover",
  genus: "Species",
  elevation: "Elevation",
  landmarks: "Landmarks",
  art: "Public art",
  ferries: "Ferries",
  highways: "Highways",
  commercial: "Shops",
  shade: "Shade",
  scaffolding: "Scaffolding",
};

// A plain substring, not fuzzy: on a list this short, fuzzy matches mostly surprise.
function matches(city: City, query: string): boolean {
  return city.name.toLowerCase().includes(query.trim().toLowerCase());
}

const { city, onSelect, onClose }: CityDialogProps = $props();

let query = $state.raw("");

const shown = $derived(CITIES.filter((entry) => matches(entry, query)));

const searchable = CITIES.length > 8;

function choose(entry: City): void {
  onSelect(entry);
  onClose();
}
</script>

<Sheet
  {onClose}
  closeLabel="Close region picker"
  labeledBy="city-title"
  width="md:max-w-md"
>
  <div class="flex shrink-0 items-start justify-between gap-3">
    <div>
      <h2
        id="city-title"
        class="text-lg font-semibold text-slate-800 dark:text-slate-100"
      >
        Choose a region
      </h2>
      <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {ONE_REGION}
      </p>
    </div>
    <button
      type="button"
      onclick={onClose}
      aria-label="Close"
      class="-m-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
    >
      <Icon icon={FiX} />
    </button>
  </div>

  {#if searchable}
    <label
      class="mt-4 flex shrink-0 items-center gap-2 rounded-xl bg-slate-100 px-3 py-2 text-sm dark:bg-slate-700/60"
    >
      <Icon
        icon={FiSearch}
        class="shrink-0 text-slate-400"
        aria-hidden="true"
      />
      <!-- 16px on a phone: iOS Safari zooms the page on a focused control with smaller text. -->
      <input
        type="search"
        bind:value={query}
        placeholder="Search regions"
        aria-label="Search regions"
        class="w-full bg-transparent text-base text-slate-700 outline-none placeholder:text-slate-400 dark:text-slate-100 md:text-sm"
      >
    </label>
  {/if}

  <ul class={`mt-4 flex flex-col gap-1 ${SHEET_SCROLL}`}>
    {#each shown as entry (entry.id)}
      <li>
        <button
          type="button"
          aria-current={entry.id === city.id ? "true" : undefined}
          onclick={() => choose(entry)}
          class={`${ROW} ${entry.id === city.id ? ROW_CURRENT : ""}`}
        >
          <Icon
            icon={CITY_ICONS[entry.id] ?? FiMap}
            class="h-5 w-5 shrink-0 text-brand-600 dark:text-brand-400"
          />
          <span class="flex min-w-0 flex-col">
            <span class="font-medium text-slate-800 dark:text-slate-100">
              {entry.name}
            </span>
            <span
              class="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400"
            >
              {entry.overlays.map((id) => OVERLAY_LABELS[id] ?? id).join(" · ")}
            </span>
          </span>
          {#if entry.id === city.id}
            <Icon
              icon={FiCheck}
              class="ml-auto shrink-0 text-brand-600 dark:text-brand-400"
            />
          {/if}
        </button>
      </li>
    {/each}
    {#if shown.length === 0}
      <li
        class="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400"
      >
        No region matches “{query.trim()}”.
      </li>
    {/if}
  </ul>
</Sheet>

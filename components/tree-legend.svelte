<script lang="ts">
import { genusCss, OTHER_GENUS_ID } from "../src/tree-cover/genus";
import {
  getEnabledGenera,
  setAllGenera,
  subscribeGenusFilter,
  toggleGenus,
} from "../src/tree-cover/genus-filter";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";
import { fromStore } from "./external-store.svelte";

// Swatches use the categorical tile palette. Rows toggle a genus for both tiles and dots.
const active = useCity();
const genus = $derived(
  manifest.cities.find((city) => city.id === active().id)?.field.genus,
);
const enabled = fromStore(subscribeGenusFilter, getEnabledGenera);

const rows = $derived.by(() => {
  if (!genus) {
    return []; // older manifest without the genus source
  }
  const listed = genus.table.map((entry, id) => ({ id, common: entry.common }));
  listed.push({ id: OTHER_GENUS_ID, common: "Other / unmapped" });
  return listed;
});

const anyOn = $derived(enabled.current.size > 0);
</script>

{#if genus}
  <div
    class="max-w-full rounded-2xl bg-white/85 px-3 py-2.5 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10"
  >
    <div class="mb-1.5 flex min-w-0 items-center justify-between gap-3">
      <p
        class="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
      >
        Genus canopy
      </p>
      <button
        type="button"
        onclick={() => setAllGenera(!anyOn)}
        class="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-400 transition hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
      >
        {anyOn ? "Clear" : "All"}
      </button>
    </div>
    <ul class="grid grid-cols-2 gap-x-3 gap-y-0.5">
      {#each rows as row (row.id)}
        <li>
          <button
            type="button"
            onclick={() => toggleGenus(row.id)}
            aria-pressed={enabled.current.has(row.id)}
            class={`flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-xs transition hover:bg-black/5 dark:hover:bg-white/10 ${
              enabled.current.has(row.id) ? "" : "opacity-40"
            }`}
          >
            <span
              class="h-3 w-3 shrink-0 rounded-sm ring-1 ring-black/10 dark:ring-white/10"
              style="background-color: {genusCss(row.id)}"
              aria-hidden="true"
            ></span>
            <span class="truncate text-slate-700 dark:text-slate-200">
              {row.common}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  </div>
{/if}

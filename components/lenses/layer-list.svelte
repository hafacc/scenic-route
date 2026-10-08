<script lang="ts">
import type { City } from "../../src/cities";
import {
  OVERLAYS,
  type OverlayId,
  overlayLabel,
  overlaySwatch,
} from "../../src/overlays/registry";
import { useMapTheme } from "../use-map-theme.svelte";

interface Props {
  city: City;
  overlays: readonly OverlayId[];
  hidden: ReadonlySet<OverlayId>;
  onToggle: (id: OverlayId) => void;
}

// Lenses has no layers menu, so this key is where a layer is hidden; hiding never changes routing.
const { city, overlays, hidden, onToggle }: Props = $props();

const theme = useMapTheme();
const rows = $derived(
  overlays.flatMap((id) => {
    const overlay = OVERLAYS.find((entry) => entry.id === id);
    const swatch = overlay ? overlaySwatch(overlay, theme.current) : null;
    return overlay && swatch
      ? [{ id, label: overlayLabel(overlay, city), swatch }]
      : [];
  }),
);
</script>

{#if rows.length > 0}
  <div
    class="rounded-2xl bg-white/85 p-3 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10"
  >
    <!-- Two columns while they fit in two lines; one layer has no second column to fill. -->
    <ul
      class={`grid gap-x-3 ${rows.length > 1 && rows.length <= 4 ? "grid-cols-2" : "grid-cols-1"}`}
    >
      {#each rows as row (row.id)}
        <li>
          <button
            type="button"
            onclick={() => onToggle(row.id)}
            aria-pressed={!hidden.has(row.id)}
            class={`flex h-6 w-full items-center gap-2 rounded-md px-1 text-left text-xs transition hover:bg-black/5 dark:hover:bg-white/10 ${!hidden.has(row.id) ? "" : "opacity-40"}`}
          >
            <span
              class="h-3 w-3 shrink-0 rounded-sm ring-1 ring-black/10 dark:ring-white/10"
              style="background-color:{row.swatch}"
              aria-hidden="true"
            ></span>
            <span class="truncate text-slate-700 dark:text-slate-200"
              >{row.label}</span
            >
          </button>
        </li>
      {/each}
    </ul>
  </div>
{/if}

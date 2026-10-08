<script lang="ts">
import type { City } from "../src/cities";
import {
  OVERLAYS,
  type OverlayId,
  overlayLabel,
  overlayOpacity,
  overlaySwatch,
} from "../src/overlays/registry";
import {
  getResolvedDay,
  parseDay,
  subscribeRouteTime,
} from "../src/route-time/store";
import { fromStore } from "./external-store.svelte";
import { useMapTheme } from "./use-map-theme.svelte";

interface Props {
  active: ReadonlySet<OverlayId>;
  city: City;
}

// Colors come from each layer's own paint so the key can't drift. Toggling lives in the menu.
const { active, city }: Props = $props();
const theme = useMapTheme();
// The day, not the date: the store also ticks each minute. Null until the page has hydrated.
const day = fromStore<string | null>(subscribeRouteTime, getResolvedDay, null);
// A swatch fades with its layer, so the key shows the strength the map is drawing at.
const rows = $derived(
  OVERLAYS.filter((overlay) => active.has(overlay.id)).flatMap((overlay) => {
    const swatch = overlaySwatch(overlay, theme.current);
    return swatch
      ? [
          {
            id: overlay.id,
            label: overlayLabel(overlay, city),
            swatch,
            opacity:
              day.current === null
                ? 1
                : overlayOpacity(overlay, city, parseDay(day.current)),
          },
        ]
      : [];
  }),
);
</script>

{#if rows.length > 0}
  <div
    class="rounded-2xl bg-white/85 px-3 py-2.5 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10"
  >
    <p
      class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
    >
      Layers
    </p>
    <ul class="grid grid-cols-2 gap-x-3 gap-y-0.5">
      {#each rows as row (row.id)}
        <li class="flex items-center gap-2 px-1 py-0.5 text-xs">
          <span
            class="h-3 w-3 shrink-0 rounded-sm ring-1 ring-black/10 dark:ring-white/10"
            style="background-color: {row.swatch}; opacity: {row.opacity}"
            aria-hidden="true"
          ></span>
          <span class="truncate text-slate-700 dark:text-slate-200">
            {row.label}
          </span>
        </li>
      {/each}
    </ul>
  </div>
{/if}

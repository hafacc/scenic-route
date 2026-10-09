<script lang="ts">
import type { City } from "../../src/cities";
import {
  OVERLAYS,
  type OverlayId,
  overlayLabel,
  overlayOpacity,
  overlaySwatch,
} from "../../src/overlays/registry";
import {
  getResolvedDay,
  parseDay,
  subscribeRouteTime,
} from "../../src/route-time/store";
import { fromStore } from "../external-store.svelte";
import { useMapTheme } from "../use-map-theme.svelte";

interface Props {
  city: City;
  overlays: readonly OverlayId[];
  extras: readonly OverlayId[]; // listed after the lens's own, on a line to themselves
  hidden: ReadonlySet<OverlayId>;
  onToggle: (id: OverlayId) => void;
  onToggleExtra: (id: OverlayId) => void;
}

interface Row {
  id: OverlayId;
  label: string;
  swatch: string;
  opacity: number;
}

// Lenses has no layers menu, so this key is where a layer is hidden or shown; neither changes routing.
const { city, overlays, extras, hidden, onToggle, onToggleExtra }: Props =
  $props();

const theme = useMapTheme();
// The day, not the date: the store also ticks each minute. Null until the page has hydrated.
const day = fromStore<string | null>(subscribeRouteTime, getResolvedDay, null);
// A swatch fades with its layer, so the key shows the strength the map is drawing at.
function rowsOf(ids: readonly OverlayId[]): Row[] {
  return ids.flatMap((id) => {
    const overlay = OVERLAYS.find((entry) => entry.id === id);
    const swatch = overlay ? overlaySwatch(overlay, theme.current) : null;
    return overlay && swatch
      ? [
          {
            id,
            label: overlayLabel(overlay, city),
            swatch,
            opacity:
              day.current === null
                ? 1
                : overlayOpacity(overlay, city, parseDay(day.current)),
          },
        ]
      : [];
  });
}
const rows = $derived(rowsOf(overlays));
const extraRows = $derived(rowsOf(extras));
</script>

{#snippet list(
  entries: readonly Row[],
  toggle: (id: OverlayId) => void,
)}
  <!-- Two columns while they fit in two lines; one layer has no second column to fill. -->
  <ul
    class={`grid gap-x-3 ${entries.length > 1 && entries.length <= 4 ? "grid-cols-2" : "grid-cols-1"}`}
  >
    {#each entries as row (row.id)}
      <li>
        <button
          type="button"
          onclick={() => toggle(row.id)}
          aria-pressed={!hidden.has(row.id)}
          class={`flex h-6 w-full items-center gap-2 rounded-md px-1 text-left text-xs transition hover:bg-black/5 dark:hover:bg-white/10 ${!hidden.has(row.id) ? "" : "opacity-40"}`}
        >
          <span
            class="h-3 w-3 shrink-0 rounded-sm ring-1 ring-black/10 dark:ring-white/10"
            style="background-color:{row.swatch};opacity:{row.opacity}"
            aria-hidden="true"
          ></span>
          <span class="truncate text-slate-700 dark:text-slate-200"
            >{row.label}</span
          >
        </button>
      </li>
    {/each}
  </ul>
{/snippet}

{#if rows.length + extraRows.length > 0}
  <div
    class="rounded-2xl bg-white/85 p-3 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10"
  >
    {@render list(rows, onToggle)}
    {@render list(extraRows, onToggleExtra)}
  </div>
{/if}

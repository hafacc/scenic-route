<script module lang="ts">
import { PALETTES, type ThemeName } from "../src/theme/palette";
import { useCity } from "./city-context";
import { useMapTheme } from "./use-map-theme.svelte";

// The tint stretches over each city's own height range (range.json), so a legend must show it.

interface Range {
  lowMeters: number;
  highMeters: number;
}

function bar(theme: ThemeName): string {
  const ramp = PALETTES[theme].elevation.stops;
  return ramp
    .map(
      ({ red, green, blue }, index) =>
        `rgb(${red} ${green} ${blue}) ${(100 * index) / (ramp.length - 1)}%`,
    )
    .join(", ");
}

const BARS: Record<ThemeName, string> = {
  light: bar("light"),
  dark: bar("dark"),
};

const ranges = new Map<string, Promise<Range | null>>();

function loadRange(cityId: string): Promise<Range | null> {
  const cached = ranges.get(cityId);
  if (cached) {
    return cached;
  }
  const promise: Promise<Range | null> = fetch(
    `tiles/elevation/${cityId}/range.json`,
  )
    .then((response) =>
      response.ok ? (response.json() as Promise<Range>) : null,
    )
    .catch(() => null);
  ranges.set(cityId, promise);
  return promise;
}

const feet = (meters: number): number => Math.round(meters / 0.3048);
</script>

<script lang="ts">
const active = useCity();
const theme = useMapTheme();
const cityId = $derived(active().id);
let loaded = $state.raw<{ city: string; range: Range | null } | null>(null);
// Held by city, so a switch shows nothing rather than the last city's range.
const range = $derived(loaded?.city === cityId ? loaded.range : null);

$effect(() => {
  const requested = cityId;
  let live = true;
  loadRange(requested).then((fetched) => {
    if (live) {
      loaded = { city: requested, range: fetched };
    }
  });
  return () => {
    live = false;
  };
});
</script>

{#if range}
  <div
    class="rounded-2xl bg-white/90 px-3 py-2 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/90 dark:ring-white/10"
  >
    <div
      class="mb-1 text-[11px] font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-300"
    >
      Elevation
    </div>
    <div
      class="h-2 w-40 rounded-full"
      style="background: linear-gradient(to right, {BARS[theme.current]})"
    ></div>
    <div
      class="mt-1 flex justify-between font-medium text-[11px] text-slate-600 tabular-nums dark:text-slate-300"
    >
      <span>{feet(range.lowMeters)} ft</span>
      <span>{feet(range.highMeters)} ft</span>
    </div>
  </div>
{/if}

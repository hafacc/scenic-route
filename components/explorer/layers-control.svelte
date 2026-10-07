<script lang="ts">
import type { City } from "../../src/cities";
import {
  FiCheck,
  FiCloudOff,
  FiLayers,
  FiSliders,
} from "../../src/icons/glyphs";
import type { IconSpec } from "../../src/icons/types";
import {
  OVERLAYS,
  type OverlayId,
  overlayLabel,
} from "../../src/overlays/registry";
import { orderedOverlays } from "../../src/settings/store";
import { dismiss } from "../dismiss";
import Icon from "../icon.svelte";
import { useMapTheme } from "../use-map-theme.svelte";
import { useSettings } from "../use-settings.svelte";
import { useUnreachableLayers } from "../use-unreachable-layers.svelte";

interface LayersControlProps {
  city: City;
  active: ReadonlySet<OverlayId>;
  onToggle: (id: OverlayId) => void;
  onSettings: (section?: string) => void;
}

const ROW_BASE =
  "flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-medium";
const ROW_ACTIVE = `${ROW_BASE} text-brand-600 dark:text-brand-400`;
const ROW_IDLE = `${ROW_BASE} text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700/60`;
// A short name for a whole string: a line break here or in the markup would reach the DOM.
const SETTINGS = "Layer settings…";

const { city, active, onToggle, onSettings }: LayersControlProps = $props();

let menuOpen = $state.raw<boolean>(false);
const unreachable = useUnreachableLayers();
const settings = useSettings();
const mapTheme = useMapTheme();

const offered = $derived(
  orderedOverlays(city.overlays, settings.current)
    .map((id) => OVERLAYS.find((overlay) => overlay.id === id))
    .filter((overlay) => overlay !== undefined),
);
const activeEntries = $derived(
  offered.filter((overlay) => active.has(overlay.id)),
);
const soleEntry = $derived(
  activeEntries.length === 1 ? activeEntries[0] : null,
);
const buttonLabel = $derived(
  activeEntries.length > 0
    ? `Map layers (${activeEntries.map((entry) => overlayLabel(entry, city)).join(", ")})`
    : "Map layers",
);
// A layer whose data didn't arrive looks empty, so its glyph replaces the tick.
const rows = $derived(
  offered.map((overlay) => {
    const on = active.has(overlay.id);
    return { overlay, on, lost: on && unreachable.current.has(overlay.id) };
  }),
);

// The tint is per map theme, since a Tailwind tint shows only one half of the light/dark pair.
function tint(icon: IconSpec): string | undefined {
  return icon.color ? `color:${icon.color[mapTheme.current]}` : undefined;
}

function closeMenu(): void {
  menuOpen = false;
}

function openSettings(): void {
  menuOpen = false;
  onSettings("layers");
}
</script>

<!-- A snippet, so the mark touches the label. -->
{#snippet mark(
  lost: boolean,
  on: boolean,
)}
  {#if lost}
    <Icon
      icon={FiCloudOff}
      class="ml-auto h-4 w-4 text-slate-400 dark:text-slate-500"
      aria-label="data could not be loaded"
    />
  {:else if on}
    <Icon icon={FiCheck} class="ml-auto h-4 w-4" aria-hidden="true" />
  {/if}
{/snippet}

<div {@attach menuOpen && dismiss(closeMenu)} class="relative">
  <button
    type="button"
    onclick={() => (menuOpen = !menuOpen)}
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    aria-label={buttonLabel}
    title="Map layers"
    class={`grid h-10 w-10 place-items-center rounded-full bg-white/85 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white dark:bg-slate-800/80 dark:ring-white/10 dark:hover:bg-slate-800 ${activeEntries.length > 0 ? "text-brand-600 dark:text-brand-400" : "text-slate-500 dark:text-slate-400"}`}
  >
    {#if soleEntry}
      <Icon
        icon={soleEntry.icon.glyph}
        class={soleEntry.icon.class}
        style={tint(soleEntry.icon)}
        aria-hidden="true"
      />
    {:else}
      <Icon icon={FiLayers} class="h-4 w-4" aria-hidden="true" />
    {/if}
  </button>
  {#if menuOpen}
    <!-- Capped with scrolling rows, so the footer (where layers are hidden) stays put. -->
    <div
      role="menu"
      class="toolbar-menu-shell absolute right-0 mt-2 flex w-44 origin-top-right flex-col overflow-hidden rounded-2xl bg-white/95 shadow-2xl ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/95 dark:ring-white/10"
    >
      <div class="toolbar-menu-scroll py-1">
        {#each rows as { overlay, on, lost } (overlay.id)}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={on}
            onclick={() => onToggle(overlay.id)}
            class={on ? ROW_ACTIVE : ROW_IDLE}
            title={lost ? "This layer's data could not be loaded" : undefined}
          >
            <Icon
              icon={overlay.icon.glyph}
              class={overlay.icon.class}
              style={tint(overlay.icon)}
              aria-hidden="true"
            />{overlayLabel(overlay, city)}{@render mark(lost, on)}
          </button>
        {/each}
      </div>
      <button
        type="button"
        role="menuitem"
        onclick={openSettings}
        class={`${ROW_IDLE} shrink-0 border-t border-slate-200/60 text-slate-500 dark:border-slate-700/60 dark:text-slate-400`}
      >
        <Icon icon={FiSliders} class="h-4 w-4" aria-hidden="true" />{SETTINGS}
      </button>
    </div>
  {/if}
</div>

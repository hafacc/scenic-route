<script lang="ts">
import { MODE_ICONS } from "../../src/modes/icons";
import type { Mode, ModeId } from "../../src/modes/modes";
import Icon from "../icon.svelte";

interface Props {
  modes: readonly Mode[];
  active: ModeId;
  class?: string;
  onSelect: (id: ModeId) => void;
}

// On a phone only the active chip shows its name; four modes plus the switches don't fit 375 px.
const { modes, active, class: className, onSelect }: Props = $props();

let row: HTMLDivElement | null = null;

// Keeps the active chip in view; not `scrollIntoView`, so only this row moves.
$effect(() => {
  // Found by its place, since a `bind:this` cannot follow the active chip.
  const chip = row?.children[modes.findIndex((mode) => mode.id === active)];
  if (row && chip instanceof HTMLElement) {
    row.scrollLeft = Math.max(
      0,
      chip.offsetLeft - (row.clientWidth - chip.clientWidth) / 2,
    );
  }
});

// Arrows choose as they move, per the ARIA radio group pattern.
const handleKey = (event: KeyboardEvent): void => {
  const step =
    event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (step === 0) {
    return;
  }
  event.preventDefault();
  const at = modes.findIndex((mode) => mode.id === active);
  const next = modes[(at + step + modes.length) % modes.length];
  if (next) {
    onSelect(next.id);
  }
};
</script>

<!-- svelte-ignore a11y_interactive_supports_focus (focus roves over the radios inside; the group itself is never a tab stop) -->
<div
  bind:this={row}
  role="radiogroup"
  aria-label="Mode"
  onkeydown={handleKey}
  class={`chip-row gap-1 ${className ?? ""}`}
>
  {#each modes as mode (mode.id)}
    <!-- biome-ignore-start lint/a11y/useSemanticElements: a radio input cannot be a filled chip -->
    <button
      type="button"
      role="radio"
      aria-checked={mode.id === active}
      tabindex={mode.id === active ? 0 : -1}
      onclick={() => onSelect(mode.id)}
      aria-label={mode.name}
      title={mode.name}
      class={`flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full text-xs font-semibold transition ${mode.id === active ? "px-2.5 text-white shadow-sm" : "w-8 bg-slate-100 text-slate-600 hover:bg-slate-200 md:w-auto md:px-2.5 dark:bg-slate-700/60 dark:text-slate-300 dark:hover:bg-slate-700"}`}
      style={mode.id === active ? `background-color:${mode.color}` : undefined}
    >
      <Icon
        icon={MODE_ICONS[mode.id].glyph}
        class="h-4 w-4"
        aria-hidden="true"
      />
      <span class={mode.id === active ? "" : "hidden md:inline"}
        >{mode.name}</span
      >
    </button>
  <!-- biome-ignore-end lint/a11y/useSemanticElements: a radio input cannot be a filled chip -->
  {/each}
</div>

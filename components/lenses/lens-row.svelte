<script lang="ts">
import { LENS_ICONS } from "../../src/lenses/icons";
import type { Lens, LensId } from "../../src/lenses/lenses";
import Icon from "../icon.svelte";

interface Props {
  lenses: readonly Lens[];
  active: LensId;
  class?: string;
  onSelect: (id: LensId) => void;
}

// On a phone only the active chip shows its name; four lenses plus the switches don't fit 375 px.
const { lenses, active, class: className, onSelect }: Props = $props();

let row: HTMLDivElement | null = null;

// Keeps the active chip in view; not `scrollIntoView`, so only this row moves.
$effect(() => {
  // Found by its place, since a `bind:this` cannot follow the active chip.
  const chip = row?.children[lenses.findIndex((lens) => lens.id === active)];
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
  const at = lenses.findIndex((lens) => lens.id === active);
  const next = lenses[(at + step + lenses.length) % lenses.length];
  if (next) {
    onSelect(next.id);
  }
};
</script>

<!-- svelte-ignore a11y_interactive_supports_focus (focus roves over the radios inside; the group itself is never a tab stop) -->
<div
  bind:this={row}
  role="radiogroup"
  aria-label="Lens"
  onkeydown={handleKey}
  class={`chip-row gap-1 ${className ?? ""}`}
>
  {#each lenses as lens (lens.id)}
    <!-- biome-ignore-start lint/a11y/useSemanticElements: a radio input cannot be a filled chip -->
    <button
      type="button"
      role="radio"
      aria-checked={lens.id === active}
      tabindex={lens.id === active ? 0 : -1}
      onclick={() => onSelect(lens.id)}
      aria-label={lens.name}
      title={lens.name}
      class={`flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full text-xs font-semibold transition ${lens.id === active ? "px-2.5 text-white shadow-sm" : "w-8 bg-slate-100 text-slate-600 hover:bg-slate-200 md:w-auto md:px-2.5 dark:bg-slate-700/60 dark:text-slate-300 dark:hover:bg-slate-700"}`}
      style={lens.id === active ? `background-color:${lens.color}` : undefined}
    >
      <Icon
        icon={LENS_ICONS[lens.id].glyph}
        class="h-4 w-4"
        aria-hidden="true"
      />
      <span class={lens.id === active ? "" : "hidden md:inline"}
        >{lens.name}</span
      >
    </button>
    <!-- biome-ignore-end lint/a11y/useSemanticElements: a radio input cannot be a filled chip -->
  {/each}
</div>

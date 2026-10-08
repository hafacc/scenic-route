<script lang="ts">
import { cardLine } from "../../src/lenses/cards";
import CardChips from "./card-chips.svelte";
import CardLine from "./card-line.svelte";
import CardNumber from "./card-number.svelte";
import type { CardView } from "./route-cards";

interface Props {
  cards: readonly CardView[];
  selected: number | null;
  // These cards are the last plan's and a new one is on its way, so they are held but not offered.
  dimmed: boolean;
  onSelect: (index: number) => void;
  onHover: (index: number | null) => void;
}

const { cards, selected, dimmed, onSelect, onHover }: Props = $props();

// A touch never leaves, but that tap chooses the card anyway, so the highlight is right.
function handleEnter(event: PointerEvent, index: number): void {
  if (event.pointerType !== "touch") {
    onHover(index);
  }
}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (leaving the list only clears the hover highlight) -->
<div
  class={`min-h-0 shrink space-y-0.5 overflow-y-auto overscroll-contain ${dimmed ? "pointer-events-none opacity-50" : ""}`}
  onpointerleave={() => onHover(null)}
>
  {#each cards as card, index}
    <!-- A screen reader gets the same sentence in words. -->
    <button
      type="button"
      onclick={() => onSelect(index)}
      onpointerenter={(event) => handleEnter(event, index)}
      aria-pressed={index === selected}
      aria-label={`${index + 1} ${cardLine(card.summary)}`}
      class={`flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition hover:bg-slate-100 dark:hover:bg-slate-700/60 ${index === selected ? "bg-slate-100 dark:bg-slate-700/60" : ""}`}
    >
      <CardNumber {index} color={card.color} />
      <span class="min-w-0 flex-1">
        <CardLine summary={card.summary} />
        {#if card.chips.length > 0}
          <CardChips chips={card.chips} />
        {/if}
      </span>
    </button>
  {/each}
</div>

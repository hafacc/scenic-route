<script lang="ts">
import { MdDragIndicator } from "../src/icons/glyphs";
import Icon from "./icon.svelte";
import type { RowDrag } from "./use-row-drag.svelte";

interface Props {
  label: string;
  index: number;
  count: number;
  drag: RowDrag;
  move: (from: number, to: number) => void;
}

const { label, index, count, drag, move }: Props = $props();

function handleKeyDown(event: KeyboardEvent): void {
  const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
  const to = index + step;
  if (step !== 0 && to >= 0 && to < count) {
    event.preventDefault();
    move(index, to);
  }
}
</script>

<!-- iOS Safari needs `-webkit-touch-callout` cleared, or a long press opens the callout. -->
<button
  type="button"
  onpointerdown={(event) => drag.start(event, index)}
  onkeydown={handleKeyDown}
  aria-label={`Reorder ${label}, ${index + 1} of ${count}`}
  class="grid h-8 w-8 shrink-0 cursor-grab touch-none select-none place-items-center rounded-full text-slate-300 [-webkit-touch-callout:none] hover:bg-slate-100 active:cursor-grabbing dark:text-slate-500 dark:hover:bg-slate-700"
>
  <Icon icon={MdDragIndicator} />
</button>

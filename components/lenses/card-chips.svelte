<script lang="ts">
import type { Snippet } from "svelte";
import { MdWaterDrop } from "../../src/icons/glyphs";
import { chipReading } from "../../src/lenses/cards";
import { FACTORS } from "../../src/routing/factors";
import Icon from "../icon.svelte";
import type { CardView } from "./route-cards";

interface Props {
  chips: CardView["chips"];
  lead?: Snippet | null;
}

const { chips, lead }: Props = $props();

// The number counts the rain you are out in, so a bigger one has to read as wetter.
const EXPOSURE = { icon: MdWaterDrop, label: "Rain exposure" };

const shown = $derived(
  chips.flatMap((chip) => {
    const factor = FACTORS.find((entry) => entry.key === chip.key);
    if (!factor) {
      return [];
    }
    const { percent, exposure } = chipReading(chip.key, chip.percent);
    return [
      {
        key: chip.key,
        title: exposure ? EXPOSURE.label : factor.label,
        tint: factor.tint,
        best: chip.best,
        icon: exposure ? EXPOSURE.icon : factor.icon.glyph,
        percent,
      },
    ];
  }),
);
</script>

<span class="chip-row gap-x-2.5">
  {@render lead?.()}
  {#each shown as { key, title, tint, best, icon, percent } (key)}
    <span
      {title}
      class={`inline-flex items-center gap-1 text-xs tabular-nums ${tint} ${best ? "font-bold" : "font-medium"}`}
    >
      <Icon {icon} class="h-3.5 w-3.5" aria-hidden="true" />{percent}
    </span>
  {/each}
</span>

<script lang="ts">
import type { Snippet } from "svelte";
import { MdExplore } from "../../src/icons/glyphs";
import type { IconData } from "../../src/icons/types";
import type { ChipKey } from "../../src/lenses/cards";
import { FACTORS, GATES } from "../../src/routing/factors";
import FactorChip from "../factor-chip.svelte";
import type { CardView } from "./route-cards";

interface Props {
  chips: CardView["chips"];
  lead?: Snippet | null;
}

const { chips, lead }: Props = $props();

interface ChipFace {
  icon: IconData;
  tint: string;
  label: string;
}

const EXPLORER: Partial<Record<ChipKey, ChipFace>> = Object.fromEntries(
  FACTORS.map((factor) => [
    factor.key,
    { icon: factor.icon.glyph, tint: factor.tint, label: factor.label },
  ]),
);
const sheds = GATES.find((gate) => gate.key === "allowSheds");

// Explorer's own faces, relabelled where a card reads the share its own way.
const FACES: Partial<Record<ChipKey, ChipFace>> = {
  ...EXPLORER,
  // The number counts the rain you are out in, so a bigger one has to read as wetter.
  shelter: EXPLORER.shelter && { ...EXPLORER.shelter, label: "Rain exposure" },
  familiar: EXPLORER.familiar && {
    ...EXPLORER.familiar,
    label: "On streets you've walked",
  },
  unwalked: EXPLORER.familiar && {
    ...EXPLORER.familiar,
    icon: MdExplore,
    label: "On streets you haven't walked",
  },
  sheds: sheds && {
    icon: sheds.icon.glyph,
    tint: sheds.tint,
    label: "Under scaffolding",
  },
};

const shown = $derived(
  chips.flatMap((chip) => {
    const face = FACES[chip.key];
    return face ? [{ ...chip, ...face }] : [];
  }),
);
</script>

<span class="chip-row gap-x-2.5">
  {@render lead?.()}
  {#each shown as { key, label, tint, best, icon, percent } (key)}
    <FactorChip
      {icon}
      {tint}
      title={label}
      text={`${percent}`}
      weight={best ? "font-bold" : "font-medium"}
    />
  {/each}
</span>

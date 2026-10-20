<script lang="ts">
import {
  FiCompass,
  MdDirectionsBoat,
  MdDirectionsWalk,
  MdHorizontalRule,
  MdLandscape,
  MdOutlineDirectionsWalk,
  MdTerrain,
  MdWbShade,
  MdWbSunny,
  MdWbTwilight,
} from "../../src/icons/glyphs";
import type { IconData } from "../../src/icons/types";
import type { FactorAvailability } from "../../src/lenses/lenses";
import {
  FAMILIAR_VALUES,
  HILLS_VALUES,
  SUN_VALUES,
  type Toggles,
} from "../../src/lenses/lenses";
import Icon from "../icon.svelte";

const GRAY = "text-slate-400 dark:text-slate-500";

interface ToggleFace {
  icon: IconData;
  tint: string;
  label: string;
}

const SUN_FACES: Readonly<Record<Toggles["sun"], ToggleFace>> = {
  sun: {
    icon: MdWbSunny,
    tint: "text-amber-500 dark:text-amber-400",
    label: "Walk in the sun",
  },
  shade: {
    icon: MdWbShade,
    tint: "text-sky-600 dark:text-sky-400",
    label: "Walk in the shade",
  },
  neutral: { icon: MdWbTwilight, tint: GRAY, label: "Sun and shade ignored" },
};

const HILL_FACES: Readonly<Record<Toggles["hills"], ToggleFace>> = {
  any: {
    icon: MdTerrain,
    tint: "text-[#966c5c] dark:text-[#c29684]",
    label: "Hills are fine",
  },
  some: {
    icon: MdLandscape,
    tint: "text-[#966c5c] dark:text-[#c29684]",
    label: "Fewer hills",
  },
  none: { icon: MdHorizontalRule, tint: GRAY, label: "Avoid hills" },
};

const FERRY_FACES: Readonly<Record<"on" | "off", ToggleFace>> = {
  on: {
    icon: MdDirectionsBoat,
    tint: "text-blue-600 dark:text-blue-400",
    label: "Ferries allowed",
  },
  off: { icon: MdDirectionsBoat, tint: GRAY, label: "Ferries barred" },
};

const FAMILIAR_FACES: Readonly<Record<Toggles["familiar"], ToggleFace>> = {
  familiar: {
    icon: MdDirectionsWalk,
    tint: "text-indigo-600 dark:text-indigo-400",
    label: "Prefer streets you've walked",
  },
  new: {
    icon: FiCompass,
    tint: "text-indigo-600 dark:text-indigo-400",
    label: "Prefer streets you haven't walked",
  },
  neutral: {
    icon: MdOutlineDirectionsWalk,
    tint: GRAY,
    label: "Walked streets ignored",
  },
};

function next<Value extends string>(
  values: readonly Value[],
  current: Value,
): Value {
  return values[(values.indexOf(current) + 1) % values.length];
}

interface Props {
  toggles: Toggles;
  // Hidden, not grayed, when there is no data: grayed reads as a state the reader chose.
  available: FactorAvailability;
  onChange: (toggles: Toggles) => void;
}

const { toggles, available, onChange }: Props = $props();

const ferryFace = $derived(FERRY_FACES[toggles.ferries ? "on" : "off"]);

function cycleSun(): void {
  onChange({ ...toggles, sun: next(SUN_VALUES, toggles.sun) });
}

function cycleHills(): void {
  onChange({ ...toggles, hills: next(HILLS_VALUES, toggles.hills) });
}

function cycleFamiliar(): void {
  onChange({ ...toggles, familiar: next(FAMILIAR_VALUES, toggles.familiar) });
}

function flipFerries(): void {
  onChange({ ...toggles, ferries: !toggles.ferries });
}
</script>

<!-- `pressed` is for two-state switches only: a tri-state is neither pressed nor unpressed. -->
{#snippet toggleButton(
  face: ToggleFace,
  onClick: () => void,
  pressed?: boolean,
)}
  <button
    type="button"
    onclick={onClick}
    aria-pressed={pressed}
    aria-label={face.label}
    title={face.label}
    class={`grid h-8 w-8 shrink-0 place-items-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-700 ${face.tint}`}
  >
    <Icon icon={face.icon} class="h-[18px] w-[18px]" aria-hidden="true" />
  </button>
{/snippet}

<div class="flex shrink-0 items-center">
  {#if available.shade}
    {@render toggleButton(SUN_FACES[toggles.sun], cycleSun)}
  {/if}
  {#if available.hill}
    {@render toggleButton(HILL_FACES[toggles.hills], cycleHills)}
  {/if}
  {#if available.familiar}
    {@render toggleButton(FAMILIAR_FACES[toggles.familiar], cycleFamiliar)}
  {/if}
  {#if available.ferry}
    {@render toggleButton(ferryFace, flipFerries, toggles.ferries)}
  {/if}
</div>

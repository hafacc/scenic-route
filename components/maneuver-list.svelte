<script lang="ts">
import {
  formatDistance,
  formatDuration,
  type Maneuver,
} from "../src/routing/directions";
import type { NavProgress } from "../src/routing/nav-progress";
import Icon from "./icon.svelte";
import LinePill from "./lenses/line-pill.svelte";
import { maneuverIcon, maneuverState } from "./maneuvers";

interface Props {
  directions: Maneuver[];
  progress: NavProgress | null;
  class: string;
}

const { directions, progress, class: className }: Props = $props();

const RIDE_BUBBLE =
  "flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-bold leading-none";

let list: HTMLOListElement | null = null;
const nextIndex = $derived(progress ? progress.nextManeuver : null);
$effect(() => {
  if (nextIndex !== null) {
    // Found by position, since a `bind:this` cannot follow the highlighted row.
    list?.children[nextIndex]?.scrollIntoView({ block: "nearest" });
  }
});

function bubbleClass(maneuver: Maneuver): string {
  return maneuver.kind === "landmark"
    ? "bg-[#bd8c1d]/10 text-[#8e6704] dark:bg-[#d7b16d]/15 dark:text-[#d7b16d]"
    : maneuver.kind === "art"
      ? "bg-[#2552aa]/10 text-[#2552aa] dark:bg-[#92b8fd]/15 dark:text-[#92b8fd]"
      : "bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300";
}

function textClass(maneuver: Maneuver): string {
  return maneuver.kind === "landmark"
    ? "text-[#8e6704] dark:text-[#d7b16d]"
    : maneuver.kind === "art"
      ? "text-[#2552aa] dark:text-[#92b8fd]"
      : "text-slate-700 dark:text-slate-200";
}
</script>

<ol bind:this={list} class={className}>
  {#each directions as maneuver, index (`${maneuver.kind}-${maneuver.stepRange[0]}-${maneuver.stepRange[1]}-${maneuver.text}-${index}`)}
    <li
      class={`flex items-center gap-3 rounded-lg px-2 py-1.5 ${maneuverState(progress, index) === "next" ? "bg-brand-100 font-medium dark:bg-brand-500/25" : ""} ${maneuverState(progress, index) === "passed" ? "opacity-50" : ""}`}
    >
      {#if maneuver.ride}
        <LinePill ride={maneuver.ride} class={RIDE_BUBBLE} />
      {:else}
        <span
          class={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${bubbleClass(maneuver)}`}
        >
          <Icon
            icon={maneuverIcon(maneuver)}
            class="h-4 w-4"
            aria-hidden="true"
          />
        </span>
      {/if}
      <span class={`min-w-0 flex-1 text-sm ${textClass(maneuver)}`}
        >{maneuver.text}</span
      >
      {#if maneuver.durationSeconds !== undefined}
        <span
          class="shrink-0 text-xs font-medium text-slate-400 dark:text-slate-500"
          >{formatDuration(maneuver.durationSeconds)}</span
        >
      {:else if maneuver.lengthMeters > 0}
        <span
          class="shrink-0 text-xs font-medium text-slate-400 dark:text-slate-500"
          >{formatDistance(maneuver.lengthMeters)}</span
        >
      {/if}
    </li>
  {/each}
</ol>

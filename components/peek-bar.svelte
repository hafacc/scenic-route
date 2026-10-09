<script lang="ts">
import { FiChevronUp } from "../src/icons/glyphs";
import { formatDistance, formatDuration } from "../src/routing/directions";
import Icon from "./icon.svelte";
import { maneuverIcon, type PeekNext } from "./maneuvers";

interface Props {
  next: PeekNext | null;
  fallback: string;
  bare?: boolean;
  onExpand: () => void;
}

const { next, fallback, bare, onExpand }: Props = $props();

// `bare` when the containing card carries the chrome instead.
const PEEK_CHROME =
  "rounded-2xl bg-white/85 px-4 py-3 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10";
</script>

<button
  type="button"
  onclick={onExpand}
  aria-label="Expand directions"
  class={`flex min-h-10 w-full items-center justify-between gap-2 text-left ${bare ? "" : PEEK_CHROME}`}
>
  {#if next}
    <span class="flex min-w-0 flex-1 items-center gap-3">
      <span
        class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300"
      >
        <Icon
          icon={maneuverIcon(next.maneuver)}
          class="h-4 w-4"
          aria-hidden="true"
        />
      </span>
      <span class="min-w-0 flex-1">
        <span
          class="block truncate text-sm font-semibold text-slate-800 dark:text-slate-100"
          >{next.maneuver.text}</span
        >
        <span
          class="block text-xs font-medium text-slate-400 dark:text-slate-500"
          >{next.current?.kind === "transit"
            ? `after ${next.current.stops ?? 0} stop${next.current.stops === 1 ? "" : "s"} · ${formatDuration(next.current.durationSeconds ?? 0)}`
            : `in ${formatDistance(next.distanceMeters)}`}</span
        >
      </span>
    </span>
  {:else}
    <span
      class="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800 dark:text-slate-100"
      >{fallback}</span
    >
  {/if}
  <Icon
    icon={FiChevronUp}
    class="h-5 w-5 shrink-0 text-slate-400"
    aria-hidden="true"
  />
</button>

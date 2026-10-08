<script lang="ts">
import { FiCheck, FiShare2 } from "../src/icons/glyphs";
import { useCopy } from "./copy-status.svelte";
import Icon from "./icon.svelte";

interface ShareControlProps {
  composeUrl: () => string;
}

// Below the pill, the location banner (higher stacking context) hides it.
const { composeUrl }: ShareControlProps = $props();

const copier = useCopy();
const status = $derived(copier.status);
</script>

<div class="relative">
  <button
    type="button"
    onclick={() => void copier.copy(composeUrl)}
    aria-label="Copy a link to this view"
    title="Copy a link to this view"
    class={`grid h-10 w-10 place-items-center rounded-full bg-white/85 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white dark:bg-slate-800/80 dark:ring-white/10 dark:hover:bg-slate-800 ${status === "copied" ? "text-brand-600 dark:text-brand-400" : "text-slate-500 dark:text-slate-400"}`}
  >
    {#if status === "copied"}
      <Icon icon={FiCheck} class="h-4 w-4" aria-hidden="true" />
    {:else}
      <Icon icon={FiShare2} class="h-4 w-4" aria-hidden="true" />
    {/if}
  </button>
  {#if status !== "idle"}
    <span
      role="status"
      class="absolute top-1/2 right-full mr-2 -translate-y-1/2 whitespace-nowrap rounded-full bg-slate-900/90 px-3 py-1.5 text-xs font-medium text-white shadow-lg backdrop-blur-md dark:bg-slate-100/95 dark:text-slate-900"
    >
      {status === "copied" ? "Link copied" : "Couldn't copy the link"}
    </span>
  {/if}
</div>

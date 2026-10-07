<script lang="ts">
import { type Snippet, tick } from "svelte";
import {
  HIGHLIGHT_MS,
  SECTION_TITLE,
  type SettingsSection,
} from "./settings-dialog";

interface Props {
  id: SettingsSection;
  caption: string;
  wanted: boolean;
  children: Snippet;
}

const SECTION = "mt-5 scroll-mt-2 rounded-2xl transition-colors duration-700";
const ARRIVING = "bg-brand-50/70 dark:bg-brand-500/10";

const { id, caption, wanted, children }: Props = $props();

let heading: HTMLDivElement | null = null;
let arriving = $state.raw(false);

$effect(() => {
  if (!wanted) {
    return;
  }
  // After the sheet has portaled: on mount this runs first, and the move drops the scroll.
  void tick().then(() => {
    heading?.scrollIntoView({ block: "start", behavior: "smooth" });
  });
  arriving = true;
  const timer = window.setTimeout(() => {
    arriving = false;
  }, HIGHLIGHT_MS);
  return () => window.clearTimeout(timer);
});
</script>

<!-- The flash fades; left on, it reads as a selection the reader can't clear. -->
<div bind:this={heading} class={`${SECTION} ${arriving ? ARRIVING : ""}`}>
  <p
    class="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500"
  >
    {SECTION_TITLE[id]}
  </p>
  <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">{caption}</p>
  {@render children()}
</div>

<script lang="ts">
import type { Snippet } from "svelte";
import type { PeekNext } from "./maneuvers";
import { PANEL_WRAPPER } from "./panel-shell";
import PeekBar from "./peek-bar.svelte";

interface MinimizedPanelProps {
  next: PeekNext | null;
  fallback: string;
  header?: Snippet;
  cardClassName?: string;
  corner?: Snippet;
  onExpand: () => void;
}

const {
  next,
  fallback,
  header,
  cardClassName,
  corner,
  onExpand,
}: MinimizedPanelProps = $props();
</script>

{#if header === undefined || cardClassName === undefined}
  <div class={PANEL_WRAPPER}>
    <div class="pointer-events-auto relative">
      <PeekBar {next} {fallback} {onExpand} />
      {@render corner?.()}
    </div>
  </div>
{:else}
  <div class={PANEL_WRAPPER}>
    <div class={cardClassName}>
      {@render corner?.()}
      {@render header()}
      <PeekBar {next} {fallback} bare {onExpand} />
    </div>
  </div>
{/if}

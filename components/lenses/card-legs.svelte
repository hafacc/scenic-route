<script lang="ts">
import { type CardSummary, summaryLegs } from "../../src/lenses/cards";
import LegParts from "./leg-parts.svelte";

interface Props {
  summary: CardSummary;
}

// The same segments, for the chips row. Nothing where the trip walks the whole way.
const { summary }: Props = $props();

const parts = $derived(summaryLegs(summary));
</script>

{#if parts.length > 0}
  <span class="text-xs font-semibold text-slate-800 dark:text-slate-100"
    ><LegParts {parts} lead={false} /></span
  >
{/if}

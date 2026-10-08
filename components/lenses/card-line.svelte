<script lang="ts">
import {
  type CardSummary,
  type SummaryOrder,
  summaryNumbers,
  summaryParts,
} from "../../src/lenses/cards";
import LegParts from "./leg-parts.svelte";

interface Props {
  summary: CardSummary;
  order?: SummaryOrder;
  legs?: "inline" | "row";
}

// "row" leaves the legs off a too-narrow header; `CardLegs` puts them in the chips row.
const { summary, order, legs = "inline" }: Props = $props();

const parts = $derived(
  legs === "inline"
    ? summaryParts(summary, order)
    : summaryNumbers(summary, order),
);
</script>

<span
  class="block truncate text-sm font-semibold text-slate-800 dark:text-slate-100"
  ><LegParts {parts} lead={false} /></span
>

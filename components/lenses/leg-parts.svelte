<script lang="ts">
import type { LinePart, RideSummary } from "../../src/lenses/cards";
import FerryPill from "./ferry-pill.svelte";
import LinePill from "./line-pill.svelte";

interface Props {
  parts: LinePart[];
  lead: boolean;
}

const { parts, lead }: Props = $props();

type Piece =
  | { kind: "dot" }
  | { kind: "text"; text: string }
  | { kind: "ferry" }
  | { kind: "ride"; ride: RideSummary };

function piecesOf(part: LinePart): Piece[] {
  if (typeof part === "string") {
    return [{ kind: "text", text: part }];
  } else if (part.kind === "ferry") {
    return [{ kind: "ferry" }, { kind: "text", text: part.minutes }];
  } else {
    return [
      { kind: "text", text: `${part.minutes} on` },
      ...part.rides.map((ride): Piece => ({ kind: "ride", ride })),
    ];
  }
}

// Flat, one piece per block, so no formatter's line break lands between a pill and its text.
const pieces = $derived(
  parts.flatMap((part, index): Piece[] =>
    lead || index > 0 ? [{ kind: "dot" }, ...piecesOf(part)] : piecesOf(part),
  ),
);
</script>

{#each pieces as piece}
  {#if piece.kind === "dot"}
    <span class="px-1 text-slate-400">·</span>
  {:else if piece.kind === "text"}
    {piece.text}
  {:else if piece.kind === "ferry"}
    <FerryPill />
  {:else}
    <LinePill ride={piece.ride} />
  {/if}
{/each}

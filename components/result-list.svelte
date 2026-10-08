<script lang="ts">
import type { GeocodeResult } from "../src/geocode";
import Icon from "./icon.svelte";
import ResultGlyph from "./result-glyph.svelte";
import type { LeadingAction } from "./result-list";

const ROW =
  "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm";
const IDLE =
  "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700/60";
const ACTIVE =
  "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300";
const BRAND =
  "font-medium text-brand-700 hover:bg-slate-50 dark:text-brand-300 dark:hover:bg-slate-700/60";

interface ResultListProps {
  listId: string;
  results: readonly GeocodeResult[];
  activeIndex: number; // -1 = none
  onHover: (index: number) => void;
  onPick: (result: GeocodeResult) => void;
  notice?: string | null;
  leadingAction?: LeadingAction | null;
  class: string;
  style?: string;
}

const {
  listId,
  results,
  activeIndex,
  onHover,
  onPick,
  notice,
  leadingAction,
  class: className,
  style,
}: ResultListProps = $props();
</script>

<!-- biome-ignore-start lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA in HTML allows it -->
<ul
  id={listId}
  role="listbox"
  {style}
  class={`space-y-0.5 overflow-y-auto overscroll-contain ${className}`}
>
  {#if leadingAction}
    <!-- A listbox owns its options directly, so each `li` wrapper is `role="none"`. -->
    <li role="none">
      <!-- Keep focus, or a blur races the field's close timer and swallows the pick. -->
      <button
        type="button"
        onmousedown={(event) => event.preventDefault()}
        onclick={leadingAction.onPick}
        class={`${ROW} ${leadingAction.tone === "brand" ? BRAND : IDLE}`}
      >
        <Icon
          icon={leadingAction.icon}
          class="h-4 w-4 shrink-0"
          aria-hidden="true"
        />{leadingAction.label}
      </button>
    </li>
  {/if}
  {#if notice}
    <li
      role="none"
      class="px-2 py-2 text-sm text-slate-500 dark:text-slate-400"
    >
      {notice}
    </li>
  {:else}
    {#each results as result, index (result.placeId)}
      <li role="none">
        <button
          type="button"
          role="option"
          id={`${listId}-${index}`}
          aria-selected={index === activeIndex}
          onmousedown={(event) => event.preventDefault()}
          onclick={() => onPick(result)}
          onmouseenter={() => onHover(index)}
          class={`${ROW} ${index === activeIndex ? ACTIVE : IDLE}`}
        >
          <ResultGlyph type={result.type} />
          <span class="truncate">{result.displayName}</span>
        </button>
      </li>
    {/each}
  {/if}
</ul>
<!-- biome-ignore-end lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA in HTML allows it -->

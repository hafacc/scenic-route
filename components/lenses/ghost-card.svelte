<script lang="ts">
import { FiLoader } from "../../src/icons/glyphs";
import Icon from "../icon.svelte";
import CardNumber from "./card-number.svelte";

interface Props {
  line: string | null;
  color: string;
}

// Drawn where its card will sit, so the list doesn't jump when the rest arrive.
const { line, color }: Props = $props();
</script>

<div class="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2 py-1.5">
  <CardNumber index={0} {color} />
  <span class="min-w-0 flex-1">
    <span
      class="block truncate text-sm font-semibold text-slate-800 dark:text-slate-100"
      >{line ?? "Finding routes…"}</span
    >
    <Icon
      icon={FiLoader}
      class="mt-0.5 h-3.5 w-3.5 animate-spin text-slate-400"
      aria-hidden="true"
    />
  </span>
</div>

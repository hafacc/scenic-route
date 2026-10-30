<script lang="ts">
import type { IconData } from "../src/icons/types";
import Icon from "./icon.svelte";

// One route summary chip, drawn alike in Explorer and on the route cards.
interface Props {
  icon: IconData;
  tint: string;
  text: string;
  title?: string;
  weight?: "font-semibold" | "font-bold" | "font-medium";
}

const { icon, tint, text, title, weight = "font-semibold" }: Props = $props();
</script>

<span
  {title}
  class={`inline-flex items-center gap-1 text-xs tabular-nums ${tint} ${weight}`}
>
  <Icon {icon} class="h-3.5 w-3.5" aria-hidden="true" />{text}
</span>

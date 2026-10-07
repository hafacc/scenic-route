<script lang="ts">
import type { SVGAttributes } from "svelte/elements";
import type { IconData } from "../src/icons/types";

const {
  icon,
  size,
  title,
  ...rest
}: SVGAttributes<SVGSVGElement> & {
  icon: IconData;
  size?: string | number;
  title?: string;
} = $props();

// Later wins, in the order of react-icons, whose glyphs these are: defaults, the glyph's, the caller's, the size.
const attributes = $derived({
  stroke: "currentColor",
  fill: "currentColor",
  "stroke-width": "0",
  ...icon.attr,
  ...rest,
  height: size || "1em",
  width: size || "1em",
  xmlns: "http://www.w3.org/2000/svg",
});
</script>

<!-- biome-ignore lint/a11y/noSvgWithoutTitle: the caller passes a title or aria-hidden -->
<svg {...attributes}>
  {#if title}
    <title>{title}</title>
  {/if}
  {@html icon.body}
</svg>

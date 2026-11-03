<script lang="ts">
import type { LineBullet } from "../../src/lenses/cards";
import { letterColor, lineColor } from "../../src/overlays/line-colors";
import { useMapTheme } from "../use-map-theme.svelte";
import { PILL } from "./route-cards";

interface Props {
  ride: LineBullet;
  class?: string;
}

const { ride, class: className }: Props = $props();
const theme = useMapTheme();
const fill = $derived(lineColor(ride.color, theme.current));
const letter = $derived(letterColor(ride.color, ride.textColor, theme.current));
</script>

<span class={className ?? PILL} style="background-color:{fill};color:{letter}"
  >{ride.shortName || "Train"}</span
>

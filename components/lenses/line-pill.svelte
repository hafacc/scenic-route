<script lang="ts">
import type { LineBullet } from "../../src/lenses/cards";
import { PILL } from "./route-cards";

interface Props {
  ride: LineBullet;
  class?: string;
}

const { ride, class: className }: Props = $props();
</script>

<span
  class={className ?? PILL}
  style="background-color:{ride.color};color:{ride.textColor}"
  >{ride.shortName || "Train"}</span
>

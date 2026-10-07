<script lang="ts">
import { PiBoatFill } from "../../src/icons/glyphs";
import { FERRY_COLOR } from "../../src/overlays/colors";
import Icon from "../icon.svelte";
import { useMapTheme } from "../use-map-theme.svelte";
import { FERRY_PILL } from "./route-cards";

// No agency numbers a boat, so the bullet is the ferry layer's glyph, in the same blue.
const theme = useMapTheme();
</script>

<span
  class={FERRY_PILL}
  style="background-color:{FERRY_COLOR[theme.current]};color:#ffffff"
  ><Icon icon={PiBoatFill} class="h-3 w-3" aria-hidden="true" /></span
>

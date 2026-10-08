<script lang="ts">
import {
  ADDRESS_RESULT_TYPE,
  INDEX_RESULT_TYPE,
  STREET_RESULT_TYPE,
  SUBWAY_RESULT_TYPE,
} from "../src/geocode";
import {
  MdOutlineHome,
  MdOutlinePlace,
  MdSignpost,
  PiTrainSimpleFill,
} from "../src/icons/glyphs";
import { SUBWAY_COLOR } from "../src/overlays/colors";
import Icon from "./icon.svelte";
import { useMapTheme } from "./use-map-theme.svelte";

const GLYPH = "h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500";

const { type }: { type: string } = $props();

const theme = useMapTheme();
</script>

{#if type === ADDRESS_RESULT_TYPE}
  <Icon icon={MdOutlineHome} class={GLYPH} aria-hidden="true" />
{:else if type === SUBWAY_RESULT_TYPE}
  <!-- The layer menu's subway color in the map's theme, so list and map show the same blue. -->
  <Icon
    icon={PiTrainSimpleFill}
    class="h-4 w-4 shrink-0"
    style="color:{SUBWAY_COLOR[theme.current]}"
    aria-hidden="true"
  />
{:else if type === STREET_RESULT_TYPE}
  <Icon icon={MdSignpost} class={GLYPH} aria-hidden="true" />
{:else if type === INDEX_RESULT_TYPE}
  <!-- One pin for every place; a glyph per category would be 1,758 of them. -->
  <Icon icon={MdOutlinePlace} class={GLYPH} aria-hidden="true" />
{/if}

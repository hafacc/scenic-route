<script lang="ts">
import { FiX } from "../../src/icons/glyphs";
import Icon from "../icon.svelte";

interface Props {
  onClose: () => void;
}

const { onClose }: Props = $props();
</script>

<button
  type="button"
  onclick={onClose}
  aria-label="Close directions"
  title="Close directions"
  class="absolute top-0 right-0 z-10 grid h-7 w-7 -translate-y-1/3 translate-x-1/3 place-items-center rounded-full bg-white text-slate-500 shadow-md ring-1 ring-black/5 transition hover:text-slate-700 dark:bg-slate-700 dark:text-slate-300 dark:ring-white/10 dark:hover:text-white"
>
  <Icon icon={FiX} class="h-[18px] w-[18px]" aria-hidden="true" />
</button>

<script lang="ts">
import { FiEye, FiEyeOff } from "../src/icons/glyphs";
import Icon from "./icon.svelte";

interface Props {
  off: boolean;
  label: string;
  where: string;
  onToggle: () => void;
}

const { off, label, where, onToggle }: Props = $props();
</script>

<!-- `where` names what the row leaves, since "hide" alone doesn't say whether it still applies. -->
<button
  type="button"
  onclick={onToggle}
  aria-pressed={!off}
  aria-label={off ? `Show ${label} in ${where}` : `Hide ${label} from ${where}`}
  class="grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
>
  {#if off}
    <Icon icon={FiEyeOff} />
  {:else}
    <Icon icon={FiEye} />
  {/if}
</button>

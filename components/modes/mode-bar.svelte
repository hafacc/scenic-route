<script lang="ts">
import type {
  FactorAvailability,
  Mode,
  ModeId,
  Toggles,
} from "../../src/modes/modes";
import ModeRow from "./mode-row.svelte";
import ToggleRow from "./toggle-row.svelte";

interface Props {
  modes: readonly Mode[];
  mode: ModeId;
  toggles: Toggles;
  available: FactorAvailability;
  onMode: (id: ModeId) => void;
  onToggles: (toggles: Toggles) => void;
}

const { modes, mode, toggles, available, onMode, onToggles }: Props = $props();
</script>

<ModeRow {modes} active={mode} class="min-w-0 flex-1" onSelect={onMode} />
<span
  class="mx-2 h-6 w-px shrink-0 bg-slate-200 dark:bg-slate-600"
  aria-hidden="true"
></span>
<ToggleRow {toggles} {available} onChange={onToggles} />

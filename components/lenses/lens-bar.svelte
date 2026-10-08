<script lang="ts">
import type {
  FactorAvailability,
  Lens,
  LensId,
  Toggles,
} from "../../src/lenses/lenses";
import LensRow from "./lens-row.svelte";
import ToggleRow from "./toggle-row.svelte";

interface Props {
  lenses: readonly Lens[];
  lens: LensId;
  toggles: Toggles;
  available: FactorAvailability;
  onLens: (id: LensId) => void;
  onToggles: (toggles: Toggles) => void;
}

const { lenses, lens, toggles, available, onLens, onToggles }: Props = $props();
</script>

<LensRow {lenses} active={lens} class="min-w-0 flex-1" onSelect={onLens} />
<span
  class="mx-2 h-6 w-px shrink-0 bg-slate-200 dark:bg-slate-600"
  aria-hidden="true"
></span>
<ToggleRow {toggles} {available} onChange={onToggles} />

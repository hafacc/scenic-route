<script lang="ts">
import type { RouteWeights } from "../src/routing/cost";
import { GATES, type GateKey } from "../src/routing/factors";
import { updateSettings } from "../src/settings/store";
import SettingsGateRow from "./settings-gate-row.svelte";
import { useSettings } from "./use-settings.svelte";

interface Props {
  weights: RouteWeights;
  onGate: (key: GateKey, on: boolean) => void;
}

const { weights, onGate }: Props = $props();

const settings = useSettings();
const hidden = $derived(new Set(settings.current.hiddenGates));

function hide(key: GateKey): void {
  const next = new Set(hidden);
  if (!next.delete(key)) {
    next.add(key);
  }
  updateSettings({ hiddenGates: [...next] });
}
</script>

<ul class="mt-2">
  {#each GATES as gate (gate.key)}
    <SettingsGateRow
      {gate}
      on={weights[gate.key]}
      hidden={hidden.has(gate.key)}
      onChange={(on) => onGate(gate.key, on)}
      onHide={() => hide(gate.key)}
    />
  {/each}
</ul>

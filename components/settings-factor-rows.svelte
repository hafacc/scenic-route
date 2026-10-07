<script lang="ts">
import type { RouteWeights } from "../src/routing/cost";
import { FACTORS, type FactorKey, factorReading } from "../src/routing/factors";
import { factorRunOrder, updateSettings } from "../src/settings/store";
import FactorSlider from "./factor-slider.svelte";
import Icon from "./icon.svelte";
import { draggingRow, keepFocus, LIFTED, rowLabel } from "./settings-dialog";
import SettingsDragHandle from "./settings-drag-handle.svelte";
import SettingsHideToggle from "./settings-hide-toggle.svelte";
import { useRowDrag } from "./use-row-drag.svelte";
import { useSettings } from "./use-settings.svelte";

interface Props {
  weights: RouteWeights;
  onWeight: (key: FactorKey, weight: number) => void;
}

const { weights, onWeight }: Props = $props();

const settings = useSettings();
const order = $derived(factorRunOrder(settings.current.factorOrder));
const hidden = $derived(new Set(settings.current.hiddenFactors));

// Before the rows move, so the focused handle is still the active element.
$effect.pre(() => {
  void order;
  keepFocus();
});

function move(from: number, to: number): void {
  const next = [...order];
  next.splice(to, 0, ...next.splice(from, 1));
  updateSettings({ factorOrder: next });
}
const drag = useRowDrag(() => order.length, move);

function toggle(key: FactorKey): void {
  const next = new Set(hidden);
  if (!next.delete(key)) {
    next.add(key);
  }
  updateSettings({ hiddenFactors: [...next] });
}

// A key with no factor draws no row but keeps its place in the order.
const rows = $derived(
  order.flatMap((key, index) => {
    const factor = FACTORS.find((entry) => entry.key === key);
    return factor
      ? [{ key, index, factor, off: hidden.has(key), weight: weights[key] }]
      : [];
  }),
);
</script>

<ul class="mt-3">
  {#each rows as { key, index, factor, off, weight } (key)}
    <li
      style={draggingRow(index, drag)}
      class={`relative rounded-xl px-2 py-1.5 ${drag.isDragging(index) ? LIFTED : ""}`}
    >
      <div class="flex items-center gap-3">
        <span class={off ? "opacity-40" : factor.tint}>
          <Icon icon={factor.icon.glyph} class="h-4 w-4" aria-hidden="true" />
        </span>
        <span class={rowLabel(off)}>
          <span class="truncate">{factor.label}</span>
        </span>
        <span
          class="shrink-0 text-xs tabular-nums text-slate-400 dark:text-slate-500"
        >
          {factorReading(factor, weight)}
        </span>
        <SettingsHideToggle
          {off}
          label={factor.label}
          where="the route panel"
          onToggle={() => toggle(key)}
        />
        <SettingsDragHandle
          label={factor.label}
          {index}
          count={order.length}
          {drag}
          {move}
        />
      </div>
      <FactorSlider
        {factor}
        {weight}
        onChange={(next) => onWeight(key, next)}
        class="mt-1 w-full"
      />
    </li>
  {/each}
</ul>

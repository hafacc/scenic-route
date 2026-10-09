<script lang="ts">
import {
  OVERLAYS,
  type OverlayId,
  overlayLabel,
} from "../src/overlays/registry";
import { layerMenuOrder, updateSettings } from "../src/settings/store";
import { useCity } from "./city-context";
import Icon from "./icon.svelte";
import { draggingRow, keepFocus, LIFTED, rowLabel } from "./settings-dialog";
import SettingsDragHandle from "./settings-drag-handle.svelte";
import SettingsHideToggle from "./settings-hide-toggle.svelte";
import { useMapTheme } from "./use-map-theme.svelte";
import { useRowDrag } from "./use-row-drag.svelte";
import { useSettings } from "./use-settings.svelte";

const city = useCity();
const settings = useSettings();
const mapTheme = useMapTheme();
const order = $derived(layerMenuOrder(settings.current.layerOrder));
const hidden = $derived(new Set(settings.current.hiddenLayers));

// Before the rows move, so the focused handle is still the active element.
$effect.pre(() => {
  void order;
  keepFocus();
});

function move(from: number, to: number): void {
  const next = [...order];
  next.splice(to, 0, ...next.splice(from, 1));
  updateSettings({ layerOrder: next });
}
const drag = useRowDrag(() => order.length, move);

function toggle(id: OverlayId): void {
  const next = new Set(hidden);
  if (!next.delete(id)) {
    next.add(id);
  }
  updateSettings({ hiddenLayers: [...next] });
}

// An id with no overlay draws no row but keeps its place in the order.
const rows = $derived(
  order.flatMap((id, index) => {
    const overlay = OVERLAYS.find((entry) => entry.id === id);
    return overlay
      ? [
          {
            id,
            index,
            overlay,
            off: hidden.has(id),
            label: overlayLabel(overlay, city()),
          },
        ]
      : [];
  }),
);
</script>

<ul class="mt-3">
  {#each rows as { id, index, overlay, off, label } (id)}
    <li
      style={`height:44px;${draggingRow(index, drag)}`}
      class={`relative flex items-center gap-3 rounded-xl px-2 ${drag.isDragging(index) ? LIFTED : ""}`}
    >
      <span class={off ? "opacity-40" : undefined}>
        <Icon
          icon={overlay.icon.glyph}
          class={overlay.icon.class}
          style={overlay.icon.color
            ? `color:${overlay.icon.color[mapTheme.current]}`
            : undefined}
          aria-hidden="true"
        />
      </span>
      <span class={rowLabel(off)}>
        <span class="truncate">{label}</span>
      </span>
      <SettingsHideToggle
        {off}
        {label}
        where="the layers menu"
        onToggle={() => toggle(id)}
      />
      <SettingsDragHandle {label} {index} count={order.length} {drag} {move} />
    </li>
  {/each}
</ul>

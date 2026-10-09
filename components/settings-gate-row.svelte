<script lang="ts">
import type { Gate } from "../src/routing/factors";
import Icon from "./icon.svelte";
import { rowLabel } from "./settings-dialog";
import SettingsHideToggle from "./settings-hide-toggle.svelte";
import SettingsSwitch from "./settings-switch.svelte";

interface Props {
  gate: Gate;
  on: boolean;
  hidden: boolean;
  onChange: (on: boolean) => void;
  onHide: () => void;
}

const { gate, on, hidden, onChange, onHide }: Props = $props();
</script>

<!-- A hidden gate keeps gating, so it counts toward "hidden preferences still apply". -->
<li class="flex items-center gap-3 rounded-xl px-2 py-2">
  <span
    class={hidden
      ? "opacity-40"
      : on
        ? "text-slate-500 dark:text-slate-400"
        : "opacity-40"}
  >
    <Icon icon={gate.icon.glyph} class="h-4 w-4" aria-hidden="true" />
  </span>
  <span class={rowLabel(hidden)}>
    <span class="truncate">{gate.label}</span>
  </span>
  <SettingsSwitch label={gate.label} {on} {onChange} />
  <SettingsHideToggle
    off={hidden}
    label={gate.label}
    where="the route panel"
    onToggle={onHide}
  />
</li>

<script lang="ts">
import { updateSettings } from "../src/settings/store";
import { walks } from "../src/walks/history";
import { rowLabel } from "./settings-dialog";
import Section from "./settings-section.svelte";
import SettingsSwitch from "./settings-switch.svelte";
import { forgetWalkHeat } from "./sw-messages";
import { useSettings } from "./use-settings.svelte";
import { useWalkCount } from "./use-walks.svelte";

interface Props {
  wanted: boolean;
}

const LABEL = "Remember where I walk";
const CAPTION =
  "While the app is open and has your location, the streets you walk are remembered on this device alone — never synced or sent — so a route can prefer familiar streets or new ones.";

const { wanted }: Props = $props();

const settings = useSettings();
const on = $derived(settings.current.trackWalks);
const count = useWalkCount();
const remembered = $derived(
  count.current === 0
    ? "Nothing remembered yet"
    : `${count.current} block${count.current === 1 ? "" : "s"} remembered`,
);
</script>

<Section id="walks" {wanted} caption={CAPTION}>
  <ul class="mt-2">
    <li class="flex items-center gap-3 rounded-xl px-2 py-2">
      <span class={rowLabel(false)}>
        <span class="truncate">{LABEL}</span>
      </span>
      <SettingsSwitch
        label={LABEL}
        {on}
        onChange={(next) => updateSettings({ trackWalks: next })}
      />
    </li>
  </ul>
  <div
    class="mt-2 flex items-center justify-between px-2 text-xs text-slate-500 dark:text-slate-400"
  >
    <span>{remembered}</span>
    <button
      type="button"
      onclick={() => {
        walks.forget();
        forgetWalkHeat();
      }}
      disabled={count.current === 0}
      class="font-medium text-brand-600 hover:underline disabled:pointer-events-none disabled:opacity-40 dark:text-brand-400"
    >
      Forget my walks
    </button>
  </div>
</Section>

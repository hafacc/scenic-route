<script lang="ts">
import { FiX } from "../src/icons/glyphs";
import type { RouteWeights } from "../src/routing/cost";
import type { FactorKey, GateKey } from "../src/routing/factors";
import Icon from "./icon.svelte";
import { SECTIONS, type SettingsSection } from "./settings-dialog";
import SettingsFactorRows from "./settings-factor-rows.svelte";
import SettingsGateRows from "./settings-gate-rows.svelte";
import SettingsLayerRows from "./settings-layer-rows.svelte";
import SettingsOfflineSection from "./settings-offline-section.svelte";
import Section from "./settings-section.svelte";
import Sheet from "./sheet.svelte";
import { SHEET_SCROLL } from "./sheet-shell";

interface SettingsDialogProps {
  // Only with the routing group: Modes has no sliders.
  weights?: RouteWeights;
  onWeight?: (key: FactorKey, weight: number) => void;
  onGate?: (key: GateKey, on: boolean) => void;
  sections?: readonly SettingsSection[];
  syncingAs: string | null;
  // The empty string means the page with no group in mind.
  section: string | null;
  onClose: () => void;
}

const LAYERS_CAPTION =
  "The order of the layers menu, and which layers it offers. One order for every region — each shows the layers it has data for.";
const LOCAL_NOTE =
  "These settings are kept on this device. Sign in and they follow you to your others.";
const ROUTING_CAPTION =
  "One value per preference — these are the route panel's own sliders. Hiding one takes it out of the panel; it still prices the route.";

const {
  weights,
  onWeight,
  onGate,
  sections = SECTIONS,
  syncingAs,
  section,
  onClose,
}: SettingsDialogProps = $props();

const syncNote = $derived(
  syncingAs === null
    ? LOCAL_NOTE
    : `Synced with ${syncingAs}. Changes here reach your other devices, and theirs reach this one.`,
);
</script>

<Sheet
  {onClose}
  closeLabel="Close settings"
  labeledBy="settings-title"
  width="md:max-w-md"
>
  <div class="flex shrink-0 items-start gap-3">
    <h2
      id="settings-title"
      class="min-w-0 flex-1 text-lg font-semibold tracking-tight"
    >
      Settings
    </h2>
    <button
      type="button"
      onclick={onClose}
      class="-m-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
      aria-label="Close"
    >
      <Icon icon={FiX} />
    </button>
  </div>

  <div class={SHEET_SCROLL}>
    {#if sections.includes("layers")}
      <Section
        id="layers"
        wanted={section === "layers"}
        caption={LAYERS_CAPTION}
      >
        <SettingsLayerRows />
      </Section>
    {/if}

    {#if sections.includes("routing") && weights && onWeight && onGate}
      <Section
        id="routing"
        wanted={section === "routing"}
        caption={ROUTING_CAPTION}
      >
        <SettingsFactorRows {weights} {onWeight} />
        <SettingsGateRows {weights} {onGate} />
      </Section>
    {/if}

    {#if sections.includes("offline")}
      <SettingsOfflineSection wanted={section === "offline"} />
    {/if}

    <div
      class="mt-7 border-t border-slate-200/60 pt-4 text-xs text-slate-500 dark:border-slate-700/60 dark:text-slate-400"
    >
      {syncNote}
    </div>
  </div>
</Sheet>

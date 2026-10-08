<script lang="ts">
import type { Snippet } from "svelte";
import {
  type ModeId,
  modeForCity,
  modesForCity,
  type Toggles,
} from "../../src/modes/modes";
import SettingsDialog from "../settings-dialog.svelte";
import type { ShellDeck } from "../shell-types";
import { expand, type ModesState } from "./modes-state";
import ModesPanel from "./panel.svelte";

interface Props {
  shell: ShellDeck;
  deck: ModesState;
  exportAction: Snippet | null;
}

const { shell, deck, exportAction }: Props = $props();

const city = $derived(shell.city);
const modes = $derived(modesForCity(city));
const mode = $derived(modeForCity(city, deck.modeId));

// Unresolved link text counts as a destination, since the box it is typed into is the answer.
const routing = $derived(
  shell.dest !== null || shell.destPrefill !== null || deck.directionsOpen,
);
function close(): void {
  shell.onToggleRouting();
  deck.onClose();
}
function handleMode(id: ModeId): void {
  deck.onMode(id);
  expand(shell);
}
function handleToggles(next: Toggles): void {
  deck.onToggles(next);
  expand(shell);
}

const startLabel = $derived(
  shell.manualStart
    ? shell.manualStart.label
    : shell.hasLiveLocation
      ? "My location"
      : null,
);
const errorMessage = $derived(
  shell.routeState.kind === "error" ? shell.routeState.message : null,
);
</script>

<ModesPanel
  {city}
  {modes}
  {mode}
  onMode={handleMode}
  toggles={deck.toggles}
  available={shell.available}
  onToggles={handleToggles}
  {routing}
  foundLabel={shell.searchPin?.label ?? null}
  onSearchSelect={shell.onSearchSelect}
  onSearchClear={shell.onSearchClear}
  onSearchDirections={shell.onSearchDirections}
  onClose={close}
  {startLabel}
  destLabel={shell.dest?.label ?? null}
  startSet={shell.manualStart !== null}
  destSet={shell.dest !== null}
  needsStart={shell.manualStart === null && !shell.hasLiveLocation}
  hasLiveLocation={shell.hasLiveLocation}
  pickTarget={shell.pickTarget}
  destPrefill={shell.destPrefill}
  status={shell.routeState.kind}
  {errorMessage}
  planning={deck.planning || shell.dragging}
  planningLine={deck.planningLine}
  cards={deck.cards}
  selected={deck.alt}
  directions={shell.directions}
  progress={shell.progress}
  minimized={shell.minimized}
  {exportAction}
  onSelect={deck.onSelect}
  onHover={deck.onHover}
  onBack={deck.onBack}
  onStartSelect={shell.onStartSelect}
  onDestSelect={shell.onDestSelect}
  onStartClear={shell.onStartClear}
  onDestClear={shell.onDestClear}
  onSwap={shell.onSwap}
  onArmStart={shell.onArmStart}
  onArmDest={shell.onArmDest}
  onToggleMinimize={shell.onToggleMinimize}
/>
{#if shell.settingsSection !== null}
  <SettingsDialog
    sections={["offline"]}
    syncingAs={shell.syncingAs}
    section={shell.settingsSection}
    onClose={() => shell.onSettings(null)}
  />
{/if}

<script lang="ts">
import { ferrySummaries, rideSummaries } from "../../src/modes/cards";
import type { RouteWeights } from "../../src/routing/cost";
import type { FactorKey, GateKey } from "../../src/routing/factors";
import GoogleMapsButton from "../google-maps-button.svelte";
import SettingsDialog from "../settings-dialog.svelte";
import type { ShellDeck } from "../shell-types";
import RoutePanel from "./route-panel.svelte";

interface PanelsProps {
  shell: ShellDeck;
  weights: RouteWeights;
  onWeight: (key: FactorKey, weight: number) => void;
  onGate: (key: GateKey, on: boolean) => void;
}

const { shell, weights, onWeight, onGate }: PanelsProps = $props();

const city = $derived(shell.city);
const routeState = $derived(shell.routeState);

const exportShown = $derived(
  routeState.kind === "ready" &&
    shell.exportOrigin !== null &&
    shell.dest !== null,
);
const startLabel = $derived(
  shell.manualStart
    ? shell.manualStart.label
    : shell.hasLiveLocation
      ? "My location"
      : null,
);
const summary = $derived(
  routeState.kind === "ready"
    ? {
        walkMeters: routeState.result.walkMeters,
        travelSeconds: routeState.result.travelSeconds,
        rides: rideSummaries(routeState.result.rides),
        ferries: ferrySummaries(routeState.result.ferries),
        factors: routeState.result.factors,
      }
    : null,
);
</script>

{#snippet exportButton()}
  {#if shell.exportOrigin && shell.dest}
    <GoogleMapsButton
      plan={shell.waypointPlan}
      start={shell.exportOrigin}
      dest={shell.dest}
    />
  {/if}
{/snippet}

{#if shell.routingOpen}
  <RoutePanel
    {city}
    exportAction={exportShown ? exportButton : null}
    destPrefill={shell.destPrefill}
    {startLabel}
    destLabel={shell.dest?.label ?? null}
    startSet={shell.manualStart !== null}
    destSet={shell.dest !== null}
    needsStart={shell.manualStart === null && !shell.hasLiveLocation}
    hasLiveLocation={shell.hasLiveLocation}
    pickTarget={shell.pickTarget}
    status={routeState.kind}
    errorMessage={routeState.kind === "error" ? routeState.message : null}
    {summary}
    treeWeight={weights.tree}
    ferryWeight={weights.ferry}
    allowFerries={weights.allowFerries}
    transitWeight={weights.transit}
    landmarkWeight={weights.landmark}
    artWeight={weights.art}
    highwayWeight={weights.highway}
    hillWeight={weights.hill}
    graphAvailable={shell.graphAvailable}
    shedFeed={shell.shedFeed}
    commercialWeight={weights.commercial}
    industrialWeight={weights.industrial}
    historicWeight={weights.historic}
    bridgeWeight={weights.bridge}
    shadeWeight={weights.shade}
    shadeDataLost={shell.shadeDataLost}
    shelterWeight={weights.shelter}
    allowSheds={weights.allowSheds}
    allowCrossings={weights.allowCrossings}
    directions={shell.directions}
    progress={shell.progress}
    directionsOpen={shell.directionsOpen}
    minimized={shell.minimized}
    onTreeWeight={(weight) => onWeight("tree", weight)}
    onFerryWeight={(weight) => onWeight("ferry", weight)}
    onTransitWeight={(weight) => onWeight("transit", weight)}
    onLandmarkWeight={(weight) => onWeight("landmark", weight)}
    onArtWeight={(weight) => onWeight("art", weight)}
    onHighwayWeight={(weight) => onWeight("highway", weight)}
    onHillWeight={(weight) => onWeight("hill", weight)}
    onCommercialWeight={(weight) => onWeight("commercial", weight)}
    onIndustrialWeight={(weight) => onWeight("industrial", weight)}
    onHistoricWeight={(weight) => onWeight("historic", weight)}
    onBridgeWeight={(weight) => onWeight("bridge", weight)}
    onShadeWeight={(weight) => onWeight("shade", weight)}
    onShelterWeight={(weight) => onWeight("shelter", weight)}
    {onGate}
    onStartSelect={shell.onStartSelect}
    onDestSelect={shell.onDestSelect}
    onStartClear={shell.onStartClear}
    onDestClear={shell.onDestClear}
    onSwap={shell.onSwap}
    onUseCurrentLocation={shell.onStartClear}
    onArmStart={shell.onArmStart}
    onArmDest={shell.onArmDest}
    onToggleDirections={shell.onToggleDirections}
    onToggleMinimize={shell.onToggleMinimize}
    onSettings={(section) => shell.onSettings(section ?? "")}
    onClose={shell.onToggleRouting}
  />
{/if}
{#if shell.settingsSection !== null}
  <SettingsDialog
    {weights}
    {onWeight}
    {onGate}
    syncingAs={shell.syncingAs}
    section={shell.settingsSection}
    onClose={() => shell.onSettings(null)}
  />
{/if}

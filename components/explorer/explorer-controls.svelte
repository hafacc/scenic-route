<script lang="ts">
import type { OverlayId } from "../../src/overlays/registry";
import { LENSES_PAGE } from "../../src/pages";
import { getPinnedTime } from "../../src/route-time/store";
import type { RouteWeights } from "../../src/routing/cost";
import { encodeRoute, encodeView, shareUrl } from "../../src/url-state";
import RouteToggle from "../route-toggle.svelte";
import ShellToolbar from "../shell-toolbar.svelte";
import type { RoutingContext, ShellDeck } from "../shell-types";
import UrlSync from "../url-sync.svelte";
import LayersControl from "./layers-control.svelte";

interface ControlsProps {
  shell: ShellDeck;
  weights: RouteWeights;
  // The same function the shell draws from, so the menu and the link show what the map does.
  activeOverlays: (context: RoutingContext) => ReadonlySet<OverlayId>;
  onToggleOverlay: (id: OverlayId) => void;
}

const { shell, weights, activeOverlays, onToggleOverlay }: ControlsProps =
  $props();

const city = $derived(shell.city);
const shown = $derived(activeOverlays({ city, available: shell.available }));

// The camera and overlay set live in a URL only here.
function composeShareUrl(): string {
  const params = encodeHash(getPinnedTime());
  const camera = shell.camera();
  if (camera) {
    for (const [key, value] of encodeView(camera, [...shown], city.id)) {
      params.append(key, value);
    }
  }
  return shareUrl(window.location, params);
}

function encodeHash(clock: {
  hour: number | null;
  day: string | null;
}): URLSearchParams {
  return encodeRoute({
    start: shell.manualStart,
    dest: shell.dest,
    pin: shell.searchPin,
    weights,
    customHour: clock.hour,
    customDay: clock.day,
  });
}
</script>

{#snippet controls()}
  <RouteToggle active={shell.routingOpen} onToggle={shell.onToggleRouting} />
  <LayersControl
    {city}
    active={shown}
    onToggle={onToggleOverlay}
    onSettings={(section) => shell.onSettings(section ?? "")}
  />
{/snippet}

<ShellToolbar
  {shell}
  otherPage={LENSES_PAGE}
  clock
  {controls}
  {composeShareUrl}
/>
<UrlSync
  start={shell.manualStart}
  dest={shell.dest}
  pin={shell.searchPin}
  encode={encodeHash}
  enabled={shell.hashApplied}
/>

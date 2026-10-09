<script module lang="ts">
import L from "leaflet";
import { onMount } from "svelte";
import { CITY_ZOOM, type City, type CityBounds } from "../src/cities";
import { OVERLAYS, type OverlayId } from "../src/overlays/registry";
import type { Pin, PinDraft } from "../src/pin";
import type { RoutingGraph } from "../src/routing/graph";
import type { RouteResult } from "../src/routing/search";
import installTilePrune from "../src/tiles/prune";
import type { Camera } from "../src/url-state";
import Basemap from "./basemap.svelte";
import LazyLayer from "./lazy-layer.svelte";
import Marker from "./leaflet/marker.svelte";
import CameraWatcher from "./map/camera-watcher.svelte";
import DoubleTapZoom from "./map/double-tap-zoom.svelte";
import MapController from "./map/map-controller.svelte";
import PickCatcher from "./map/pick-catcher.svelte";
import PickCursor from "./map/pick-cursor.svelte";
import { setMap } from "./map-context";
import { savedIcon, searchIcon, userIcon } from "./map-icons";
import type { MapTarget, RouteLine, SearchPin } from "./map-types";
import { OVERLAY_VIEWS } from "./overlay-views";
import RouteLayer from "./route-layer.svelte";
import { useMapTheme } from "./use-map-theme.svelte";

// Patches every grid layer on the map, so it runs once here.
installTilePrune();

// px from the viewport edge, as for a dragged endpoint.
const SEARCH_PIN_AUTOPAN: [number, number] = [80, 80];

const draftIcon = L.divIcon({
  className: "",
  html: '<div class="scenic-draft-pin"><div class="scenic-draft-pin-ring"></div><div class="scenic-draft-pin-dot"></div></div>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

const PIN_TOOLTIP: L.TooltipOptions = {
  direction: "top",
  offset: [0, -8],
  opacity: 1,
  className: "scenic-tooltip",
};

function summarizePin(pin: Pin): string {
  const note = pin.text.trim();
  if (note) {
    return note;
  }
  return pin.address;
}
</script>

<script lang="ts">
interface MapViewProps {
  city: City;
  pins: Pin[];
  draft: PinDraft | null;
  target: MapTarget | null;
  userLocation: { lat: number; lng: number } | null;
  following: boolean;
  activeOverlays: ReadonlySet<OverlayId>;
  routeResult: RouteResult | null;
  routeGraph: RoutingGraph | null;
  routeLines: readonly RouteLine[] | undefined;
  onSelectLine: ((index: number) => void) | undefined;
  onHoverLine: ((index: number | null) => void) | undefined;
  routeDest: { lat: number; lng: number } | null;
  routeStart: { lat: number; lng: number } | null;
  searchPin: SearchPin | null;
  // null keeps the app's green.
  markerColor: string | null;
  // A field has armed the next tap to set its point; nothing else makes a tap place anything.
  picking: boolean;
  dragging: boolean;
  initialCamera: Camera | null;
  preframedDest: { lat: number; lng: number } | null;
  routedTo: { lat: number; lng: number } | null;
  // The visible bounds pick the active city when only one is on screen.
  onCamera: (camera: Camera, view: CityBounds) => void;
  onBasemapLost: (lost: boolean) => void;
  onMapPick: (lat: number, lng: number) => void;
  onDisengageFollow: () => void;
  onEndpointDragMove: (
    which: "start" | "dest",
    lat: number,
    lng: number,
  ) => void;
  onEndpointDrag: (which: "start" | "dest", lat: number, lng: number) => void;
  // The same as tapping the map elsewhere: it renames the place.
  onSearchPinDrag: (lat: number, lng: number) => void;
  onPinSelect: (pin: Pin) => void;
}

const {
  onBasemapLost,
  city,
  pins,
  draft,
  target,
  userLocation,
  following,
  activeOverlays,
  routeResult,
  routeGraph,
  routeLines,
  onSelectLine,
  onHoverLine,
  routeDest,
  routeStart,
  searchPin,
  onSearchPinDrag,
  markerColor,
  picking,
  dragging,
  initialCamera,
  preframedDest,
  routedTo,
  onCamera,
  onMapPick,
  onDisengageFollow,
  onEndpointDragMove,
  onEndpointDrag,
  onPinSelect,
}: MapViewProps = $props();
// Rebuilt on a theme flip, since an existing icon keeps its old gradient.
const theme = useMapTheme();
const searchMarker = $derived(searchIcon(theme.current, markerColor));

// Out of the markup, where the formatter mangles a multi-line object.
const searchPinHandlers: L.LeafletEventHandlerFnMap = {
  dragend: (event) => {
    const { lat, lng } = event.target.getLatLng();
    onSearchPinDrag(lat, lng);
  },
};

let container: HTMLDivElement;
let map = $state.raw<L.Map | null>(null);
setMap(() => map);

// Built once, on the city it mounts with; the view is set before any layer mounts.
onMount(() => {
  const created = new L.Map(container, {
    zoomControl: false,
    bounceAtZoomLimits: false,
    attributionControl: false,
  });
  created.setView([city.center.lat, city.center.lng], CITY_ZOOM);
  // The full source list lives in About; the corner carries only the basemap credit.
  const attribution = new L.Control.Attribution({ prefix: false });
  attribution.addTo(created);
  map = created;
  return () => {
    created.remove();
    attribution.remove();
  };
});
</script>

<div class="h-dvh w-full" bind:this={container}></div>
{#if map}
  <Basemap onLost={onBasemapLost} />
  {#each OVERLAYS.filter((overlay) =>
    activeOverlays.has(overlay.id),
  ) as overlay (overlay.id)}
    {#each OVERLAY_VIEWS[overlay.id].layers as view}
      <LazyLayer overlay={overlay.id} {view} />
    {/each}
  {/each}
  <CameraWatcher initial={initialCamera} {onCamera} />
  <MapController {target} {following} {userLocation} {onDisengageFollow} />
  <RouteLayer
    result={routeResult}
    graph={routeGraph}
    {markerColor}
    lines={routeLines}
    {onSelectLine}
    {onHoverLine}
    dest={routeDest}
    start={routeStart}
    {dragging}
    {preframedDest}
    {routedTo}
    {onDisengageFollow}
    {onEndpointDragMove}
    {onEndpointDrag}
  />
  <PickCursor {picking} />
  {#if picking}
    <PickCatcher {onMapPick} />
  {/if}
  <DoubleTapZoom {following} {picking} />
  {#each pins as pin (pin.id)}
    <Marker
      position={[pin.lat, pin.lng]}
      icon={savedIcon}
      eventHandlers={{ click: () => onPinSelect(pin) }}
      tooltip={summarizePin(pin)}
      tooltipOptions={PIN_TOOLTIP}
    />
  {/each}
  {#if userLocation}
    <Marker position={[userLocation.lat, userLocation.lng]} icon={userIcon} />
  {/if}
  {#if draft}
    <Marker position={[draft.lat, draft.lng]} icon={draftIcon} />
  {/if}
  {#if searchPin}
    <!-- Leaflet stops a draggable marker's clicks; bubbling hands an armed pick tap to the map. -->
    <Marker
      position={[searchPin.lat, searchPin.lng]}
      icon={searchMarker}
      draggable
      bubblingMouseEvents
      autoPan
      autoPanPadding={SEARCH_PIN_AUTOPAN}
      eventHandlers={searchPinHandlers}
    />
  {/if}
{/if}

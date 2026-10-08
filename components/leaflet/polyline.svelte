<script lang="ts">
import L from "leaflet";
import { onMount, untrack } from "svelte";
import { getMap } from "../map-context";

// A Leaflet polyline.
interface Props {
  positions: L.LatLngExpression[];
  interactive?: boolean;
  pathOptions?: L.PathOptions;
  // Only the events named at mount are listened to; each calls the current handler.
  eventHandlers?: L.LeafletEventHandlerFnMap;
}

type Handlers = Record<string, ((event: L.LeafletEvent) => void) | undefined>;

const { positions, pathOptions, eventHandlers, ...fixed }: Props = $props();
const map = getMap();

// Leaflet reads the `fixed` options at construction only; an omitted one keeps its default.
const polyline = untrack(() => new L.Polyline(positions, { ...fixed }));

for (const type of Object.keys(untrack(() => eventHandlers) ?? {})) {
  polyline.on(type, (event) => {
    (eventHandlers as Handlers | undefined)?.[type]?.(event);
  });
}

$effect(() => {
  polyline.setLatLngs(positions);
});

$effect(() => {
  polyline.setStyle(pathOptions ?? {});
});

onMount(() => {
  map.addLayer(polyline);
  return () => {
    map.removeLayer(polyline);
  };
});
</script>

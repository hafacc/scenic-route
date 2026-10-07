<script lang="ts">
import L from "leaflet";
import { onMount, untrack } from "svelte";
import { getMap } from "../map-context";

// A Leaflet marker, with its tooltip as the `tooltip` text.
interface Props {
  position: L.LatLngExpression;
  icon: L.Icon | L.DivIcon;
  zIndexOffset?: number;
  interactive?: boolean;
  draggable?: boolean;
  bubblingMouseEvents?: boolean;
  autoPan?: boolean;
  autoPanPadding?: L.PointExpression;
  // Only the events named at mount are listened to; each calls the current handler.
  eventHandlers?: L.LeafletEventHandlerFnMap;
  tooltip?: string;
  // Read once, when the tooltip is bound.
  tooltipOptions?: L.TooltipOptions;
}

type Handlers = Record<string, ((event: L.LeafletEvent) => void) | undefined>;

const {
  position,
  icon,
  zIndexOffset,
  draggable,
  eventHandlers,
  tooltip,
  tooltipOptions,
  ...fixed
}: Props = $props();
const map = getMap();

// Leaflet reads the `fixed` options at construction only; an omitted one keeps its default.
const marker = untrack(() => new L.Marker(position, { ...fixed, icon }));
// A text node, since Leaflet would parse a string as HTML.
const label = document.createTextNode("");

for (const type of Object.keys(untrack(() => eventHandlers) ?? {})) {
  marker.on(type, (event) => {
    (eventHandlers as Handlers | undefined)?.[type]?.(event);
  });
}

// One effect per setter, so a marker being dragged is moved only by a new position.
let placed = marker.getLatLng();
$effect(() => {
  const next = L.latLng(position);
  // The same place in a new array (a relabel) would pull a marker mid-drag back to its drop.
  if (!next.equals(placed, 0)) {
    placed = next;
    marker.setLatLng(next);
  }
});

$effect(() => {
  marker.setIcon(icon);
});

$effect(() => {
  marker.setZIndexOffset(zIndexOffset ?? 0);
});

$effect(() => {
  if (tooltip === undefined) {
    marker.unbindTooltip();
    return;
  }
  label.data = tooltip;
  if (!marker.getTooltip()) {
    marker.bindTooltip(
      label as unknown as HTMLElement,
      untrack(() => tooltipOptions),
    );
  } else if (marker.isTooltipOpen()) {
    // Laid out again, since the new text has another width.
    marker.getTooltip()?.update();
  }
});

onMount(() => {
  map.addLayer(marker);
  return () => {
    map.removeLayer(marker);
  };
});

// Declared after the marker joins the map, which is when Leaflet gives it a drag handler.
$effect(() => {
  if (draggable) {
    marker.dragging?.enable();
  } else {
    marker.dragging?.disable();
  }
});
</script>

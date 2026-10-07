<script lang="ts">
import L from "leaflet";
import type { OverlayId } from "../src/overlays/registry";
import { watchLayerStatus } from "../src/overlays/status";
import type { ThemeName } from "../src/theme/palette";
import WorkerTileLayer from "../src/tiles/layer";
import { KEEP_BUFFER } from "../src/tiles/raster";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";
import { getMap } from "./map-context";

const PANE_NAME = "scenic-lines";
const PANE_Z_INDEX = 290; // below POIs (300), above canopy
const MIN_ZOOM = 10;
const MAX_ZOOM = 20;

interface Props {
  overlay: OverlayId;
  dir: string; // blob at <dir>/<city>.bin
  format: "hway" | "ferr";
  color: Record<ThemeName, string>; // CSS stroke color, per theme
}

const { overlay, dir, format, color }: Props = $props();
const map = getMap();
const current = useCity();
const cityId = $derived(current().id);

$effect(() => {
  const id = cityId;
  // Read here, so a tile request made later carries plain values.
  const paint = { format, color };
  if (!map.getPane(PANE_NAME)) {
    const pane = map.createPane(PANE_NAME);
    pane.style.zIndex = String(PANE_Z_INDEX);
  }
  const layers = manifest.cities
    .filter((entry) => entry.id === id)
    .map((city) => {
      const { south, west, north, east } = city.bounds;
      // Relative to the page, which sits at the site root.
      const url = `${dir}/${city.id}.bin`;
      return new WorkerTileLayer(() => ({ kind: "lines", url, ...paint }), {
        pane: PANE_NAME,
        bounds: L.latLngBounds([south, west], [north, east]),
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        keepBuffer: KEEP_BUFFER,
      });
    });
  // Attached before the layers go on the map, or the first load cycle's `loading` is missed.
  const watching = layers.map((layer) => watchLayerStatus(layer, overlay));
  for (const layer of layers) {
    layer.addTo(map);
  }
  return () => {
    for (const detach of watching) {
      detach();
    }
    for (const layer of layers) {
      layer.remove();
    }
  };
});
</script>

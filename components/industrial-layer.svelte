<script lang="ts">
import L from "leaflet";
import { watchLayerStatus } from "../src/overlays/status";
import WorkerTileLayer from "../src/tiles/layer";
import { KEEP_BUFFER } from "../src/tiles/raster";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";
import { getMap } from "./map-context";

// Its own pane under the lines, since an areal wash would hide a line drawn beneath it.

const PANE_NAME = "scenic-industrial";
const PANE_Z_INDEX = 270; // under shade (275), commercial (280)
const MIN_ZOOM = 11;
const MAX_ZOOM = 20;

const map = getMap();
const current = useCity();
const cityId = $derived(current().id);

$effect(() => {
  const id = cityId;
  if (!map.getPane(PANE_NAME)) {
    const pane = map.createPane(PANE_NAME);
    pane.style.zIndex = String(PANE_Z_INDEX);
  }
  const layers = manifest.cities
    .filter((entry) => entry.id === id)
    .map((city) => {
      const { south, west, north, east } = city.bounds;
      // Relative to the page, which sits at the site root.
      const url = `industrial/${city.id}.bin`;
      return new WorkerTileLayer(() => ({ kind: "industrial", url }), {
        pane: PANE_NAME,
        bounds: L.latLngBounds([south, west], [north, east]),
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        keepBuffer: KEEP_BUFFER,
      });
    });
  // Attached before the layers go on the map, or the first load cycle's `loading` is missed.
  const watching = layers.map((layer) => watchLayerStatus(layer, "industrial"));
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

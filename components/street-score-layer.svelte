<script lang="ts">
import L from "leaflet";
import { watchLayerStatus } from "../src/overlays/status";
import WorkerTileLayer from "../src/tiles/layer";
import { KEEP_BUFFER } from "../src/tiles/raster";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";
import { getMap } from "./map-context";

// Below this zoom the lines are hairlines and would fetch every chunk in the city.
const MIN_ZOOM = 13;
const MAX_ZOOM = 20;

// Above the fill (zIndex 2) in the tile pane, since it reads the same canopy ramp.
const Z_INDEX = 3;

const map = getMap();
const current = useCity();
const cityId = $derived(current().id);

$effect(() => {
  const id = cityId;
  const layers = manifest.cities
    .filter((entry) => entry.id === id)
    .map((city) => {
      const { south, west, north, east } = city.bounds;
      return new WorkerTileLayer(() => ({ kind: "street-score" }), {
        bounds: L.latLngBounds([south, west], [north, east]),
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        zIndex: Z_INDEX,
        keepBuffer: KEEP_BUFFER,
      });
    });
  // Attached before the layers go on the map, or the first load cycle's `loading` is missed.
  const watching = layers.map((layer) => watchLayerStatus(layer, "canopy"));
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

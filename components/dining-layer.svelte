<script lang="ts">
import L from "leaflet";
import { watchLayerStatus } from "../src/overlays/status";
import WorkerTileLayer from "../src/tiles/layer";
import { KEEP_BUFFER } from "../src/tiles/raster";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";
import { getMap } from "./map-context";

const PANE_NAME = "commercial-blocks";
const PANE_Z_INDEX = 280; // over canopy, under lines (290), POIs (300)

// The raster overview stays legible from z10; below that the city is a speck.
const MIN_ZOOM = 10;
const MAX_ZOOM = 20;

const map = getMap();
const current = useCity();
const cityId = $derived(current().id);

$effect(() => {
  const id = cityId;
  // The tile pane has one z-index, so sitting between washes and dots needs a pane.
  if (!map.getPane(PANE_NAME)) {
    const pane = map.createPane(PANE_NAME);
    pane.style.zIndex = String(PANE_Z_INDEX);
  }

  const layers = manifest.cities
    .filter((entry) => entry.id === id)
    .map((city) => {
      const { south, west, north, east } = city.bounds;
      return new WorkerTileLayer(() => ({ kind: "commercial" }), {
        pane: PANE_NAME,
        bounds: L.latLngBounds([south, west], [north, east]),
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        keepBuffer: KEEP_BUFFER,
      });
    });
  // Attached before the layers go on the map, or the first load cycle's `loading` is missed.
  const watching = layers.map((layer) => watchLayerStatus(layer, "commercial"));
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

<script module lang="ts">
import L from "leaflet";
import { untrack } from "svelte";
import { WALK_COLOR } from "../src/overlays/colors";
import { loadLayerData } from "../src/overlays/status";
import { familiarField } from "../src/routing/familiar";
import { loadGraph, type RoutingGraph } from "../src/routing/graph";
import WorkerTileLayer from "../src/tiles/layer";
import { NO_STROKES } from "../src/tiles/path-strokes";
import { KEEP_BUFFER } from "../src/tiles/raster";
import StrokeGrid, { readyStrokes } from "../src/tiles/stroke-grid";
import {
  RASTER_MAX_ZOOM,
  RASTER_MIN_ZOOM,
  STROKE_MIN_ZOOM,
} from "../src/tiles/tree-cover";
import { heatPoints, heatVersion } from "../src/walks/heat";
import { walks } from "../src/walks/history";
import { WALK_BAND_OPACITY, walkStrokes } from "../src/walks/strokes";
import { useCity } from "./city-context";
import { getMap } from "./map-context";
import { sendWalkHeat } from "./sw-messages";

const PANE_NAME = "walks";
const PANE_Z_INDEX = 286; // over the sheds (285), under the lines (290)
const MAX_ZOOM = 20;
// A walk adds a street a minute at most, so a burst of them is redrawn once.
const SETTLE_MS = 2000;
// Drawn by the service worker from this device's history (src/sw/walks.ts); never fetched from a server.
const TILE_URL = "__walks/heat/{city}/{version}/{z}/{x}/{y}.png";
</script>

<script lang="ts">
const map = getMap();
const current = useCity();
const cityId = $derived(current().id);

$effect(() => {
  const id = cityId;
  const { bounds } = untrack(current);
  if (!map.getPane(PANE_NAME)) {
    const pane = map.createPane(PANE_NAME);
    pane.style.zIndex = String(PANE_Z_INDEX);
  }
  const cityBounds = L.latLngBounds(
    [bounds.south, bounds.west],
    [bounds.north, bounds.east],
  );
  // One grid per band, faded as a layer, so a stronger street is the same indigo laid on thicker.
  const grids = WALK_BAND_OPACITY.map((opacity) =>
    new StrokeGrid(WALK_COLOR, {
      pane: PANE_NAME,
      bounds: cityBounds,
      minZoom: STROKE_MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      keepBuffer: KEEP_BUFFER,
      opacity,
    }).addTo(map),
  );
  // No points are held for this version, so until the worker has them the tiles read as empty ground.
  let version = "0";
  const pyramid = new WorkerTileLayer(
    () => ({
      kind: "tree-cover",
      url: TILE_URL.replace("{city}", id).replace("{version}", version),
      maxNativeZoom: RASTER_MAX_ZOOM,
      color: WALK_COLOR,
    }),
    {
      pane: PANE_NAME,
      bounds: cityBounds,
      minNativeZoom: RASTER_MIN_ZOOM,
      maxZoom: RASTER_MAX_ZOOM,
      keepBuffer: KEEP_BUFFER,
    },
  ).addTo(map);

  let graph: RoutingGraph | null = null;
  let live = true;
  const draw = (): void => {
    if (!graph) {
      return;
    }
    const field = familiarField(graph, walks.records(id), Date.now());
    const bands = field ? walkStrokes(graph, field) : [];
    grids.forEach((grid, band) => {
      grid.setSource(readyStrokes(bands[band] ?? NO_STROKES));
    });
    const points = field ? heatPoints(graph, field) : new Float64Array(0);
    const next = heatVersion(points);
    void sendWalkHeat(id, next, points).then(() => {
      if (live && next !== version) {
        version = next;
        pyramid.redraw();
      }
    });
  };

  const unload = loadLayerData(
    "walks",
    () => loadGraph(id),
    (loaded) => {
      graph = loaded;
      draw();
    },
  );
  let settle = 0;
  const unsubscribe = walks.subscribe(() => {
    window.clearTimeout(settle);
    settle = window.setTimeout(draw, SETTLE_MS);
  });

  return () => {
    live = false;
    window.clearTimeout(settle);
    unsubscribe();
    unload();
    pyramid.remove();
    for (const grid of grids) {
      grid.remove();
    }
  };
});
</script>

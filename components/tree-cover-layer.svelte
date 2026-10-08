<script module lang="ts">
import L from "leaflet";
import { untrack } from "svelte";
import { TREE_COVER_COLOR } from "../src/overlays/colors";
import { treeCoverOpacity } from "../src/overlays/shelter";
import { loadLayerData, watchLayerStatus } from "../src/overlays/status";
import { getResolvedDate, subscribeRouteTime } from "../src/route-time/store";
import {
  forgetCanopyRuns,
  loadCanopyRuns,
  sameGraph,
} from "../src/routing/canopy-runs";
import { loadGraph } from "../src/routing/graph";
import { type CanopyStrokes, canopyStrokes } from "../src/tiles/canopy-strokes";
import WorkerTileLayer from "../src/tiles/layer";
import { KEEP_BUFFER } from "../src/tiles/raster";
import StrokeGrid from "../src/tiles/stroke-grid";
import {
  type CoverForm,
  RASTER_MAX_ZOOM,
  RASTER_MIN_ZOOM,
  STROKE_MIN_ZOOM,
  shownForm,
  treeCoverForm,
} from "../src/tiles/tree-cover";
import { useCity } from "./city-context";
import { getMap } from "./map-context";

const PANE_NAME = "tree-cover";
const PANE_Z_INDEX = 284; // under the sheds (285), whose deck is the cover where both stand
const MAX_ZOOM = 20;
// Below the strokes' zoom a block's stretches are a pixel or two apart, so the tiler's pyramid stands in.
const TILE_URL = "tiles/tree-cover/{city}/{z}/{x}/{y}.webp";
</script>

<script lang="ts">
const map = getMap();
const current = useCity();
const cityId = $derived(current().id);

$effect(() => {
  const id = cityId;
  const city = untrack(current);
  const { bounds } = city;
  if (!map.getPane(PANE_NAME)) {
    const pane = map.createPane(PANE_NAME);
    pane.style.zIndex = String(PANE_Z_INDEX);
  }
  // Season moves the opacity alone: the crowns stand where they stand all year.
  const fade = (): number => treeCoverOpacity(city, getResolvedDate());
  const grid = new StrokeGrid(TREE_COVER_COLOR, {
    pane: PANE_NAME,
    bounds: L.latLngBounds(
      [bounds.south, bounds.west],
      [bounds.north, bounds.east],
    ),
    minZoom: STROKE_MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    keepBuffer: KEEP_BUFFER,
    opacity: fade(),
  });
  grid.addTo(map);
  // The same layer further out: one opacity, one legend row, one pane.
  const pyramid = new WorkerTileLayer(
    () => ({
      kind: "tree-cover",
      url: TILE_URL.replace("{city}", id),
      maxNativeZoom: RASTER_MAX_ZOOM,
      color: TREE_COVER_COLOR,
    }),
    {
      pane: PANE_NAME,
      bounds: L.latLngBounds(
        [bounds.south, bounds.west],
        [bounds.north, bounds.east],
      ),
      minNativeZoom: RASTER_MIN_ZOOM,
      // Past its own levels the worker magnifies it, so it can stand in while the strokes are cut.
      maxZoom: MAX_ZOOM,
      keepBuffer: KEEP_BUFFER,
      opacity: fade(),
    },
  );
  // Attached before the layer goes on the map, or the first load cycle's `loading` is missed.
  const unwatch = watchLayerStatus(pyramid, "treecover");
  pyramid.addTo(map);

  // One form at a time: the pyramid until the strokes called for have painted, then the strokes.
  let shown: CoverForm = "raster";
  let painted = false;
  const show = (): void => {
    const zoom = map.getZoom();
    // Below their zoom the strokes' tiles are dropped, so coming back in starts unpainted.
    if (treeCoverForm(zoom) === "raster") {
      painted = false;
    }
    shown = shownForm(shown, zoom, painted);
    const strokes = grid.getContainer();
    const raster = pyramid.getContainer();
    if (strokes && raster) {
      strokes.style.visibility = shown === "strokes" ? "visible" : "hidden";
      raster.style.visibility = shown === "raster" ? "visible" : "hidden";
    }
  };
  const loading = (): void => {
    painted = false;
  };
  const loaded = (): void => {
    painted = true;
    show();
  };
  grid.on("loading", loading);
  grid.on("load", loaded);
  // `zoom` fires through a pinch and `zoomend` after an animated one.
  map.on("zoom zoomend", show);
  show();

  // Runs for another deploy's graph are no cover for this one: forgotten, so the next ask fetches again.
  const cut = async (): Promise<CanopyStrokes> => {
    const [graph, runs] = await Promise.all([
      loadGraph(id),
      loadCanopyRuns(id),
    ]);
    if (!sameGraph(graph, runs)) {
      forgetCanopyRuns(id);
      throw new Error("the canopy runs were sampled along another graph");
    }
    return canopyStrokes(graph, runs);
  };
  const unload = loadLayerData("treecover", cut, (strokes) => {
    grid.setSource(strokes);
  });
  // The store also ticks with the clock and the hour slider; an unmoved opacity costs nothing to set.
  const unsubscribe = subscribeRouteTime(() => {
    grid.setOpacity(fade());
    pyramid.setOpacity(fade());
  });

  return () => {
    unload();
    unsubscribe();
    map.off("zoom zoomend", show);
    grid.off("loading", loading);
    grid.off("load", loaded);
    unwatch();
    pyramid.remove();
    grid.remove();
  };
});
</script>

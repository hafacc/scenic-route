<script module lang="ts">
import L from "leaflet";
import { untrack } from "svelte";
import { SHED_COLOR } from "../src/overlays/colors";
import { SHED_OPACITY } from "../src/overlays/shelter";
import { loadLayerData } from "../src/overlays/status";
import { getResolvedDate, subscribeRouteTime } from "../src/route-time/store";
import { loadGraph, type RoutingGraph } from "../src/routing/graph";
import { loadSheds, type ShedHistory, shedDay } from "../src/routing/sheds";
import { KEEP_BUFFER } from "../src/tiles/raster";
import { shedStrokes } from "../src/tiles/shed-strokes";
import StrokeGrid, { readyStrokes } from "../src/tiles/stroke-grid";
import { useCity } from "./city-context";
import { getMap } from "./map-context";

const PANE_NAME = "sheds";
const PANE_Z_INDEX = 285; // above commercial (280), below lines (290)
const MIN_ZOOM = 11; // further out a shed is a tenth of a pixel wide and Manhattan a smear
const MAX_ZOOM = 20;
</script>

<script lang="ts">
const map = getMap();
const current = useCity();
const cityId = $derived(current().id);

$effect(() => {
  const id = cityId;
  const { bounds } = untrack(current);
  // A pane of its own, so the decks sit over the washes rather than among them.
  if (!map.getPane(PANE_NAME)) {
    const pane = map.createPane(PANE_NAME);
    pane.style.zIndex = String(PANE_Z_INDEX);
  }
  // A deck keeps all the rain off, so its line is drawn at full strength.
  const grid = new StrokeGrid(SHED_COLOR, {
    pane: PANE_NAME,
    bounds: L.latLngBounds(
      [bounds.south, bounds.west],
      [bounds.north, bounds.east],
    ),
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    keepBuffer: KEEP_BUFFER,
    opacity: SHED_OPACITY,
  });
  grid.addTo(map);

  let graph: RoutingGraph | null = null;
  let history: ShedHistory | null = null;
  let drawnDay = Number.NaN;
  let live = true;

  // The store also ticks with the clock and the hour slider, so the rebuild is gated on the day.
  const apply = (): void => {
    if (!graph || !history) {
      return;
    }
    const day = shedDay(getResolvedDate());
    if (day === drawnDay) {
      return;
    }
    drawnDay = day;
    // A date being typed passes through days nobody means; each is dropped as the next arrives.
    void shedStrokes(graph, history, day, () => live && drawnDay === day).then(
      (strokes) => {
        if (strokes) {
          grid.setSource(readyStrokes(strokes));
        }
      },
    );
  };

  const unload = loadLayerData(
    "scaffolding",
    () => Promise.all([loadGraph(id), loadSheds(id)]),
    ([loaded, sheds]) => {
      graph = loaded;
      history = sheds;
      apply();
    },
  );
  const unsubscribe = subscribeRouteTime(apply);

  return () => {
    live = false;
    unload();
    unsubscribe();
    grid.remove();
  };
});
</script>

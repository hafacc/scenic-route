"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { SHED_COLOR } from "../src/overlays/colors";
import { getResolvedDate, subscribeRouteTime } from "../src/route-time/store";
import { loadGraph, type RoutingGraph } from "../src/routing/graph";
import { loadSheds, type ShedHistory, shedDay } from "../src/routing/sheds";
import { currentTheme } from "../src/theme/current";
import CanvasGrid from "../src/tiles/canvas-grid";
import { KEEP_BUFFER, tileRatio } from "../src/tiles/raster";
import { repeatable } from "../src/tiles/repaint";
import {
  forEachDeckIn,
  type ShedDecks,
  shedDecks,
  traceDeck,
} from "../src/tiles/shed-decks";
import { useCity } from "./city-context";

// Main thread, not the tile worker: the graph and artifact are already here.

const PANE_NAME = "sheds";
const PANE_Z_INDEX = 285; // above commercial (280), below lines (290)
const MIN_ZOOM = 10;
const MAX_ZOOM = 20;
const TILE_SIZE = 256;

const MIN_WIDTH = 1.5; // px
const SHED_ALPHA = 0.75;

// Zoom 0 is the whole world in 256 px, which a double resolves far past z20.
const REFERENCE_ZOOM = 0;

class ShedGrid extends CanvasGrid {
  private decks: ShedDecks | null = null;

  setDecks(decks: ShedDecks): void {
    this.decks = decks;
    this.redraw();
  }

  createTile(coords: L.Coords): HTMLCanvasElement {
    const tile = document.createElement("canvas");
    const ratio = tileRatio();
    tile.width = TILE_SIZE * ratio;
    tile.height = TILE_SIZE * ratio;
    const context = tile.getContext("2d");
    const decks = this.decks;
    if (context && decks) {
      this.watch(
        tile,
        repeatable(context, ratio, (target) => {
          this.draw(target, decks, coords);
        }),
      );
    }
    return tile;
  }

  // One Path2D per tile: per-deck fills are costly and would darken overlapping sheds twice.
  private draw(
    context: CanvasRenderingContext2D,
    decks: ShedDecks,
    coords: L.Coords,
  ): void {
    const scale = 2 ** (coords.z - REFERENCE_ZOOM);
    // Widened by half the minimum width, so a deck just outside still paints its sliver.
    const margin = MIN_WIDTH / 2 / scale;
    const left = (coords.x * TILE_SIZE) / scale - margin;
    const top = (coords.y * TILE_SIZE) / scale - margin;
    const right = left + TILE_SIZE / scale + 2 * margin;
    const bottom = top + TILE_SIZE / scale + 2 * margin;
    const originX = coords.x * TILE_SIZE;
    const originY = coords.y * TILE_SIZE;

    const path = new Path2D();
    forEachDeckIn(decks, left, top, right, bottom, (deck) => {
      traceDeck(path, decks, deck, scale, originX, originY, MIN_WIDTH);
    });

    context.globalAlpha = SHED_ALPHA;
    context.fillStyle = SHED_COLOR[currentTheme()];
    context.fill(path);
  }
}

export default function ShedLayer() {
  const map = useMap();
  const city = useCity();

  useEffect(() => {
    // A pane of its own, so the decks sit over the washes rather than among them.
    if (!map.getPane(PANE_NAME)) {
      const pane = map.createPane(PANE_NAME);
      pane.style.zIndex = String(PANE_Z_INDEX);
    }
    const grid = new ShedGrid({
      pane: PANE_NAME,
      bounds: L.latLngBounds(
        [city.bounds.south, city.bounds.west],
        [city.bounds.north, city.bounds.east],
      ),
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      keepBuffer: KEEP_BUFFER,
    });
    grid.addTo(map);

    let canceled = false;
    let graph: RoutingGraph | null = null;
    let history: ShedHistory | null = null;
    let drawnDay = Number.NaN;

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
      grid.setDecks(shedDecks(graph, history, day));
    };

    Promise.all([loadGraph(city.id), loadSheds()]).then(
      ([loaded, sheds]) => {
        if (!canceled) {
          graph = loaded;
          history = sheds;
          apply();
        }
      },
      () => {},
    );
    const unsubscribe = subscribeRouteTime(apply);

    return () => {
      canceled = true;
      unsubscribe();
      grid.remove();
    };
  }, [map, city]);

  return null;
}

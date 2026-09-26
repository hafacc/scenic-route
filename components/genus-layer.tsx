"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { watchLayerStatus } from "../src/overlays/status";
import WorkerTileLayer from "../src/tiles/layer";
import { KEEP_BUFFER } from "../src/tiles/raster";
import {
  getEnabledGenera,
  subscribeGenusFilter,
} from "../src/tree-cover/genus-filter";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";
import TreeDotsLayer from "./tree-dots-layer";

// The genus wash, drawn by the tile worker (src/tiles/genus.ts); the live dots join it from z15.

// Relative, so they pick up the basePath the deploy injects.
const TILE_URL = "tiles/genus-field/{layer}/{z}/{x}/{y}.webp";
const CANOPY_URL = "tiles/canopy/{z}/{x}/{y}.webp";
const MIN_NATIVE_ZOOM = 9; // coarsest baked level of both pyramids
const MAX_NATIVE_ZOOM = 14; // the genus field's finest; deeper tiles are magnified
const CANOPY_MAX_NATIVE_ZOOM = 15; // the canopy's
const MAX_ZOOM = 20;
const DOTS_ZOOM = 15;

// Where the canopy sits in the tile pane, under the dots' own pane.
const Z_INDEX = 2;

// The live dots take over from z15, so the wash steps back a little behind them.
function washOpacity(zoom: number): number {
  return zoom < DOTS_ZOOM ? 1 : 0.85;
}

export default function GenusLayer() {
  const map = useMap();
  const active = useCity();

  useEffect(() => {
    const layers = manifest.cities
      .filter((entry) => entry.id === active.id)
      // The wash takes its shape from the canopy, so a city needs both.
      .filter((city) => city.field.genus && city.field.canopy)
      .map((city) => {
        const { south, west, north, east } = city.bounds;
        return new WorkerTileLayer(
          // The selection rides on each tile request, so a toggle's repaint picks up the new one.
          () => ({
            kind: "genus",
            url: TILE_URL,
            canopyUrl: CANOPY_URL,
            maxNativeZoom: MAX_NATIVE_ZOOM,
            canopyMaxNativeZoom: CANOPY_MAX_NATIVE_ZOOM,
            enabled: [...getEnabledGenera()],
          }),
          {
            bounds: L.latLngBounds([south, west], [north, east]),
            // No maxNativeZoom, or Leaflet stretches tiles instead of the worker magnifying them.
            minNativeZoom: MIN_NATIVE_ZOOM,
            maxZoom: MAX_ZOOM,
            zIndex: Z_INDEX,
            keepBuffer: KEEP_BUFFER,
            opacity: washOpacity(map.getZoom()),
          },
        );
      });
    // Attached before the layers go on the map, or the first load cycle's `loading` is missed.
    const watching = layers.map((layer) => watchLayerStatus(layer, "genus"));
    for (const layer of layers) {
      layer.addTo(map);
    }

    // On the animation's target zoom too, so the step lands with the zoom rather than after it.
    const fadeTo = (zoom: number): void => {
      for (const layer of layers) {
        layer.setOpacity(washOpacity(zoom));
      }
    };
    const onZoomAnim = (event: L.ZoomAnimEvent): void => fadeTo(event.zoom);
    const onZoom = (): void => fadeTo(map.getZoom());
    map.on("zoomanim", onZoomAnim);
    map.on("zoom", onZoom);

    const unsubscribe = subscribeGenusFilter(() => {
      for (const layer of layers) {
        layer.repaint();
      }
    });

    return () => {
      unsubscribe();
      map.off("zoomanim", onZoomAnim);
      map.off("zoom", onZoom);
      for (const detach of watching) {
        detach();
      }
      for (const layer of layers) {
        layer.remove();
      }
    };
  }, [map, active.id]);

  return <TreeDotsLayer />;
}

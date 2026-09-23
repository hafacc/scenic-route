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

// Below MIN_ZOOM raster tiles carry the overlay; above, they would blur, so each tree is a disc.

const MIN_ZOOM = 15;
const MAX_ZOOM = 20;
const PANE_NAME = "genus";
const PANE_Z_INDEX = 250;

export default function TreeDotsLayer() {
  const map = useMap();
  const active = useCity();

  useEffect(() => {
    // The raster layer's pane, so the handoff happens at the same depth; create it if missing.
    if (!map.getPane(PANE_NAME)) {
      const pane = map.createPane(PANE_NAME);
      pane.style.zIndex = String(PANE_Z_INDEX);
    }

    const layers = manifest.cities
      .filter((entry) => entry.id === active.id)
      .filter((city) => city.field.genus)
      .map((city) => {
        const { south, west, north, east } = city.bounds;
        const file = city.field.trees.file;
        return new WorkerTileLayer(
          // The selection rides on each tile request, so a toggle's redraw picks up the new one.
          () => ({ kind: "tree-dots", file, enabled: [...getEnabledGenera()] }),
          {
            pane: PANE_NAME,
            bounds: L.latLngBounds([south, west], [north, east]),
            minZoom: MIN_ZOOM,
            maxZoom: MAX_ZOOM,
            keepBuffer: KEEP_BUFFER,
          },
        );
      });
    // Attached before the layers go on the map, or the first load cycle's `loading` is missed.
    const watching = layers.map((layer) => watchLayerStatus(layer, "genus"));
    for (const layer of layers) {
      layer.addTo(map);
    }

    const unsubscribe = subscribeGenusFilter(() => {
      for (const layer of layers) {
        layer.redraw();
      }
    });

    return () => {
      unsubscribe();
      for (const detach of watching) {
        detach();
      }
      for (const layer of layers) {
        layer.remove();
      }
    };
  }, [map, active.id]);

  return null;
}

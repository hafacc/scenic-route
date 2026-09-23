"use client";

import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { watchLayerStatus } from "../src/overlays/status";
import WorkerTileLayer from "../src/tiles/layer";
import { KEEP_BUFFER } from "../src/tiles/raster";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";

// No `bounds`: clipping to the city would cut lines like BART's Transbay Tube mid-bay.

const PANE_NAME = "scenic-subway";
const PANE_Z_INDEX = 295; // above lines (290), below POIs (300)
const MIN_ZOOM = 10;
const MAX_ZOOM = 20;

export default function SubwayLayer() {
  const map = useMap();
  const active = useCity();

  useEffect(() => {
    if (!map.getPane(PANE_NAME)) {
      const pane = map.createPane(PANE_NAME);
      pane.style.zIndex = String(PANE_Z_INDEX);
    }
    const layers = manifest.cities
      .filter((entry) => entry.id === active.id)
      .map((city) => {
        // Relative, so it picks up the basePath the deploy injects.
        const url = `subway/${city.id}.bin`;
        return new WorkerTileLayer(() => ({ kind: "subway", url }), {
          pane: PANE_NAME,
          minZoom: MIN_ZOOM,
          maxZoom: MAX_ZOOM,
          keepBuffer: KEEP_BUFFER,
        });
      });
    // Attached before the layers go on the map, or the first load cycle's `loading` is missed.
    const watching = layers.map((layer) => watchLayerStatus(layer, "subway"));
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
  }, [map, active.id]);

  return null;
}

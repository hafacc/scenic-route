"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import type { OverlayId } from "../src/overlays/registry";
import { watchLayerStatus } from "../src/overlays/status";
import type { ThemeName } from "../src/theme/palette";
import WorkerTileLayer from "../src/tiles/layer";
import { KEEP_BUFFER } from "../src/tiles/raster";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";

const PANE_NAME = "scenic-lines";
const PANE_Z_INDEX = 290; // below POIs (300), above canopy
const MIN_ZOOM = 10;
const MAX_ZOOM = 20;

export default function LinesLayer({
  overlay,
  dir,
  format,
  color,
}: {
  overlay: OverlayId;
  dir: string; // blob at <dir>/<city>.bin
  format: "hway" | "ferr";
  color: Record<ThemeName, string>; // CSS stroke color, per theme
}) {
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
        const { south, west, north, east } = city.bounds;
        // Relative, so it picks up the basePath the deploy injects.
        const url = `${dir}/${city.id}.bin`;
        return new WorkerTileLayer(
          () => ({ kind: "lines", url, format, color }),
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
    const watching = layers.map((layer) => watchLayerStatus(layer, overlay));
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
  }, [map, overlay, dir, format, color, active.id]);

  return null;
}

"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { watchLayerStatus } from "../src/overlays/status";
import WorkerTileLayer from "../src/tiles/layer";
import { KEEP_BUFFER } from "../src/tiles/raster";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";

// Measured 2017 LiDAR canopy, drawn by the tile worker so overzoom resamples across tile edges.

// Relative, so it picks up the basePath the deploy injects.
const TILE_URL = "tiles/canopy/{z}/{x}/{y}.webp";
const MIN_NATIVE_ZOOM = 9; // coarsest baked level
const MAX_NATIVE_ZOOM = 15; // finest baked level
const MAX_ZOOM = 20;

const Z_INDEX = 2;

export default function CanopyLayer() {
  const map = useMap();
  const active = useCity();

  useEffect(() => {
    const layers = manifest.cities
      .filter((entry) => entry.id === active.id)
      .filter((city) => city.field.canopy)
      .map((city) => {
        const { south, west, north, east } = city.bounds;
        return new WorkerTileLayer(
          () => ({
            kind: "canopy",
            url: TILE_URL,
            maxNativeZoom: MAX_NATIVE_ZOOM,
          }),
          {
            bounds: L.latLngBounds([south, west], [north, east]),
            // No maxNativeZoom, or Leaflet stretches tiles instead of the worker magnifying them.
            minNativeZoom: MIN_NATIVE_ZOOM,
            maxZoom: MAX_ZOOM,
            zIndex: Z_INDEX,
            keepBuffer: KEEP_BUFFER,
          },
        );
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
  }, [map, active.id]);

  return null;
}

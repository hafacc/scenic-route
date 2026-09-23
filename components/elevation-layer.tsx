"use client";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { watchLayerStatus } from "../src/overlays/status";
import WorkerTileLayer from "../src/tiles/layer";
import { KEEP_BUFFER } from "../src/tiles/raster";
import manifest from "../src/tree-cover/manifest.json";
import { useCity } from "./city-context";

// Tiles bake height, relief and land cover, not color; the tile worker applies the palette.

// Relative, so it picks up the basePath the deploy injects.
const TILE_URL = "tiles/elevation/{city}/{z}/{x}/{y}.webp";
// Under the canopy fill (z 2), since at 67% opacity it buries anything beneath it.
const Z_INDEX = 1;
const MIN_ZOOM = 9;
const MAX_ZOOM = 20;
// Keep in sync with ELEVATION_MAX_ZOOM in crates/tiler/src/elevation.rs.
const MAX_NATIVE_ZOOM = 16;
// Degrees, over the pass's 300 m widening. Unbaked tiles 404, which reads as no terrain.
const BAKED_MARGIN = 0.01;

export default function ElevationLayer(): null {
  const map = useMap();
  const active = useCity();

  useEffect(() => {
    const city = manifest.cities.find((entry) => entry.id === active.id);
    if (!city) {
      return;
    }
    const { south, west, north, east } = city.bounds;
    const layer = new WorkerTileLayer(
      () => ({
        kind: "elevation",
        url: TILE_URL.replace("{city}", active.id),
        maxNativeZoom: MAX_NATIVE_ZOOM,
      }),
      {
        // The pass bakes past the city box by SHORE_REACH_METERS to reach piers and port fill.
        bounds: L.latLngBounds(
          [south - BAKED_MARGIN, west - BAKED_MARGIN],
          [north + BAKED_MARGIN, east + BAKED_MARGIN],
        ),
        // No maxNativeZoom, or Leaflet stretches tiles instead of the worker magnifying them.
        minNativeZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        zIndex: Z_INDEX,
        keepBuffer: KEEP_BUFFER,
      },
    );
    // Attached before the layer goes on the map, or the first load cycle's `loading` is missed.
    const detach = watchLayerStatus(layer, "elevation");
    layer.addTo(map);
    return () => {
      detach();
      layer.remove();
    };
  }, [map, active.id]);

  return null;
}

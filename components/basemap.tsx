"use client";

import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { FLAVORS } from "../src/basemap/flavor";
import { basemapLayer } from "../src/basemap/layer";
import { useMapTheme } from "./use-map-theme";

// Mounted imperatively: `leafletLayer` builds a GridLayer, not a react-leaflet component.

type Fetcher = (coords: unknown, tileSize: number) => Promise<unknown>;

// Reads the untyped `layer.views`: protomaps-leaflet only logs failed fetches, never `tileerror`.
function watchTiles(layer: unknown, onLost: (lost: boolean) => void): void {
  const { views } = layer as {
    views?: Map<string, { tileCache?: { source?: { get?: Fetcher } } }>;
  };
  for (const view of views?.values() ?? []) {
    const source = view.tileCache?.source;
    const original = source?.get;
    if (!source || !original) {
      continue;
    }
    const fetchTile = original.bind(source);
    source.get = async (coords: unknown, tileSize: number) => {
      try {
        const tile = await fetchTile(coords, tileSize);
        onLost(false);
        return tile;
      } catch (error) {
        // A pan aborts the tiles it left behind; that is not a fetch failure.
        if ((error as { name?: string })?.name !== "AbortError") {
          onLost(true);
        }
        throw error;
      }
    };
  }
}

export default function Basemap({
  onLost,
}: {
  onLost: (lost: boolean) => void;
}) {
  const map = useMap();
  const theme = useMapTheme();

  useEffect(() => {
    // Rebuilt, not restyled: protomaps-leaflet resolves paint rules once, at construction.
    const layer = basemapLayer(FLAVORS[theme]);
    watchTiles(layer, onLost);
    layer.addTo(map);
    return () => {
      onLost(false);
      layer.remove();
    };
  }, [map, onLost, theme]);

  return null;
}

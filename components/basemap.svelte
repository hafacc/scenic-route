<script lang="ts">
import { FLAVORS } from "../src/basemap/flavor";
import { basemapLayer } from "../src/basemap/layer";
import { getMap } from "./map-context";
import { useMapTheme } from "./use-map-theme.svelte";

// Mounted imperatively: `leafletLayer` builds a GridLayer, not a component.

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

interface Props {
  onLost: (lost: boolean) => void;
}

const { onLost }: Props = $props();
const map = getMap();
const theme = useMapTheme();

$effect(() => {
  // Rebuilt, not restyled: protomaps-leaflet resolves paint rules once, at construction.
  const layer = basemapLayer(FLAVORS[theme.current]);
  // Called as tiles settle, so the theme is all this effect tracks.
  watchTiles(layer, (lost) => onLost(lost));
  layer.addTo(map);
  return () => {
    onLost(false);
    layer.remove();
  };
});
</script>

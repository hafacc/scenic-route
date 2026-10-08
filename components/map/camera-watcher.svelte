<script lang="ts">
import { onMount, untrack } from "svelte";
import type { CityBounds } from "../../src/cities";
import type { Camera } from "../../src/url-state";
import { getMap } from "../map-context";

interface Props {
  initial: Camera | null;
  onCamera: (camera: Camera, view: CityBounds) => void;
}

// A shared camera arrives as a prop after mount, once the hash has been read.
const { initial, onCamera }: Props = $props();
const map = getMap();
let applied = false;

// The callback is untracked, since Leaflet fires `moveend` inside whichever effect moved the map.
const report = (): void => {
  const { lat, lng } = map.getCenter();
  const view = map.getBounds();
  untrack(() => {
    onCamera(
      { center: { lat, lng }, zoom: map.getZoom() },
      {
        south: view.getSouth(),
        west: view.getWest(),
        north: view.getNorth(),
        east: view.getEast(),
      },
    );
  });
};

onMount(() => {
  map.on("moveend", report);
  return () => {
    map.off("moveend", report);
  };
});

$effect(() => {
  const camera = initial;
  // Untracked, since Leaflet runs its move listeners inside `setView`.
  untrack(() => {
    if (camera && !applied) {
      applied = true;
      // Reported by the `moveend` this fires.
      map.setView([camera.center.lat, camera.center.lng], camera.zoom, {
        animate: false,
      });
    } else {
      report();
    }
  });
});
</script>

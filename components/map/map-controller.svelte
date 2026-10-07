<script lang="ts">
import { onMount, untrack } from "svelte";
import { CROSS_CITY_METERS } from "../../src/cities";
import { getMap } from "../map-context";
import type { MapTarget } from "../map-types";

interface MapControllerProps {
  target: MapTarget | null;
  following: boolean;
  userLocation: { lat: number; lng: number } | null;
  onDisengageFollow: () => void;
}

const props: MapControllerProps = $props();
const map = getMap();
let lastTargetKey = "";
let hasZoomed = false;
let wasFollowing = untrack(() => props.following);

$effect(() => {
  const { target } = props;
  if (!target) {
    // Clear the key so re-selecting the same target still flies.
    lastTargetKey = "";
    return;
  }
  const key = `${target.lat},${target.lng},${target.zoom ?? ""}`;
  if (key === lastTargetKey) {
    return;
  }
  lastTargetKey = key;
  // Untracked, since Leaflet runs its move listeners inside these calls.
  untrack(() => {
    const zoom = target.zoom ?? map.getZoom();
    // A cross-city hop is cut, since an animated crossing draws layers over open water.
    if (
      map.distance([target.lat, target.lng], map.getCenter()) >
      CROSS_CITY_METERS
    ) {
      map.setView([target.lat, target.lng], zoom, { animate: false });
    } else {
      map.flyTo([target.lat, target.lng], zoom, { duration: 0.8 });
    }
  });
});

$effect(() => {
  const { following, userLocation } = props;
  const justEngaged = following && !wasFollowing;
  wasFollowing = following;
  if (!following || !userLocation) {
    return;
  }
  const { lat, lng } = userLocation;
  // Untracked, since Leaflet runs its move listeners inside these calls.
  untrack(() => {
    const crossCity =
      map.distance([lat, lng], map.getCenter()) > CROSS_CITY_METERS;
    if (!hasZoomed) {
      // First fix: zoom to street level, cutting rather than flying to a different city.
      hasZoomed = true;
      if (crossCity) {
        map.setView([lat, lng], 16, { animate: false });
      } else {
        map.flyTo([lat, lng], 16, { duration: 0.8 });
      }
    } else if (justEngaged) {
      // Re-engaged: snap back at the current zoom, cutting if that crosses to another city.
      if (crossCity) {
        map.setView([lat, lng], map.getZoom(), { animate: false });
      } else {
        map.flyTo([lat, lng], map.getZoom(), { duration: 0.8 });
      }
    } else {
      map.setView([lat, lng], map.getZoom(), { animate: true });
    }
  });
});

// While following, anchor zoom on the map center (the user), not the cursor.
$effect(() => {
  const { following } = props;
  const zoomAnchor = following ? "center" : true;
  map.options.scrollWheelZoom = zoomAnchor;
  map.options.doubleClickZoom = zoomAnchor;
  map.options.touchZoom = zoomAnchor;
});

// Programmatic flyTo/setView fire no dragstart, so any dragstart is a real user grab.
onMount(() => {
  const handleDragStart = () => {
    props.onDisengageFollow();
  };
  map.on("dragstart", handleDragStart);
  return () => {
    map.off("dragstart", handleDragStart);
  };
});
</script>

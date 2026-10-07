<script lang="ts">
import type L from "leaflet";
import { onMount } from "svelte";
import { getMap } from "../map-context";

interface Props {
  onMapPick: (lat: number, lng: number) => void;
}

const { onMapPick }: Props = $props();
const map = getMap();

// Mounted only while picking.
onMount(() => {
  const handlers = {
    click: (event: L.LeafletMouseEvent) => {
      onMapPick(event.latlng.lat, event.latlng.lng);
    },
  };
  map.on(handlers);
  return () => {
    map.off(handlers);
  };
});
</script>

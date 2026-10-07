<script lang="ts">
import { getMap } from "../map-context";

interface Props {
  picking: boolean;
}

// Leaflet owns the container's class list, so the crosshair is toggled on it directly.
const { picking }: Props = $props();
const map = getMap();

$effect(() => {
  const container = map.getContainer();
  container.classList.toggle("scenic-picking", picking);
  return () => container.classList.remove("scenic-picking");
});
</script>

<script lang="ts">
import { type Component, onMount } from "svelte";
import type { OverlayId } from "../src/overlays/registry";
import { reportLayerData } from "../src/overlays/status";
import type { LayerView } from "./overlay-views";

interface Props {
  overlay: OverlayId;
  view: LayerView;
}

const { overlay, view }: Props = $props();
let Layer = $state.raw<Component<Record<string, unknown>> | null>(null);

// Loaded in the browser only; nothing shows while the chunk is on its way.
onMount(() => {
  const token = Symbol(overlay);
  let live = true;
  view.load().then(
    (module) => {
      if (live) {
        Layer = module.default;
      }
    },
    // A chunk that fails to load mounts no tile layer to report through.
    () => {
      if (live) {
        reportLayerData(overlay, token, false);
      }
    },
  );
  return () => {
    live = false;
    // Removal isn't evidence about reachability.
    reportLayerData(overlay, token, true);
  };
});
</script>

{#if Layer}
  <Layer {...view.props} />
{/if}

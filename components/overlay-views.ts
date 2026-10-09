// What each overlay mounts: its layer and its legend, kept out of src/overlays/registry.ts.
import type { Component } from "svelte";
import {
  ART_COLOR,
  FERRY_COLOR,
  HIGHWAY_COLOR,
  LANDMARK_COLOR,
  LANDMARK_TEXT_COLOR,
  LEGACY_COLOR,
  LEGACY_TEXT_COLOR,
} from "../src/overlays/colors";
import type { OverlayId } from "../src/overlays/registry";
import ElevationLegend from "./elevation-legend.svelte";
import TreeLegend from "./tree-legend.svelte";

// One lazily imported layer and the props it mounts with; lazy-layer.svelte renders it.
export interface LayerView {
  load: () => Promise<{ default: Component<Record<string, unknown>> }>;
  props: Record<string, unknown>;
}

interface OverlayView {
  layers: readonly LayerView[]; // the Leaflet layer(s) this overlay mounts on the map, in order
  legend?: Component; // floating key shown while this overlay is active
}

// Checks the props against the layer's own, then forgets the type so the views fit one list.
function layer<Props>(
  load: () => Promise<{ default: (internals: never, props: Props) => unknown }>,
  ...[props]: Record<string, never> extends Props ? [] : [props: NoInfer<Props>]
): LayerView {
  return { load, props: props ?? {} } as unknown as LayerView;
}

// The layers touch `window` at import; browser-only also keeps Leaflet out of the server bundle.
export const OVERLAY_VIEWS: Record<OverlayId, OverlayView> = {
  canopy: {
    layers: [
      layer(() => import("./canopy-layer.svelte")),
      layer(() => import("./street-score-layer.svelte")),
    ],
  },
  commercial: { layers: [layer(() => import("./dining-layer.svelte"))] },
  shade: { layers: [layer(() => import("./shade-layer.svelte"))] },
  elevation: {
    layers: [layer(() => import("./elevation-layer.svelte"))],
    legend: ElevationLegend,
  },
  historic: { layers: [layer(() => import("./historic-layer.svelte"))] },
  legacy: {
    layers: [
      layer(() => import("./poi-layer.svelte"), {
        overlay: "legacy",
        dir: "legacy",
        magic: "LGCY",
        color: LEGACY_COLOR,
        labelColor: LEGACY_TEXT_COLOR,
        labelAnchor: "top",
      }),
    ],
  },
  landmarks: {
    layers: [
      layer(() => import("./poi-layer.svelte"), {
        overlay: "landmarks",
        dir: "landmarks",
        magic: "LMRK",
        color: LANDMARK_COLOR,
        labelColor: LANDMARK_TEXT_COLOR,
        labelAnchor: "top",
      }),
    ],
  },
  art: {
    layers: [
      layer(() => import("./poi-layer.svelte"), {
        overlay: "art",
        dir: "art",
        magic: "ARTW",
        color: ART_COLOR,
        labelAnchor: "bottom",
      }),
    ],
  },
  ferries: {
    layers: [
      layer(() => import("./lines-layer.svelte"), {
        overlay: "ferries",
        dir: "ferries",
        format: "ferr",
        color: FERRY_COLOR,
      }),
    ],
  },
  subway: { layers: [layer(() => import("./subway-layer.svelte"))] },
  highways: {
    layers: [
      layer(() => import("./lines-layer.svelte"), {
        overlay: "highways",
        dir: "highways",
        format: "hway",
        color: HIGHWAY_COLOR,
      }),
    ],
  },
  industrial: { layers: [layer(() => import("./industrial-layer.svelte"))] },
  treecover: { layers: [layer(() => import("./tree-cover-layer.svelte"))] },
  scaffolding: { layers: [layer(() => import("./shed-layer.svelte"))] },
  genus: {
    layers: [layer(() => import("./genus-layer.svelte"))],
    legend: TreeLegend,
  },
};

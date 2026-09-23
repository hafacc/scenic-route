"use client";

import type L from "leaflet";
import { useSyncExternalStore } from "react";
import type { OverlayId } from "./registry";

// Renderers turn a 404 into an empty tile, so an error means unreachable rather than empty.

const EMPTY: ReadonlySet<OverlayId> = new Set();

// Keyed per map layer, since several stand behind one menu row and load independently.
const failing = new Map<OverlayId, Set<symbol>>();

let unreachable: ReadonlySet<OverlayId> = EMPTY;
const listeners = new Set<() => void>();

function republish(): void {
  const next = new Set(failing.keys());
  if (
    next.size === unreachable.size &&
    [...next].every((id) => unreachable.has(id))
  ) {
    return;
  }
  unreachable = next;
  for (const listener of listeners) {
    listener();
  }
}

function reportLayerStatus(
  overlay: OverlayId,
  layer: symbol,
  reachable: boolean,
): void {
  const layers = failing.get(overlay);
  if (reachable) {
    layers?.delete(layer);
    if (layers?.size === 0) {
      failing.delete(overlay);
    }
  } else if (layers) {
    layers.add(layer);
  } else {
    failing.set(overlay, new Set([layer]));
  }
  republish();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// For a layer whose manifest fails, so it never mounts a tile to report through.
export function reportLayerData(
  overlay: OverlayId,
  token: symbol,
  reachable: boolean,
): void {
  reportLayerStatus(overlay, token, reachable);
}

export function unreachableLayers(): ReadonlySet<OverlayId> {
  return unreachable;
}

export function useUnreachableLayers(): ReadonlySet<OverlayId> {
  return useSyncExternalStore(subscribe, unreachableLayers, () => EMPTY);
}

// Judged once per Leaflet `loading`/`load` cycle, so one failing tile doesn't flap the badge.
export function watchLayerStatus(
  layer: L.GridLayer,
  overlay: OverlayId,
): () => void {
  const token = Symbol(overlay);
  let errors = 0;
  const started = (): void => {
    errors = 0;
  };
  const failed = (): void => {
    errors += 1;
  };
  const finished = (): void => {
    reportLayerStatus(overlay, token, errors === 0);
  };
  layer.on("loading", started);
  layer.on("tileerror", failed);
  layer.on("load", finished);
  return () => {
    layer.off("loading", started);
    layer.off("tileerror", failed);
    layer.off("load", finished);
    // Removal isn't evidence about reachability.
    reportLayerStatus(overlay, token, true);
  };
}

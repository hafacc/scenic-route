"use client";

import L from "leaflet";
import { subscribeTheme } from "../theme/current";
import { repaintOnRestore } from "./repaint";

// Leaflet keeps a drawn tile forever, so a theme flip must redraw every grid.
const grids = new Set<CanvasGrid>();

subscribeTheme(() => {
  for (const grid of grids) {
    grid.redraw();
  }
});

export default class CanvasGrid extends L.GridLayer {
  private readonly watchers = new WeakMap<HTMLElement, () => void>();

  constructor(options?: L.GridLayerOptions) {
    super(options);
    this.on({
      tileunload: ({ tile }) => {
        this.watchers.get(tile)?.();
        this.watchers.delete(tile);
      },
      add: () => {
        grids.add(this);
      },
      remove: () => {
        grids.delete(this);
      },
    });
  }

  protected watch(tile: HTMLCanvasElement, paint: () => void): void {
    this.watchers.set(tile, repaintOnRestore(tile, paint));
    paint();
  }
}

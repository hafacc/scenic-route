"use client";

import L from "leaflet";
import { currentTheme, subscribeTheme } from "../theme/current";
import type {
  DoneMessage,
  ShadePrefetchMessage,
  TileParams,
  ToWorker,
} from "./protocol";
import { tileRatio } from "./raster";
import type { ShedDecks } from "./shed-decks";

const TILE_SIZE = 256;

interface PendingTile {
  tile: HTMLCanvasElement;
  done: L.DoneCallback;
}

// One worker: blobs are shared across overlays, and draws reuse scratch buffers one tile at a time.
let worker: Worker | undefined;
const pending = new Map<number, PendingTile>();
let nextTileKey = 0;

// Leaflet keeps a drawn tile forever, so a theme flip must redraw every layer.
const layers = new Set<WorkerTileLayer>();

function repaintForTheme(): void {
  // Not `tileWorker()`, which would start one; told even with no layers, since the worker outlives them.
  if (worker) {
    const message: ToWorker = { type: "theme", theme: currentTheme() };
    worker.postMessage(message);
  }
  for (const layer of layers) {
    layer.redraw();
  }
}

subscribeTheme(repaintForTheme);

function tileWorker(): Worker {
  if (!worker) {
    const started = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    started.addEventListener(
      "message",
      ({ data }: MessageEvent<DoneMessage>) => {
        const entry = pending.get(data.tileKey);
        pending.delete(data.tileKey);
        entry?.done(data.error ? new Error(data.error) : undefined, entry.tile);
      },
    );
    // A worker resolves relative URLs against its own chunk, not the document.
    const init: ToWorker = { type: "init", base: document.baseURI };
    started.postMessage(init);
    // Before any draw, so the first tile isn't painted in the light default.
    const theme: ToWorker = { type: "theme", theme: currentTheme() };
    started.postMessage(theme);
    worker = started;
  }
  return worker;
}

export function prefetchShadeTiles(message: ShadePrefetchMessage): void {
  tileWorker().postMessage(message);
}

// Copied, not transferred: the display overlay draws from the same arrays here.
export function sendShedDecks(decks: ShedDecks): void {
  const message: ToWorker = { type: "shed-decks", decks };
  tileWorker().postMessage(message);
}

export default class WorkerTileLayer extends L.GridLayer {
  // Weak, so a dropped tile stays collectable.
  private readonly tileKeys = new WeakMap<HTMLElement, number>();

  constructor(
    private readonly tileParams: () => TileParams,
    options: L.GridLayerOptions,
  ) {
    super(options);
    this.on({
      tileunload: ({ tile }) => {
        this.discard(tile);
      },
      add: () => {
        layers.add(this);
      },
      remove: () => {
        layers.delete(this);
      },
    });
  }

  createTile(coords: L.Coords, done: L.DoneCallback): HTMLCanvasElement {
    const tile = document.createElement("canvas");
    const ratio = tileRatio();
    tile.width = TILE_SIZE * ratio;
    tile.height = TILE_SIZE * ratio;

    const tileKey = nextTileKey;
    nextTileKey += 1;
    this.tileKeys.set(tile, tileKey);
    pending.set(tileKey, { tile, done });
    // One-way: this canvas can never yield a 2d context on the main thread again.
    const canvas = tile.transferControlToOffscreen();
    const message: ToWorker = {
      type: "draw",
      tileKey,
      coords: { x: coords.x, y: coords.y, z: coords.z },
      ratio, // the worker has no window to read a pixel ratio from
      params: this.tileParams(),
      canvas,
    };
    tileWorker().postMessage(message, [canvas]);
    return tile;
  }

  // Possibly before its data arrived, so the worker skips what's left of it.
  private discard(tile: HTMLElement): void {
    const tileKey = this.tileKeys.get(tile);
    if (tileKey !== undefined) {
      this.tileKeys.delete(tile);
      pending.delete(tileKey);
      const message: ToWorker = { type: "cancel", tileKey };
      tileWorker().postMessage(message);
    }
  }
}

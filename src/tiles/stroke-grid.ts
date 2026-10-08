import L from "leaflet";
import { subscribeTheme } from "../theme/current";
import type { ThemeName } from "../theme/palette";
import { CutQueue } from "./cut-queue";
import { cancelInWorker, drawInWorker, repaintInWorker } from "./layer";
import { collectStrokes, type PathStrokes, strokeWidth } from "./path-strokes";
import { tileRatio } from "./raster";

// Cut here, where the routing graph is, and stroked in the tile worker, where the raster costs no frame.

const TILE_SIZE = 256;

// What a frame may spend cutting strokes before the rest waits for the next one.
const FRAME_BUDGET_MS = 6;

export interface StrokeSource {
  // Does one more piece of the work the tile's strokes need; false once there is none left.
  prepare(coords: L.Coords, width: number): boolean;
  // The stroke sets reaching the tile; more than one where they are cut per cell.
  strokes(coords: L.Coords, width: number): PathStrokes[];
}

// A source whose strokes are all cut already.
export function readyStrokes(strokes: PathStrokes): StrokeSource {
  const sets = [strokes];
  return { prepare: () => false, strokes: () => sets };
}

// Leaflet keeps a drawn tile forever; the lines do not move with the theme, so each is recolored in place.
const grids = new Set<StrokeGrid>();

// Subscribed after ./layer, whose own listener has told the worker the new theme by now.
// One message, a tile of each grid in turn, so two layers over one place change color together.
subscribeTheme(() => {
  const each = [...grids].map((grid) => grid.liveTiles());
  const longest = Math.max(0, ...each.map((keys) => keys.length));
  const turns: number[] = [];
  for (let at = 0; at < longest; at++) {
    for (const keys of each) {
      if (at < keys.length) {
        turns.push(keys[at]);
      }
    }
  }
  repaintInWorker(turns);
});

// Painted opaque and faded as a layer, so strokes that overlap never add up.
export default class StrokeGrid extends L.GridLayer {
  private source: StrokeSource | null = null;
  // Tiles whose strokes are not yet cut and sent.
  private readonly waiting = new CutQueue<HTMLElement>();
  // Weak, so a dropped tile stays collectable.
  private readonly tileKeys = new WeakMap<HTMLElement, number>();
  // The same keys, iterable for a recolor.
  private readonly liveKeys = new Set<number>();
  private frame = 0;

  constructor(
    private readonly color: Record<ThemeName, string>,
    options: L.GridLayerOptions,
  ) {
    super(options);
    this.on({
      tileunload: ({ tile }) => {
        this.waiting.drop(tile);
        const tileKey = this.tileKeys.get(tile);
        if (tileKey !== undefined) {
          this.tileKeys.delete(tile);
          this.liveKeys.delete(tileKey);
          cancelInWorker(tileKey);
        }
      },
      add: () => {
        grids.add(this);
      },
      remove: () => {
        grids.delete(this);
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        this.waiting.clear();
      },
    });
  }

  // The tiles the worker holds; ones still waiting to be cut take the theme it has when they are sent.
  liveTiles(): number[] {
    return [...this.liveKeys];
  }

  setSource(source: StrokeSource): void {
    this.source = source;
    this.redraw();
  }

  createTile(coords: L.Coords, done: L.DoneCallback): HTMLCanvasElement {
    const tile = document.createElement("canvas");
    const ratio = tileRatio();
    tile.width = TILE_SIZE * ratio;
    tile.height = TILE_SIZE * ratio;
    const source = this.source;
    if (source) {
      const width = strokeWidth(coords.z);
      this.waiting.add(tile, {
        prepare: () => source.prepare(coords, width),
        send: () => {
          this.send(tile, coords, source, width, done);
        },
      });
      this.schedule();
    }
    // With no source yet the tile is left unfinished, so `load` waits for a real paint.
    return tile;
  }

  private schedule(): void {
    if (this.frame === 0 && this.waiting.size > 0) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        const started = performance.now();
        this.waiting.frame(() => performance.now() - started > FRAME_BUDGET_MS);
        this.schedule();
      });
    }
  }

  // The tile's own lines only, flattened, so the worker holds no more of the city than it draws.
  private send(
    tile: HTMLCanvasElement,
    coords: L.Coords,
    source: StrokeSource,
    width: number,
    done: L.DoneCallback,
  ): void {
    const { lines, ends } = collectStrokes(
      source.strokes(coords, width),
      coords,
      width,
    );
    const tileKey = drawInWorker(
      tile,
      coords,
      tileRatio(),
      {
        kind: "strokes",
        color: this.color,
        width,
        lines,
        ends,
      },
      done,
      [lines.buffer, ends.buffer],
    );
    this.tileKeys.set(tile, tileKey);
    this.liveKeys.add(tileKey);
  }
}

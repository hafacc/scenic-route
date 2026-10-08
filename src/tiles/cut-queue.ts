// Tiles waiting for their strokes to be cut, worked a frame's budget at a time; no Leaflet, so it tests plainly.

export interface CutJob {
  // Does one more piece of the cutting; false once there is none left.
  prepare(): boolean;
  // Hands the finished tile on.
  send(): void;
}

export class CutQueue<Tile> {
  // Oldest first, which is the order tiles are finished in.
  private readonly waiting = new Map<Tile, CutJob>();

  get size(): number {
    return this.waiting.size;
  }

  add(tile: Tile, job: CutJob): void {
    this.waiting.set(tile, job);
  }

  // A tile Leaflet unloaded before its turn is never cut.
  drop(tile: Tile): void {
    this.waiting.delete(tile);
  }

  clear(): void {
    this.waiting.clear();
  }

  // One frame's work, stopping once `spent`; a tile caught mid-cut keeps its place for the next frame.
  frame(spent: () => boolean): void {
    for (const [tile, job] of this.waiting) {
      while (job.prepare()) {
        if (spent()) {
          return;
        }
      }
      if (spent()) {
        return;
      }
      this.waiting.delete(tile);
      job.send();
      if (spent()) {
        return;
      }
    }
  }
}

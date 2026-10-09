import type { DoneMessage, DrawMessage, TileParams } from "./protocol";

// Paints `message` unless `current` has turned false by the time its data loads.
export type Rasterize = (
  message: DrawMessage,
  current: () => boolean,
) => Promise<void>;

// The worker's per-tile bookkeeping, apart from the renderers so a test can inject its own.
export class TileQueue {
  // Tiles still loading, and the subset Leaflet has since dropped.
  private readonly inFlight = new Set<number>();
  private readonly canceled = new Set<number>();
  // Each tile's newest draw; a repaint replaces it, and a load it outdates is redone before painting.
  private readonly latest = new Map<number, DrawMessage>();

  constructor(
    private readonly rasterize: Rasterize,
    private readonly report: (message: DoneMessage) => void,
  ) {}

  draw(message: DrawMessage): void {
    this.latest.set(message.tileKey, message);
    this.start(message.tileKey, true);
  }

  // Without `params` each tile is drawn again from its own.
  repaint(tileKeys: readonly number[], params?: TileParams): void {
    for (const tileKey of tileKeys) {
      const current = this.latest.get(tileKey);
      if (current) {
        this.latest.set(tileKey, {
          ...current,
          params: params ?? current.params,
        });
        // An in-flight tile picks the new params up in `settle`.
        if (!this.inFlight.has(tileKey)) {
          this.start(tileKey, false);
        }
      }
    }
  }

  cancel(tileKey: number): void {
    this.latest.delete(tileKey);
    if (this.inFlight.has(tileKey)) {
      this.canceled.add(tileKey);
    }
  }

  // Loops until the tile's newest params have painted, so a repaint mid-load is never lost.
  private async settle(tileKey: number): Promise<void> {
    let message = this.latest.get(tileKey);
    while (message && !this.canceled.has(tileKey)) {
      const drawing = message;
      try {
        await this.rasterize(
          drawing,
          () =>
            !this.canceled.has(tileKey) && this.latest.get(tileKey) === drawing,
        );
      } catch (error) {
        // A superseded draw's failure doesn't matter; its replacement still has to load.
        if (this.latest.get(tileKey) === drawing) {
          throw error;
        }
      }
      const next = this.latest.get(tileKey);
      if (next === drawing) {
        return;
      }
      message = next;
    }
  }

  // A repaint reports nothing: Leaflet was told once, and a failed one leaves the old pixels up.
  private finish(tileKey: number, report: boolean, error?: string): void {
    this.inFlight.delete(tileKey);
    // Leaflet has already forgotten a dropped tile, so there is nothing to report.
    if (!this.canceled.delete(tileKey) && report) {
      this.report({ type: "done", tileKey, error });
    }
  }

  private start(tileKey: number, report: boolean): void {
    this.inFlight.add(tileKey);
    this.settle(tileKey).then(
      () => {
        this.finish(tileKey, report);
      },
      (error: Error) => {
        this.finish(tileKey, report, error.message);
      },
    );
  }
}

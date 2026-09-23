import type { TileCoords } from "./protocol";

// Split so the worker can drop a tile Leaflet discarded mid-load; `load` is shared and cached.
export interface TileRenderer<Params, Data> {
  load(params: Params, coords: TileCoords): Promise<Data>;
  draw(
    context: OffscreenCanvasRenderingContext2D,
    data: Data,
    coords: TileCoords,
    params: Params,
    ratio: number,
  ): void;
}

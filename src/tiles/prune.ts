import L from "leaflet";

// Leaflet's fade pass skips pruning when a whole burst goes opaque at once, stranding parent tiles.
// Prune once the fade settles, not per frame: `_pruneTiles` costs ~20 keyed lookups per tile.
interface Prunable {
  _noPrune?: boolean; // set while a zoom animation or a pinch is in flight
  // absent until onAdd
  _tiles?: Record<
    string,
    { current: boolean; loaded?: number; active?: boolean }
  >;
  _updateOpacity(): void;
  _pruneTiles(): void; // a no-op on a layer that is off the map
}

type PrunableGridLayer = L.GridLayer & Prunable;

let installed = false;

// Patches `L.GridLayer` itself, since the basemap and route grid are Leaflet's own classes.
export default function installTilePrune(): void {
  if (installed) {
    return;
  }
  installed = true;
  const prototype = L.GridLayer.prototype as PrunableGridLayer;
  const updateOpacity = prototype._updateOpacity;
  prototype._updateOpacity = function (this: PrunableGridLayer): void {
    updateOpacity.call(this);
    // `_setView` prunes after a zoom animation; `_initContainer` calls this before `_tiles` exists, and throwing would break the layer.
    if (this._noPrune || !this._tiles) {
      return;
    }
    // Leaflet marks a tile active when its fade reaches 1, so a loaded inactive tile is still fading.
    for (const tile of Object.values(this._tiles)) {
      if (tile.current && tile.loaded && !tile.active) {
        return;
      }
    }
    this._pruneTiles();
  };
}

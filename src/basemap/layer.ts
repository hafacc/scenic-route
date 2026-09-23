"use client";

import type L from "leaflet";
import { leafletLayer } from "protomaps-leaflet";
import { KEEP_BUFFER, tileRatio } from "../tiles/raster";
import type { Flavor } from "./flavor";
import { basemapLabelRules, basemapPaintRules } from "./rules";

// CARTO's terms forbid caching its tiles; Protomaps' allow it, so the service worker caches these.

// Committed on purpose: its CORS allow-list gates it, so localhost needs its own key in .env.local.
const PUBLISHED_KEY = "265db316db1cddf4";
const KEY = process.env.NEXT_PUBLIC_PROTOMAPS_KEY ?? PUBLISHED_KEY;

export const BASEMAP_URL = `https://api.protomaps.com/tiles/v4/{z}/{x}/{y}.mvt?key=${KEY}`;

// Above this the renderer redraws the vectors larger rather than enlarging a picture of them.
export const BASEMAP_MAX_DATA_ZOOM = 15;

export const BASEMAP_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &middot; <a href="https://protomaps.com">Protomaps</a>';

// Everything before the first `{z}`, matching every basemap tile request and nothing else.
const BASEMAP_PREFIX = BASEMAP_URL.slice(0, BASEMAP_URL.indexOf("{"));

let statusChecked = false;

// protomaps-leaflet ignores the status and decodes the error page, so a 403 surfaces as
// `Unimplemented type: 7`; wrapping fetch is the only seam, and aborts must still reject as aborts.
function checkTileStatus(): void {
  // Next.js evaluates this module on the server too, where there is no map and no fetch to wrap.
  if (statusChecked || typeof window === "undefined") {
    return;
  }
  statusChecked = true;
  const original = window.fetch.bind(window);
  const checking: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(BASEMAP_PREFIX)) {
      return original(input, init);
    }
    return original(input, init).then((response) => {
      if (response.ok) {
        return response;
      } else {
        // The key rides in the query string, so only the tile itself is named.
        const [tile] = url.split("?");
        throw new Error(
          `basemap tile request failed: ${response.status} ${response.statusText} for ${tile}`,
        );
      }
    });
  };
  window.fetch = checking;
}

export function basemapLayer(flavor: Flavor): L.Layer {
  checkTileStatus();
  return leafletLayer({
    url: BASEMAP_URL,
    maxDataZoom: BASEMAP_MAX_DATA_ZOOM,
    // The map's zoom range derives from this; dropping it caps the app below the shade and route zooms.
    maxZoom: 20,
    // The raw pixel ratio would cost a phone hundreds of megabytes of tile canvases (../tiles/raster).
    devicePixelRatio: tileRatio(),
    keepBuffer: KEEP_BUFFER,
    paintRules: basemapPaintRules(flavor),
    labelRules: basemapLabelRules(flavor),
    backgroundColor: flavor.background as string,
    attribution: BASEMAP_ATTRIBUTION,
  }) as unknown as L.Layer;
}

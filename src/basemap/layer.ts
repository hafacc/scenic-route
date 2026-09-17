"use client";

import type L from "leaflet";
import { leafletLayer } from "protomaps-leaflet";
import { KEEP_BUFFER, tileRatio } from "../tiles/raster";
import type { Flavor } from "./flavor";
import { basemapLabelRules, basemapPaintRules } from "./rules";

// The basemap: Protomaps vector tiles, drawn in the browser from the style in this directory.
//
// It replaced CARTO's Voyager raster tiles, which looked right but could not come offline — CARTO's
// terms forbid caching them, and an offline map whose background is missing is not much of a map.
// Protomaps' terms invert that: the whole point of the project is that a map is an asset you may
// keep. So the service worker caches these, bounded to the cities (src/sw/policy.ts).
//
// Drawing the vectors here rather than fetching pictures of them is also what makes the night map a
// real style: it is a second colour dictionary in ./flavor.ts and nothing else, where the raster
// layer this replaced could only be inverted in CSS.

// Free for non-commercial use up to a soft cap, and restricted by the CORS allow-list set on the key
// itself rather than by keeping the key secret — so it is committed deliberately, not leaked. It is
// scoped to the deploy's own origin, which is why local development needs its own key:
// `http://localhost:3000` is not unique to any one machine, so a key that admits it admits everyone's.
// Put that one in `.env.local`, which is gitignored.
const PUBLISHED_KEY = "265db316db1cddf4";
const KEY = process.env.NEXT_PUBLIC_PROTOMAPS_KEY ?? PUBLISHED_KEY;

export const BASEMAP_URL = `https://api.protomaps.com/tiles/v4/{z}/{x}/{y}.mvt?key=${KEY}`;

// The basemap's data stops here; above it the renderer redraws the same vectors larger rather than
// enlarging a picture of them, which is why deep zooms stay sharp.
export const BASEMAP_MAX_DATA_ZOOM = 15;

export const BASEMAP_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &middot; <a href="https://protomaps.com">Protomaps</a>';

// Every basemap tile request, and nothing else: what the templated URL above starts with, before the
// first `{z}`.
const BASEMAP_PREFIX = BASEMAP_URL.slice(0, BASEMAP_URL.indexOf("{"));

let statusChecked = false;

// Fail a refused tile request as itself.
//
// protomaps-leaflet never looks at the response status: it pipes whatever comes back straight into
// the protobuf decoder, so a 403 or a 504 arrives as `Unimplemented type: 7` thrown over an HTML
// error page, which names nothing that happened. The library takes no custom source and does not
// export the decoder, so `fetch` is the only seam; requests that are not basemap tiles are handed to
// the original untouched, and an abort still rejects as an abort, which is what tells the watcher in
// components/basemap.tsx that the app changed its mind rather than lost the map.
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
    // `maxZoom` is carried over from the raster layer this replaced: it is what the MAP's zoom range
    // is derived from, so dropping it would quietly cap the whole app below the zooms the swept
    // shade and the route detail live at.
    maxZoom: 20,
    // The renderer would otherwise size its tile canvases by the raw pixel ratio, which is the one
    // choice on the map that costs a phone hundreds of megabytes (../tiles/raster).
    devicePixelRatio: tileRatio(),
    keepBuffer: KEEP_BUFFER,
    paintRules: basemapPaintRules(flavor),
    labelRules: basemapLabelRules(flavor),
    backgroundColor: flavor.background as string,
    attribution: BASEMAP_ATTRIBUTION,
  }) as unknown as L.Layer;
}

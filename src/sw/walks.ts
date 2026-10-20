// Your walks' heat tiles, drawn and kept here from points only this device's own pages post.

import { HEAT_TILE_SIZE, heatAlpha } from "../walks/heat-raster";

// Outside the data stores, so no deploy sweeps it; "Forget my walks" deletes it whole.
export const WALKS_CACHE = "walks";
const TILE_PATH =
  /^__walks\/heat\/([a-z]+)\/([0-9a-f]+)\/(\d+)\/(\d+)\/(\d+)\.png$/;
const VERSION_HEADER = "x-walks-version";

export interface HeatTile {
  city: string;
  version: string;
  z: number;
  x: number;
  y: number;
}

// `__walks/heat/{city}/{version}/{z}/{x}/{y}.png` under the scope; null for anything else.
export function heatTileRequest(url: string, scope: string): HeatTile | null {
  if (!url.startsWith(scope)) {
    return null;
  }
  const match = TILE_PATH.exec(url.slice(scope.length));
  return match
    ? {
        city: match[1],
        version: match[2],
        z: Number(match[3]),
        x: Number(match[4]),
        y: Number(match[5]),
      }
    : null;
}

const pointsUrl = (scope: string, city: string): string =>
  `${scope}__sw/walks/${city}`;

// A new version drops the city's drawn tiles; the same one again keeps them.
export async function keepHeatPoints(
  scope: string,
  city: string,
  version: string,
  points: Float64Array,
): Promise<void> {
  const cache = await caches.open(WALKS_CACHE);
  const stored = await cache.match(pointsUrl(scope, city));
  if (stored?.headers.get(VERSION_HEADER) === version) {
    return;
  }
  const drawn = `${scope}__walks/heat/${city}/`;
  for (const request of await cache.keys()) {
    if (request.url.startsWith(drawn)) {
      await cache.delete(request);
    }
  }
  await cache.put(
    pointsUrl(scope, city),
    new Response(points.slice().buffer, {
      headers: { [VERSION_HEADER]: version },
    }),
  );
}

export async function forgetHeat(): Promise<void> {
  await caches.delete(WALKS_CACHE);
}

// A 404 is empty ground to the tile worker, which is also what a tile of no walks is.
export async function serveHeat(
  request: Request,
  tile: HeatTile,
  scope: string,
): Promise<Response> {
  const cache = await caches.open(WALKS_CACHE);
  const hit = await cache.match(request);
  if (hit) {
    return hit;
  }
  const stored = await cache.match(pointsUrl(scope, tile.city));
  if (
    stored?.headers.get(VERSION_HEADER) !== tile.version ||
    typeof OffscreenCanvas === "undefined"
  ) {
    return new Response(null, { status: 404 });
  }
  const alpha = heatAlpha(
    new Float64Array(await stored.arrayBuffer()),
    tile.z,
    tile.x,
    tile.y,
  );
  let response: Response;
  if (alpha.every((value) => value === 0)) {
    response = new Response(null, { status: 404 });
  } else {
    const size = HEAT_TILE_SIZE;
    const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let pixel = 0; pixel < alpha.length; pixel++) {
      pixels[pixel * 4 + 3] = alpha[pixel];
    }
    const canvas = new OffscreenCanvas(size, size);
    canvas.getContext("2d")?.putImageData(new ImageData(pixels, size), 0, 0);
    response = new Response(await canvas.convertToBlob({ type: "image/png" }), {
      headers: { "content-type": "image/png" },
    });
  }
  await cache.put(request, response.clone());
  return response;
}

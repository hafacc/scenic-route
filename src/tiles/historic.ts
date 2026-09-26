import { HISTORIC_COLOR } from "../overlays/colors";
import { resolveUrl } from "./base-url";
import { projectX, projectY, unproject } from "./mercator";
import { bucketize, type Polyline, readPolyline } from "./polylines";
import type { HistoricParams, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import {
  BLUR_PAD,
  compositeSoft,
  MAX_BLUR_PX,
  tileMetersPerPixel,
} from "./soft-edge";
import { themeName } from "./theme";
import type { Cursor } from "./varint";

const TILE_SIZE = 256;
const CELL_DEG = 0.005; // ~550 m; a district is filed under every cell its bounding box spans
// At the industrial wash's alpha, so the streets and the buildings under a district read through.
const FILL_ALPHA = 0.45;
// Smaller districts are drawn as a square, since antialiasing fades sub-pixel ones to nothing.
const MIN_DISTRICT_PX = 1.5;
// A ground width of feathering, capped at MAX_BLUR_PX from about z16 so close in it stays crisp.
const BLUR_METERS = 12;
const MIN_BLUR_PX = 1;

interface Districts {
  districts: Polyline[][]; // filled even-odd so an inner ring punches a hole
  boxes: Polyline[]; // per district, its [min, max] lng and lat
  // District indices by `${cellX},${cellY}` over each bounding box.
  buckets: Map<string, number[]>;
}

// encodePolygons' layout (scripts/geometry.ts); the router prices the same file (historic.rs).
export function decodeHistoric(buffer: ArrayBuffer): Districts {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const count = view.getUint32(8, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const cursor: Cursor = { offset: view.getUint16(6, true) };

  const districts: Polyline[][] = [];
  for (let polygon = 0; polygon < count; polygon++) {
    const ringCount = view.getUint16(cursor.offset, true);
    cursor.offset += 2;
    const rings: Polyline[] = [];
    for (let ring = 0; ring < ringCount; ring++) {
      const vertices = view.getUint32(cursor.offset, true);
      cursor.offset += 4;
      rings.push(
        readPolyline(bytes, cursor, vertices, originLng, originLat, scale),
      );
    }
    districts.push(rings);
  }

  // Its box's two corners, so the shared bucketing files it under every cell the box spans.
  const boxes = districts.map((rings) => {
    let minLng = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    for (const { lngs, lats } of rings) {
      for (let vertex = 0; vertex < lngs.length; vertex++) {
        minLng = Math.min(minLng, lngs[vertex]);
        maxLng = Math.max(maxLng, lngs[vertex]);
        minLat = Math.min(minLat, lats[vertex]);
        maxLat = Math.max(maxLat, lats[vertex]);
      }
    }
    return {
      lngs: Float64Array.of(minLng, maxLng),
      lats: Float64Array.of(minLat, maxLat),
    };
  });
  return { districts, boxes, buckets: bucketize(boxes, CELL_DEG) };
}

const loaded = new Map<string, Promise<Districts>>();

function loadDistricts({ url }: HistoricParams): Promise<Districts> {
  const pending = loaded.get(url);
  if (pending) {
    return pending;
  } else {
    const resolved = resolveUrl(url);
    const request = fetch(resolved)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `${resolved}: ${response.status} ${response.statusText}`,
          );
        }
        return decodeHistoric(await response.arrayBuffer());
      })
      .catch((error: unknown) => {
        loaded.delete(url);
        throw error;
      });
    loaded.set(url, request);
    return request;
  }
}

// Filled opaque as one union so overlaps don't darken, then blurred and washed in together.
function draw(
  context: OffscreenCanvasRenderingContext2D,
  { districts, boxes, buckets }: Districts,
  coords: TileCoords,
  _params: HistoricParams,
  ratio: number,
): void {
  const zoom = coords.z;
  const originX = coords.x * TILE_SIZE;
  const originY = coords.y * TILE_SIZE;
  // Padded, so districts just past the edge feed the blur and neighbouring tiles seam.
  const northWest = unproject(originX - BLUR_PAD, originY - BLUR_PAD, zoom);
  const southEast = unproject(
    originX + TILE_SIZE + BLUR_PAD,
    originY + TILE_SIZE + BLUR_PAD,
    zoom,
  );
  const blur = Math.min(
    MAX_BLUR_PX,
    Math.max(MIN_BLUR_PX, BLUR_METERS / tileMetersPerPixel(coords)),
  );
  // Grown by the blur so a tiny district's square keeps a solid core after feathering.
  const minSide = MIN_DISTRICT_PX + 2 * blur;

  const found: number[] = [];
  const seen = new Set<number>();
  for (
    let cellX = Math.floor(northWest.lng / CELL_DEG);
    cellX <= Math.floor(southEast.lng / CELL_DEG);
    cellX++
  ) {
    for (
      let cellY = Math.floor(southEast.lat / CELL_DEG);
      cellY <= Math.floor(northWest.lat / CELL_DEG);
      cellY++
    ) {
      for (const index of buckets.get(`${cellX},${cellY}`) ?? []) {
        if (!seen.has(index)) {
          seen.add(index);
          found.push(index);
        }
      }
    }
  }
  if (found.length === 0) {
    return;
  }

  compositeSoft(context, ratio, blur, FILL_ALPHA, (wash) => {
    wash.fillStyle = HISTORIC_COLOR[themeName()];
    let painted = false;
    for (const index of found) {
      // Its box's projected corners; north is the smaller y.
      const { lngs: boxLngs, lats: boxLats } = boxes[index];
      const minX = projectX(boxLngs[0], zoom) - originX;
      const maxX = projectX(boxLngs[1], zoom) - originX;
      const minY = projectY(boxLats[1], zoom) - originY;
      const maxY = projectY(boxLats[0], zoom) - originY;
      // A bucket reaches well past the scratch, so a district wholly outside it is skipped.
      const grow = minSide / 2;
      if (
        maxX + grow < -BLUR_PAD ||
        minX - grow > TILE_SIZE + BLUR_PAD ||
        maxY + grow < -BLUR_PAD ||
        minY - grow > TILE_SIZE + BLUR_PAD
      ) {
        continue;
      }
      painted = true;
      wash.beginPath();
      for (const { lngs, lats } of districts[index]) {
        for (let vertex = 0; vertex < lngs.length; vertex++) {
          const x = projectX(lngs[vertex], zoom) - originX;
          const y = projectY(lats[vertex], zoom) - originY;
          if (vertex === 0) {
            wash.moveTo(x, y);
          } else {
            wash.lineTo(x, y);
          }
        }
        wash.closePath();
      }
      if (maxX - minX < minSide && maxY - minY < minSide) {
        wash.fillRect(
          (minX + maxX - minSide) / 2,
          (minY + maxY - minSide) / 2,
          minSide,
          minSide,
        );
      } else {
        wash.fill("evenodd");
      }
    }
    return painted;
  });
}

export const historicRenderer: TileRenderer<HistoricParams, Districts> = {
  load: loadDistricts,
  draw,
};

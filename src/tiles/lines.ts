import { resolveUrl } from "./base-url";
import { roundedPath } from "./ferry-curve";
import { routeStyles } from "./ferry-routes";
import { projectX, projectY, unproject } from "./mercator";
import {
  bucketize,
  decodeNames,
  laneRibbons,
  laneSpacingPx,
  type Polyline,
  readPolyline,
} from "./polylines";
import type { LinesParams, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import { themeName } from "./theme";
import type { Cursor } from "./varint";

const TILE_SIZE = 256;
const CELL_DEG = 0.01; // ~1.1 km; a line is filed under every cell its bounding box spans
const LINE_WIDTH_PX = 2;

// Routes sharing water share its track (68% within 60 m); the SI Ferry and St. George are 100+ m apart.
const LANE_CELL_M = 60;
// Long enough that a route joining a bundle changes lane over open water, not at a far-off vertex.
const LANE_BLEND_M = 400;
// Two 2 px strokes this far apart just touch; pinned at z14 it is 18 m, what Buttermilk Channel affords.
const LANE_SPACING_PX = 2.5;
const LANE_FULL_ZOOM = 14;

interface Ribbon {
  color: string | null; // null falls back to the layer's color
  // Per vertex, in lane widths; zero where the crossing has the water to itself.
  lanes: Float64Array;
  // Unit normals per vertex in projected space, so the offset stays in screen pixels as the map zooms.
  normalX: Float64Array;
  normalY: Float64Array;
}

interface Lines {
  polylines: Polyline[];
  // Polyline indices by `${cellX},${cellY}` over each line's bounding box.
  buckets: Map<string, number[]>;
  // Index-aligned with polylines; null for a source with no route identity (HWAY).
  ribbons: Ribbon[] | null;
}

// HWAY is binfmt.rs read_polygons' layout; each nuisance line is one open ring of its own polygon.
function decodeHway(buffer: ArrayBuffer): Polyline[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const count = view.getUint32(8, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const cursor: Cursor = { offset: view.getUint16(6, true) };

  const polylines: Polyline[] = [];
  for (let polygon = 0; polygon < count; polygon++) {
    const rings = view.getUint16(cursor.offset, true);
    cursor.offset += 2;
    for (let ring = 0; ring < rings; ring++) {
      const vertices = view.getUint32(cursor.offset, true);
      cursor.offset += 4;
      polylines.push(
        readPolyline(bytes, cursor, vertices, originLng, originLat, scale),
      );
    }
  }
  return polylines;
}

// FERR is binfmt.rs read_ferries' layout; a segment with no shape draws straight between its stops.
function decodeFerr(buffer: ArrayBuffer): {
  polylines: Polyline[];
  routes: (string | null)[];
} {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const NO_GEOMETRY = 0xffffffff;
  const NO_ROUTE = 0xffff;
  const STOP_BYTES = 12;
  const SEGMENT_BYTES = 20;
  const headerBytes = view.getUint16(6, true);
  const stopCount = view.getUint32(8, true);
  const segmentCount = view.getUint32(12, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const geometryOffset = view.getUint32(40, true);
  const names = decodeNames(view, bytes, view.getUint32(48, true));

  const stopTable = headerBytes;
  const stopLng = new Float64Array(stopCount);
  const stopLat = new Float64Array(stopCount);
  for (let stop = 0; stop < stopCount; stop++) {
    const record = stopTable + stop * STOP_BYTES;
    stopLng[stop] = originLng + view.getInt32(record, true) * scale;
    stopLat[stop] = originLat + view.getInt32(record + 4, true) * scale;
  }

  const segmentTable = stopTable + stopCount * STOP_BYTES;
  const polylines: Polyline[] = [];
  const routes: (string | null)[] = [];
  for (let segment = 0; segment < segmentCount; segment++) {
    const record = segmentTable + segment * SEGMENT_BYTES;
    const stopA = view.getUint32(record, true);
    const stopB = view.getUint32(record + 4, true);
    const geomOffset = view.getUint32(record + 12, true);
    const geomCount = view.getUint16(record + 16, true);
    const routeName = view.getUint16(record + 18, true);
    routes.push(routeName === NO_ROUTE ? null : (names[routeName] ?? null));
    if (geomOffset === NO_GEOMETRY) {
      polylines.push({
        lngs: Float64Array.of(stopLng[stopA], stopLng[stopB]),
        lats: Float64Array.of(stopLat[stopA], stopLat[stopB]),
      });
    } else {
      const cursor: Cursor = { offset: geometryOffset + geomOffset };
      polylines.push(
        readPolyline(bytes, cursor, geomCount, originLng, originLat, scale),
      );
    }
  }
  return { polylines, routes };
}

// The latitude the lane grid is measured at.
function midLatitude(polylines: readonly Polyline[]): number {
  let sum = 0;
  for (const { lats } of polylines) {
    sum += lats[0];
  }
  return polylines.length ? sum / polylines.length : 0;
}

const loaded = new Map<string, Promise<Lines>>();

export function decodeLines(
  buffer: ArrayBuffer,
  format: LinesParams["format"],
): Lines {
  if (format === "hway") {
    const polylines = decodeHway(buffer);
    return {
      polylines,
      buckets: bucketize(polylines, CELL_DEG),
      ribbons: null,
    };
  } else {
    const { polylines, routes } = decodeFerr(buffer);
    const styles = routeStyles(routes);
    const ribbons = laneRibbons(
      polylines.map((polyline, index) => ({
        ...polyline,
        route: styles[index].route,
      })),
      {
        cellMeters: LANE_CELL_M,
        blendMeters: LANE_BLEND_M,
        latitude: midLatitude(polylines),
      },
    ).map((ribbon, index) => ({ color: styles[index].color, ...ribbon }));
    return { polylines, buckets: bucketize(polylines, CELL_DEG), ribbons };
  }
}

function loadLines({ url, format }: LinesParams): Promise<Lines> {
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
        return decodeLines(await response.arrayBuffer(), format);
      })
      .catch((error: unknown) => {
        loaded.delete(url);
        throw error;
      });
    loaded.set(url, request);
    return request;
  }
}

function draw(
  context: OffscreenCanvasRenderingContext2D,
  lines: Lines,
  coords: TileCoords,
  { color }: LinesParams,
): void {
  const zoom = coords.z;
  const originX = coords.x * TILE_SIZE;
  const originY = coords.y * TILE_SIZE;
  const northWest = unproject(originX, originY, zoom);
  const southEast = unproject(originX + TILE_SIZE, originY + TILE_SIZE, zoom);
  const stroke = color[themeName()];

  context.lineWidth = LINE_WIDTH_PX;
  context.lineJoin = "round";
  context.lineCap = "round";
  const spacing = laneSpacingPx(zoom, LANE_SPACING_PX, LANE_FULL_ZOOM);
  const drawn = new Set<number>();
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
      const cell = lines.buckets.get(`${cellX},${cellY}`);
      if (!cell) {
        continue;
      }
      for (const index of cell) {
        if (drawn.has(index)) {
          continue;
        }
        drawn.add(index);
        const { lngs, lats } = lines.polylines[index];
        const ribbon = lines.ribbons?.[index];
        // Project the whole polyline: lane offsets and curves read vertices outside the tile.
        const pixelX: number[] = [];
        const pixelY: number[] = [];
        for (let vertex = 0; vertex < lngs.length; vertex++) {
          const offset = (ribbon?.lanes[vertex] ?? 0) * spacing;
          pixelX.push(
            projectX(lngs[vertex], zoom) -
              originX +
              offset * (ribbon?.normalX[vertex] ?? 0),
          );
          pixelY.push(
            projectY(lats[vertex], zoom) -
              originY +
              offset * (ribbon?.normalY[vertex] ?? 0),
          );
        }
        context.strokeStyle = ribbon?.color ?? stroke;
        context.beginPath();
        if (ribbon) {
          roundedPath(context, pixelX, pixelY);
        } else {
          for (let vertex = 0; vertex < pixelX.length; vertex++) {
            if (vertex === 0) {
              context.moveTo(pixelX[vertex], pixelY[vertex]);
            } else {
              context.lineTo(pixelX[vertex], pixelY[vertex]);
            }
          }
        }
        context.stroke();
      }
    }
  }
}

export const linesRenderer: TileRenderer<LinesParams, Lines> = {
  load: loadLines,
  draw,
};

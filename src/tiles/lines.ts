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
// Web Mercator ground resolution of a 256 px tile at z0 on the equator.
const EQUATOR_METERS_PER_PX = 156_543.033_92;

// Per HWAY class byte, a rough carriageway width in meters, so the line covers the road it marks.
const CLASS_WIDTH_M = [25, 20, 16, 13, 10, 8];
// Per class byte, the severity a v2 blob (no severity region) reads as; scripts/highways.ts CLASS_SEVERITY.
const V2_CLASS_SEVERITY = [1, 0.582, 0.249, 0.133, 0.086, 1];
// So a zoomed-out line stays visible rather than thinning to nothing.
const MIN_ROAD_WIDTH_PX = 1;
// Opacity runs from this at the faintest severity to 1 at full, so a quiet street still shows.
const MIN_ALPHA = 0.25;
// Severity is drawn in this many opacity levels, each one stroke per class.
const ALPHA_STEPS = 16;
// Within one opacity level, narrowest first.
const CLASS_DRAW_ORDER = [4, 3, 2, 1, 5, 0];

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
  // Index-aligned with polylines; null for FERR, which has no classes.
  classes: Uint8Array | null;
  // Index-aligned with polylines, 0..1; null for FERR.
  severities: Float32Array | null;
}

// HWAY is binfmt.rs read_highways' layout; each nuisance line is one open ring of its own polygon.
function decodeHway(buffer: ArrayBuffer): {
  polylines: Polyline[];
  classes: Uint8Array;
  severities: Float32Array;
} {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const format = view.getUint16(4, true);
  const count = view.getUint32(8, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const cursor: Cursor = { offset: view.getUint16(6, true) };

  const polylines: Polyline[] = [];
  const recordOf: number[] = []; // which polygon record each polyline's ring came from
  for (let polygon = 0; polygon < count; polygon++) {
    const rings = view.getUint16(cursor.offset, true);
    cursor.offset += 2;
    for (let ring = 0; ring < rings; ring++) {
      const vertices = view.getUint32(cursor.offset, true);
      cursor.offset += 4;
      polylines.push(
        readPolyline(bytes, cursor, vertices, originLng, originLat, scale),
      );
      recordOf.push(polygon);
    }
  }

  // The service worker can serve a cached older blob to fresh JS: v1 has no trailing bytes and
  // reads as all motorway, v2 has classes but no severities and reads its class's.
  const classes = new Uint8Array(polylines.length);
  const severities = new Float32Array(polylines.length).fill(1);
  const hasClasses = format >= 2 && cursor.offset + count <= bytes.length;
  const hasSeverities =
    format >= 3 && cursor.offset + 2 * count <= bytes.length;
  for (let line = 0; line < polylines.length; line++) {
    const record = recordOf[line];
    if (hasClasses) {
      const klass = bytes[cursor.offset + record];
      classes[line] = klass < CLASS_WIDTH_M.length ? klass : 0;
    }
    if (hasSeverities) {
      severities[line] = bytes[cursor.offset + count + record] / 255;
    } else if (hasClasses) {
      severities[line] = V2_CLASS_SEVERITY[classes[line]];
    }
  }
  return { polylines, classes, severities };
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
    const { polylines, classes, severities } = decodeHway(buffer);
    return {
      polylines,
      buckets: bucketize(polylines, CELL_DEG),
      ribbons: null,
      classes,
      severities,
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
    return {
      polylines,
      buckets: bucketize(polylines, CELL_DEG),
      ribbons,
      classes: null,
      severities: null,
    };
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
  const visible: number[] = [];
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
      for (const index of lines.buckets.get(`${cellX},${cellY}`) ?? []) {
        if (!seen.has(index)) {
          seen.add(index);
          visible.push(index);
        }
      }
    }
  }

  // Project the whole polyline: lane offsets and curves read vertices outside the tile.
  const project = (index: number): [number[], number[]] => {
    const { lngs, lats } = lines.polylines[index];
    const ribbon = lines.ribbons?.[index];
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
    return [pixelX, pixelY];
  };

  const { classes, severities } = lines;
  if (classes && severities) {
    // In CSS pixels: the worker has already scaled the context by the device pixel ratio.
    const metersPerPx =
      (EQUATOR_METERS_PER_PX *
        Math.cos(((northWest.lat + southEast.lat) / 2) * (Math.PI / 180))) /
      2 ** zoom;
    // Keyed so ascending order paints faintest first, then narrowest first within a level.
    const groups = new Map<number, number[]>();
    for (const index of visible) {
      const severity = severities[index];
      if (severity <= 0) {
        continue; // no penalty in routing, so nothing to show
      }
      const key =
        Math.round(severity * ALPHA_STEPS) * CLASS_DRAW_ORDER.length +
        CLASS_DRAW_ORDER.indexOf(classes[index]);
      const group = groups.get(key);
      if (group) {
        group.push(index);
      } else {
        groups.set(key, [index]);
      }
    }
    context.strokeStyle = stroke;
    for (const key of [...groups.keys()].sort((left, right) => left - right)) {
      const step = Math.floor(key / CLASS_DRAW_ORDER.length);
      const klass = CLASS_DRAW_ORDER[key % CLASS_DRAW_ORDER.length];
      const alpha = MIN_ALPHA + ((1 - MIN_ALPHA) * step) / ALPHA_STEPS;
      context.lineWidth = Math.max(
        CLASS_WIDTH_M[klass] / metersPerPx,
        MIN_ROAD_WIDTH_PX,
      );
      context.beginPath();
      for (const index of groups.get(key) ?? []) {
        const [pixelX, pixelY] = project(index);
        for (let vertex = 0; vertex < pixelX.length; vertex++) {
          if (vertex === 0) {
            context.moveTo(pixelX[vertex], pixelY[vertex]);
          } else {
            context.lineTo(pixelX[vertex], pixelY[vertex]);
          }
        }
      }
      // Erase what's under the group, then paint it: a pixel keeps the alpha of the last and so
      // strongest group covering it rather than the sum, and one stroke never overlaps itself.
      context.globalCompositeOperation = "destination-out";
      context.globalAlpha = 1;
      context.stroke();
      context.globalCompositeOperation = "source-over";
      context.globalAlpha = alpha;
      context.stroke();
    }
    context.globalAlpha = 1;
    return;
  }

  for (const index of visible) {
    const ribbon = lines.ribbons?.[index];
    const [pixelX, pixelY] = project(index);
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

export const linesRenderer: TileRenderer<LinesParams, Lines> = {
  load: loadLines,
  draw,
};

import {
  decodeSubway,
  mergeStations,
  type SubwayRoute,
  type SubwayStation,
  stationRouteIndices,
} from "../subway/format";
import { resolveUrl } from "./base-url";
import { drawLabels, type PlacedLabels, placeLabels } from "./labels";
import { projectX, projectY, unproject } from "./mercator";
import {
  bucketize,
  laneRibbons,
  laneSpacingPx,
  type Polyline,
} from "./polylines";
import type { SubwayParams, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import { splinePath } from "./spline";

// The ferry layer's machinery, but subway trunks are narrower and more shared, so lanes count over 40 m.

const TILE_SIZE = 256;
const CELL_DEG = 0.01; // ~1.1 km; a line is filed under every cell its bounding box spans
const LINE_WIDTH_PX = 2;

// Wider than the ferries' 2.5 px: a 0.5 px gap between 2 px strokes merges a four-route stack.
const LANE_SPACING_PX = 3;
const LANE_FULL_ZOOM = 15;

// Wider than one trunk's two tracks, narrower than the ~80 m to a parallel avenue's line.
const TRUNK_CELL_M = 40;
// Under the ~700 m between stations, and ~5× the 46.6 m vertex spacing so a shift is a diagonal.
const LANE_BLEND_M = 250;

const STATION_MIN_ZOOM = 13;
const STATION_LABEL_ZOOM = 15;
const STATION_BASE_RADIUS_PX = 2.5;
const STATION_LABEL_COLOR = "#ffffff"; // legible on either theme over the outline ./labels strokes
// Rings a station whose routes differ in color, and colors a line whose route the file doesn't name.
const NEUTRAL_COLOR = "#334155"; // slate-700

// The first zoom where under 5% of bullet blocks overlap another (1.7% NYC, 4.1% SF).
const BULLET_ZOOM = 15;
// Wraps so the block stays about square; Times Sq (10 routes) and Powell (12) take three rows.
const BULLETS_PER_ROW = 4;
const BULLET_GAP_PX = 1.5;
const BULLET_OUTLINE = "#ffffff"; // parts touching bullets, and lifts a dark one off a dark map
// Grows 2 px a zoom; the smallest a two-letter name reads in, which SF's same-colored cable cars need.
const BULLET_BASE_DIAMETER_PX = 12;
const BULLET_MAX_DIAMETER_PX = 16;
// The MTA's own bullet proportions; a two-character name is set smaller and squeezed to fit.
const BULLET_TEXT_WIDTH = 0.82;
const BULLET_TEXT_SIZE = 0.78;
const BULLET_PAIR_TEXT_SIZE = 0.6;
// A diamond is a narrower box than a circle of the same width, so its name gets less room.
const DIAMOND_TEXT_WIDTH = 0.58;
// Longer names are words, so the color carries the route: BART's are named "Yellow", "Red" and so on.
const BULLET_MAX_TEXT_CHARS = 2;

interface DrawnLine extends Polyline {
  color: string;
  lanes: Float64Array; // per vertex, in lane widths, from laneTracks

  // Unit normals per vertex, in projected space, so the lane is a screen offset at draw time.
  normalX: Float64Array;
  normalY: Float64Array;
}

interface RouteBullet {
  color: string;
  textColor: string;
  text: string;
  diamond: boolean;
}

interface Subway {
  lines: DrawnLine[];
  // Line indices by `${cellX},${cellY}` over each line's bounding box.
  buckets: Map<string, number[]>;
  stationBuckets: Map<string, number[]>;
  bullets: RouteBullet[];
  // Per marker, in the feed's route order.
  stationRoutes: number[][];
  // Per marker, the dot's ring color below BULLET_ZOOM.
  rings: string[];
  names: string[];
  lngs: Float64Array;
  lats: Float64Array;
  // Per zoom; filled on the first tile that needs one.
  labels: Map<number, PlacedLabels>;
}

// The MTA signs express routes (6X, FX, 7X) as a diamond around the plain name, never as "6X".
// Every express stop is also a local stop (checked in the feed), so the diamond alone says both.
function foldExpressPairs(
  indices: readonly number[],
  routes: readonly SubwayRoute[],
): number[] {
  const expressed = new Set(
    indices
      .map((index) => routes[index]?.shortName)
      .filter((name): name is string => name?.endsWith("X") ?? false)
      .map((name) => name.slice(0, -1)),
  );
  return indices.filter((index) => {
    const name = routes[index]?.shortName;
    return name === undefined || !expressed.has(name);
  });
}

function routeBullets(routes: readonly SubwayRoute[]): RouteBullet[] {
  const names = new Set(routes.map(({ shortName }) => shortName));
  return routes.map(({ color, textColor, shortName }) => {
    const diamond =
      shortName.endsWith("X") && names.has(shortName.slice(0, -1));
    return {
      color,
      textColor,
      text: diamond ? shortName.slice(0, -1) : shortName,
      diamond,
    };
  });
}

// A station on two trunks is neither's color, so only a single shared color (4/5/6 green) is used.
function stationRing(
  station: SubwayStation,
  routes: readonly SubwayRoute[],
): string {
  const colors = new Set(
    routes
      .filter((_, index) => (station.routes & (1 << index)) !== 0)
      .map(({ color }) => color),
  );
  return colors.size === 1 ? [...colors][0] : NEUTRAL_COLOR;
}

export function decodeSubwayTiles(buffer: ArrayBuffer): Subway {
  const { routes, lines, stations: records } = decodeSubway(buffer);
  // One marker per place: NYC spreads a complex over several records, and SF files a stop per curb.
  const stations = mergeStations(records);
  const midLat = stations.length
    ? stations[Math.floor(stations.length / 2)].lat
    : 0;
  const ribbons = laneRibbons(lines, {
    cellMeters: TRUNK_CELL_M,
    blendMeters: LANE_BLEND_M,
    latitude: midLat,
  });

  const drawn = lines.map(({ lngs, lats, route }, index) => ({
    lngs,
    lats,
    color: routes[route]?.color ?? NEUTRAL_COLOR,
    ...ribbons[index],
  }));

  return {
    lines: drawn,
    buckets: bucketize(drawn, CELL_DEG),
    stationBuckets: bucketize(
      stations.map(({ lng, lat }) => ({
        lngs: Float64Array.of(lng),
        lats: Float64Array.of(lat),
      })),
      CELL_DEG,
    ),
    bullets: routeBullets(routes),
    stationRoutes: stations.map((station) =>
      foldExpressPairs(stationRouteIndices(station), routes),
    ),
    rings: stations.map((station) => stationRing(station, routes)),
    names: stations.map(({ name }) => name),
    lngs: Float64Array.from(stations, ({ lng }) => lng),
    lats: Float64Array.from(stations, ({ lat }) => lat),
    labels: new Map(),
  };
}

const loaded = new Map<string, Promise<Subway>>();

function loadSubway({ url }: SubwayParams): Promise<Subway> {
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
        return decodeSubwayTiles(await response.arrayBuffer());
      })
      .catch((error: unknown) => {
        loaded.delete(url);
        throw error;
      });
    loaded.set(url, request);
    return request;
  }
}

function stationRadius(zoom: number): number {
  return Math.min(5, STATION_BASE_RADIUS_PX + Math.max(0, zoom - 13) * 0.4);
}

function bulletDiameter(zoom: number): number {
  return Math.min(
    BULLET_MAX_DIAMETER_PX,
    BULLET_BASE_DIAMETER_PX + (zoom - BULLET_ZOOM) * 2,
  );
}

interface BulletBlock {
  diameter: number;
  pitch: number; // one bullet's center to the next
  rows: number;
  halfWidth: number;
  halfHeight: number;
}

function bulletBlock(count: number, zoom: number): BulletBlock {
  const diameter = bulletDiameter(zoom);
  const pitch = diameter + BULLET_GAP_PX;
  const rows = Math.ceil(count / BULLETS_PER_ROW);
  return {
    diameter,
    pitch,
    rows,
    halfWidth: (Math.min(count, BULLETS_PER_ROW) * pitch - BULLET_GAP_PX) / 2,
    halfHeight: (rows * pitch - BULLET_GAP_PX) / 2,
  };
}

// Half the marker's size at this zoom, for the tile cull and label placement.
function markerExtent(
  subway: Subway,
  station: number,
  zoom: number,
): { halfWidth: number; halfHeight: number } {
  if (zoom < BULLET_ZOOM) {
    const radius = stationRadius(zoom);
    return { halfWidth: radius, halfHeight: radius };
  } else {
    return bulletBlock(subway.stationRoutes[station].length, zoom);
  }
}

const BULLET_FONT_FAMILY = "system-ui, sans-serif";
const BULLET_REFERENCE_PX = 10;
// Width scales with font size, so one measurement per name serves every bullet size.
const referenceWidths = new Map<string, number>();

function bulletText(
  context: OffscreenCanvasRenderingContext2D,
  { text, diamond }: RouteBullet,
  diameter: number,
): { size: number; squeeze: number } | null {
  if (!text || text.length > BULLET_MAX_TEXT_CHARS) {
    return null;
  }
  let reference = referenceWidths.get(text);
  if (reference === undefined) {
    context.font = `700 ${BULLET_REFERENCE_PX}px ${BULLET_FONT_FAMILY}`;
    reference = context.measureText(text).width;
    referenceWidths.set(text, reference);
  }
  const size =
    diameter * (text.length > 1 ? BULLET_PAIR_TEXT_SIZE : BULLET_TEXT_SIZE);
  const room = diameter * (diamond ? DIAMOND_TEXT_WIDTH : BULLET_TEXT_WIDTH);
  const width = (reference * size) / BULLET_REFERENCE_PX;
  return { size, squeeze: Math.min(1, room / width) };
}

function bulletPath(
  context: OffscreenCanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radius: number,
  diamond: boolean,
): void {
  context.beginPath();
  if (diamond) {
    context.moveTo(centerX, centerY - radius);
    context.lineTo(centerX + radius, centerY);
    context.lineTo(centerX, centerY + radius);
    context.lineTo(centerX - radius, centerY);
    context.closePath();
  } else {
    context.arc(centerX, centerY, radius, 0, 2 * Math.PI);
  }
}

// route_text_color is published for the name inside the bullet.
function drawBullets(
  context: OffscreenCanvasRenderingContext2D,
  subway: Subway,
  station: number,
  markerX: number,
  markerY: number,
  zoom: number,
): void {
  const indices = subway.stationRoutes[station];
  const { diameter, pitch, rows, halfHeight } = bulletBlock(
    indices.length,
    zoom,
  );
  const radius = diameter / 2;
  context.lineWidth = 1;
  context.strokeStyle = BULLET_OUTLINE;
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (let row = 0; row < rows; row++) {
    const inRow = indices.slice(
      row * BULLETS_PER_ROW,
      (row + 1) * BULLETS_PER_ROW,
    );
    // Each row is centered on its own, so a short last row sits under the middle.
    const left = markerX - (inRow.length * pitch - BULLET_GAP_PX) / 2 + radius;
    const centerY = markerY - halfHeight + radius + row * pitch;
    for (const [column, index] of inRow.entries()) {
      const bullet = subway.bullets[index];
      const centerX = left + column * pitch;
      context.fillStyle = bullet?.color ?? NEUTRAL_COLOR;
      bulletPath(context, centerX, centerY, radius, bullet?.diamond ?? false);
      context.fill();
      context.stroke();
      const legend = bullet && bulletText(context, bullet, diameter);
      if (bullet && legend) {
        context.font = `700 ${legend.size}px ${BULLET_FONT_FAMILY}`;
        context.fillStyle = bullet.textColor;
        context.save();
        context.translate(centerX, centerY);
        context.scale(legend.squeeze, 1);
        context.fillText(bullet.text, 0, 0);
        context.restore();
      }
    }
  }
}

function drawLines(
  context: OffscreenCanvasRenderingContext2D,
  subway: Subway,
  coords: TileCoords,
  cellX0: number,
  cellX1: number,
  cellY0: number,
  cellY1: number,
): void {
  const zoom = coords.z;
  const originX = coords.x * TILE_SIZE;
  const originY = coords.y * TILE_SIZE;
  const spacing = laneSpacingPx(zoom, LANE_SPACING_PX, LANE_FULL_ZOOM);
  context.lineWidth = LINE_WIDTH_PX;
  context.lineJoin = "round";
  context.lineCap = "round";
  const drawn = new Set<number>();
  for (let cellX = cellX0; cellX <= cellX1; cellX++) {
    for (let cellY = cellY0; cellY <= cellY1; cellY++) {
      for (const index of subway.buckets.get(`${cellX},${cellY}`) ?? []) {
        if (drawn.has(index)) {
          continue;
        }
        drawn.add(index);
        const { lngs, lats, lanes, normalX, normalY, color } =
          subway.lines[index];
        // Project the whole line: lane offsets and spline controls read vertices outside the tile.
        const pixelX: number[] = [];
        const pixelY: number[] = [];
        for (let vertex = 0; vertex < lngs.length; vertex++) {
          const offset = lanes[vertex] * spacing;
          pixelX.push(
            projectX(lngs[vertex], zoom) - originX + offset * normalX[vertex],
          );
          pixelY.push(
            projectY(lats[vertex], zoom) - originY + offset * normalY[vertex],
          );
        }
        context.strokeStyle = color;
        context.beginPath();
        splinePath(context, pixelX, pixelY);
        context.stroke();
      }
    }
  }
}

// The MTA map's ringed white disc; below z13 markers smear together (91 within 6 px at z12).
function drawStations(
  context: OffscreenCanvasRenderingContext2D,
  subway: Subway,
  coords: TileCoords,
  cellX0: number,
  cellX1: number,
  cellY0: number,
  cellY1: number,
): void {
  const zoom = coords.z;
  const originX = coords.x * TILE_SIZE;
  const originY = coords.y * TILE_SIZE;
  for (let cellX = cellX0; cellX <= cellX1; cellX++) {
    for (let cellY = cellY0; cellY <= cellY1; cellY++) {
      for (const station of subway.stationBuckets.get(`${cellX},${cellY}`) ??
        []) {
        const markerX = projectX(subway.lngs[station], zoom) - originX;
        const markerY = projectY(subway.lats[station], zoom) - originY;
        const { halfWidth, halfHeight } = markerExtent(subway, station, zoom);
        if (
          markerX < -halfWidth ||
          markerX > TILE_SIZE + halfWidth ||
          markerY < -halfHeight ||
          markerY > TILE_SIZE + halfHeight
        ) {
          continue;
        }
        if (zoom >= BULLET_ZOOM) {
          drawBullets(context, subway, station, markerX, markerY, zoom);
        } else {
          context.lineWidth = 1.5;
          context.fillStyle = "#ffffff";
          context.beginPath();
          context.arc(markerX, markerY, halfWidth, 0, 2 * Math.PI);
          context.fill();
          context.strokeStyle = subway.rings[station];
          context.stroke();
        }
      }
    }
  }
}

function labelsAt(
  context: OffscreenCanvasRenderingContext2D,
  subway: Subway,
  zoom: number,
): PlacedLabels {
  const cached = subway.labels.get(zoom);
  if (cached) {
    return cached;
  } else {
    // Busiest first: placement is greedy, so whoever is offered a spot first keeps it.
    const order = subway.names
      .map((_, station) => station)
      .sort(
        (left, right) =>
          subway.stationRoutes[right].length -
          subway.stationRoutes[left].length,
      );
    const extents = order.map((station) => markerExtent(subway, station, zoom));
    const placed = placeLabels(
      context,
      {
        lngs: order.map((station) => subway.lngs[station]),
        lats: order.map((station) => subway.lats[station]),
        names: order.map((station) => subway.names[station]),
        halfWidths: extents.map(({ halfWidth }) => halfWidth),
        halfHeights: extents.map(({ halfHeight }) => halfHeight),
      },
      zoom,
      stationRadius(zoom),
      false,
    );
    subway.labels.set(zoom, placed);
    return placed;
  }
}

function draw(
  context: OffscreenCanvasRenderingContext2D,
  subway: Subway,
  coords: TileCoords,
): void {
  const zoom = coords.z;
  const originX = coords.x * TILE_SIZE;
  const originY = coords.y * TILE_SIZE;
  const northWest = unproject(originX, originY, zoom);
  const southEast = unproject(originX + TILE_SIZE, originY + TILE_SIZE, zoom);
  const cellX0 = Math.floor(northWest.lng / CELL_DEG);
  const cellX1 = Math.floor(southEast.lng / CELL_DEG);
  const cellY0 = Math.floor(southEast.lat / CELL_DEG);
  const cellY1 = Math.floor(northWest.lat / CELL_DEG);

  drawLines(context, subway, coords, cellX0, cellX1, cellY0, cellY1);
  if (zoom >= STATION_MIN_ZOOM) {
    // One cell wider: a marker centered just outside the tile still reaches in.
    drawStations(
      context,
      subway,
      coords,
      cellX0 - 1,
      cellX1 + 1,
      cellY0 - 1,
      cellY1 + 1,
    );
  }
  if (zoom >= STATION_LABEL_ZOOM) {
    drawLabels(
      context,
      labelsAt(context, subway, zoom),
      coords,
      STATION_LABEL_COLOR,
      false,
    );
  }
}

export const subwayRenderer: TileRenderer<SubwayParams, Subway> = {
  load: loadSubway,
  draw,
};

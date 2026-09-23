// Transit edges are straight chords, so rides borrow the agency shapes from the subway artifact.
import type { Polyline } from "../tiles/polylines";
import { decodeSubway, type Subway, type SubwayRoute } from "./format";

const METERS_PER_DEGREE_LAT = 111_320;

// Real offsets are tens of meters; beyond this the projection hit the wrong stretch.
const MAX_STATION_OFFSET_METERS = 300;

// About a centimeter: only projection round-off.
const SAME_POINT_DEGREES = 1e-7;

export interface TrackPoint {
  lat: number;
  lng: number;
}

interface Projection {
  along: number; // distance from the line's first vertex, in the local metric frame
  distance: number; // how far the point sits off the line
  lat: number;
  lng: number;
  vertex: number; // the index the projection falls before
}

// The nearest point on `line` to (lat, lng), in a planar frame scaled at the line's own latitude.
function project(line: Polyline, lat: number, lng: number): Projection | null {
  const count = line.lats.length;
  if (count < 2) {
    return null;
  }
  const scaleLng =
    METERS_PER_DEGREE_LAT * Math.cos((line.lats[0] * Math.PI) / 180);
  const toX = (degrees: number): number => degrees * scaleLng;
  const toY = (degrees: number): number => degrees * METERS_PER_DEGREE_LAT;
  const pointX = toX(lng);
  const pointY = toY(lat);
  let best: Projection | null = null;
  let cumulative = 0;
  let previousX = toX(line.lngs[0]);
  let previousY = toY(line.lats[0]);
  for (let vertex = 1; vertex < count; vertex++) {
    const currentX = toX(line.lngs[vertex]);
    const currentY = toY(line.lats[vertex]);
    const deltaX = currentX - previousX;
    const deltaY = currentY - previousY;
    const lengthSq = deltaX * deltaX + deltaY * deltaY;
    const param =
      lengthSq > 0
        ? Math.max(
            0,
            Math.min(
              1,
              ((pointX - previousX) * deltaX + (pointY - previousY) * deltaY) /
                lengthSq,
            ),
          )
        : 0;
    const closestX = previousX + param * deltaX;
    const closestY = previousY + param * deltaY;
    const distance = Math.hypot(pointX - closestX, pointY - closestY);
    if (best === null || distance < best.distance) {
      const segment = Math.sqrt(lengthSq);
      best = {
        along: cumulative + param * segment,
        distance,
        lat:
          line.lats[vertex - 1] +
          param * (line.lats[vertex] - line.lats[vertex - 1]),
        lng:
          line.lngs[vertex - 1] +
          param * (line.lngs[vertex] - line.lngs[vertex - 1]),
        vertex,
      };
    }
    cumulative += Math.sqrt(lengthSq);
    previousX = currentX;
    previousY = currentY;
  }
  return best;
}

// Hung off the station points, not the projections, or the ride floats clear of the walk to it.
function sliceBetween(
  line: Polyline,
  board: Projection,
  alight: Projection,
  from: TrackPoint,
  to: TrackPoint,
): Polyline {
  const forward = board.along <= alight.along;
  const first = forward ? board : alight;
  const last = forward ? alight : board;
  const track: [number, number][] = [];
  // A projection on a vertex is that vertex, so the interior run would repeat it.
  const push = (lng: number, lat: number): void => {
    const end = track[track.length - 1];
    if (end === undefined || end[0] !== lng || end[1] !== lat) {
      track.push([lng, lat]);
    }
  };
  push(first.lng, first.lat);
  for (let vertex = first.vertex; vertex < last.vertex; vertex++) {
    push(line.lngs[vertex], line.lats[vertex]);
  }
  push(last.lng, last.lat);
  if (!forward) {
    track.reverse();
  }
  const lngs = track.map(([lng]) => lng);
  const lats = track.map(([, lat]) => lat);
  const apart = (lng: number, lat: number, point: TrackPoint): boolean =>
    Math.abs(lng - point.lng) > SAME_POINT_DEGREES ||
    Math.abs(lat - point.lat) > SAME_POINT_DEGREES;
  if (apart(lngs[0], lats[0], from)) {
    lngs.unshift(from.lng);
    lats.unshift(from.lat);
  }
  const end = lngs.length - 1;
  if (apart(lngs[end], lats[end], to)) {
    lngs.push(to.lng);
    lats.push(to.lat);
  }
  return { lngs: Float64Array.from(lngs), lats: Float64Array.from(lats) };
}

// The variant both stations sit nearest, since branches differ; null means draw the chord.
export function sliceTrack(
  lines: readonly Polyline[],
  board: TrackPoint,
  alight: TrackPoint,
): Polyline | null {
  let bestLine: Polyline | null = null;
  let bestBoard: Projection | null = null;
  let bestAlight: Projection | null = null;
  let bestOffset = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const from = project(line, board.lat, board.lng);
    const to = project(line, alight.lat, alight.lng);
    if (from === null || to === null) {
      continue;
    }
    const offset = Math.max(from.distance, to.distance);
    if (offset < bestOffset) {
      bestOffset = offset;
      bestLine = line;
      bestBoard = from;
      bestAlight = to;
    }
  }
  if (
    bestLine === null ||
    bestBoard === null ||
    bestAlight === null ||
    bestOffset > MAX_STATION_OFFSET_METERS
  ) {
    return null;
  }
  return sliceBetween(bestLine, bestBoard, bestAlight, board, alight);
}

// The artifact has no route ids, so the join is on the rider-facing name plus the published color.
export function trackShapes(
  subway: Subway,
  route: { shortName: string; color: string },
): Polyline[] {
  const matches = (candidate: SubwayRoute, exact: boolean): boolean =>
    candidate.shortName === route.shortName &&
    (!exact || candidate.color.toLowerCase() === route.color.toLowerCase());
  for (const exact of [true, false]) {
    const wanted = new Set<number>();
    subway.routes.forEach((candidate, index) => {
      if (matches(candidate, exact)) {
        wanted.add(index);
      }
    });
    if (wanted.size > 0) {
      return subway.lines.filter((line) => wanted.has(line.route));
    }
  }
  return [];
}

const loading = new Map<string, Promise<Subway>>();

// Kept for the page's life; the subway overlay fetches the same file.
export function loadSubwayTracks(cityId: string): Promise<Subway> {
  const cached = loading.get(cityId);
  if (cached) {
    return cached;
  }
  const url = `subway/${cityId}.bin`;
  const promise = fetch(url)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
      }
      return decodeSubway(await response.arrayBuffer());
    })
    .catch((error: unknown) => {
      loading.delete(cityId); // a failed load must not be memoized
      throw error;
    });
  loading.set(cityId, promise);
  return promise;
}

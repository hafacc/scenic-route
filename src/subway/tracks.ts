// The track a ride is drawn on. The routing graph carries no geometry for a ride — a transit edge is
// a straight chord from one platform to the next — so a route that gets on a train would otherwise be
// drawn cutting across the blocks the train runs under. The shapes the agency publishes are already
// in the app, as the subway overlay's artifact (./format), so a ride borrows them: the two stations
// are projected onto the line's own drawn variants and the stretch between them is sliced out.

import type { Polyline } from "../tiles/polylines";
import { decodeSubway, type Subway, type SubwayRoute } from "./format";

const METERS_PER_DEGREE_LAT = 111_320;

// How far a station may sit from the shape its own line is drawn as before the match is refused.
// The agency's shapes run down the middle of the tracks and a station point stands over them, so the
// gap is tens of meters where the two describe the same place; a few hundred means the projection
// landed on the wrong stretch, and a chord is a better drawing than a wrong one.
const MAX_STATION_OFFSET_METERS = 300;

// A station whose projection lands this close to it is already on the track: about a centimeter, so
// the only thing it absorbs is the arithmetic of projecting a point onto the segment it lies on.
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

// The stretch of `line` between two projections, in board -> alight order, hung off the two station
// points themselves: a projection sits on the track, the platform stands beside it, and a slice that
// began at the projection left the ride floating clear of the walk that reaches it.
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
  // A projection that lands on a vertex is that vertex, so the interior run would repeat it.
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

// The stretch of track a ride covers: the variant of the line both stations sit closest to, cut
// between them. Null where no variant passes near enough to both — a line the artifact does not
// draw, or a station the shapes do not reach — and the caller draws the chord instead.
//
// The variant matters: a route's shapes include its branches and its express pattern, and a trip
// down one branch projected onto another would be drawn running down the wrong avenue.
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

// The shapes drawn for a line the graph names. The display artifact carries no route ids, so the
// join is on the name a rider says plus the published color — the pair the two files agree on.
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

// The overlay's own artifact, fetched the first time a plan puts somebody on a train and kept for
// the life of the page. Same file the subway layer draws, so a reader who has had that overlay on
// has it in the browser cache already.
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

// Best snap per component, so park-path starts stay routable and cross-harbor queries fail honestly.

import { edgeKind, edgePath, isTransitEdge, type RoutingGraph } from "./graph";

export const SNAP_RADIUS_METERS = 300;

const METERS_PER_DEGREE_LAT = 111_320;
const TARGET_CELL_METERS = 250;
const EARTH_RADIUS_METERS = 6_371_000;
// Cell coordinates never reach this, so packed keys never collide.
const CELL_KEY_STRIDE = 1 << 20;

export interface SnapIndex {
  cellUnitsX: number; // cell size in quantized units, longitude
  cellUnitsY: number; // cell size in quantized units, latitude
  cellMeters: number; // the smaller cell side in meters, for ring termination
  cells: Map<number, Uint32Array>; // packed cell key -> edge ids whose bbox touches the cell
}

export interface Snap {
  edge: number;
  metersFromA: number; // along the polyline, for splitting cost and trimming geometry
  point: { lat: number; lng: number }; // the projected point on the edge
  distanceMeters: number; // query point to projected point
  component: number;
}

function cellKey(cellX: number, cellY: number): number {
  return cellX * CELL_KEY_STRIDE + cellY;
}

export function buildSnapIndex(graph: RoutingGraph): SnapIndex {
  const metersPerUnitLat = graph.scale * METERS_PER_DEGREE_LAT;
  const referenceLat = (graph.originLat + 0.25) * (Math.PI / 180);
  const metersPerUnitLng = metersPerUnitLat * Math.cos(referenceLat);
  const cellUnitsX = Math.max(
    1,
    Math.round(TARGET_CELL_METERS / metersPerUnitLng),
  );
  const cellUnitsY = Math.max(
    1,
    Math.round(TARGET_CELL_METERS / metersPerUnitLat),
  );
  const cellMeters = Math.min(
    cellUnitsX * metersPerUnitLng,
    cellUnitsY * metersPerUnitLat,
  );

  const buckets = new Map<number, number[]>();
  const cursor = { offset: 0 };
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    // Crossings, links, ferries and transit aren't indexed, so no walk snaps onto one.
    const kind = edgeKind(graph, edge);
    if (
      kind === "crossing" ||
      kind === "link" ||
      kind === "ferry" ||
      isTransitEdge(graph, edge)
    ) {
      continue;
    }
    cursor.offset = graph.edgeGeomOffset[edge];
    // The first delta is the absolute quantized position.
    let quantizedX = 0;
    let quantizedY = 0;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const count = graph.edgeGeomCount[edge];
    for (let vertex = 0; vertex < count; vertex++) {
      quantizedX += readVarint(graph.geometry, cursor);
      quantizedY += readVarint(graph.geometry, cursor);
      minX = Math.min(minX, quantizedX);
      maxX = Math.max(maxX, quantizedX);
      minY = Math.min(minY, quantizedY);
      maxY = Math.max(maxY, quantizedY);
    }
    const fromCellX = Math.floor(minX / cellUnitsX);
    const toCellX = Math.floor(maxX / cellUnitsX);
    const fromCellY = Math.floor(minY / cellUnitsY);
    const toCellY = Math.floor(maxY / cellUnitsY);
    for (let cellX = fromCellX; cellX <= toCellX; cellX++) {
      for (let cellY = fromCellY; cellY <= toCellY; cellY++) {
        const key = cellKey(cellX, cellY);
        const bucket = buckets.get(key);
        if (bucket) {
          bucket.push(edge);
        } else {
          buckets.set(key, [edge]);
        }
      }
    }
  }

  const cells = new Map<number, Uint32Array>();
  for (const [key, bucket] of buckets) {
    cells.set(key, Uint32Array.from(bucket));
  }
  return { cellUnitsX, cellUnitsY, cellMeters, cells };
}

function readVarint(bytes: Uint8Array, cursor: { offset: number }): number {
  let value = 0;
  let shift = 0;
  let byte = 0;
  do {
    byte = bytes[cursor.offset];
    cursor.offset += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return (value >>> 1) ^ -(value & 1);
}

function haversineMeters(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const toRad = Math.PI / 180;
  const lat1 = aLat * toRad;
  const lat2 = bLat * toRad;
  const deltaLat = (bLat - aLat) * toRad;
  const deltaLng = (bLng - aLng) * toRad;
  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);
  const inner =
    sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(inner)));
}

// Along-distance is scaled to the edge's geodesic length.
function projectToEdge(
  graph: RoutingGraph,
  edge: number,
  lat: number,
  lng: number,
): {
  metersFromA: number;
  point: { lat: number; lng: number };
  distanceMeters: number;
} {
  const { lngs, lats } = edgePath(graph, edge);
  const cosLat = Math.cos(lat * (Math.PI / 180));
  const localX = (vertexLng: number): number =>
    (vertexLng - lng) * METERS_PER_DEGREE_LAT * cosLat;
  const localY = (vertexLat: number): number =>
    (vertexLat - lat) * METERS_PER_DEGREE_LAT;

  let bestDistance2 = Number.POSITIVE_INFINITY;
  let bestSegment = 0;
  let bestParam = 0;
  let bestAlongRaw = 0;
  let alongRaw = 0;
  let previousX = localX(lngs[0]);
  let previousY = localY(lats[0]);
  for (let segment = 0; segment + 1 < lngs.length; segment++) {
    const nextX = localX(lngs[segment + 1]);
    const nextY = localY(lats[segment + 1]);
    const deltaX = nextX - previousX;
    const deltaY = nextY - previousY;
    const segmentLength2 = deltaX * deltaX + deltaY * deltaY;
    const param =
      segmentLength2 > 0
        ? Math.max(
            0,
            Math.min(
              1,
              (-previousX * deltaX + -previousY * deltaY) / segmentLength2,
            ),
          )
        : 0;
    const projectedX = previousX + param * deltaX;
    const projectedY = previousY + param * deltaY;
    const distance2 = projectedX * projectedX + projectedY * projectedY;
    if (distance2 < bestDistance2) {
      bestDistance2 = distance2;
      bestSegment = segment;
      bestParam = param;
      bestAlongRaw = alongRaw + param * Math.sqrt(segmentLength2);
    }
    alongRaw += Math.sqrt(segmentLength2);
    previousX = nextX;
    previousY = nextY;
  }

  const scale = alongRaw > 0 ? graph.edgeLength[edge] / alongRaw : 0;
  const point = {
    lat:
      lats[bestSegment] +
      bestParam * (lats[bestSegment + 1] - lats[bestSegment]),
    lng:
      lngs[bestSegment] +
      bestParam * (lngs[bestSegment + 1] - lngs[bestSegment]),
  };
  return {
    metersFromA: bestAlongRaw * scale,
    point,
    distanceMeters: Math.sqrt(bestDistance2),
  };
}

// Expanding rings, so a dense query point stops early.
export function snapCandidates(
  graph: RoutingGraph,
  index: SnapIndex,
  point: { lat: number; lng: number },
): Snap[] {
  const quantizedX = Math.round((point.lng - graph.originLng) / graph.scale);
  const quantizedY = Math.round((point.lat - graph.originLat) / graph.scale);
  const centerCellX = Math.floor(quantizedX / index.cellUnitsX);
  const centerCellY = Math.floor(quantizedY / index.cellUnitsY);
  const maxRing = Math.ceil(SNAP_RADIUS_METERS / index.cellMeters) + 1;

  const best = new Map<number, Snap>();
  const visited = new Set<number>();
  for (let ring = 0; ring <= maxRing; ring++) {
    for (let cellX = centerCellX - ring; cellX <= centerCellX + ring; cellX++) {
      for (
        let cellY = centerCellY - ring;
        cellY <= centerCellY + ring;
        cellY++
      ) {
        const onRing =
          Math.abs(cellX - centerCellX) === ring ||
          Math.abs(cellY - centerCellY) === ring;
        if (!onRing) {
          continue;
        }
        const edges = index.cells.get(cellKey(cellX, cellY));
        if (!edges) {
          continue;
        }
        for (const edge of edges) {
          if (visited.has(edge)) {
            continue;
          }
          visited.add(edge);
          const projection = projectToEdge(graph, edge, point.lat, point.lng);
          if (projection.distanceMeters > SNAP_RADIUS_METERS) {
            continue;
          }
          // Each sidewalk has its own offset geometry, so the nearest edge is the nearer side.
          const component = graph.nodeComponent[graph.edgeNodeA[edge]];
          const incumbent = best.get(component);
          if (
            !incumbent ||
            projection.distanceMeters < incumbent.distanceMeters
          ) {
            best.set(component, {
              edge,
              metersFromA: projection.metersFromA,
              point: projection.point,
              distanceMeters: projection.distanceMeters,
              component,
            });
          }
        }
      }
    }
  }
  return [...best.values()];
}

export type SnapPair =
  | { ok: true; start: Snap; dest: Snap }
  | { ok: false; reason: "startTooFar" | "destTooFar" | "disconnected" };

export function snapPair(
  graph: RoutingGraph,
  index: SnapIndex,
  start: { lat: number; lng: number },
  dest: { lat: number; lng: number },
): SnapPair {
  const startCandidates = snapCandidates(graph, index, start);
  if (startCandidates.length === 0) {
    return { ok: false, reason: "startTooFar" };
  }
  const destCandidates = snapCandidates(graph, index, dest);
  if (destCandidates.length === 0) {
    return { ok: false, reason: "destTooFar" };
  }

  const destByComponent = new Map<number, Snap>();
  for (const candidate of destCandidates) {
    destByComponent.set(candidate.component, candidate);
  }

  let bestStart: Snap | null = null;
  let bestDest: Snap | null = null;
  let bestTotal = Number.POSITIVE_INFINITY;
  for (const startCandidate of startCandidates) {
    const destCandidate = destByComponent.get(startCandidate.component);
    if (!destCandidate) {
      continue;
    }
    const total = startCandidate.distanceMeters + destCandidate.distanceMeters;
    if (total < bestTotal) {
      bestTotal = total;
      bestStart = startCandidate;
      bestDest = destCandidate;
    }
  }

  if (!bestStart || !bestDest) {
    return { ok: false, reason: "disconnected" };
  }
  return { ok: true, start: bestStart, dest: bestDest };
}

export { haversineMeters };

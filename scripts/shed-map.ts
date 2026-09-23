// A shed may cover only its own tax lot's frontage; length past that is dropped.
// Every constant here was measured against the whole feed; do not tune them by eye.

import {
  edgeGeometryRight,
  edgeKind,
  edgeName,
  edgePath,
  edgeSideLabel,
  type RoutingGraph,
  type SideLabel,
} from "../src/routing/graph";
import {
  boundsOf,
  boxGap,
  densifyRing,
  type LineProjection,
  newProjection,
  outwardNormals,
  pointAt,
  polylineLength,
  projectToPolyline,
  projectX,
  projectY,
  ringCentroid,
  ringSignedArea,
  ringToPoint,
  ringToPolyline,
  ringToRing,
} from "./planar";
import type { Ring } from "./shed-parcels";
import { streetScore } from "./shed-streets";

const FEET_PER_METER = 3.280839895;
// Past the widest plausible setback: a rear wall, interior lot line or waterfront edge.
const MAX_FRONTAGE_METERS = 30;
// ~70 degrees off the wall's outward normal.
const FACING_COSINE = 0.34;
// Wide enough that the named street is in the pool even when the lot does not reach it.
const CANDIDATE_RADIUS_METERS = 70;
const RING_STEP_METERS = 1;
// Twice the sample step, so a projection pinned to a polyline's end never continues.
const FRONTAGE_STEP_METERS = 2 * RING_STEP_METERS;
const NORMAL_WINDOW = 3;
const NAME_MATCH_THRESHOLD = 0.6;
// Shorter is projection noise.
const MIN_SPAN_METERS = 2;
// A deep lot's side lines face the sidewalk at a glancing angle and would stretch the span.
const FRONTAGE_DEPTH_METERS = 8;
// A same-name sidewalk further behind the near one is across the street.
const SIDE_BAND_METERS = 7;
// One ~90 degree corner plus drift, not a lap of a cul-de-sac.
const MAX_WRAP_TURN_DEGREES = 150;
// Sharper is a dead end or a service loop.
const MAX_JUNCTION_TURN_DEGREES = 100;
// Coarse: it only orders arcs.
const ARC_SAMPLE_STEP_METERS = 5;
const GRID_CELL_METERS = 150;
const CELL_KEY_OFFSET = 1 << 20;
const CELL_KEY_STRIDE = 1 << 21;

// No NYC dataset has sidewalk widths, so deck depth is the lot line's offset from the baked line.
const SIDEWALK_INSET_METERS = 2; // the manifest's streets.sidewalkInsetMeters
// DOB wants the roadway clear.
const CURB_MARGIN_METERS = 0.3;
// Side lot lines climb away from the closest distance; only samples this near are the street wall.
const STREET_WALL_BAND_METERS = 2;
// The floor keeps a depth off the 0 byte ("unmeasured"); the reader floors what can be built.
const MIN_DECK_DEPTH_METERS = 0.1;
const MAX_DECK_DEPTH_METERS = 8;

export interface SidewalkIndex {
  graph: RoutingGraph;
  edges: Uint32Array; // position -> graph edge id
  positionOf: Int32Array; // graph edge id -> position, -1 when not a sidewalk
  lines: Float64Array[]; // position -> projected polyline
  lengths: Float64Array;
  boxes: Float64Array[];
  cells: Map<number, Uint32Array>; // grid cell -> positions whose box touches it
  nodeSidewalks: Map<number, number[]>; // node id -> incident sidewalk edge ids
}

function cellKey(cellX: number, cellY: number): number {
  return (
    (cellX + CELL_KEY_OFFSET) * CELL_KEY_STRIDE + (cellY + CELL_KEY_OFFSET)
  );
}

export function buildSidewalkIndex(graph: RoutingGraph): SidewalkIndex {
  const edges: number[] = [];
  const lines: Float64Array[] = [];
  const lengths: number[] = [];
  const boxes: Float64Array[] = [];
  const positionOf = new Int32Array(graph.edgeCount).fill(-1);
  const nodeSidewalks = new Map<number, number[]>();
  const buckets = new Map<number, number[]>();

  for (let edge = 0; edge < graph.edgeCount; edge++) {
    if (edgeKind(graph, edge) !== "sidewalk") {
      continue;
    }
    const { lngs, lats } = edgePath(graph, edge);
    if (lngs.length < 2) {
      continue;
    }
    const coords = new Float64Array(lngs.length * 2);
    for (let vertex = 0; vertex < lngs.length; vertex++) {
      coords[vertex * 2] = projectX(lngs[vertex]);
      coords[vertex * 2 + 1] = projectY(lats[vertex]);
    }
    const position = edges.length;
    positionOf[edge] = position;
    edges.push(edge);
    lines.push(coords);
    lengths.push(polylineLength(coords));
    const box = boundsOf(coords);
    boxes.push(box);
    for (const node of [graph.edgeNodeA[edge], graph.edgeNodeB[edge]]) {
      const incident = nodeSidewalks.get(node);
      if (incident) {
        incident.push(edge);
      } else {
        nodeSidewalks.set(node, [edge]);
      }
    }
    for (
      let cellX = Math.floor(box[0] / GRID_CELL_METERS);
      cellX <= Math.floor(box[2] / GRID_CELL_METERS);
      cellX++
    ) {
      for (
        let cellY = Math.floor(box[1] / GRID_CELL_METERS);
        cellY <= Math.floor(box[3] / GRID_CELL_METERS);
        cellY++
      ) {
        const key = cellKey(cellX, cellY);
        const bucket = buckets.get(key);
        if (bucket) {
          bucket.push(position);
        } else {
          buckets.set(key, [position]);
        }
      }
    }
  }

  const cells = new Map<number, Uint32Array>();
  for (const [key, bucket] of buckets) {
    cells.set(key, Uint32Array.from(bucket));
  }

  return {
    graph,
    edges: Uint32Array.from(edges),
    positionOf,
    lines,
    lengths: Float64Array.from(lengths),
    boxes,
    cells,
    nodeSidewalks,
  };
}

function edgesNear(index: SidewalkIndex, box: Float64Array): number[] {
  const found = new Set<number>();
  for (
    let cellX = Math.floor(box[0] / GRID_CELL_METERS);
    cellX <= Math.floor(box[2] / GRID_CELL_METERS);
    cellX++
  ) {
    for (
      let cellY = Math.floor(box[1] / GRID_CELL_METERS);
      cellY <= Math.floor(box[3] / GRID_CELL_METERS);
      cellY++
    ) {
      for (const position of index.cells.get(cellKey(cellX, cellY)) ?? []) {
        const other = index.boxes[position];
        if (
          other[0] <= box[2] &&
          other[2] >= box[0] &&
          other[1] <= box[3] &&
          other[3] >= box[1]
        ) {
          found.add(index.edges[position]);
        }
      }
    }
  }
  return [...found].sort((left, right) => left - right);
}

function lineOf(index: SidewalkIndex, edge: number): Float64Array {
  return index.lines[index.positionOf[edge]];
}

function lengthOf(index: SidewalkIndex, edge: number): number {
  return index.lengths[index.positionOf[edge]];
}

export interface ShedSpan {
  edge: number;
  t0: number;
  t1: number;
  meters: number;
  depthMeters: number; // building line to just short of the curb; NaN when unmeasurable
}

export interface ShedPlacement {
  status: "ok" | "noFootprint" | "noSidewalk" | "noNamedStreet";
  spans: ShedSpan[]; // descending by length
  geometrySource: "lot" | "building" | "none";
  primaryEdge: number | null;
  oppositeEdge: number | null;
  primaryDistance: number; // meters
  oppositeDistance: number; // meters
  sideMargin: number; // gap to the next-nearest same-name frontage candidate
  frontageMeters: number; // the lot's arc on the permit's street
  shedMeters: number; // what the permit claims
  coveredMeters: number;
  offStreetMeters: number; // on the lot's frontage on a street the permit does not name
  unplacedMeters: number;
  recoveredMeters: number; // on lot frontage the walk could not reach on foot
  measuredDepths: number;
  nameMatched: boolean;
  nameScore: number;
  confidence: number;
}

export interface ShedRequest {
  street: string;
  linearFeet: number; // NaN when the feed carries none
  lot: readonly Ring[] | null;
  footprint: readonly Ring[] | null;
  lng: number | null; // picks the part of a multi-part lot
  lat: number | null;
}

interface Arc {
  low: number;
  high: number;
}

interface Shadow extends Arc {
  distance: number;
  // Street wall's signed offset from the baked line, positive away from the roadway; NaN if none.
  offset: number;
}

interface WrapContext {
  street: string;
  scores: Map<number, number>; // memoized across the walk
}

function onStreet(
  index: SidewalkIndex,
  context: WrapContext,
  edge: number,
): boolean {
  let score = context.scores.get(edge);
  if (score === undefined) {
    score = streetScore(context.street, edgeName(index.graph, edge));
    context.scores.set(edge, score);
  }
  return score >= NAME_MATCH_THRESHOLD;
}

function toRing(ring: Ring): Float64Array {
  const projected = new Float64Array(ring.length);
  for (let at = 0; at < ring.length; at += 2) {
    projected[at] = projectX(ring[at]);
    projected[at + 1] = projectY(ring[at + 1]);
  }
  return ringSignedArea(projected) < 0 ? reverseRing(projected) : projected;
}

function reverseRing(ring: Float64Array): Float64Array {
  const out = new Float64Array(ring.length);
  for (let at = 0; at < ring.length; at += 2) {
    out[at] = ring[ring.length - 2 - at];
    out[at + 1] = ring[ring.length - 1 - at];
  }
  return out;
}

function ringArea(ring: Float64Array): number {
  return Math.abs(ringSignedArea(ring));
}

// The part nearest the anchor, or the largest when there is none.
function pickPartIndex(
  parts: readonly Float64Array[],
  anchorRing: Float64Array | null,
  anchorX: number,
  anchorY: number,
): number {
  const anchored = anchorRing !== null || Number.isFinite(anchorX);
  if (parts.length === 1 || !anchored) {
    let widest = 0;
    for (const [index, part] of parts.entries()) {
      if (ringArea(part) > ringArea(parts[widest])) {
        widest = index;
      }
    }
    return widest;
  } else {
    const distanceTo = (part: Float64Array): number =>
      anchorRing !== null
        ? ringToRing(part, anchorRing)
        : ringToPoint(part, anchorX, anchorY);
    let best = 0;
    let bestDistance = distanceTo(parts[0]);
    let bestArea = ringArea(parts[0]);
    for (const [index, part] of parts.entries()) {
      const distance = distanceTo(part);
      const area = ringArea(part);
      if (
        distance < bestDistance ||
        (distance === bestDistance && area > bestArea)
      ) {
        best = index;
        bestDistance = distance;
        bestArea = area;
      }
    }
    return best;
  }
}

function pickPart(
  parts: readonly Float64Array[],
  anchorRing: Float64Array | null,
  anchorX: number,
  anchorY: number,
): Float64Array {
  return parts[pickPartIndex(parts, anchorRing, anchorX, anchorY)];
}

// Graph-independent, so the daily job can store it and re-snap against a rebuilt graph.
export function pickShedParts(request: ShedRequest): {
  lot: Ring | null;
  footprint: Ring | null;
} {
  const pointX = request.lng === null ? Number.NaN : projectX(request.lng);
  const pointY = request.lat === null ? Number.NaN : projectY(request.lat);
  const buildings = (request.footprint ?? []).map(toRing);
  const footprint =
    buildings.length > 0
      ? pickPartIndex(buildings, null, pointX, pointY)
      : null;
  const lots = (request.lot ?? []).map(toRing);
  const lot =
    lots.length > 0
      ? pickPartIndex(
          lots,
          footprint === null ? null : buildings[footprint],
          pointX,
          pointY,
        )
      : null;
  return {
    lot: lot === null ? null : (request.lot as readonly Ring[])[lot],
    footprint:
      footprint === null
        ? null
        : (request.footprint as readonly Ring[])[footprint],
  };
}

// Reorders `scratch`.
function medianOf(scratch: Float64Array, count: number): number {
  if (count === 0) {
    return Number.NaN;
  }
  const values = scratch.subarray(0, count);
  values.sort();
  return count % 2 === 1
    ? values[(count - 1) / 2]
    : (values[count / 2 - 1] + values[count / 2]) / 2;
}

// Swept from the closest approach, not min-to-max, which spans a neighbor's pavement.
function frontageArc(
  alongs: Float64Array,
  distances: Float64Array,
  keep: (sample: number) => boolean,
): Arc | null {
  const count = alongs.length;
  let anchor = -1;
  for (let sample = 0; sample < count; sample++) {
    if (keep(sample) && (anchor < 0 || distances[sample] < distances[anchor])) {
      anchor = sample;
    }
  }
  if (anchor < 0) {
    return null;
  }
  const arc: Arc = { low: alongs[anchor], high: alongs[anchor] };
  for (const step of [-1, 1]) {
    for (let taken = 1; taken < count; taken++) {
      const sample = (anchor + step * taken + 2 * count) % count;
      const along = alongs[sample];
      // A jump means the boundary left this pavement.
      if (
        !keep(sample) ||
        along < arc.low - FRONTAGE_STEP_METERS ||
        along > arc.high + FRONTAGE_STEP_METERS
      ) {
        break;
      }
      arc.low = Math.min(arc.low, along);
      arc.high = Math.max(arc.high, along);
    }
  }
  return arc;
}

// Distance alone picks the sidewalk: a baked line inside the lot makes every wall face away.
function frontageShadows(
  index: SidewalkIndex,
  ring: Float64Array,
  candidates: readonly number[],
): Map<number, Shadow> {
  const points = densifyRing(ring, RING_STEP_METERS);
  const normals = outwardNormals(points, NORMAL_WINDOW);
  const box = boundsOf(points);
  const shadows = new Map<number, Shadow>();
  const projection: LineProjection = newProjection();
  const alongs = new Float64Array(points.length / 2);
  const distances = new Float64Array(points.length / 2);
  const facings = new Float64Array(points.length / 2);
  const offsets = new Float64Array(points.length / 2);
  const wall = new Float64Array(points.length / 2);

  for (const edge of candidates) {
    const coords = lineOf(index, edge);
    if (
      boxGap(box, index.boxes[index.positionOf[edge]]) > MAX_FRONTAGE_METERS
    ) {
      continue;
    }
    // A sidewalk is baked to its centerline's geometry-left unless flagged right.
    const outward = edgeGeometryRight(index.graph, edge) ? -1 : 1;
    let nearest = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < alongs.length; sample++) {
      const pointX = points[sample * 2];
      const pointY = points[sample * 2 + 1];
      projectToPolyline(coords, pointX, pointY, projection);
      alongs[sample] = projection.along;
      distances[sample] = projection.distance;
      nearest = Math.min(nearest, projection.distance);
      offsets[sample] =
        outward *
        (projection.tangentX * (pointY - projection.y) -
          projection.tangentY * (pointX - projection.x));
      const towardX = projection.x - pointX;
      const towardY = projection.y - pointY;
      const reach = Math.hypot(towardX, towardY);
      // On the line itself the offset vector is noise, so the point counts as facing.
      facings[sample] =
        reach < 0.5
          ? 1
          : (towardX * normals[sample * 2] +
              towardY * normals[sample * 2 + 1]) /
            reach;
    }
    if (nearest > MAX_FRONTAGE_METERS) {
      continue;
    }
    const depth = nearest + FRONTAGE_DEPTH_METERS;
    let walls = 0;
    for (let sample = 0; sample < alongs.length; sample++) {
      // Magnitude: a line inside the lot makes the street wall face away.
      if (
        distances[sample] <= nearest + STREET_WALL_BAND_METERS &&
        Math.abs(facings[sample]) >= FACING_COSINE
      ) {
        wall[walls] = offsets[sample];
        walls += 1;
      }
    }
    const arc =
      frontageArc(
        alongs,
        distances,
        (sample) =>
          distances[sample] <= depth && facings[sample] >= FACING_COSINE,
      ) ??
      // No facing wall, as when the baked line lands inside the lot.
      (frontageArc(
        alongs,
        distances,
        (sample) => distances[sample] <= depth,
      ) as Arc);
    // Median, not nearest: a stoop or bay reaches past the wall a shed follows.
    shadows.set(edge, {
      low: arc.low,
      high: arc.high,
      distance: nearest,
      offset: medianOf(wall, walls),
    });
  }
  return shadows;
}

const FLIPPED_SIDES: Readonly<Record<string, SideLabel>> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
};

function oppositeSidewalk(
  index: SidewalkIndex,
  edge: number,
  candidates: readonly number[],
): number | null {
  const { graph } = index;
  const nameId = graph.edgeNameId[edge];
  const flipped = FLIPPED_SIDES[edgeSideLabel(graph, edge) ?? ""];
  const reference = lineOf(index, edge);
  let best: number | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const other of candidates) {
    if (other === edge || graph.edgeNameId[other] !== nameId) {
      continue;
    }
    if (flipped !== undefined && edgeSideLabel(graph, other) !== flipped) {
      continue;
    }
    const line = lineOf(index, other);
    const middle = pointAt(line, lengthOf(index, other) / 2);
    const projection = projectToPolyline(
      reference,
      middle.x,
      middle.y,
      newProjection(),
    );
    // Scored mid-to-line so a sidewalk merely touching at a corner loses to one alongside.
    const score =
      Math.max(0, polylineDistance(reference, line)) + projection.distance;
    if (score < bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best;
}

function polylineDistance(left: Float64Array, right: Float64Array): number {
  let best = Number.POSITIVE_INFINITY;
  for (let at = 0; at < right.length; at += 2) {
    best = Math.min(
      best,
      pointToPolylineDistance(left, right[at], right[at + 1]),
    );
  }
  for (let at = 0; at < left.length; at += 2) {
    best = Math.min(
      best,
      pointToPolylineDistance(right, left[at], left[at + 1]),
    );
  }
  return best;
}

function pointToPolylineDistance(
  coords: Float64Array,
  x: number,
  y: number,
): number {
  return projectToPolyline(coords, x, y, newProjection()).distance;
}

function deckDepth(shadow: Shadow | undefined): number {
  if (shadow === undefined || !Number.isFinite(shadow.offset)) {
    return Number.NaN;
  }
  const depth = SIDEWALK_INSET_METERS + shadow.offset - CURB_MARGIN_METERS;
  return Math.min(
    MAX_DECK_DEPTH_METERS,
    Math.max(MIN_DECK_DEPTH_METERS, depth),
  );
}

// Unmeasured spans take the shed's own median; returns how many were measured.
function fillDepths(spans: ShedSpan[]): number {
  const measured = Float64Array.from(
    spans.map((span) => span.depthMeters).filter(Number.isFinite),
  );
  const fallback = medianOf(measured, measured.length);
  for (const span of spans) {
    if (!Number.isFinite(span.depthMeters)) {
      span.depthMeters = fallback;
    }
  }
  return measured.length;
}

// Ranks frontage arcs, not edges: a rebuild re-cuts one curb into different edges.
interface Seat {
  edge: number;
  along: number;
}
function seatOf(
  index: SidewalkIndex,
  seeds: ReadonlyMap<number, Arc>,
  anchorX: number,
  anchorY: number,
): Seat {
  const projection: LineProjection = newProjection();
  const seats = [...seeds].map(([edge, arc]) => {
    const coords = lineOf(index, edge);
    projectToPolyline(coords, anchorX, anchorY, projection);
    const along = Math.min(Math.max(projection.along, arc.low), arc.high);
    const at = pointAt(coords, along);
    const middle = pointAt(coords, (arc.low + arc.high) / 2);
    return {
      edge,
      along,
      distance: Math.hypot(at.x - anchorX, at.y - anchorY),
      width: arc.high - arc.low,
      middle,
    };
  });
  // A pinched arc has no room to grow; ties break on geometry since edge ids are positional.
  seats.sort(
    (left, right) =>
      Number(right.width >= MIN_SPAN_METERS) -
        Number(left.width >= MIN_SPAN_METERS) ||
      left.distance - right.distance ||
      right.width - left.width ||
      left.middle.x - right.middle.x ||
      left.middle.y - right.middle.y,
  );
  return seats[0];
}

export function placeShed(
  index: SidewalkIndex,
  request: ShedRequest,
): ShedPlacement {
  const { graph } = index;
  const result: ShedPlacement = {
    status: "ok",
    spans: [],
    geometrySource: "none",
    primaryEdge: null,
    oppositeEdge: null,
    primaryDistance: Number.NaN,
    oppositeDistance: Number.NaN,
    sideMargin: Number.NaN,
    frontageMeters: Number.NaN,
    shedMeters:
      request.linearFeet > 0 ? request.linearFeet / FEET_PER_METER : Number.NaN,
    coveredMeters: 0,
    offStreetMeters: 0,
    unplacedMeters: 0,
    recoveredMeters: 0,
    measuredDepths: 0,
    nameMatched: false,
    nameScore: 0,
    confidence: 0,
  };

  const pointX = request.lng === null ? Number.NaN : projectX(request.lng);
  const pointY = request.lat === null ? Number.NaN : projectY(request.lat);
  const buildings = (request.footprint ?? []).map(toRing);
  const footprint =
    buildings.length > 0 ? pickPart(buildings, null, pointX, pointY) : null;
  const lots = (request.lot ?? []).map(toRing);
  const lot =
    lots.length > 0 ? pickPart(lots, footprint, pointX, pointY) : null;
  const frontage = lot ?? footprint;
  result.geometrySource =
    lot !== null ? "lot" : footprint !== null ? "building" : "none";
  if (frontage === null) {
    result.status = "noFootprint";
    return result;
  }

  const box = boundsOf(frontage);
  const candidates = edgesNear(
    index,
    Float64Array.of(
      box[0] - CANDIDATE_RADIUS_METERS,
      box[1] - CANDIDATE_RADIUS_METERS,
      box[2] + CANDIDATE_RADIUS_METERS,
      box[3] + CANDIDATE_RADIUS_METERS,
    ),
  );
  if (candidates.length === 0) {
    result.status = "noSidewalk";
    return result;
  }

  const shadows = frontageShadows(index, frontage, candidates);
  if (shadows.size === 0) {
    result.status = "noSidewalk";
    return result;
  }

  const scores = new Map<number, number>();
  for (const edge of candidates) {
    scores.set(edge, streetScore(request.street, edgeName(graph, edge)));
  }
  let named = [...shadows].filter(
    ([edge]) => (scores.get(edge) ?? 0) >= NAME_MATCH_THRESHOLD,
  );
  result.nameMatched = named.length > 0;
  if (named.length === 0) {
    // A renamed street, private drive or plaza address: take the closest frontage.
    result.status = "noNamedStreet";
    let closest = candidates[0];
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const [edge, shadow] of shadows) {
      if (shadow.distance < closestDistance) {
        closestDistance = shadow.distance;
        closest = edge;
      }
    }
    named = [[closest, shadows.get(closest) as Shadow]];
  }

  // The opposite sidewalk also faces the lot and would seed a span a roadbed away.
  const nearest = Math.min(...named.map(([, shadow]) => shadow.distance));
  const behind = named
    .map(([, shadow]) => shadow.distance)
    .filter((distance) => distance > nearest + 1e-6);
  result.sideMargin =
    behind.length > 0
      ? Math.min(...behind) - nearest
      : Number.POSITIVE_INFINITY;

  const seeds = new Map<number, Arc>();
  for (const [edge, shadow] of named) {
    if (shadow.distance <= nearest + SIDE_BAND_METERS) {
      seeds.set(edge, { low: shadow.low, high: shadow.high });
    }
  }
  const spans = new Map<number, Arc>();
  let frontageMeters = 0;
  for (const [edge, arc] of seeds) {
    spans.set(edge, { low: arc.low, high: arc.high });
    frontageMeters += arc.high - arc.low;
  }
  const center = ringCentroid(footprint ?? frontage);
  const seat = seatOf(index, seeds, center.x, center.y);
  const primary = seat.edge;
  result.frontageMeters = frontageMeters;
  result.nameScore = scores.get(primary) ?? 0;

  const context: WrapContext = {
    street: result.nameMatched
      ? request.street
      : (edgeName(graph, primary) ?? request.street),
    scores: result.nameMatched ? scores : new Map(),
  };
  // All the shed may cover; the side band also excludes pavement across a side street.
  const lotArcs = new Map<number, Arc>();
  for (const [edge, shadow] of shadows) {
    if (
      shadow.distance <= nearest + SIDE_BAND_METERS &&
      shadow.high - shadow.low >= MIN_SPAN_METERS
    ) {
      lotArcs.set(edge, { low: shadow.low, high: shadow.high });
    }
  }

  const target =
    Number.isFinite(result.shedMeters) && result.shedMeters > 0
      ? result.shedMeters
      : frontageMeters;
  if (target < frontageMeters) {
    // One continuous run in front of the building, not the whole lot line thinned out.
    const bounds = new Map(
      [...spans].map(([edge, arc]) => [edge, { low: arc.low, high: arc.high }]),
    );
    spans.clear();
    spans.set(primary, { low: seat.along, high: seat.along });
    const stranded = growSpans(index, spans, primary, target, context, bounds);
    if (stranded > MIN_SPAN_METERS) {
      const anchorPoint = pointAt(lineOf(index, primary), seat.along);
      result.recoveredMeters =
        stranded - placeOnSeeds(index, spans, bounds, anchorPoint, stranded);
    }
  } else if (target > frontageMeters) {
    // Spilled where the walk can't reach: the network dead-ends pavement at every curb.
    const stranded = growSpans(
      index,
      spans,
      primary,
      target - frontageMeters,
      context,
      lotArcs,
    );
    if (stranded > MIN_SPAN_METERS) {
      const anchorPoint = pointAt(lineOf(index, primary), seat.along);
      result.recoveredMeters =
        stranded - placeOnSeeds(index, spans, lotArcs, anchorPoint, stranded);
    }
  }

  const placed: ShedSpan[] = [];
  for (const [edge, arc] of spans) {
    const rawLength = lengthOf(index, edge);
    if (rawLength <= 0) {
      continue;
    }
    const meters = ((arc.high - arc.low) / rawLength) * graph.edgeLength[edge];
    if (meters < MIN_SPAN_METERS) {
      continue;
    }
    placed.push({
      edge,
      t0: Math.max(0, arc.low / rawLength),
      t1: Math.min(1, arc.high / rawLength),
      meters,
      depthMeters: deckDepth(shadows.get(edge)),
    });
  }
  placed.sort((left, right) => right.meters - left.meters);
  result.measuredDepths = fillDepths(placed);
  result.spans = placed;
  result.coveredMeters = placed.reduce((total, span) => total + span.meters, 0);
  result.offStreetMeters = placed
    .filter((span) => !onStreet(index, context, span.edge))
    .reduce((total, span) => total + span.meters, 0);
  result.unplacedMeters = Number.isFinite(result.shedMeters)
    ? Math.max(0, result.shedMeters - result.coveredMeters)
    : 0;

  result.primaryEdge = primary;
  result.primaryDistance = ringToPolyline(frontage, lineOf(index, primary));
  const opposite = oppositeSidewalk(index, primary, candidates);
  result.oppositeEdge = opposite;
  if (opposite !== null) {
    result.oppositeDistance = ringToPolyline(frontage, lineOf(index, opposite));
  }
  result.confidence = confidenceOf(result);
  return result;
}

// In [0, 1]: a product of independent ways the placement can be wrong.
export function confidenceOf(result: ShedPlacement): number {
  if (result.spans.length === 0) {
    return 0;
  }
  const street = result.nameScore >= 0.99 ? 1 : result.nameMatched ? 0.8 : 0.35;
  const margin = result.oppositeDistance - result.primaryDistance;
  const gap = Number.isFinite(margin) ? margin : result.sideMargin;
  const side = Number.isFinite(gap)
    ? Math.min(1, Math.max(0.15, gap / 8))
    : 0.5;
  const measured =
    !Number.isFinite(result.shedMeters) ||
    result.shedMeters <= result.frontageMeters
      ? 1
      : result.frontageMeters / result.shedMeters;
  // A permit short against its frontage could sit anywhere along it.
  const fill =
    !Number.isFinite(result.shedMeters) || result.frontageMeters <= 0.5
      ? 1
      : result.shedMeters / result.frontageMeters;
  const placed = fill >= 0.5 ? 1 : Math.min(1, Math.max(0.4, 2 * fill));
  const source = result.geometrySource === "lot" ? 1 : 0.9;
  const share = (meters: number): number =>
    Math.min(1, Math.max(0, meters / result.coveredMeters));
  const onLicense =
    result.coveredMeters <= 0 ? 1 : 1 - 0.25 * share(result.offStreetMeters);
  const contiguity =
    result.coveredMeters <= 0 ? 1 : 1 - 0.15 * share(result.recoveredMeters);
  const product =
    street *
    side *
    (0.35 + 0.65 * measured) *
    placed *
    source *
    onLicense *
    contiguity;
  return Math.round(product * 1000) / 1000;
}

// Half each way to center the shed, then again so a blocked side's leftover goes to the other.
function growSpans(
  index: SidewalkIndex,
  spans: Map<number, Arc>,
  primary: number,
  extra: number,
  context: WrapContext,
  bounds: ReadonlyMap<number, Arc>,
): number {
  const shares = [extra / 2, extra / 2, 0, 0];
  let leftover = 0;
  for (let pass = 0; pass < shares.length; pass++) {
    const budget = leftover + shares[pass];
    if (budget <= 0.5) {
      break;
    }
    leftover = walk(
      index,
      spans,
      primary,
      pass % 2 === 0 ? -1 : 1,
      budget,
      bounds,
      context,
    );
  }
  return leftover;
}

// Returns what could not be spent.
function walk(
  index: SidewalkIndex,
  spans: Map<number, Arc>,
  primary: number,
  startDirection: number,
  budget: number,
  bounds: ReadonlyMap<number, Arc>,
  context: WrapContext,
): number {
  const { graph } = index;
  let edge = primary;
  let direction = startDirection;
  let remaining = budget;
  let turned = 0;
  const visited = new Set([primary]);
  while (remaining > 0.5) {
    remaining = spend(spans, edge, direction, remaining, bounds);
    if (remaining <= 0.5) {
      break;
    }
    const node = direction < 0 ? graph.edgeNodeA[edge] : graph.edgeNodeB[edge];
    const following = nextSidewalk(index, edge, node, visited, context);
    if (following === null) {
      break;
    }
    if (
      following.turn > MAX_JUNCTION_TURN_DEGREES ||
      turned + following.turn > MAX_WRAP_TURN_DEGREES
    ) {
      break;
    }
    turned += following.turn;
    edge = following.edge;
    visited.add(edge);
    if (!spans.has(edge)) {
      const entry = following.atA ? 0 : lengthOf(index, edge);
      // Enter at the arc's near end, not the node, or the pavement in between gets covered.
      const arc = bounds.get(edge);
      const clamped = arc
        ? Math.min(Math.max(entry, arc.low), arc.high)
        : entry;
      spans.set(edge, { low: clamped, high: clamped });
    }
    direction = following.atA ? 1 : -1;
  }
  return remaining;
}

function spend(
  spans: Map<number, Arc>,
  edge: number,
  direction: number,
  remaining: number,
  bounds: ReadonlyMap<number, Arc>,
): number {
  const limit = bounds.get(edge);
  if (limit === undefined) {
    // Not this lot's frontage: pass through without spending.
    return remaining;
  }
  const arc = spans.get(edge) as Arc;
  if (direction < 0) {
    const step = Math.min(Math.max(0, arc.low - limit.low), remaining);
    arc.low -= step;
    return remaining - step;
  } else {
    const step = Math.min(Math.max(0, limit.high - arc.high), remaining);
    arc.high += step;
    return remaining - step;
  }
}

// Staying on the permit's street beats the straightest turn; never crosses to the next block.
function nextSidewalk(
  index: SidewalkIndex,
  edge: number,
  node: number,
  visited: ReadonlySet<number>,
  context: WrapContext,
): { edge: number; atA: boolean; turn: number } | null {
  const { graph } = index;
  const coords = lineOf(index, edge);
  const last = coords.length;
  const arrivingX =
    graph.edgeNodeB[edge] === node
      ? coords[last - 2] - coords[last - 4]
      : coords[0] - coords[2];
  const arrivingY =
    graph.edgeNodeB[edge] === node
      ? coords[last - 1] - coords[last - 3]
      : coords[1] - coords[3];
  const arrivingScale = 1 / Math.max(Math.hypot(arrivingX, arrivingY), 1e-9);

  let bestSame: { edge: number; atA: boolean; turn: number } | null = null;
  let bestSameAlignment = Number.NEGATIVE_INFINITY;
  let bestAny: { edge: number; atA: boolean; turn: number } | null = null;
  let bestAnyAlignment = Number.NEGATIVE_INFINITY;
  for (const other of index.nodeSidewalks.get(node) ?? []) {
    if (other === edge || visited.has(other)) {
      continue;
    }
    const line = lineOf(index, other);
    const atA = graph.edgeNodeA[other] === node;
    const leavingX = atA
      ? line[2] - line[0]
      : line[line.length - 4] - line[line.length - 2];
    const leavingY = atA
      ? line[3] - line[1]
      : line[line.length - 3] - line[line.length - 1];
    const leavingScale = 1 / Math.max(Math.hypot(leavingX, leavingY), 1e-9);
    const alignment = Math.min(
      1,
      Math.max(
        -1,
        (arrivingX * leavingX + arrivingY * leavingY) *
          arrivingScale *
          leavingScale,
      ),
    );
    const turn = (Math.acos(alignment) * 180) / Math.PI;
    if (alignment > bestAnyAlignment) {
      bestAnyAlignment = alignment;
      bestAny = { edge: other, atA, turn };
    }
    if (
      alignment > bestSameAlignment &&
      turn <= MAX_JUNCTION_TURN_DEGREES &&
      onStreet(index, context, other)
    ) {
      bestSameAlignment = alignment;
      bestSame = { edge: other, atA, turn };
    }
  }
  return bestSame ?? bestAny;
}

// Spills a stranded run onto the lot's unreached frontage, nearest first; returns what's left.
function placeOnSeeds(
  index: SidewalkIndex,
  spans: Map<number, Arc>,
  bounds: Map<number, Arc>,
  anchor: { x: number; y: number },
  stranded: number,
): number {
  const distanceToArc = (edge: number, arc: Arc): number => {
    const coords = lineOf(index, edge);
    const steps = Math.max(
      2,
      Math.floor((arc.high - arc.low) / ARC_SAMPLE_STEP_METERS) + 1,
    );
    let best = Number.POSITIVE_INFINITY;
    for (let step = 0; step < steps; step++) {
      const at = pointAt(
        coords,
        arc.low + ((arc.high - arc.low) * step) / (steps - 1),
      );
      best = Math.min(best, Math.hypot(at.x - anchor.x, at.y - anchor.y));
    }
    return best;
  };
  // Ties break on geometry since edge ids are positional.
  const order = [...bounds]
    .map(([edge, arc]) => ({
      edge,
      arc,
      distance: distanceToArc(edge, arc),
      middle: pointAt(lineOf(index, edge), (arc.low + arc.high) / 2),
    }))
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        left.middle.x - right.middle.x ||
        left.middle.y - right.middle.y,
    );

  let remaining = stranded;
  for (const { edge, arc } of order) {
    if (remaining <= MIN_SPAN_METERS) {
      break;
    }
    if (arc.high - arc.low <= MIN_SPAN_METERS) {
      continue;
    }
    const existing = spans.get(edge);
    if (
      existing === undefined ||
      existing.high - existing.low < MIN_SPAN_METERS
    ) {
      // Centered on the point nearest the anchor, clamped into the arc.
      const width = Math.min(remaining, arc.high - arc.low);
      const projection = projectToPolyline(
        lineOf(index, edge),
        anchor.x,
        anchor.y,
        newProjection(),
      );
      const center = Math.min(
        Math.max(projection.along, arc.low + width / 2),
        arc.high - width / 2,
      );
      spans.set(edge, { low: center - width / 2, high: center + width / 2 });
      remaining -= width;
    } else {
      const before = Math.min(Math.max(0, existing.low - arc.low), remaining);
      existing.low -= before;
      remaining -= before;
      const after = Math.min(Math.max(0, arc.high - existing.high), remaining);
      existing.high += after;
      remaining -= after;
    }
  }
  return remaining;
}

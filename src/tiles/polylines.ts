import { projectX, projectY } from "./mercator";
import { type Cursor, readVarint } from "./varint";

// Mercator scales uniformly with zoom, so a direction taken at any zoom holds at all of them.
const NORMAL_ZOOM = 0;
// Max stretch of a mitred normal before the corner is cut, so a doubled-back vertex can't fling it.
const MITER_LIMIT = 2;

export interface Polyline {
  lngs: Float64Array;
  lats: Float64Array;
}

// Varint (lng, lat) deltas, the first from the file origin, the rest from the previous vertex.
export function readPolyline(
  bytes: Uint8Array,
  cursor: Cursor,
  vertices: number,
  originLng: number,
  originLat: number,
  scale: number,
): Polyline {
  const lngs = new Float64Array(vertices);
  const lats = new Float64Array(vertices);
  let quantizedX = 0;
  let quantizedY = 0;
  for (let vertex = 0; vertex < vertices; vertex++) {
    quantizedX += readVarint(bytes, cursor);
    quantizedY += readVarint(bytes, cursor);
    lngs[vertex] = originLng + quantizedX * scale;
    lats[vertex] = originLat + quantizedY * scale;
  }
  return { lngs, lats };
}

// A u32 count, then each name as a u16 byte length and that many UTF-8 bytes.
export function decodeNames(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
): string[] {
  const decoder = new TextDecoder();
  const names: string[] = [];
  let cursor = offset + 4;
  for (let name = 0; name < view.getUint32(offset, true); name++) {
    const length = view.getUint16(cursor, true);
    cursor += 2;
    names.push(decoder.decode(bytes.subarray(cursor, cursor + length)));
    cursor += length;
  }
  return names;
}

// Polyline indices keyed `${cellX},${cellY}`, each under every cell its bounding box spans.
export function bucketize(
  polylines: readonly Polyline[],
  cellDeg: number,
): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  for (let index = 0; index < polylines.length; index++) {
    const { lngs, lats } = polylines[index];
    let minLng = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    for (let vertex = 0; vertex < lngs.length; vertex++) {
      minLng = Math.min(minLng, lngs[vertex]);
      maxLng = Math.max(maxLng, lngs[vertex]);
      minLat = Math.min(minLat, lats[vertex]);
      maxLat = Math.max(maxLat, lats[vertex]);
    }
    for (
      let cellX = Math.floor(minLng / cellDeg);
      cellX <= Math.floor(maxLng / cellDeg);
      cellX++
    ) {
      for (
        let cellY = Math.floor(minLat / cellDeg);
        cellY <= Math.floor(maxLat / cellDeg);
        cellY++
      ) {
        const key = `${cellX},${cellY}`;
        const cell = buckets.get(key);
        if (cell) {
          cell.push(index);
        } else {
          buckets.set(key, [index]);
        }
      }
    }
  }
  return buckets;
}

// `route` indexes the order the caller wants the lanes stacked in.
export interface RoutedPolyline extends Polyline {
  route: number;
}

export interface LaneOptions {
  // Routes closer than this share a lane stack.
  cellMeters: number;
  // Distance over which a route slides between lanes, so it doesn't step sideways at a vertex.
  blendMeters: number;
  // Where the distances above are measured; within a degree is enough across a city.
  latitude: number;
}

export const METERS_PER_DEGREE_LAT = 111_320;

export function metersPerLng(lat: number): number {
  return METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
}

interface Walked {
  sampleLngs: Float64Array;
  sampleLats: Float64Array;
  // Unit direction of the sample's span, in the projected space the normals are built in.
  sampleDirX: Float64Array;
  sampleDirY: Float64Array;
}

// Resampled at half a cell because shapes are coarse in open water, leaving cells between vertices.
function walk(
  { lngs, lats }: Polyline,
  cellLng: number,
  cellLat: number,
): Walked {
  const count = lngs.length;
  const sampleLngs: number[] = [];
  const sampleLats: number[] = [];
  const sampleDirX: number[] = [];
  const sampleDirY: number[] = [];
  let lastDirX = 0;
  let lastDirY = 0;
  for (let vertex = 0; vertex + 1 < count; vertex++) {
    const deltaLng = lngs[vertex + 1] - lngs[vertex];
    const deltaLat = lats[vertex + 1] - lats[vertex];
    const deltaX =
      projectX(lngs[vertex + 1], NORMAL_ZOOM) -
      projectX(lngs[vertex], NORMAL_ZOOM);
    const deltaY =
      projectY(lats[vertex + 1], NORMAL_ZOOM) -
      projectY(lats[vertex], NORMAL_ZOOM);
    const projected = Math.hypot(deltaX, deltaY);
    if (projected > 0) {
      lastDirX = deltaX / projected;
      lastDirY = deltaY / projected;
    }
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(deltaLng / cellLng, deltaLat / cellLat) * 2),
    );
    for (let step = 0; step < steps; step++) {
      const along = step / steps;
      sampleLngs.push(lngs[vertex] + deltaLng * along);
      sampleLats.push(lats[vertex] + deltaLat * along);
      sampleDirX.push(lastDirX);
      sampleDirY.push(lastDirY);
    }
  }
  sampleLngs.push(lngs[count - 1]);
  sampleLats.push(lats[count - 1]);
  sampleDirX.push(lastDirX);
  sampleDirY.push(lastDirY);
  return {
    sampleLngs: Float64Array.from(sampleLngs),
    sampleLats: Float64Array.from(sampleLats),
    sampleDirX: Float64Array.from(sampleDirX),
    sampleDirY: Float64Array.from(sampleDirY),
  };
}

const NEIGHBORS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const NO_CELL = -1;

// Every occupied cell, resolved once because every pass below reads it (3x faster on the subway).
interface Occupancy {
  idOf: Map<string, number>;
  routes: Set<number>[];
  adjoining: Int32Array; // NEIGHBORS.length per cell, NO_CELL where no line runs
  sampled: Int32Array[]; // per line, the cell each of its samples fell in
}

function occupancyOf(
  lines: readonly RoutedPolyline[],
  walked: readonly Walked[],
  cellLng: number,
  cellLat: number,
): Occupancy {
  const idOf = new Map<string, number>();
  const cellX: number[] = [];
  const cellY: number[] = [];
  const routes: Set<number>[] = [];
  const sampled = walked.map(({ sampleLngs, sampleLats }, index) =>
    Int32Array.from(sampleLngs, (lng, sample) => {
      const atX = Math.floor(lng / cellLng);
      const atY = Math.floor(sampleLats[sample] / cellLat);
      const key = `${atX},${atY}`;
      let cell = idOf.get(key);
      if (cell === undefined) {
        cell = cellX.length;
        idOf.set(key, cell);
        cellX.push(atX);
        cellY.push(atY);
        routes.push(new Set());
      }
      routes[cell].add(lines[index].route);
      return cell;
    }),
  );

  const adjoining = new Int32Array(cellX.length * NEIGHBORS.length);
  for (let cell = 0; cell < cellX.length; cell++) {
    NEIGHBORS.forEach(([alongX, alongY], side) => {
      adjoining[cell * NEIGHBORS.length + side] =
        idOf.get(`${cellX[cell] + alongX},${cellY[cell] + alongY}`) ?? NO_CELL;
    });
  }
  return { idOf, routes, adjoining, sampled };
}

// Per cell, 1 where the route runs, tapering to 0 over `blendMeters` walked through occupied cells.
function presenceOf(
  { routes, adjoining }: Occupancy,
  route: number,
  cellMeters: number,
  blendMeters: number,
): Float64Array {
  const spread = new Float64Array(routes.length).fill(Number.POSITIVE_INFINITY);
  const pending: number[] = [];
  for (let cell = 0; cell < routes.length; cell++) {
    if (routes[cell].has(route)) {
      spread[cell] = 0;
      pending.push(cell);
    }
  }
  const steps = NEIGHBORS.map(
    ([alongX, alongY]) => cellMeters * (alongX && alongY ? Math.SQRT2 : 1),
  );
  for (let head = 0; head < pending.length; head++) {
    const cell = pending[head];
    for (let side = 0; side < steps.length; side++) {
      const neighbor = adjoining[cell * steps.length + side];
      const reach = spread[cell] + steps[side];
      if (
        neighbor !== NO_CELL &&
        reach < spread[neighbor] &&
        reach < blendMeters
      ) {
        spread[neighbor] = reach;
        pending.push(neighbor);
      }
    }
  }
  return spread.map((reach) =>
    reach === Number.POSITIVE_INFINITY ? 0 : 1 - reach / blendMeters,
  );
}

// Meters per projected unit; mercator is conformal, so one factor covers both axes.
function metersPerPixel(latitude: number): number {
  return (metersPerLng(latitude) * 360) / (256 * 2 ** NORMAL_ZOOM);
}

// Cap on a parting's vote in cells; uncapped, steep departures outvote gentle ones and add crossings.
const VOTE_CAP_CELLS = 1;

// Per route pair, meters, positive where the higher-numbered wants the higher lane.
// Each parting votes for the side the leaver swung off to, so it needn't cross the bundle.
function partingVotes(
  lines: readonly RoutedPolyline[],
  walked: readonly Walked[],
  { routes, sampled }: Occupancy,
  senses: Float64Array,
  cellLng: number,
  cellLat: number,
  cellMeters: number,
  blendMeters: number,
  metersPerUnit: number,
): Map<string, number> {
  const votes = new Map<string, number>();
  const cast = (route: number, other: number, lateral: number): void => {
    const capped =
      Math.sign(lateral) *
      Math.min(Math.abs(lateral), VOTE_CAP_CELLS * cellMeters);
    const key = route < other ? `${route},${other}` : `${other},${route}`;
    votes.set(key, (votes.get(key) ?? 0) + (route < other ? -capped : capped));
  };

  const projected = walked.map(({ sampleLngs, sampleLats }) => [
    Float64Array.from(sampleLngs, (lng) => projectX(lng, NORMAL_ZOOM)),
    Float64Array.from(sampleLats, (lat) => projectY(lat, NORMAL_ZOOM)),
  ]);

  const reach = (index: number, sample: number, step: number): number => {
    const { sampleLngs, sampleLats } = walked[index];
    let at = sample;
    for (let traveled = 0; traveled < blendMeters; ) {
      const next = at + step;
      if (next < 0 || next >= sampleLngs.length) {
        break;
      }
      traveled +=
        Math.hypot(
          (sampleLngs[next] - sampleLngs[at]) / cellLng,
          (sampleLats[next] - sampleLats[at]) / cellLat,
        ) * cellMeters;
      at = next;
    }
    return at;
  };

  // Corridor is the chord behind, not the local direction: a route already turning would measure 0.
  const lateralOf = (index: number, sample: number, step: number): number => {
    const { sampleDirX, sampleDirY } = walked[index];
    const [pixelX, pixelY] = projected[index];
    const away = reach(index, sample, step);
    const back = reach(index, sample, -step);
    const alongX = (pixelX[sample] - pixelX[back]) * step;
    const alongY = (pixelY[sample] - pixelY[back]) * step;
    const length = Math.hypot(alongX, alongY);
    const dirX = length > 0 ? alongX / length : sampleDirX[sample];
    const dirY = length > 0 ? alongY / length : sampleDirY[sample];
    return (
      senses[index] *
      ((pixelX[away] - pixelX[sample]) * dirY -
        (pixelY[away] - pixelY[sample]) * dirX) *
      metersPerUnit
    );
  };

  for (const [index, { route }] of lines.entries()) {
    const cells = sampled[index];
    // Company can only change at a cell crossing; each lateral is read at most once per crossing.
    for (let sample = 0; sample + 1 < cells.length; sample++) {
      if (cells[sample] !== cells[sample + 1]) {
        const here = routes[cells[sample]];
        const next = routes[cells[sample + 1]];
        let leaving = Number.NaN;
        let joining = Number.NaN;
        for (const other of here) {
          if (other !== route && !next.has(other)) {
            if (Number.isNaN(leaving)) {
              leaving = lateralOf(index, sample, 1);
            }
            cast(route, other, leaving);
          }
        }
        for (const other of next) {
          if (other !== route && !here.has(other)) {
            if (Number.isNaN(joining)) {
              joining = lateralOf(index, sample + 1, -1);
            }
            cast(route, other, joining);
          }
        }
      }
    }
  }
  return votes;
}

// Rank per route minimizing unsatisfied `partingVotes`: linear ordering, NP-hard but tiny, so greedy.
function laneOrder(
  routes: readonly number[],
  votes: Map<string, number>,
): Map<number, number> {
  // `wants[first * n + second]` is what placing first before second buys.
  const wants = new Float64Array(routes.length * routes.length);
  for (let first = 0; first < routes.length; first++) {
    for (let second = 0; second < routes.length; second++) {
      const left = routes[first];
      const right = routes[second];
      const vote =
        votes.get(left < right ? `${left},${right}` : `${right},${left}`) ?? 0;
      wants[first * routes.length + second] = left < right ? vote : -vote;
    }
  }

  const pull = routes.map((_, route) => {
    let total = 0;
    for (let other = 0; other < routes.length; other++) {
      total += wants[route * routes.length + other];
    }
    return total;
  });
  const order = routes.map((_, route) => route);
  order.sort((left, right) => pull[right] - pull[left] || left - right);

  // A move flips order only with the routes it passes, so its gain is their sum, not a full rescore.
  for (let pass = 0; pass < routes.length; pass++) {
    let improved = false;
    for (let from = 0; from < order.length; from++) {
      for (let to = 0; to < order.length; to++) {
        let gain = 0;
        for (
          let at = Math.min(from + 1, to);
          at <= Math.max(from - 1, to);
          at++
        ) {
          if (at !== from) {
            gain +=
              (at > from ? -2 : 2) *
              wants[order[from] * routes.length + order[at]];
          }
        }
        if (gain > 0) {
          order.splice(to, 0, ...order.splice(from, 1));
          improved = true;
        }
      }
    }
    if (!improved) {
      break;
    }
  }
  return new Map(order.map((route, rank) => [routes[route], rank]));
}

// Lane widths per vertex: presence of earlier-ranked routes in its cell, so lanes can't swap.
function laneTracks(
  lines: readonly RoutedPolyline[],
  occupancy: Occupancy,
  ranks: Map<number, number>,
  cellLng: number,
  cellLat: number,
  cellMeters: number,
  blendMeters: number,
): Float64Array[] {
  const presence = [...ranks].map(([route, rank]) => ({
    rank,
    present: presenceOf(occupancy, route, cellMeters, blendMeters),
  }));
  return lines.map(({ lngs, lats, route }) => {
    const own = ranks.get(route) ?? 0;
    return Float64Array.from(lngs, (lng, vertex) => {
      const cell = occupancy.idOf.get(
        `${Math.floor(lng / cellLng)},${Math.floor(lats[vertex] / cellLat)}`,
      );
      if (cell === undefined) {
        return 0;
      } else {
        let lane = 0;
        for (const { rank, present } of presence) {
          if (rank < own) {
            lane += present[cell];
          }
        }
        return lane;
      }
    });
  });
}

// CSS px; a screen width from `fullZoom` up, a ground width below so a bundle stays in its channel.
export function laneSpacingPx(
  zoom: number,
  spacingPx: number,
  fullZoom: number,
): number {
  return spacingPx * Math.min(1, 2 ** (zoom - fullZoom));
}

// From the whole polyline, not a tile's clipped piece, which would step the ribbon at every seam.
function offsetNormals(
  lngs: Float64Array,
  lats: Float64Array,
  sense: number,
): { normalX: Float64Array; normalY: Float64Array } {
  const count = lngs.length;
  if (count < 2) {
    return {
      normalX: new Float64Array(count),
      normalY: new Float64Array(count),
    };
  }
  const pixelX = Float64Array.from(lngs, (lng) => projectX(lng, NORMAL_ZOOM));
  const pixelY = Float64Array.from(lats, (lat) => projectY(lat, NORMAL_ZOOM));

  // Each span's own perpendicular; a side carried through a >90° turn disagrees with other lines.
  const spanX = new Float64Array(count - 1);
  const spanY = new Float64Array(count - 1);
  let lastX = 0;
  let lastY = 1;
  for (let span = 0; span + 1 < count; span++) {
    const deltaX = pixelX[span + 1] - pixelX[span];
    const deltaY = pixelY[span + 1] - pixelY[span];
    const length = Math.hypot(deltaX, deltaY);
    if (length > 0) {
      lastX = (sense * deltaY) / length;
      lastY = (-sense * deltaX) / length;
    }
    spanX[span] = lastX;
    spanY[span] = lastY;
  }

  const normalX = new Float64Array(count);
  const normalY = new Float64Array(count);
  for (let vertex = 0; vertex < count; vertex++) {
    const before = Math.max(vertex - 1, 0);
    const after = Math.min(vertex, count - 2);
    const sumX = spanX[before] + spanX[after];
    const sumY = spanY[before] + spanY[after];
    const length = Math.hypot(sumX, sumY);
    if (length === 0) {
      normalX[vertex] = spanX[after];
      normalY[vertex] = spanY[after];
    } else {
      const cosine = (sumX * spanX[after] + sumY * spanY[after]) / length;
      const miter = 1 / Math.max(cosine, 1 / MITER_LIMIT);
      normalX[vertex] = (sumX / length) * miter;
      normalY[vertex] = (sumY / length) * miter;
    }
  }
  return { normalX, normalY };
}

// Below this the two lines are crossing rather than sharing, which says nothing about orientation.
const MIN_PARALLEL_COSINE = Math.cos((30 * Math.PI) / 180);

// Per line, +1 or -1, agreed per bundle: source lines run either way, so lanes would mirror.
function orientations(
  lines: readonly Polyline[],
  walked: readonly Walked[],
  { routes, sampled }: Occupancy,
): Float64Array {
  const headings = routes.map(
    () => new Map<number, { x: number; y: number; samples: number }>(),
  );
  for (const [index, { sampleDirX, sampleDirY }] of walked.entries()) {
    for (let sample = 0; sample < sampleDirX.length; sample++) {
      const cell = headings[sampled[index][sample]];
      const heading = cell.get(index);
      if (heading) {
        heading.x += sampleDirX[sample];
        heading.y += sampleDirY[sample];
        heading.samples++;
      } else {
        cell.set(index, {
          x: sampleDirX[sample],
          y: sampleDirY[sample],
          samples: 1,
        });
      }
    }
  }

  // Mean headings, so a line turning within a cell votes with less than unit weight.
  const votes = new Map<string, number>();
  for (const cell of headings) {
    const present = [...cell].map(([index, { x, y, samples }]) => ({
      index,
      x: x / samples,
      y: y / samples,
    }));
    for (let first = 0; first < present.length; first++) {
      for (let second = first + 1; second < present.length; second++) {
        const vote =
          present[first].x * present[second].x +
          present[first].y * present[second].y;
        const cosine =
          vote /
          (Math.hypot(present[first].x, present[first].y) *
            Math.hypot(present[second].x, present[second].y));
        if (Math.abs(cosine) >= MIN_PARALLEL_COSINE) {
          const key = `${present[first].index},${present[second].index}`;
          votes.set(key, (votes.get(key) ?? 0) + vote);
        }
      }
    }
  }

  // Union-find carrying each line's sense relative to its root.
  const parent = Int32Array.from(lines, (_, index) => index);
  const flipped = new Uint8Array(lines.length);
  const find = (node: number): { root: number; flip: number } => {
    let root = node;
    let flip = 0;
    while (parent[root] !== root) {
      flip ^= flipped[root];
      root = parent[root];
    }
    for (let step = node, stepFlip = flip; parent[step] !== step; ) {
      const next = parent[step];
      const nextFlip = stepFlip ^ flipped[step];
      parent[step] = root;
      flipped[step] = stepFlip;
      step = next;
      stepFlip = nextFlip;
    }
    return { root, flip };
  };

  const edges = [...votes].map(([key, weight]) => {
    const [first, second] = key.split(",").map(Number);
    return { first, second, weight };
  });
  edges.sort(
    (left, right) =>
      Math.abs(right.weight) - Math.abs(left.weight) ||
      left.first - right.first ||
      left.second - right.second,
  );
  for (const { first, second, weight } of edges) {
    const from = find(first);
    const to = find(second);
    if (from.root !== to.root) {
      parent[from.root] = to.root;
      flipped[from.root] = from.flip ^ to.flip ^ (weight < 0 ? 1 : 0);
    }
  }
  const senses = Float64Array.from(lines, (_, index) =>
    find(index).flip ? -1 : 1,
  );

  // The tree drops a cycle's last vote, not its weakest, so let single flips repair it.
  const neighbors = lines.map((): { line: number; weight: number }[] => []);
  for (const { first, second, weight } of edges) {
    neighbors[first].push({ line: second, weight });
    neighbors[second].push({ line: first, weight });
  }
  for (let pass = 0; pass < lines.length; pass++) {
    let improved = false;
    for (let line = 0; line < lines.length; line++) {
      let satisfied = 0;
      for (const { line: other, weight } of neighbors[line]) {
        satisfied += senses[line] * senses[other] * weight;
      }
      if (satisfied < 0) {
        senses[line] = -senses[line];
        improved = true;
      }
    }
    if (!improved) {
      break;
    }
  }

  // Each bundle faces east off its combined chord.
  const chordX = new Map<number, number>();
  const chordY = new Map<number, number>();
  for (const [index, { lngs, lats }] of lines.entries()) {
    const last = lngs.length - 1;
    const { root } = find(index);
    const sense = senses[index];
    if (last > 0) {
      const alongX =
        projectX(lngs[last], NORMAL_ZOOM) - projectX(lngs[0], NORMAL_ZOOM);
      const alongY =
        projectY(lats[last], NORMAL_ZOOM) - projectY(lats[0], NORMAL_ZOOM);
      chordX.set(root, (chordX.get(root) ?? 0) + sense * alongX);
      chordY.set(root, (chordY.get(root) ?? 0) + sense * alongY);
    }
  }
  for (const [index] of lines.entries()) {
    const root = find(index).root;
    const alongX = chordX.get(root) ?? 0;
    const alongY = chordY.get(root) ?? 0;
    const eastward = alongX > 0 || (alongX === 0 && alongY > 0) ? 1 : -1;
    senses[index] *= eastward;
  }
  return senses;
}

export function laneRibbons(
  lines: readonly RoutedPolyline[],
  { cellMeters, blendMeters, latitude }: LaneOptions,
): { lanes: Float64Array; normalX: Float64Array; normalY: Float64Array }[] {
  const cellLat = cellMeters / METERS_PER_DEGREE_LAT;
  const cellLng = cellMeters / metersPerLng(latitude);
  const walked = lines.map((line) => walk(line, cellLng, cellLat));
  const occupancy = occupancyOf(lines, walked, cellLng, cellLat);
  // Senses first: lane order is read along the axis they fix.
  const senses = orientations(lines, walked, occupancy);
  const routeIds = [...new Set(lines.map((line) => line.route))].sort(
    (left, right) => left - right,
  );
  const ranks = laneOrder(
    routeIds,
    partingVotes(
      lines,
      walked,
      occupancy,
      senses,
      cellLng,
      cellLat,
      cellMeters,
      blendMeters,
      metersPerPixel(latitude),
    ),
  );
  const lanes = laneTracks(
    lines,
    occupancy,
    ranks,
    cellLng,
    cellLat,
    cellMeters,
    blendMeters,
  );
  return lines.map(({ lngs, lats }, index) => ({
    lanes: lanes[index],
    ...offsetNormals(lngs, lats, senses[index]),
  }));
}

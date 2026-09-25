import { DECK_HEIGHT_METERS } from "../routing/sheds";
import { DISK_SAMPLES, type SunSample, sunSamples } from "../shade/sun";
import {
  type CasterChunk,
  casterManifest,
  chunksFor,
  EQUATOR_METERS_PER_PIXEL,
} from "./casters";
import { unproject } from "./mercator";
import type { ShadeParams, TileCoords } from "./protocol";
import {
  forEachDeckIn,
  NO_DECKS,
  type ShedDecks,
  traceDeck,
} from "./shed-decks";
import { palette } from "./theme";

// Must match the model crates/tiler/src/shade.rs bakes, or the swept and baked tiles won't join.
// Every polygon is wound positively, or the nonzero fill punches holes where they overlap.

export const TILE_SIZE = 256;
const DEGREES = Math.PI / 180;

export function shadeRgb(): readonly [number, number, number] {
  const [{ red, green, blue }] = palette().shade.stops;
  return [red, green, blue];
}
// Keep in sync with MAX_SHADE_ALPHA in crates/tiler/src/shade.rs, or the handoff steps.
export const MAX_SHADE_ALPHA = 190;

// Keep all three in sync with crates/tiler/src/crown.rs; the base is a share of the tree's height.
const CROWN_BASE_FRACTION = 0.4;
const CROWN_SEGMENTS = 4;
const CROWN_TIP_FRACTION = 0.99;
const SMEAR_PIXELS_PER_SEGMENT = 2;

// Keep in sync with MAX_SWEEP_RUN in crates/tiler/src/shade.rs.
const MAX_SWEEP_RUN = 16;

// Levels to ramp from the pyramid's binned sun to the true one; switching at once jumps shadow tips.
const RAMP_LEVELS = 2;
// Levels above the handoff before the sun disk is sampled; at the handoff it changes almost nothing.
const PENUMBRA_LEVELS = 2;

export interface SweptGround {
  chunks: CasterChunk[];
  decks: ShedDecks;
  samples: SunSample[];
  intensity: number;
  maxShadowMeters: number;
}

// Zoom-0 world pixels to tile pixels; Mercator is conformal, so one `pixelsPerMeter` does both axes.
export interface Frame {
  scale: number;
  originX: number;
  originY: number;
  pixelsPerMeter: number;
}

export interface PolygonSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
}

export function frameFor({
  x,
  y,
  z,
}: TileCoords): Frame & { latitude: number } {
  const originX = x * TILE_SIZE;
  const originY = y * TILE_SIZE;
  const center = unproject(originX + TILE_SIZE / 2, originY + TILE_SIZE / 2, z);
  return {
    scale: 2 ** z,
    originX,
    originY,
    pixelsPerMeter:
      2 ** z / (EQUATOR_METERS_PER_PIXEL * Math.cos(center.lat * DEGREES)),
    latitude: center.lat,
  };
}

// The azimuth difference is taken the short way round so a pair straddling north can't spin.
function rampedSun(
  {
    vectorZoom,
    binElevation,
    binAzimuth,
    sunElevation,
    sunAzimuth,
  }: ShadeParams,
  zoom: number,
): { elevation: number; azimuth: number } {
  const level = Math.min(1, Math.max(0, (zoom - vectorZoom) / RAMP_LEVELS));
  const turn = ((sunAzimuth - binAzimuth + 540) % 360) - 180;
  return {
    elevation: binElevation + (sunElevation - binElevation) * level,
    azimuth: binAzimuth + turn * level,
  };
}

function traceRing(
  path: PolygonSink,
  points: Float64Array,
  from: number,
  to: number,
  forward: boolean,
  { scale, originX, originY }: Frame,
  shiftX: number,
  shiftY: number,
): void {
  for (let step = 0; step < to - from; step++) {
    const index = forward ? from + step : to - 1 - step;
    const x = points[index * 2] * scale - originX + shiftX;
    const y = points[index * 2 + 1] * scale - originY + shiftY;
    if (step === 0) {
      path.moveTo(x, y);
    } else {
      path.lineTo(x, y);
    }
  }
  path.closePath();
}

// Same polygon as `convex_hull(ring ∪ shift(ring))` in crates/tiler/src/shade.rs, without the sort.
function traceSweptHull(
  path: PolygonSink,
  points: Float64Array,
  from: number,
  to: number,
  { scale, originX, originY }: Frame,
  baseX: number,
  baseY: number,
  shiftX: number,
  shiftY: number,
): void {
  const span = to - from;
  let ahead = from;
  let behind = from;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  // Relative to the first vertex: a building is ~1e-5 zoom-0 px across, lost in absolute rounding.
  const pivotX = points[from * 2];
  const pivotY = points[from * 2 + 1];
  for (let index = from; index < to; index++) {
    const along =
      (points[index * 2] - pivotX) * -shiftY +
      (points[index * 2 + 1] - pivotY) * shiftX;
    if (along > high) {
      high = along;
      ahead = index;
    }
    if (along < low) {
      low = along;
      behind = index;
    }
  }

  const chains: [number, number, number, number][] = [
    [ahead, behind, baseX, baseY],
    [behind, ahead, baseX + shiftX, baseY + shiftY],
  ];
  let started = false;
  for (const [start, stop, dx, dy] of chains) {
    let index = start;
    for (;;) {
      const x = points[index * 2] * scale - originX + dx;
      const y = points[index * 2 + 1] * scale - originY + dy;
      if (started) {
        path.lineTo(x, y);
      } else {
        path.moveTo(x, y);
        started = true;
      }
      if (index === stop) {
        break;
      }
      index = from + ((index - from + 1) % span);
    }
  }
  path.closePath();
}

// Wound positively however the edge runs against the shadow.
function traceEdgeSweep(
  path: PolygonSink,
  points: Float64Array,
  first: number,
  second: number,
  { scale, originX, originY }: Frame,
  shiftX: number,
  shiftY: number,
): void {
  const x0 = points[first * 2] * scale - originX;
  const y0 = points[first * 2 + 1] * scale - originY;
  const x1 = points[second * 2] * scale - originX;
  const y1 = points[second * 2 + 1] * scale - originY;
  const corners: [number, number][] =
    (x1 - x0) * shiftY - (y1 - y0) * shiftX > 0
      ? [
          [x0, y0],
          [x1, y1],
          [x1 + shiftX, y1 + shiftY],
          [x0 + shiftX, y0 + shiftY],
        ]
      : [
          [x0 + shiftX, y0 + shiftY],
          [x1 + shiftX, y1 + shiftY],
          [x1, y1],
          [x0, y0],
        ];
  path.moveTo(corners[0][0], corners[0][1]);
  for (const [x, y] of corners.slice(1)) {
    path.lineTo(x, y);
  }
  path.closePath();
}

function reaches(
  boxes: Float64Array,
  record: number,
  { scale, originX, originY }: Frame,
  shiftX: number,
  shiftY: number,
): boolean {
  const left = boxes[record * 4] * scale - originX;
  const top = boxes[record * 4 + 1] * scale - originY;
  const right = boxes[record * 4 + 2] * scale - originX;
  const bottom = boxes[record * 4 + 3] * scale - originY;
  return (
    Math.min(left, left + shiftX) <= TILE_SIZE &&
    Math.max(right, right + shiftX) >= 0 &&
    Math.min(top, top + shiftY) <= TILE_SIZE &&
    Math.max(bottom, bottom + shiftY) >= 0
  );
}

// A near-convex footprint sweeps its hull; a real concavity sweeps the exact Minkowski sum.
export function castBuildings(
  path: PolygonSink,
  chunks: CasterChunk[],
  sample: SunSample,
  maxShadowMeters: number,
  frame: Frame,
): number {
  let drawn = 0;
  for (const chunk of chunks) {
    const { points, rings, records, heights, boxes, hulls, hullPoints, wound } =
      chunk;
    for (let record = 0; record < chunk.buildings; record++) {
      const distance = Math.min(
        heights[record] * sample.shadowPerHeight,
        maxShadowMeters,
      );
      if (!(distance > 0)) {
        continue;
      }
      const shiftX = distance * sample.east * frame.pixelsPerMeter;
      const shiftY = -distance * sample.north * frame.pixelsPerMeter;
      if (!reaches(boxes, record, frame, shiftX, shiftY)) {
        continue;
      }
      drawn += 1;
      const outerRing = records[record];
      const hull = hulls[outerRing * 2 + 1];
      if (hull > 0) {
        const start = hulls[outerRing * 2];
        traceSweptHull(
          path,
          hullPoints,
          start,
          start + hull,
          frame,
          0,
          0,
          shiftX,
          shiftY,
        );
      } else {
        const outer = outerRing;
        const from = rings[outer];
        const to = rings[outer + 1];
        const forward = wound[outer] === 1;
        traceRing(path, points, from, to, forward, frame, 0, 0);
        traceRing(path, points, from, to, forward, frame, shiftX, shiftY);
        for (let index = from; index < to; index++) {
          const next = index + 1 < to ? index + 1 : from;
          traceEdgeSweep(path, points, index, next, frame, shiftX, shiftY);
        }
      }
    }
  }
  return drawn;
}

// A capsule drawn without its caps, which are ~1/100 px; `minWidth` keeps slivers from dropping out.
export function castTrunks(
  path: PolygonSink,
  chunks: CasterChunk[],
  sample: SunSample,
  maxShadowMeters: number,
  frame: Frame,
  minWidth: number,
): number {
  if (!(sample.shadowPerHeight > 0)) {
    return 0;
  }
  // The unit normal that winds the quad positively.
  const normalX = -sample.north;
  const normalY = -sample.east;

  const { scale, originX, originY, pixelsPerMeter } = frame;
  let drawn = 0;
  for (const chunk of chunks) {
    const { trunks, trunkRadii, trunkHeights, trunkBox, trunkMaxHeight } =
      chunk;
    const reach =
      Math.min(trunkMaxHeight * sample.shadowPerHeight, maxShadowMeters) *
      pixelsPerMeter;
    if (
      trunkRadii.length === 0 ||
      !reaches(trunkBox, 0, frame, reach * sample.east, -reach * sample.north)
    ) {
      continue;
    }
    for (let trunk = 0; trunk < trunkRadii.length; trunk++) {
      const distance = Math.min(
        trunkHeights[trunk] * sample.shadowPerHeight,
        maxShadowMeters,
      );
      const shiftX = distance * sample.east * pixelsPerMeter;
      const shiftY = -distance * sample.north * pixelsPerMeter;
      const x = trunks[trunk * 2] * scale - originX;
      const y = trunks[trunk * 2 + 1] * scale - originY;
      const half = Math.max(trunkRadii[trunk] * pixelsPerMeter, minWidth / 2);
      if (
        Math.min(x, x + shiftX) - half > TILE_SIZE ||
        Math.max(x, x + shiftX) + half < 0 ||
        Math.min(y, y + shiftY) - half > TILE_SIZE ||
        Math.max(y, y + shiftY) + half < 0
      ) {
        continue;
      }
      drawn += 1;
      const acrossX = half * normalX;
      const acrossY = half * normalY;
      path.moveTo(x - acrossX, y - acrossY);
      path.lineTo(x + acrossX, y + acrossY);
      path.lineTo(x + acrossX + shiftX, y + acrossY + shiftY);
      path.lineTo(x - acrossX + shiftX, y - acrossY + shiftY);
      path.closePath();
    }
  }
  return drawn;
}

// Mirrors `append_sweep` in crates/tiler/src/shade.rs; one strip per run, not per edge.
function traceRunSweep(
  path: PolygonSink,
  points: Float64Array,
  from: number,
  to: number,
  positive: boolean,
  frame: Frame,
  baseX: number,
  baseY: number,
  shiftX: number,
  shiftY: number,
): void {
  const span = to - from;
  traceRing(path, points, from, to, positive, frame, baseX, baseY);
  traceRing(
    path,
    points,
    from,
    to,
    positive,
    frame,
    baseX + shiftX,
    baseY + shiftY,
  );
  const winding = positive ? 1 : -1;
  const facing = (index: number): boolean => {
    const next = from + ((index - from + 1) % span);
    const cross =
      (points[next * 2] - points[index * 2]) * shiftY -
      (points[next * 2 + 1] - points[index * 2 + 1]) * shiftX;
    return winding * cross <= 0;
  };
  // Start on an edge facing away so a run can't wrap past the ring's end.
  let start = -1;
  for (let index = from; index < to; index++) {
    if (!facing(index)) {
      start = index;
      break;
    }
  }
  if (start < 0) {
    return;
  }

  const { scale, originX, originY } = frame;
  let run: number[] = [];
  const close = (): void => {
    if (run.length >= 2) {
      // The whole run shares one winding sign, so one test decides whether to walk it backwards.
      const lead = run[0];
      const next = run[1];
      const walk =
        (points[next * 2] - points[lead * 2]) * shiftY -
          (points[next * 2 + 1] - points[lead * 2 + 1]) * shiftX >
        0
          ? run
          : [...run].reverse();
      let started = false;
      const emit = (index: number, dx: number, dy: number): void => {
        const x = points[index * 2] * scale - originX + dx;
        const y = points[index * 2 + 1] * scale - originY + dy;
        if (started) {
          path.lineTo(x, y);
        } else {
          path.moveTo(x, y);
          started = true;
        }
      };
      for (const index of walk) {
        emit(index, baseX, baseY);
      }
      for (let at = walk.length - 1; at >= 0; at--) {
        emit(walk[at], baseX + shiftX, baseY + shiftY);
      }
      path.closePath();
    }
    // The next run starts at this one's last vertex, so a run cut for length leaves no gap.
    run = run.length > 0 ? [run[run.length - 1]] : [];
  };
  for (let step = 0; step < span; step++) {
    const index = from + ((start - from + step) % span);
    if (facing(index)) {
      if (run.length === 0) {
        run.push(index);
      }
      run.push(from + ((index - from + 1) % span));
      if (run.length >= MAX_SWEEP_RUN) {
        close();
      }
    } else {
      // A run that ends naturally still sweeps; only a length cut carries into the next.
      close();
      run = [];
    }
  }
  close();
}

// Must mirror `crown_segments` in crates/tiler/src/crown.rs or the handoff seam shows.
export function crownSegments(
  heightM: number,
  shadowPerHeight: number,
  maxShadowMeters: number,
  metersPerPixel: number,
): { level: number; fromM: number; toM: number }[] {
  if (!(heightM > 0) || !(shadowPerHeight > 0)) {
    return [];
  }
  const smearM = (1 - CROWN_BASE_FRACTION) * heightM * shadowPerHeight;
  const wanted = Math.ceil(smearM / metersPerPixel / SMEAR_PIXELS_PER_SEGMENT);
  let count = CROWN_SEGMENTS;
  while (count > 1 && count / 2 >= wanted) {
    count /= 2;
  }
  const stride = CROWN_SEGMENTS / count;
  const middle = (1 + CROWN_BASE_FRACTION) / 2;
  const halfHeight = (1 - CROWN_BASE_FRACTION) / 2;
  const displacement = (shareOfHeight: number): number =>
    Math.min(shareOfHeight * heightM * shadowPerHeight, maxShadowMeters);
  const segments: { level: number; fromM: number; toM: number }[] = [];
  for (let slice = 0; slice < count; slice++) {
    const level = slice * stride;
    // Half the band the crown is at least this ring's radius over; rings are spaced by equal height.
    const half = (level / (CROWN_SEGMENTS - 1)) * CROWN_TIP_FRACTION;
    const fromM = displacement(middle - halfHeight * half);
    const toM = displacement(middle + halfHeight * half);
    // Slice 0 always draws; past the shadow clip the others collapse onto it.
    if (toM > fromM || slice === 0) {
      segments.push({ level, fromM, toM });
    }
  }
  return segments;
}

// A crown floats free, so each slice is swept only between where its band starts and stops casting.
export function castCrowns(
  path: PolygonSink,
  chunks: CasterChunk[],
  sample: SunSample,
  maxShadowMeters: number,
  frame: Frame,
): number {
  const metersPerPixel = 1 / frame.pixelsPerMeter;
  let drawn = 0;
  for (const chunk of chunks) {
    const {
      points,
      rings,
      records,
      heights,
      boxes,
      hulls,
      hullPoints,
      wound,
      levels,
    } = chunk;
    for (let record = chunk.buildings; record < records.length - 1; record++) {
      const segments = crownSegments(
        heights[record],
        sample.shadowPerHeight,
        maxShadowMeters,
        metersPerPixel,
      );
      if (segments.length === 0) {
        continue;
      }
      const reach = segments[segments.length - 1].toM * frame.pixelsPerMeter;
      if (
        !reaches(
          boxes,
          record,
          frame,
          reach * sample.east,
          -reach * sample.north,
        )
      ) {
        continue;
      }
      drawn += 1;
      for (const { level, fromM, toM } of segments) {
        const baseX = fromM * sample.east * frame.pixelsPerMeter;
        const baseY = -fromM * sample.north * frame.pixelsPerMeter;
        const shiftX = (toM - fromM) * sample.east * frame.pixelsPerMeter;
        const shiftY = -(toM - fromM) * sample.north * frame.pixelsPerMeter;
        for (let ring = records[record]; ring < records[record + 1]; ring++) {
          if (levels[ring] !== level) {
            continue;
          }
          const from = rings[ring];
          const to = rings[ring + 1];
          const positive = wound[ring] === 1;
          if (shiftX === 0 && shiftY === 0) {
            traceRing(path, points, from, to, positive, frame, baseX, baseY);
          } else if (hulls[ring * 2 + 1] > 0) {
            const start = hulls[ring * 2];
            traceSweptHull(
              path,
              hullPoints,
              start,
              start + hulls[ring * 2 + 1],
              frame,
              baseX,
              baseY,
              shiftX,
              shiftY,
            );
          } else {
            traceRunSweep(
              path,
              points,
              from,
              to,
              positive,
              frame,
              baseX,
              baseY,
              shiftX,
              shiftY,
            );
          }
        }
      }
    }
  }
  return drawn;
}

// A floating opaque slab, so its shadow is the footprint translated; its penumbra is only ~4 cm.
export function castSheds(
  path: PolygonSink,
  decks: ShedDecks,
  sample: SunSample,
  maxShadowMeters: number,
  frame: Frame,
  minWidth: number,
): number {
  const distance = Math.min(
    DECK_HEIGHT_METERS * sample.shadowPerHeight,
    maxShadowMeters,
  );
  if (!(distance > 0)) {
    return 0;
  }
  const { scale, originX, originY, pixelsPerMeter } = frame;
  const shiftX = distance * sample.east * pixelsPerMeter;
  const shiftY = -distance * sample.north * pixelsPerMeter;
  // The tile in world pixels, widened back along the shadow.
  const windowMinX = (originX - Math.max(shiftX, 0)) / scale;
  const windowMinY = (originY - Math.max(shiftY, 0)) / scale;
  const windowMaxX = (originX + TILE_SIZE - Math.min(shiftX, 0)) / scale;
  const windowMaxY = (originY + TILE_SIZE - Math.min(shiftY, 0)) / scale;
  let drawn = 0;
  forEachDeckIn(
    decks,
    windowMinX,
    windowMinY,
    windowMaxX,
    windowMaxY,
    (deck) => {
      drawn += 1;
      traceDeck(
        path,
        decks,
        deck,
        scale,
        originX - shiftX,
        originY - shiftY,
        minWidth,
      );
    },
  );
  return drawn;
}

// Punched out of both shadow layers, since shade on a roof is not ground shade.
export function castBases(
  path: PolygonSink,
  chunks: CasterChunk[],
  frame: Frame,
): void {
  for (const chunk of chunks) {
    const { points, rings, records, boxes, wound } = chunk;
    for (let record = 0; record < chunk.buildings; record++) {
      if (!reaches(boxes, record, frame, 0, 0)) {
        continue;
      }
      for (let ring = records[record]; ring < records[record + 1]; ring++) {
        const positive = wound[ring] === 1;
        const outer = ring === records[record];
        traceRing(
          path,
          points,
          rings[ring],
          rings[ring + 1],
          outer ? positive : !positive,
          frame,
          0,
          0,
        );
      }
    }
  }
}

// Reused across draws; the worker rasterizes one tile at a time.
const scratch: (OffscreenCanvasRenderingContext2D | null)[] = [null, null];

function layer(
  slot: number,
  size: number,
  ratio: number,
): OffscreenCanvasRenderingContext2D | null {
  const held = scratch[slot];
  const context =
    held?.canvas.width === size
      ? held
      : new OffscreenCanvas(size, size).getContext("2d");
  scratch[slot] = context;
  if (context) {
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
  }
  return context;
}

// Handed over from the main thread, since the decks hang off the routing graph the worker lacks.
let standing: ShedDecks = NO_DECKS;

export function setShedDecks(decks: ShedDecks): void {
  standing = decks;
}

// Null on any missing chunk, falling back to the pyramid: a partial sweep would show sunlit buildings.
export async function sweptGround(
  params: ShadeParams,
  coords: TileCoords,
): Promise<SweptGround | null> {
  const manifest = await casterManifest();
  if (!manifest) {
    return null;
  }
  const frame = frameFor(coords);
  const { chunks, complete } = await chunksFor(
    manifest,
    frame.originX / frame.scale,
    frame.originY / frame.scale,
    (frame.originX + TILE_SIZE) / frame.scale,
    (frame.originY + TILE_SIZE) / frame.scale,
    frame.latitude,
  );
  if (!complete) {
    return null;
  }
  const { elevation, azimuth } = rampedSun(params, coords.z);
  return {
    chunks,
    decks: standing,
    samples: sunSamples(
      azimuth,
      elevation,
      coords.z >= params.vectorZoom + PENUMBRA_LEVELS ? DISK_SAMPLES : 1,
    ),
    intensity: Math.max(0, Math.sin(elevation * DEGREES)),
    maxShadowMeters: manifest.maxShadowMeters,
  };
}

// Samples add at 1/n so alpha is the shaded fraction; crowns over it give 1 - (1 - b)(1 - tau * t).
export function drawSweep(
  context: OffscreenCanvasRenderingContext2D,
  ground: SweptGround,
  coords: TileCoords,
  { tau }: ShadeParams,
  ratio: number,
): void {
  const { chunks, decks, samples, intensity, maxShadowMeters } = ground;
  const frame = frameFor(coords);
  const shadows = samples.map((sample) => {
    const path = new Path2D();
    return {
      path,
      drawn: castBuildings(path, chunks, sample, maxShadowMeters, frame),
    };
  });
  const sheds = new Path2D();
  const shedsDrawn = castSheds(
    sheds,
    decks,
    samples[0],
    maxShadowMeters,
    frame,
    1 / ratio,
  );
  // Trunks ride with the crowns: opaque, they read as dark scratches across the softer crown shade.
  const crowns = new Path2D();
  const crownsDrawn =
    castCrowns(crowns, chunks, samples[0], maxShadowMeters, frame) +
    castTrunks(crowns, chunks, samples[0], maxShadowMeters, frame, 1 / ratio);
  if (
    crownsDrawn === 0 &&
    shedsDrawn === 0 &&
    shadows.every(({ drawn }) => drawn === 0)
  ) {
    return;
  }
  const bases = new Path2D();
  castBases(bases, chunks, frame);

  const size = Math.round(TILE_SIZE * ratio);
  const shade = layer(0, size, ratio);
  if (!shade) {
    return;
  }
  const slate = shadeRgb().join(", ");
  shade.globalCompositeOperation = "lighter";
  shade.fillStyle = `rgba(${slate}, ${1 / samples.length})`;
  for (const { path } of shadows) {
    shade.fill(path);
  }
  // Decks use source-over, not the additive pass, which would lighten overlaps with building shadow.
  if (shedsDrawn > 0) {
    shade.globalCompositeOperation = "source-over";
    shade.fillStyle = `rgb(${slate})`;
    shade.fill(sheds);
  }
  shade.globalCompositeOperation = "destination-out";
  shade.fillStyle = "#000";
  shade.fill(bases);

  const crown = crownsDrawn > 0 ? layer(1, size, ratio) : null;
  if (crown) {
    crown.fillStyle = `rgb(${slate})`;
    crown.fill(crowns);
    crown.globalCompositeOperation = "destination-out";
    crown.fill(bases);
    shade.globalCompositeOperation = "source-over";
    shade.globalAlpha = tau;
    shade.drawImage(crown.canvas, 0, 0, TILE_SIZE, TILE_SIZE);
    shade.globalAlpha = 1;
  }

  context.globalAlpha = (MAX_SHADE_ALPHA * intensity) / 255;
  context.drawImage(shade.canvas, 0, 0, TILE_SIZE, TILE_SIZE);
  context.globalAlpha = 1;
}

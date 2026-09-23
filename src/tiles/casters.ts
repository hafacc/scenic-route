import { resolveUrl } from "./base-url";
import { projectX, projectY } from "./mercator";
import { type Cursor, readUnsignedVarint, readVarint } from "./varint";

// One chunk per z15 tile (magic `CSTR`; layout in scripts/README.md), decoded to zoom-0 pixels.

const CHUNK_URL = "casters/{x}/{y}.bin";
const MANIFEST_URL = "casters/manifest.json";
const CASTER_MAGIC = "CSTR";
const CASTER_FORMAT = 3;
const DECIMETERS_PER_METER = 10;
const CENTIMETERS_PER_METER = 100;
const TILE_SIZE = 256;

export const EQUATOR_METERS_PER_PIXEL = 156_543.033_92;

// Below this hull over-fill, sweep the hull; keep in sync with crates/tiler/src/shade.rs.
const MIN_CONCAVITY_M2 = 200;

// A screenful over a canopy-heavy park decodes to ~100 MiB; a smaller cache re-fetches on every pan.
const CACHE_BYTES = 160 * 1024 * 1024;

export interface CasterManifest {
  chunkZoom: number;
  coordScale: number;
  maxShadowMeters: number; // how far outside its own tile a chunk's shadows can reach
  chunks: { x: number; y: number; bytes: number }[];
}

// Ring r spans points[2 * rings[r]] to 2 * rings[r + 1]; a footprint's rings are outer then holes.
export interface CasterChunk {
  points: Float64Array; // x/y interleaved, zoom-0 world pixels
  rings: Uint32Array;
  records: Uint32Array;
  heights: Float32Array; // meters
  boxes: Float64Array; // per record, the box of everything it casts from, as minX, minY, maxX, maxY
  // Per ring, a start and count into `hullPoints`, positively wound; count 0 needs the exact sweep.
  hulls: Uint32Array;
  hullPoints: Float64Array;
  wound: Uint8Array; // per ring, 1 when its own winding is already positive in world pixels
  levels: Uint8Array; // per ring, which slice of its crown it is; 0 for every footprint ring
  buildings: number; // records below this are footprints, the rest crowns
  // x/y interleaved in zoom-0 world pixels; radii and heights in meters.
  trunks: Float64Array;
  trunkRadii: Float32Array;
  trunkHeights: Float32Array;
  trunkBox: Float64Array; // minX, minY, maxX, maxY over the points alone
  trunkMaxHeight: number; // how far past that box a trunk shadow can reach, as a height in meters
  bytes: number;
}

// About the first vertex: a building is ~1e-5 zoom-0 px across, so absolute terms cancel to rounding.
function signedDoubleArea(
  points: number[],
  count: number,
  at: (step: number) => number,
): number {
  const originX = points[at(0) * 2];
  const originY = points[at(0) * 2 + 1];
  let sum = 0;
  let previousX = 0;
  let previousY = 0;
  for (let step = 1; step < count; step++) {
    const x = points[at(step) * 2] - originX;
    const y = points[at(step) * 2 + 1] - originY;
    sum += previousX * y - x * previousY;
    previousX = x;
    previousY = y;
  }
  return sum;
}

// Mirrors `convex_hull` in crates/tiler/src/shade.rs; collinear points are dropped.
function convexHull(points: number[], from: number, to: number): number[] {
  const order = Array.from({ length: to - from }, (_, index) => from + index);
  order.sort(
    (left, right) =>
      points[left * 2] - points[right * 2] ||
      points[left * 2 + 1] - points[right * 2 + 1],
  );
  const cross = (origin: number, first: number, second: number): number =>
    (points[first * 2] - points[origin * 2]) *
      (points[second * 2 + 1] - points[origin * 2 + 1]) -
    (points[first * 2 + 1] - points[origin * 2 + 1]) *
      (points[second * 2] - points[origin * 2]);

  const hull: number[] = [];
  for (const index of order) {
    while (
      hull.length >= 2 &&
      cross(hull[hull.length - 2], hull[hull.length - 1], index) <= 0
    ) {
      hull.pop();
    }
    hull.push(index);
  }
  const lower = hull.length + 1; // the upper chain may not pop below the lower one's last vertex
  for (let at = order.length - 1; at >= 0; at--) {
    while (
      hull.length >= lower &&
      cross(hull[hull.length - 2], hull[hull.length - 1], order[at]) <= 0
    ) {
      hull.pop();
    }
    hull.push(order[at]);
  }
  hull.pop(); // the first point closes both chains
  return hull;
}

export function decodeChunk(buffer: ArrayBuffer): CasterChunk {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const version = view.getUint16(4, true);
  if (magic !== CASTER_MAGIC || version !== CASTER_FORMAT) {
    throw new Error(`not a v${CASTER_FORMAT} caster chunk`);
  }
  const buildings = view.getUint32(8, true);
  const count = buildings + view.getUint32(12, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const cursor: Cursor = { offset: view.getUint16(6, true) };

  // The origin's scale is close enough over a chunk to weigh a footprint against its hull.
  const metersPerPoint =
    EQUATOR_METERS_PER_PIXEL * Math.cos((originLat * Math.PI) / 180);
  const points: number[] = [];
  const hullPoints: number[] = [];
  const rings: number[] = [0];
  const wound: number[] = [];
  const levels: number[] = [];
  const hulls: number[] = [];
  const records = new Uint32Array(count + 1);
  const heights = new Float32Array(count);
  const boxes = new Float64Array(count * 4);

  const readRing = (level: number, quantized: [number, number]): void => {
    const vertices = readUnsignedVarint(bytes, cursor);
    const start = points.length / 2;
    for (let vertex = 0; vertex < vertices; vertex++) {
      quantized[0] += readVarint(bytes, cursor);
      quantized[1] += readVarint(bytes, cursor);
      points.push(
        projectX(originLng + quantized[0] * scale, 0),
        projectY(originLat + quantized[1] * scale, 0),
      );
    }
    const end = points.length / 2;
    const area = signedDoubleArea(points, end - start, (step) => start + step);
    rings.push(end);
    wound.push(area > 0 ? 1 : 0);
    levels.push(level);
    hulls.push(0, 0);

    const hull = convexHull(points, start, end);
    if (hull.length < 3) {
      return; // no area; the exact sweep produces nothing
    }
    const hullArea = signedDoubleArea(
      points,
      hull.length,
      (step) => hull[step],
    );
    const concavity =
      ((Math.abs(hullArea) - Math.abs(area)) / 2) *
      metersPerPoint *
      metersPerPoint;
    if (concavity >= MIN_CONCAVITY_M2) {
      return; // swept exactly, so its notches stay unshaded
    }
    if (hullArea < 0) {
      hull.reverse();
    }
    hulls[hulls.length - 2] = hullPoints.length / 2;
    hulls[hulls.length - 1] = hull.length;
    for (const index of hull) {
      hullPoints.push(points[index * 2], points[index * 2 + 1]);
    }
  };

  for (let record = 0; record < count; record++) {
    // Deltas chain across a record's rings but restart at the chunk origin per record.
    const quantized: [number, number] = [0, 0];
    heights[record] = readUnsignedVarint(bytes, cursor) / DECIMETERS_PER_METER;
    if (record < buildings) {
      const ringCount = readUnsignedVarint(bytes, cursor);
      records[record + 1] = records[record] + ringCount;
      for (let ring = 0; ring < ringCount; ring++) {
        readRing(0, quantized);
      }
    } else {
      const levelCount = readUnsignedVarint(bytes, cursor);
      records[record + 1] = records[record];
      for (let level = 0; level < levelCount; level++) {
        const ringCount = readUnsignedVarint(bytes, cursor);
        records[record + 1] += ringCount;
        for (let ring = 0; ring < ringCount; ring++) {
          readRing(level, quantized);
        }
      }
    }
    // Only the outermost rings (outer ring, widest slice), which contain the rest.
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let ring = records[record]; ring < records[record + 1]; ring++) {
      if (
        levels[ring] !== 0 ||
        (record < buildings && ring > records[record])
      ) {
        continue;
      }
      for (let index = rings[ring]; index < rings[ring + 1]; index++) {
        minX = Math.min(minX, points[index * 2]);
        maxX = Math.max(maxX, points[index * 2]);
        minY = Math.min(minY, points[index * 2 + 1]);
        maxY = Math.max(maxY, points[index * 2 + 1]);
      }
    }
    boxes[record * 4] = minX;
    boxes[record * 4 + 1] = minY;
    boxes[record * 4 + 2] = maxX;
    boxes[record * 4 + 3] = maxY;
  }

  const trunkCount = view.getUint32(40, true);
  const trunks = new Float64Array(trunkCount * 2);
  const trunkRadii = new Float32Array(trunkCount);
  const trunkHeights = new Float32Array(trunkCount);
  const trunkBox = new Float64Array([
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]);
  let trunkMaxHeight = 0;
  let trunkX = 0;
  let trunkY = 0;
  for (let trunk = 0; trunk < trunkCount; trunk++) {
    trunkX += readVarint(bytes, cursor);
    trunkY += readVarint(bytes, cursor);
    const x = projectX(originLng + trunkX * scale, 0);
    const y = projectY(originLat + trunkY * scale, 0);
    trunks[trunk * 2] = x;
    trunks[trunk * 2 + 1] = y;
    trunkRadii[trunk] =
      readUnsignedVarint(bytes, cursor) / CENTIMETERS_PER_METER;
    const height = readUnsignedVarint(bytes, cursor) / DECIMETERS_PER_METER;
    trunkHeights[trunk] = height;
    trunkMaxHeight = Math.max(trunkMaxHeight, height);
    trunkBox[0] = Math.min(trunkBox[0], x);
    trunkBox[1] = Math.min(trunkBox[1], y);
    trunkBox[2] = Math.max(trunkBox[2], x);
    trunkBox[3] = Math.max(trunkBox[3], y);
  }

  const buffers = {
    points: new Float64Array(points),
    rings: new Uint32Array(rings),
    records,
    heights,
    boxes,
    hulls: new Uint32Array(hulls),
    hullPoints: new Float64Array(hullPoints),
    wound: new Uint8Array(wound),
    levels: new Uint8Array(levels),
    trunks,
    trunkRadii,
    trunkHeights,
    trunkBox,
  };
  return {
    ...buffers,
    buildings,
    trunkMaxHeight,
    bytes: Object.values(buffers).reduce(
      (total, buffer) => total + buffer.byteLength,
      0,
    ),
  };
}

let manifest: Promise<CasterManifest | null> | null = null;

// Null without casters; a 404 is remembered but a network failure is retried.
export function casterManifest(): Promise<CasterManifest | null> {
  if (!manifest) {
    manifest = fetch(resolveUrl(MANIFEST_URL))
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => {
        manifest = null;
        return null;
      });
  }
  return manifest;
}

// So the halo around a viewport doesn't request unwritten chunks.
const written = new WeakMap<CasterManifest, Set<string>>();

function exists(manifest: CasterManifest, key: string): boolean {
  let index = written.get(manifest);
  if (!index) {
    index = new Set(manifest.chunks.map(({ x, y }) => `${x}/${y}`));
    written.set(manifest, index);
  }
  return index.has(key);
}

interface CacheEntry {
  chunk: Promise<CasterChunk | null>;
  bytes: number; // 0 until it decodes, so an in-flight chunk is free to evict
}

const cache = new Map<string, CacheEntry>();
let cached = 0;

function fetchChunk(key: string): Promise<CasterChunk | null> {
  const hit = cache.get(key);
  if (hit) {
    // Map iterates in insertion order, so re-inserting makes the eviction below an LRU.
    cache.delete(key);
    cache.set(key, hit);
    return hit.chunk;
  }
  const [x, y] = key.split("/");
  const url = resolveUrl(CHUNK_URL.replace("{x}", x).replace("{y}", y));
  const entry: CacheEntry = {
    bytes: 0,
    chunk: fetch(url)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`${url}: ${response.status} ${response.statusText}`);
        }
        const chunk = decodeChunk(await response.arrayBuffer());
        if (cache.get(key) === entry) {
          entry.bytes = chunk.bytes;
          cached += chunk.bytes;
          for (const [oldest, evicted] of cache) {
            if (cached <= CACHE_BYTES) {
              break;
            }
            cache.delete(oldest);
            cached -= evicted.bytes;
          }
        }
        return chunk;
      })
      // Not cached, so the next tile over the same ground retries.
      .catch(() => {
        cache.delete(key);
        return null;
      }),
  };
  cache.set(key, entry);
  return entry.chunk;
}

// A missing chunk would read as sunlight, so an incomplete gather falls back to the baked pyramid.
export interface CasterGather {
  chunks: CasterChunk[];
  complete: boolean;
}

// Every chunk whose shadows can reach a zoom-0 world-pixel box.
export async function chunksFor(
  manifest: CasterManifest,
  west: number,
  north: number,
  east: number,
  south: number,
  latitude: number,
): Promise<CasterGather> {
  const { chunkZoom, maxShadowMeters } = manifest;
  const halo =
    maxShadowMeters /
    (EQUATOR_METERS_PER_PIXEL * Math.cos((latitude * Math.PI) / 180));
  const last = 2 ** chunkZoom - 1;
  const chunkAt = (point: number): number =>
    Math.min(
      last,
      Math.max(0, Math.floor((point * 2 ** chunkZoom) / TILE_SIZE)),
    );
  const wanted: Promise<CasterChunk | null>[] = [];
  for (let y = chunkAt(north - halo); y <= chunkAt(south + halo); y++) {
    for (let x = chunkAt(west - halo); x <= chunkAt(east + halo); x++) {
      const key = `${x}/${y}`;
      if (exists(manifest, key)) {
        wanted.push(fetchChunk(key));
      }
    }
  }
  const loaded = await Promise.all(wanted);
  const chunks = loaded.filter((chunk): chunk is CasterChunk => chunk !== null);
  return { chunks, complete: chunks.length === loaded.length };
}

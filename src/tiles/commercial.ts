import { COMMERCIAL_COLOR } from "../overlays/colors";
import { decodeStreetChunk } from "../streets/chunk";
import { hexToRgb, type ThemeName } from "../theme/palette";
import { resolveUrl } from "./base-url";
import { projectX, projectY } from "./mercator";
import type { CommercialParams, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import { BLUR_PAD, compositeSoft, tileMetersPerPixel } from "./soft-edge";
import { themeName } from "./theme";

// Signals are baked per segment by crates/tiler/src/commercial.rs; the gate runs here to stay tunable.

const TILE_SIZE = 256;

// Relative, so it picks up the deploy's basePath.
const CHUNK_URL = "streets/{x}/{y}.bin";
const CHUNK_ZOOM = 12;

const COMMERCIAL_URL = "commercial/{x}/{y}.bin";
const COMMERCIAL_MAGIC = "CMRC";
const COMMERCIAL_FORMAT = 1;
const COMMERCIAL_BYTES_PER_SEGMENT = 3; // [commercialFrac, medianHeightMeters, flags]
const FLAG_OPEN_STREET = 1; // bit0: an Open Street sample snapped to the segment
const FLAG_SEATING = 2; // bit1: a dining / outdoor-seating point snapped to the segment

// Share of fronting lots that must be commercial.
const COMMERCIAL_FRACTION = 0.5;
// Max median snapped roof height; the 255 "no buildings" sentinel also fails it.
const LOW_RISE_METERS = 25;

// Lower than a thin line would take, since fat bands overlap at corners.
const BAND_OPACITY = 0.45;

function channels(hex: string): readonly [number, number, number] {
  const { red, green, blue } = hexToRgb(hex);
  return [red, green, blue];
}

const BAND_CHANNELS: Record<ThemeName, readonly [number, number, number]> = {
  light: channels(COMMERCIAL_COLOR.light),
  dark: channels(COMMERCIAL_COLOR.dark),
};

// ~12 m road plus most of the ~30 m lots each side; floored so the overview isn't invisible hairlines.
const BAND_METERS = 50;
const MIN_BAND_PX = 4;

// Blur scales with band width so thin bands survive.
const BLUR_FRACTION = 0.18;

// One block-length CSCL centerline.
interface Segment {
  lngs: Float64Array;
  lats: Float64Array;
}

// `qualifies` is the gate per segment; `longest` sizes the draw's scratch arrays.
interface ChunkModel {
  segments: Segment[];
  qualifies: Uint8Array;
  longest: number;
}

// Index-aligned with the sibling STCK chunk's segments.
interface Signals {
  commercialFrac: Uint8Array;
  medianHeight: Uint8Array;
  flags: Uint8Array;
}

interface TileData {
  segments: Segment[];
  signals: Signals;
}

function decodeCommercial(buffer: ArrayBuffer): Signals {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const version = view.getUint16(4, true);
  if (magic !== COMMERCIAL_MAGIC || version !== COMMERCIAL_FORMAT) {
    throw new Error(`not a v${COMMERCIAL_FORMAT} commercial chunk`);
  }
  const count = view.getUint32(8, true);
  const commercialFrac = new Uint8Array(count);
  const medianHeight = new Uint8Array(count);
  const flags = new Uint8Array(count);
  let offset = view.getUint16(6, true);
  // Reads past the end give undefined (coerced to 0), so a truncated chunk must fail here.
  if (offset + count * COMMERCIAL_BYTES_PER_SEGMENT > bytes.length) {
    throw new Error("commercial chunk truncated");
  }
  for (let segment = 0; segment < count; segment++) {
    commercialFrac[segment] = bytes[offset];
    medianHeight[segment] = bytes[offset + 1];
    flags[segment] = bytes[offset + 2];
    offset += COMMERCIAL_BYTES_PER_SEGMENT;
  }
  return { commercialFrac, medianHeight, flags };
}

const chunks = new Map<string, Promise<Segment[]>>();
const signalChunks = new Map<string, Promise<Signals | null>>();

// A 404 is a water tile and caches as empty; any other failure is evicted so it can be retried.
function loadChunk(tileX: number, tileY: number): Promise<Segment[]> {
  const key = `${tileX}/${tileY}`;
  const pending = chunks.get(key);
  if (pending) {
    return pending;
  }
  const url = resolveUrl(
    CHUNK_URL.replace("{x}", String(tileX)).replace("{y}", String(tileY)),
  );
  const request = fetch(url)
    .then(async (response) => {
      if (response.ok) {
        // Keep only the geometry, since the segments stay cached.
        const buffer = await response.arrayBuffer();
        return decodeStreetChunk(buffer).map((segment) => ({
          lngs: segment.lngs,
          lats: segment.lats,
        }));
      } else if (response.status === 404) {
        return [];
      } else {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
      }
    })
    .catch((error: unknown) => {
      chunks.delete(key);
      throw error;
    });
  chunks.set(key, request);
  return request;
}

// A 404 (water, or not yet built) is null, and the tile draws nothing.
function loadSignals(tileX: number, tileY: number): Promise<Signals | null> {
  const key = `${tileX}/${tileY}`;
  const pending = signalChunks.get(key);
  if (pending) {
    return pending;
  }
  const url = resolveUrl(
    COMMERCIAL_URL.replace("{x}", String(tileX)).replace("{y}", String(tileY)),
  );
  const request = fetch(url)
    .then(async (response) => {
      if (response.ok) {
        return decodeCommercial(await response.arrayBuffer());
      } else if (response.status === 404) {
        return null;
      } else {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
      }
    })
    .catch((error: unknown) => {
      signalChunks.delete(key);
      throw error;
    });
  signalChunks.set(key, request);
  return request;
}

// Missing or misaligned signals become all zeros, so nothing qualifies.
async function loadTile(tileX: number, tileY: number): Promise<TileData> {
  const [segments, signals] = await Promise.all([
    loadChunk(tileX, tileY),
    loadSignals(tileX, tileY),
  ]);
  if (signals && signals.commercialFrac.length === segments.length) {
    return { segments, signals };
  }
  const count = segments.length;
  return {
    segments,
    signals: {
      commercialFrac: new Uint8Array(count),
      medianHeight: new Uint8Array(count),
      flags: new Uint8Array(count),
    },
  };
}

// Below z12 a tile spans a 2^(12-z) square of chunks, so an overview fetches only those under it.
function coveringChunks(coords: TileCoords): { x: number; y: number }[] {
  if (coords.z >= CHUNK_ZOOM) {
    const shift = coords.z - CHUNK_ZOOM;
    return [{ x: coords.x >> shift, y: coords.y >> shift }];
  }
  const span = 1 << (CHUNK_ZOOM - coords.z);
  const baseX = coords.x << (CHUNK_ZOOM - coords.z);
  const baseY = coords.y << (CHUNK_ZOOM - coords.z);
  const chunkList: { x: number; y: number }[] = [];
  for (let offsetX = 0; offsetX < span; offsetX++) {
    for (let offsetY = 0; offsetY < span; offsetY++) {
      chunkList.push({ x: baseX + offsetX, y: baseY + offsetY });
    }
  }
  return chunkList;
}

const chunkModels = new Map<string, Promise<ChunkModel>>();

function loadChunkModel(tileX: number, tileY: number): Promise<ChunkModel> {
  const key = `${tileX}/${tileY}`;
  const pending = chunkModels.get(key);
  if (pending) {
    return pending;
  }
  const request = loadTile(tileX, tileY)
    .then(({ segments, signals }) => {
      const qualifies = new Uint8Array(segments.length);
      let longest = 0;
      for (let index = 0; index < segments.length; index++) {
        longest = Math.max(longest, segments[index].lngs.length);
        const commercial = signals.commercialFrac[index] / 255;
        const flagged =
          (signals.flags[index] & (FLAG_OPEN_STREET | FLAG_SEATING)) !== 0;
        if (
          commercial >= COMMERCIAL_FRACTION &&
          signals.medianHeight[index] <= LOW_RISE_METERS &&
          flagged
        ) {
          qualifies[index] = 1;
        }
      }
      return { segments, qualifies, longest };
    })
    .catch((error: unknown) => {
      chunkModels.delete(key);
      throw error;
    });
  chunkModels.set(key, request);
  return request;
}

function load(
  _params: CommercialParams,
  coords: TileCoords,
): Promise<ChunkModel[]> {
  return Promise.all(
    coveringChunks(coords).map(({ x, y }) => loadChunkModel(x, y)),
  );
}

// Stroked opaque as one union so crossings don't darken; square caps fill T and L corners flush.
function compositeBand(
  context: OffscreenCanvasRenderingContext2D,
  path: Path2D,
  width: number,
  ratio: number,
): void {
  const [red, green, blue] = BAND_CHANNELS[themeName()];
  compositeSoft(context, ratio, width * BLUR_FRACTION, BAND_OPACITY, (band) => {
    band.lineCap = "square";
    band.lineJoin = "miter";
    band.lineWidth = width;
    band.strokeStyle = `rgba(${red}, ${green}, ${blue}, 1)`;
    band.stroke(path);
    return true;
  });
}

function draw(
  context: OffscreenCanvasRenderingContext2D,
  models: ChunkModel[],
  coords: TileCoords,
  _params: CommercialParams,
  ratio: number,
): void {
  const originX = coords.x * TILE_SIZE;
  const originY = coords.y * TILE_SIZE;
  const width = Math.max(MIN_BAND_PX, BAND_METERS / tileMetersPerPixel(coords));
  const margin = width + BLUR_PAD;

  const band = new Path2D();
  let hasBand = false;
  const longest = models.reduce(
    (most, model) => Math.max(most, model.longest),
    0,
  );
  const xs = new Float64Array(longest);
  const ys = new Float64Array(longest);

  for (const { segments, qualifies } of models) {
    for (let index = 0; index < segments.length; index++) {
      if (qualifies[index] === 0) {
        continue;
      }
      const { lngs, lats } = segments[index];
      let left = Number.POSITIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      let low = Number.POSITIVE_INFINITY;
      let high = Number.NEGATIVE_INFINITY;
      for (let vertex = 0; vertex < lngs.length; vertex++) {
        xs[vertex] = projectX(lngs[vertex], coords.z) - originX;
        ys[vertex] = projectY(lats[vertex], coords.z) - originY;
        left = Math.min(left, xs[vertex]);
        right = Math.max(right, xs[vertex]);
        low = Math.min(low, ys[vertex]);
        high = Math.max(high, ys[vertex]);
      }
      // A segment can cross the tile between two outside vertices, so test its box.
      const overlaps =
        right >= -margin &&
        left <= TILE_SIZE + margin &&
        high >= -margin &&
        low <= TILE_SIZE + margin;
      if (!overlaps) {
        continue;
      }
      band.moveTo(xs[0], ys[0]);
      for (let vertex = 1; vertex < lngs.length; vertex++) {
        band.lineTo(xs[vertex], ys[vertex]);
      }
      hasBand = true;
    }
  }

  if (hasBand) {
    compositeBand(context, band, width, ratio);
  }
}

export const commercialRenderer: TileRenderer<CommercialParams, ChunkModel[]> =
  {
    load,
    draw,
  };

import { COMMERCIAL_COLOR } from "../overlays/colors";
import { hexToRgb, type ThemeName } from "../theme/palette";
import { resolveUrl } from "./base-url";
import { cachedLru } from "./lru";
import { projectX, projectY } from "./mercator";
import type { CommercialParams, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import { BLUR_PAD, compositeSoft, tileMetersPerPixel } from "./soft-edge";
import { loadAround, loadStreetChunk } from "./street-score";
import { themeName } from "./theme";

// Signals are baked per segment by crates/tiler/src/commercial.rs; the gate runs here to stay tunable.

const TILE_SIZE = 256;
const CHUNK_ZOOM = 12; // the street chunks' zoom

// Relative to the page, which sits at the site root.
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

// A chunk's segments that pass the gate; `longest` sizes the draw's scratch arrays.
interface ChunkModel {
  segments: Segment[];
  longest: number;
}

// Index-aligned with the sibling STCK chunk's segments.
interface Signals {
  commercialFrac: Uint8Array;
  medianHeight: Uint8Array;
  flags: Uint8Array;
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

// A 404 (water, or not yet built) is null, and the chunk draws nothing.
async function loadSignals(
  tileX: number,
  tileY: number,
): Promise<Signals | null> {
  const url = resolveUrl(
    COMMERCIAL_URL.replace("{x}", String(tileX)).replace("{y}", String(tileY)),
  );
  const response = await fetch(url);
  if (response.ok) {
    return decodeCommercial(await response.arrayBuffer());
  } else if (response.status === 404) {
    return null;
  } else {
    throw new Error(`${url}: ${response.status} ${response.statusText}`);
  }
}

// Models hold only the qualifying geometry, so a wide overview fits many.
const MODEL_CACHE_LIMIT = 512;
const chunkModels = new Map<string, Promise<ChunkModel>>();

// Missing or misaligned signals mean nothing qualifies.
function loadChunkModel(tileX: number, tileY: number): Promise<ChunkModel> {
  return cachedLru(
    chunkModels,
    `${tileX}/${tileY}`,
    MODEL_CACHE_LIMIT,
    async () => {
      const [segments, signals] = await Promise.all([
        loadStreetChunk(tileX, tileY),
        loadSignals(tileX, tileY),
      ]);
      const qualifying: Segment[] = [];
      let longest = 0;
      if (signals?.commercialFrac.length === segments.length) {
        for (let index = 0; index < segments.length; index++) {
          const flagged =
            (signals.flags[index] & (FLAG_OPEN_STREET | FLAG_SEATING)) !== 0;
          if (
            signals.commercialFrac[index] / 255 >= COMMERCIAL_FRACTION &&
            signals.medianHeight[index] <= LOW_RISE_METERS &&
            flagged
          ) {
            const { lngs, lats } = segments[index];
            qualifying.push({ lngs, lats });
            longest = Math.max(longest, lngs.length);
          }
        }
      }
      return { segments: qualifying, longest };
    },
  );
}

const NO_MODEL: ChunkModel = { segments: [], longest: 0 };

function bandWidth(coords: TileCoords): number {
  return Math.max(MIN_BAND_PX, BAND_METERS / tileMetersPerPixel(coords));
}

// Chunks are filed by bbox alone, so a neighbour's band reaches in by its width plus the blur pad.
function load(
  _params: CommercialParams,
  coords: TileCoords,
): Promise<ChunkModel[]> {
  // Below z12 the band is at its 4 px floor, so a ~3 px cut at a chunk seam is accepted to skip neighbours.
  const margin = coords.z < CHUNK_ZOOM ? 0 : bandWidth(coords) + BLUR_PAD;
  return loadAround(coords, margin, loadChunkModel, NO_MODEL);
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
  const width = bandWidth(coords);
  const margin = width + BLUR_PAD;

  const band = new Path2D();
  let hasBand = false;
  const longest = models.reduce(
    (most, model) => Math.max(most, model.longest),
    0,
  );
  const xs = new Float64Array(longest);
  const ys = new Float64Array(longest);

  for (const { segments } of models) {
    for (const { lngs, lats } of segments) {
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

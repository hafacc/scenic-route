import { genusColor } from "../tree-cover/genus";
import { resolveUrl } from "./base-url";
import { projectX, projectY, unproject } from "./mercator";
import type { TileCoords, TreeDotsParams } from "./protocol";
import type { TileRenderer } from "./renderer";
import { type Cursor, readVarint } from "./varint";

// Live dots above the raster half; sizing mirrors crates/tiler/src/genus_field.rs so nothing jumps.
const TREE_URL = "trees/{file}"; // relative, picks up the deploy basePath; layout: scripts/README.md
const TREE_FORMAT = 3;

const TILE_SIZE = 256;
const EQUATOR_METERS_PER_PIXEL = 156_543.033_92;
const METERS_PER_DEGREE_LAT = 111_320;
const DECIMETERS_PER_METER = 10;

const MIN_DOT_PX = 1.5; // a visibility floor; above it the dot is the crown's true size
const MAX_CROWN_METERS = 25.5; // the crown byte's ceiling (255 dm)
const DOT_ALPHA = 0.85;

const CELL_DEG = 0.004; // ~440 m buckets

const GENUS_CSS: readonly string[] = Array.from({ length: 13 }, (_, id) => {
  const { red, green, blue } = genusColor(id);
  return `rgb(${red}, ${green}, ${blue})`;
});

interface Trees {
  lngs: Float64Array;
  lats: Float64Array;
  crownM: Float32Array; // crown radius in meters, the dot's size
  genus: Uint8Array; // 0..12, the dot's color
  // Tree indices by `${floor(lng/CELL_DEG)},${floor(lat/CELL_DEG)}`.
  buckets: Map<string, number[]>;
}

// TREE v3 (crates/tiler/src/binfmt.rs): sorted varint deltas, then crown bytes, then genus bytes.
function decodeTrees(buffer: ArrayBuffer): Trees {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const version = view.getUint16(4, true);
  if (magic !== "TREE" || version !== TREE_FORMAT) {
    throw new Error(`not a v${TREE_FORMAT} tree blob`);
  }

  const count = view.getUint32(8, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const cursor: Cursor = { offset: view.getUint16(6, true) };

  const lngs = new Float64Array(count);
  const lats = new Float64Array(count);
  let quantizedX = 0;
  let quantizedY = 0;
  for (let tree = 0; tree < count; tree++) {
    quantizedX += readVarint(bytes, cursor);
    quantizedY += readVarint(bytes, cursor);
    lngs[tree] = originLng + quantizedX * scale;
    lats[tree] = originLat + quantizedY * scale;
  }
  const crownM = new Float32Array(count);
  for (let tree = 0; tree < count; tree++) {
    crownM[tree] = bytes[cursor.offset] / DECIMETERS_PER_METER;
    cursor.offset += 1;
  }
  const genus = bytes.slice(cursor.offset, cursor.offset + count);

  const buckets = new Map<string, number[]>();
  for (let tree = 0; tree < count; tree++) {
    const key = `${Math.floor(lngs[tree] / CELL_DEG)},${Math.floor(lats[tree] / CELL_DEG)}`;
    const cell = buckets.get(key);
    if (cell) {
      cell.push(tree);
    } else {
      buckets.set(key, [tree]);
    }
  }
  return { lngs, lats, crownM, genus, buckets };
}

const loaded = new Map<string, Promise<Trees>>();

function loadTrees({ file }: TreeDotsParams): Promise<Trees> {
  const pending = loaded.get(file);
  if (pending) {
    return pending;
  } else {
    const url = resolveUrl(TREE_URL.replace("{file}", file));
    const request = fetch(url)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`${url}: ${response.status} ${response.statusText}`);
        }
        return decodeTrees(await response.arrayBuffer());
      })
      .catch((error: unknown) => {
        loaded.delete(file);
        throw error;
      });
    loaded.set(file, request);
    return request;
  }
}

// Discs at the crown's true pixel radius (floored), so big trees stay bigger at every zoom.
function draw(
  context: OffscreenCanvasRenderingContext2D,
  trees: Trees,
  coords: TileCoords,
  params: TreeDotsParams,
): void {
  const zoom = coords.z;
  const originX = coords.x * TILE_SIZE;
  const originY = coords.y * TILE_SIZE;
  // Disabled genera are skipped so the live dots match the raster half.
  const enabled = new Set(params.enabled);
  const center = unproject(
    originX + TILE_SIZE / 2,
    originY + TILE_SIZE / 2,
    zoom,
  );
  const cosLat = Math.cos((center.lat * Math.PI) / 180);
  const metersPerPixel = (EQUATOR_METERS_PER_PIXEL * cosLat) / 2 ** zoom;

  const northWest = unproject(originX, originY, zoom);
  const southEast = unproject(originX + TILE_SIZE, originY + TILE_SIZE, zoom);
  // Grow the query box by the largest possible dot, so none spilling in is missed.
  const marginMeters = Math.max(MAX_CROWN_METERS, MIN_DOT_PX * metersPerPixel);
  const marginLat = marginMeters / METERS_PER_DEGREE_LAT;
  const marginLng = marginMeters / (METERS_PER_DEGREE_LAT * cosLat);
  const cellX0 = Math.floor((northWest.lng - marginLng) / CELL_DEG);
  const cellX1 = Math.floor((southEast.lng + marginLng) / CELL_DEG);
  const cellY0 = Math.floor((southEast.lat - marginLat) / CELL_DEG);
  const cellY1 = Math.floor((northWest.lat + marginLat) / CELL_DEG);

  context.globalAlpha = DOT_ALPHA;
  for (let cellX = cellX0; cellX <= cellX1; cellX++) {
    for (let cellY = cellY0; cellY <= cellY1; cellY++) {
      const cell = trees.buckets.get(`${cellX},${cellY}`);
      if (!cell) {
        continue;
      }
      for (const tree of cell) {
        if (!enabled.has(trees.genus[tree])) {
          continue;
        }
        const px = projectX(trees.lngs[tree], zoom) - originX;
        const py = projectY(trees.lats[tree], zoom) - originY;
        const radius = Math.max(
          MIN_DOT_PX,
          trees.crownM[tree] / metersPerPixel,
        );
        if (
          px < -radius ||
          px > TILE_SIZE + radius ||
          py < -radius ||
          py > TILE_SIZE + radius
        ) {
          continue;
        }
        context.fillStyle = GENUS_CSS[trees.genus[tree]];
        context.beginPath();
        context.arc(px, py, radius, 0, 2 * Math.PI);
        context.fill();
      }
    }
  }
  context.globalAlpha = 1;
}

export const treeDotsRenderer: TileRenderer<TreeDotsParams, Trees> = {
  load: loadTrees,
  draw,
};

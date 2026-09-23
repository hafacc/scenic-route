// The Alameda flight has no DSM or building class, so the tiler builds a surface from the points.
// EPT levels are unbiased subsamples, so truncating the walk only lowers resolution.
// EPT node keys never change contents, so every node is cached for good.

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cached, cachedFile } from "./cache";
import { forwardTmerc, type Tmerc, UTM_10N } from "./canopy-raster";
import { fetchBytes, fetchJson } from "./http";

const MAX_ATTEMPTS = 4;
const NODE_WORKERS = 16;
// `x56y419` is the 10 km square east of 560 km and south of 4 190 km.
export const DEM_SQUARE_METERS = 10_000;
const PROGRESS_NODES = 25;

// EPT bounds are in web mercator even when the points were flown on a UTM grid.
const EARTH_RADIUS_METERS = 6_378_137.0;
const MERCATOR_HALF_WIDTH_METERS = 20_037_508.342_789_244;

// At 37.8 N a 3857 meter is 21% off a true one, a whole octree level.
function mercatorScale(lat: number): number {
  return 1 / Math.cos((lat * Math.PI) / 180);
}

function mercator(lng: number, lat: number): [number, number] {
  const x = (lng * MERCATOR_HALF_WIDTH_METERS) / 180;
  const y =
    Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) *
    EARTH_RADIUS_METERS;
  return [x, y];
}

function degrees(x: number, y: number): [number, number] {
  const lng = (x * 180) / MERCATOR_HALF_WIDTH_METERS;
  const lat =
    ((2 * Math.atan(Math.exp(y / EARTH_RADIUS_METERS)) - Math.PI / 2) * 180) /
    Math.PI;
  return [lng, lat];
}

// Keyed by the names crates/tiler/src/heights.rs resolves; needed to name the DEM tiles to fetch.
export const PROJECTIONS = {
  utm10n: UTM_10N,
} satisfies Record<string, Tmerc>;

export interface LidarWindow {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface LidarSource {
  // Unioned: the cubes overlap on paper but the coverage doesn't.
  eptRoots: string[];
  demProject: string; // the staged 1 m bare-earth DEM
  crs: keyof typeof PROJECTIONS;
  attribution: string;
  sourceUrl: string;
}

// True meters. A level finer costs 3.8x the bytes and moves building heights only 0.74 m (MAE).
export const NODE_SPACING_METERS = 1.83;

// Public domain.
export const ALAMEDA_LIDAR: LidarSource = {
  eptRoots: [1, 2, 3].map(
    (subproject) =>
      `https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_AlamedaCo_${subproject}_2021`,
  ),
  demProject: "CA_AlamedaCounty_2021_B21",
  crs: "utm10n",
  attribution: "Elevation © USGS 3DEP",
  sourceUrl:
    "https://www.usgs.gov/3d-elevation-program/3dep-lidar-point-cloud-ca-alamedacounty-2021-b21",
};

// Downtown Oakland, the window every number in the method was measured over.
export const OAKLAND_TEST_WINDOW: LidarWindow = {
  west: -122.27,
  south: 37.805,
  east: -122.258,
  north: 37.813,
};

// The seven municipalities' outlines plus a margin; fixed so the cache keys are stable across runs.
export const EAST_BAY_WINDOW: LidarWindow = {
  west: -122.376,
  south: 37.628,
  east: -122.112,
  north: 37.909,
};

interface EptIndex {
  bounds: [number, number, number, number, number, number];
  span: number;
  dataType: string;
}

// Node key -> point count; -1 means the subtree hangs off its own page.
type Hierarchy = Record<string, number>;

export interface EptNode {
  root: string;
  key: string; // depth-x-y-z
  depth: number;
  points: number;
  // Exact, since a cube is axis-aligned in web mercator.
  bounds: LidarWindow;
}

// Each level subsamples the whole cube, so the nodes on the way down are kept too.
async function walkNodes(
  root: string,
  window: LidarWindow,
  spacingMeters: number,
): Promise<EptNode[]> {
  const index = await cached(
    `ept-index-${root.slice(root.lastIndexOf("/") + 1)}`,
    root,
    () => fetchJson<EptIndex>(`${root}/ept.json`, { attempts: MAX_ATTEMPTS }),
  );
  if (index.dataType !== "laszip") {
    throw new Error(`${root}: ${index.dataType} points, not laszip`);
  }
  const [cubeX, cubeY, , cubeMaxX] = index.bounds;
  const cubeEdge = cubeMaxX - cubeX;
  const [minX, minY] = mercator(window.west, window.south);
  const [maxX, maxY] = mercator(window.east, window.north);
  const spacing =
    spacingMeters * mercatorScale((window.south + window.north) / 2);

  const pages = new Map<string, Hierarchy>();
  const page = async (key: string): Promise<Hierarchy> => {
    const held = pages.get(key);
    if (held) {
      return held;
    }
    const url = `${root}/ept-hierarchy/${key}.json`;
    const fetched = await cached(`ept-hierarchy-${key}`, url, () =>
      fetchJson<Hierarchy>(url, { attempts: MAX_ATTEMPTS }),
    );
    pages.set(key, fetched);
    return fetched;
  };

  const nodes: EptNode[] = [];
  const visit = async (key: string, hierarchy: Hierarchy): Promise<void> => {
    const [depth, x, y, z] = key.split("-").map(Number);
    const edge = cubeEdge / 2 ** depth;
    const nodeX = cubeX + x * edge;
    const nodeY = cubeY + y * edge;
    if (
      nodeX >= maxX ||
      nodeX + edge <= minX ||
      nodeY >= maxY ||
      nodeY + edge <= minY
    ) {
      return;
    }
    const listed = hierarchy[key];
    if (listed === undefined) {
      return;
    }
    // The subtree's own page's first entry is this node's count.
    const table = listed === -1 ? await page(key) : hierarchy;
    const points = listed === -1 ? table[key] : listed;
    const [west, south] = degrees(nodeX, nodeY);
    const [east, north] = degrees(nodeX + edge, nodeY + edge);
    nodes.push({
      root,
      key,
      depth,
      points,
      bounds: { west, south, east, north },
    });
    if (edge / index.span <= spacing) {
      return;
    }
    for (const stepZ of [0, 1]) {
      for (const stepY of [0, 1]) {
        for (const stepX of [0, 1]) {
          await visit(
            `${depth + 1}-${2 * x + stepX}-${2 * y + stepY}-${2 * z + stepZ}`,
            table,
          );
        }
      }
    }
  };
  await visit("0-0-0-0", await page("0-0-0-0"));
  return nodes;
}

// Never deduped: the per-cell maximum downstream is idempotent under a duplicate return.
export async function eptNodes(
  source: LidarSource,
  window: LidarWindow,
  spacingMeters: number,
): Promise<EptNode[]> {
  const walked = await Promise.all(
    source.eptRoots.map((root) => walkNodes(root, window, spacingMeters)),
  );
  return walked.flat();
}

async function fetchNodes(nodes: EptNode[]): Promise<string[]> {
  const paths: string[] = new Array(nodes.length);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < nodes.length) {
      const index = next++;
      const { root, key } = nodes[index];
      const url = `${root}/ept-data/${key}.laz`;
      const dataset = root.slice(root.lastIndexOf("/") + 1);
      paths[index] = await cachedFile(`ept-${dataset}-${key}`, url, () =>
        fetchBytes(url, { attempts: MAX_ATTEMPTS }),
      );
      done += 1;
      if (done % PROGRESS_NODES === 0 || done === nodes.length) {
        console.error(`  lidar: ${done}/${nodes.length} point-cloud nodes`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(NODE_WORKERS, nodes.length) }, worker),
  );
  return paths;
}

export interface DemSquare {
  squareX: number;
  squareY: number;
  name: string;
}

// Named for its north edge, so the row from 4 180 to 4 190 km is y419.
export function demSquareName(squareX: number, squareY: number): string {
  return `x${squareX}y${squareY + 1}`;
}

// Edge midpoints too: grid convergence rotates the window, so its widest point is on an edge.
export function demSquaresOf(
  window: LidarWindow,
  crs: keyof typeof PROJECTIONS,
): DemSquare[] {
  const projection = PROJECTIONS[crs];
  const lngs = [window.west, (window.west + window.east) / 2, window.east];
  const lats = [window.south, (window.south + window.north) / 2, window.north];
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const lng of lngs) {
    for (const lat of lats) {
      const { x, y } = forwardTmerc(projection, lng, lat);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const squares: DemSquare[] = [];
  for (
    let squareX = Math.floor(minX / DEM_SQUARE_METERS);
    squareX <= Math.floor(maxX / DEM_SQUARE_METERS);
    squareX++
  ) {
    for (
      let squareY = Math.floor(minY / DEM_SQUARE_METERS);
      squareY <= Math.floor(maxY / DEM_SQUARE_METERS);
      squareY++
    ) {
      squares.push({ squareX, squareY, name: demSquareName(squareX, squareY) });
    }
  }
  return squares;
}

// Unstaged bay squares are reported, not thrown on; the tiler fills them from ground returns.
export async function fetchDemTiles(
  source: LidarSource,
  window: LidarWindow,
): Promise<{ paths: string[]; missing: string[] }> {
  // The S3 mirror: rockyweb serves the same bytes at under a megabyte a second.
  const listUrl = `https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/${source.demProject}/0_file_download_links.txt`;
  const links = await cached(
    `dem-links-${source.demProject}`,
    listUrl,
    async () => new TextDecoder().decode(await fetchBytes(listUrl)),
  );
  const staged = new Map<string, string>();
  for (const line of links.split("\n")) {
    const url = line.trim();
    const tile = /_(x\d+y\d+)_/.exec(url)?.[1];
    if (url && tile) {
      staged.set(tile, url);
    }
  }
  const paths: string[] = [];
  const missing: string[] = [];
  const squares = demSquaresOf(window, source.crs);
  for (const { name: tile } of squares) {
    const url = staged.get(tile);
    if (!url) {
      missing.push(tile);
      continue;
    }
    console.error(`  lidar: ground tile ${tile}`);
    paths.push(
      await cachedFile(`dem-${source.demProject}-${tile}`, url, () =>
        fetchBytes(url, { attempts: MAX_ATTEMPTS }),
      ),
    );
  }
  console.error(
    `  lidar: ${paths.length} of ${squares.length} ground squares staged${
      missing.length > 0 ? `; ${missing.join(", ")} filled from the cloud` : ""
    }`,
  );
  return { paths, missing };
}

export interface NdsmNode extends LidarWindow {
  path: string;
}

// JSON rather than argv: a city's walk runs to thousands of nodes.
export interface NdsmParams {
  nodes: NdsmNode[];
  dem: string[];
  crs: string;
  window: LidarWindow;
  out: string; // mosaics, one 500 m tile at a time
  footprints?: string;
  heights?: string;
}

export async function fetchLidar(
  source: LidarSource,
  window: LidarWindow,
  spacingMeters: number,
): Promise<{ nodes: NdsmNode[]; dem: string[] }> {
  const walked = await eptNodes(source, window, spacingMeters);
  describe(walked);
  const paths = await fetchNodes(walked);
  const { paths: dem } = await fetchDemTiles(source, window);
  return {
    nodes: walked.map((node, index) => ({
      path: paths[index],
      ...node.bounds,
    })),
    dem,
  };
}

function describe(nodes: EptNode[]): void {
  const depths = new Map<number, { nodes: number; points: number }>();
  for (const node of nodes) {
    const tally = depths.get(node.depth) ?? { nodes: 0, points: 0 };
    tally.nodes += 1;
    tally.points += node.points;
    depths.set(node.depth, tally);
  }
  let points = 0;
  for (const depth of [...depths.keys()].sort((left, right) => left - right)) {
    const tally = depths.get(depth) ?? { nodes: 0, points: 0 };
    points += tally.points;
    console.error(
      `  lidar: depth ${depth}: ${tally.nodes} nodes, ${tally.points.toLocaleString()} points`,
    );
  }
  console.error(
    `  lidar: ${nodes.length} nodes, ${points.toLocaleString()} points in the window's octree`,
  );
}

const AREAS: Record<string, { source: LidarSource; window: LidarWindow }> = {
  downtown: { source: ALAMEDA_LIDAR, window: OAKLAND_TEST_WINDOW },
  "east-bay": { source: ALAMEDA_LIDAR, window: EAST_BAY_WINDOW },
};

function argument(name: string): string | undefined {
  return process.argv
    .find((given) => given.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

if (import.meta.main) {
  const spacing = Number(argument("spacing") ?? NODE_SPACING_METERS);
  const name = argument("window") ?? "downtown";
  const area = AREAS[name];
  if (!area) {
    throw new Error(`no area named ${name}; ${Object.keys(AREAS)} exist`);
  }
  const { source, window } = area;
  const started = performance.now();
  const { nodes, dem } = await fetchLidar(source, window, spacing);
  const build = join(import.meta.dirname, "..", ".build");
  await mkdir(build, { recursive: true });
  const params: NdsmParams = {
    nodes,
    dem,
    crs: source.crs,
    window,
    out: join(build, `ndsm-${name}`),
    footprints: argument("footprints"),
    heights: argument("heights"),
  };
  await writeFile(join(build, `ndsm-${name}.json`), JSON.stringify(params));
  let bytes = 0;
  for (const node of nodes) {
    bytes += (await stat(node.path)).size;
  }
  console.error(
    `lidar: ${nodes.length} nodes at ${spacing} m spacing, ${(bytes / 1e9).toFixed(2)} GB, and ${dem.length} ground tiles cached in ${((performance.now() - started) / 1000).toFixed(0)}s`,
  );
}

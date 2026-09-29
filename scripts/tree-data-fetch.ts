import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { EAST_BAY_STREET_ATTRIBUTION, fetchEastBayStreets } from "./alameda";
import {
  ALCC_ATTRIBUTION,
  ALCC_HEIGHT_ATTRIBUTION,
  ALCC_SOURCE_URL,
  eastBayCanopy,
} from "./alcc";
import {
  type CrownAllometry,
  crownDiameterMeters,
  NOCALC_LONDON_PLANE,
  NOEAST_LONDON_PLANE,
} from "./allometry";
import { type ArtSource, ingestArt, NYC_ART, SF_ART } from "./art";
import { type BuildingSource, NYC_BUILDINGS, SF_BUILDINGS } from "./buildings";
import { writeAtomic } from "./cache";
import { canopyPages } from "./canopy";
import { CHM_ATTRIBUTION, CHM_SOURCE_URL, fetchChmRaster } from "./chm";
import {
  BERKELEY_TREE_ATTRIBUTION,
  fetchEastBayTrees,
  OAKLAND_TREE_ATTRIBUTION,
} from "./east-bay-trees";
import {
  type ElevationRaster,
  SF_CANOPY_BAND,
  SF_ELEVATION,
} from "./elevation";
import { type FerrySource, ingestFerries } from "./ferries";
import {
  boxOf,
  buildNameTable,
  type CrownedTree,
  densify,
  encodeNetwork,
  encodePolygons,
  encodeTrees,
  type TreeColumns,
  UNNAMED_ID,
} from "./geometry";
import { ingestHighways } from "./highways";
import { fetchBayAreaLand, fetchNycLand, type LandContext } from "./land";
import { buildLandTest } from "./land-filter";
import {
  ingestLandmarks,
  type LandmarkSource,
  NYC_LANDMARKS,
  SF_LANDMARKS,
} from "./landmarks";
import type { Bounds, SourceFile } from "./manifest";
import { concurrencyOf, memoryBudget, memoryLine, parseMemory } from "./memory";
import {
  fetchOsmTrees,
  fetchPaths,
  type OsmTree,
  type PathWay,
  type Polygon,
} from "./overpass";
import {
  type PackedPolygons,
  PolygonCollector,
  packPolygons,
  polygonChunks,
  writeChunks,
} from "./packed-polygons";
import {
  fetchSfCanopyPolygons,
  fetchSfStreets,
  fetchSfTrees,
  SF_CANOPY_ATTRIBUTION,
} from "./sf";
import {
  ingestSidewalks,
  NYC_SURVEY,
  SF_SURVEY,
  type Survey,
} from "./sidewalks";
import {
  type Coord,
  DATA_SF,
  fetchNycTrees,
  NYC_OPEN_DATA,
  type Paging,
} from "./socrata";
import {
  FLAG_NON_VEHICULAR,
  FLAG_STRUCTURE,
  FLAG_TUNNEL,
  FLAG_VEHICULAR_ONLY,
  notStreetFilter,
  ROAD_TYPES,
  type RoadType,
  type Segment,
  toInt,
} from "./streets";
import {
  INGEST_PARAMS_PATH,
  PERCENTILES,
  SIDECAR_PATH,
  type TreeDataSidecar,
} from "./tree-data";
import { type TreeTable, treeTableOf } from "./tree-table";

// Names are uppercased so the client's prettifier renders them like street names.
interface PathSegment {
  osmId: number; // guarded to fit a u32
  kind: number; // PATH_KIND_PATH or PATH_KIND_STEPS
  structure: boolean; // a bridge/tunnel deck or a non-zero layer
  tunnel: boolean;
  name: string; // "" when unnamed
  nameId: number; // UNNAMED_ID when unnamed
  points: Coord[]; // densified to DENSIFY_METERS
  lengthMeters: number;
}

interface StreetRow {
  the_geom?: { type: string; coordinates: [number, number][][] };
  physicalid?: string;
  rw_type?: string;
  streetwidth?: string;
  posted_speed?: string;
  nonped?: string; // 'V' vehicular-only, 'D' dedicated deck, else null
  trafdir?: string; // 'NV' non-vehicular (a ped/bike deck)
  stname_label?: string; // e.g. "W 60 ST"
}

// `crs` names a projection in crates/tiler/src/heights.rs; `band` is null for a single-band file.
interface HeightRaster {
  paths: string[];
  band: number | null;
  crs: "utm18n" | "utm10n" | "sf-cs13";
  attribution: string;
  sourceUrl: string;
}

// All paths absolute.
interface IngestParams {
  canopy: string;
  land: string;
  streets: string;
  paths: string;
  // No credits: the tiler rejects fields it doesn't know. Empty leaves every height 0 (unknown).
  chm: { paths: string[]; band: number | null; crs: HeightRaster["crs"] }[];
  sourceBox: Bounds;
  landBox: Bounds;
  fillSigmaMeters: number;
  tightSigmaAlongMeters: number;
  tightSigmaAcrossMeters: number;
  sidewalkInsetMeters: number;
  coverSamples: number;
  coverSeed: number;
  percentiles: number[];
}

const ROOT = join(import.meta.dirname, "..");
const DATA_DIR = join(ROOT, "data");

const STREET_FORMAT = 6;
const PATH_FORMAT = 1;
const PATH_KIND_PATH = 6; // like rw_type 6
const PATH_KIND_STEPS = 7; // highway=steps, like rw_type 7
const TREE_FORMAT = 3;
const LAND_FORMAT = 1;
const CANOPY_FORMAT = 2;

const TOP_GENUS_COUNT = 11; // ids 0..10; the rest share "Other"
const OTHER_GENUS_ID = TOP_GENUS_COUNT; // tail genera, unknown genus, and every OSM tree
// A genus missing here shows its Latin name. SF's are its register's, from the most planted species.
const GENUS_COMMON_NAMES: Record<string, string> = {
  Quercus: "Oak",
  Acer: "Maple",
  Platanus: "London planetree",
  Gleditsia: "Honeylocust",
  Pyrus: "Pear",
  Tilia: "Linden",
  Prunus: "Cherry",
  Zelkova: "Zelkova",
  Fraxinus: "Ash",
  Ginkgo: "Ginkgo",
  Ulmus: "Elm",
  Styphnolobium: "Pagoda tree",
  Lophostemon: "Brisbane box",
  Ficus: "Fig",
  Pittosporum: "Victorian box",
  Tristaniopsis: "Swamp myrtle",
  Magnolia: "Magnolia",
  Metrosideros: "New Zealand Christmas tree",
  Arbutus: "Strawberry tree",
  Acacia: "Acacia",
  Olea: "Olive",
  Maytenus: "Mayten",
  Corymbia: "Flowering gum",
  Eucalyptus: "Eucalyptus",
  // East Bay genera just outside the top eleven.
  Liquidambar: "Sweetgum",
  Lagerstroemia: "Crape myrtle",
  Pistacia: "Chinese pistache",
  Sequoia: "Coast redwood",
  Cinnamomum: "Camphor",
  Robinia: "Black locust",
  Pinus: "Pine",
  Betula: "Birch",
};
const FILL_SIGMA_METERS = 15;
// Tight across the road, so a park-bounding street's two sides don't blur together.
const TIGHT_SIGMA_ALONG_METERS = 15;
const TIGHT_SIGMA_ACROSS_METERS = 4;
const SIDEWALK_INSET_METERS = 2; // curb to sidewalk center

// Both sources carry nonsense dbh values (2427 in, 9999 in).
const MAX_DBH_INCHES = 60;

// An OSM tree this close to a ForMS trunk is a duplicate; ForMS wins, since it carries a dbh.
const OSM_TREE_DEDUP_METERS = 5;
// The crown byte is decimeters of radius, 0..255.
const CROWN_RADIUS_CEILING_METERS = 25.5;

const COVER_SAMPLES = 1_000_000;
const COVER_SEED = 42; // fixed, so the reported mean doesn't churn between runs

const DENSIFY_METERS = 25; // road sampling step
const DROP_LENGTH_METERS = 1; // shorter is degenerate
const EARTH_RADIUS_METERS = 6_371_008.8;

// A floor a little below the current count (111,675 rows).
const NYC_SEGMENT_COUNT = 111_000;

function crownRadiusMeters(
  allometry: CrownAllometry,
  dbhInches: number,
): number {
  return crownDiameterMeters(allometry, dbhInches) / 2;
}

// A missing dbh (0) gets the city's median rather than a zero crown; `genusIdOf` maps the table's genera.
function crownTrees(
  trees: TreeTable,
  genusIdOf: Uint8Array,
  allometry: CrownAllometry,
  medianDbhInches: number,
): {
  crownRadiusM: Float64Array;
  genusId: Uint8Array;
  clamped: number;
  imputed: number;
} {
  let clamped = 0;
  let imputed = 0;
  const crownRadiusM = new Float64Array(trees.length);
  const genusId = new Uint8Array(trees.length);
  for (let tree = 0; tree < trees.length; tree++) {
    let dbh = trees.dbhInches[tree];
    if (dbh <= 0) {
      dbh = medianDbhInches;
      imputed += 1;
    } else if (dbh > MAX_DBH_INCHES) {
      dbh = MAX_DBH_INCHES;
      clamped += 1;
    }
    crownRadiusM[tree] = crownRadiusMeters(allometry, dbh);
    genusId[tree] = genusIdOf[trees.genus[tree]];
  }
  return { crownRadiusM, genusId, clamped, imputed };
}

// Great-circle meters, as scripts/geometry.ts's haversineMeters over bare numbers.
function haversineMeters(
  fromLatDegrees: number,
  fromLng: number,
  toLatDegrees: number,
  toLng: number,
): number {
  const fromLat = fromLatDegrees * (Math.PI / 180);
  const toLat = toLatDegrees * (Math.PI / 180);
  const deltaLat = toLat - fromLat;
  const deltaLng = (toLng - fromLng) * (Math.PI / 180);
  const chord =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(chord)));
}

const METERS_PER_DEGREE_LAT = (EARTH_RADIUS_METERS * Math.PI) / 180;

interface OsmCrowns {
  crowned: CrownedTree[];
  onLandCount: number;
  deduped: number;
  imputedCrowns: number; // survivors with no diameter_crown
}

// Unique across any plausible cell index: |x| stays far below 2^22 and the sum below 2^53.
const CELL_ROW_STRIDE = 2 ** 23;

// Trunks grouped by dedup cell: sorted numeric keys, CSR offsets into a trunk list, binary-searched.
class TrunkCells {
  private readonly keys: Float64Array;
  private readonly starts: Int32Array;
  private readonly trunks: Int32Array;

  constructor(
    private readonly lat: Float64Array,
    private readonly lng: Float64Array,
    count: number,
    private readonly cellLat: number,
    private readonly cellLng: number,
  ) {
    const keyOf = new Float64Array(count);
    const order = new Int32Array(count);
    for (let trunk = 0; trunk < count; trunk++) {
      keyOf[trunk] = this.key(
        Math.floor(lat[trunk] / cellLat),
        Math.floor(lng[trunk] / cellLng),
      );
      order[trunk] = trunk;
    }
    order.sort((left, right) => keyOf[left] - keyOf[right] || left - right);
    const keys: number[] = [];
    const starts: number[] = [];
    for (let at = 0; at < count; at++) {
      const key = keyOf[order[at]];
      if (at === 0 || key !== keys[keys.length - 1]) {
        keys.push(key);
        starts.push(at);
      }
    }
    starts.push(count);
    this.keys = Float64Array.from(keys);
    this.starts = Int32Array.from(starts);
    this.trunks = order;
  }

  private key(cellY: number, cellX: number): number {
    return cellY * CELL_ROW_STRIDE + cellX;
  }

  // Whether any trunk in the 3x3 cells around the point lies within `meters`.
  anyWithin(lat: number, lng: number, meters: number): boolean {
    const cellY = Math.floor(lat / this.cellLat);
    const cellX = Math.floor(lng / this.cellLng);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cell = this.find(this.key(cellY + dy, cellX + dx));
        if (cell < 0) {
          continue;
        }
        for (let at = this.starts[cell]; at < this.starts[cell + 1]; at++) {
          const trunk = this.trunks[at];
          if (
            haversineMeters(lat, lng, this.lat[trunk], this.lng[trunk]) <=
            meters
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private find(key: number): number {
    let low = 0;
    let high = this.keys.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const probe = this.keys[middle];
      if (probe < key) {
        low = middle + 1;
      } else if (probe > key) {
        high = middle - 1;
      } else {
        return middle;
      }
    }
    return -1;
  }
}

// Grid cells span the dedup radius, so a 3x3 sweep sees every trunk that could be a duplicate.
function crownOsmTrees(
  osmTrees: readonly OsmTree[],
  trunks: { lat: Float64Array; lng: Float64Array; length: number },
  onLand: (coord: Coord) => boolean,
  centerLat: number,
  allometry: CrownAllometry,
  medianDbhInches: number,
): OsmCrowns {
  const cellLat = OSM_TREE_DEDUP_METERS / METERS_PER_DEGREE_LAT;
  const cellLng =
    OSM_TREE_DEDUP_METERS /
    (METERS_PER_DEGREE_LAT * Math.cos(centerLat * (Math.PI / 180)));
  const cells = new TrunkCells(
    trunks.lat,
    trunks.lng,
    trunks.length,
    cellLat,
    cellLng,
  );

  const imputedCrownRadiusM = crownRadiusMeters(allometry, medianDbhInches);
  const crowned: CrownedTree[] = [];
  let onLandCount = 0;
  let deduped = 0;
  let imputedCrowns = 0;
  for (const tree of osmTrees) {
    if (!onLand(tree)) {
      continue;
    }
    onLandCount += 1;
    if (cells.anyWithin(tree.lat, tree.lng, OSM_TREE_DEDUP_METERS)) {
      deduped += 1;
      continue;
    }
    let crownRadiusM: number;
    if (tree.crownDiameterMeters !== undefined) {
      crownRadiusM = Math.min(
        CROWN_RADIUS_CEILING_METERS,
        tree.crownDiameterMeters / 2,
      );
    } else {
      crownRadiusM = imputedCrownRadiusM;
      imputedCrowns += 1;
    }
    crowned.push({
      lat: tree.lat,
      lng: tree.lng,
      crownRadiusM,
      genusId: OTHER_GENUS_ID, // OSM trees carry no genus
    });
  }
  return { crowned, onLandCount, deduped, imputedCrowns };
}

// A multi-part CSCL row becomes several records sharing one physicalid; returns the degenerate parts.
function appendSegments(
  rows: readonly StreetRow[],
  segments: Segment[],
): number {
  let degenerate = 0;
  for (const row of rows) {
    const roadType = toInt(row.rw_type) as RoadType;
    if (!row.the_geom || !ROAD_TYPES.includes(roadType)) {
      continue;
    }
    const physicalId = toInt(row.physicalid);
    let flags = 0;
    if (row.nonped === "V") {
      flags |= FLAG_VEHICULAR_ONLY;
    }
    if (row.trafdir === "NV") {
      flags |= FLAG_NON_VEHICULAR;
    }
    if (roadType === 3 || roadType === 4) {
      flags |= FLAG_STRUCTURE;
    }
    const name = (row.stname_label ?? "").trim();
    for (const part of row.the_geom.coordinates) {
      const points: Coord[] = [];
      for (const [lng, lat] of part) {
        const previous = points[points.length - 1];
        if (!previous || previous.lng !== lng || previous.lat !== lat) {
          points.push({ lng, lat });
        }
      }
      if (points.length < 2) {
        degenerate += 1;
        continue;
      }
      const dense = densify(points, DENSIFY_METERS);
      if (dense.lengthMeters < DROP_LENGTH_METERS) {
        degenerate += 1;
        continue;
      }
      segments.push({
        physicalId,
        roadType,
        streetWidth: Math.min(255, toInt(row.streetwidth)),
        postedSpeed: Math.min(255, toInt(row.posted_speed)),
        flags,
        name,
        nameId: UNNAMED_ID, // assigned in buildNameTable
        points: dense.points,
        lengthMeters: dense.lengthMeters,
      });
    }
  }
  return degenerate;
}

// The StreetRow fields; a column read later must be added here, which re-pages the cache.
const CSCL_FIELDS =
  "the_geom,physicalid,rw_type,streetwidth,posted_speed,nonped,trafdir,stname_label";

async function fetchNycStreets(
  _land: LandContext,
  paging: Paging,
): Promise<Segment[]> {
  const notStreet = notStreetFilter();
  const segments: Segment[] = [];
  let degenerate = 0;
  for await (const rows of NYC_OPEN_DATA.pages<StreetRow>(
    "inkn-q76z",
    {
      $select: CSCL_FIELDS,
      $where:
        "rw_type in ('1','5','6','7','10') OR (rw_type in ('3','4') AND (nonped IS NULL OR nonped != 'V'))",
    },
    NYC_SEGMENT_COUNT,
    paging,
  )) {
    degenerate += appendSegments(rows.filter(notStreet.keep), segments);
  }
  notStreet.finish();
  if (degenerate > 0) {
    console.error(`  dropped ${degenerate} degenerate segments`);
  }
  return segments;
}

const U32_MAX = 0xffffffff; // the record id is a u32

// A way is kept if its midpoint or either endpoint is on land, so a shore-grazing way survives.
function toPathSegments(
  ways: PathWay[],
  onLand: (coord: Coord) => boolean,
): { segments: PathSegment[]; onLandCount: number } {
  const segments: PathSegment[] = [];
  let onLandCount = 0;
  let overflow = 0;
  let degenerate = 0;
  for (const way of ways) {
    const midpoint = way.points[Math.floor(way.points.length / 2)];
    const first = way.points[0];
    const last = way.points[way.points.length - 1];
    if (!onLand(midpoint) && !onLand(first) && !onLand(last)) {
      continue;
    }
    onLandCount += 1;
    if (way.id > U32_MAX) {
      overflow += 1;
      continue;
    }
    const dense = densify(way.points, DENSIFY_METERS);
    if (dense.lengthMeters < DROP_LENGTH_METERS) {
      degenerate += 1;
      continue;
    }
    segments.push({
      osmId: way.id,
      kind: way.steps ? PATH_KIND_STEPS : PATH_KIND_PATH,
      structure: way.structure,
      tunnel: way.tunnel,
      name: (way.name ?? "").trim().toUpperCase(),
      nameId: UNNAMED_ID,
      points: dense.points,
      lengthMeters: dense.lengthMeters,
    });
  }
  if (overflow > 0) {
    console.error(`  dropped ${overflow} paths whose OSM id exceeds u32`);
  }
  if (degenerate > 0) {
    console.error(`  dropped ${degenerate} degenerate paths`);
  }
  return { segments, onLandCount };
}

function emptyBox(): Bounds {
  return {
    south: Number.POSITIVE_INFINITY,
    west: Number.POSITIVE_INFINITY,
    north: Number.NEGATIVE_INFINITY,
    east: Number.NEGATIVE_INFINITY,
  };
}

function swallow(box: Bounds, { lat, lng }: Coord): void {
  box.south = Math.min(box.south, lat);
  box.north = Math.max(box.north, lat);
  box.west = Math.min(box.west, lng);
  box.east = Math.max(box.east, lng);
}

// Paths are left out of the source box: the kernel's reach already covers them.
function unionBox(left: Bounds, right: Bounds): Bounds {
  return {
    south: Math.min(left.south, right.south),
    west: Math.min(left.west, right.west),
    north: Math.max(left.north, right.north),
    east: Math.max(left.east, right.east),
  };
}

// The per-side sidewalk flag bits are filled in later by ingestSidewalks.
function encodeStreets(segments: Segment[], names: string[]): Uint8Array {
  return encodeNetwork(
    "STRT",
    STREET_FORMAT,
    segments.map((segment) => ({
      id: segment.physicalId,
      nameId: segment.nameId,
      lengthMeters: segment.lengthMeters,
      kind: segment.roadType,
      width: segment.streetWidth,
      speed: segment.postedSpeed,
      flags: segment.flags,
      points: segment.points,
    })),
    names,
  );
}

function encodePaths(segments: PathSegment[], names: string[]): Uint8Array {
  return encodeNetwork(
    "PATH",
    PATH_FORMAT,
    segments.map((segment) => ({
      id: segment.osmId,
      nameId: segment.nameId,
      lengthMeters: segment.lengthMeters,
      kind: segment.kind,
      width: 0,
      speed: 0,
      flags:
        (segment.structure ? FLAG_STRUCTURE : 0) |
        (segment.tunnel ? FLAG_TUNNEL : 0),
      points: segment.points,
    })),
    names,
  );
}

async function writeSource(
  directory: string,
  file: string,
  format: number,
  count: number,
  bytes: Uint8Array,
): Promise<SourceFile> {
  await writeAtomic(join(DATA_DIR, directory, file), bytes);
  return {
    file,
    format,
    count,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

interface CanopyChunk {
  polygons: PackedPolygons;
  // Already cut on the land by the source, so not kept or dropped whole against it.
  landCut: boolean;
  features: number;
  dropped: number;
}

async function* nycCanopy(): AsyncGenerator<CanopyChunk> {
  for await (const page of canopyPages()) {
    yield { ...page, landCut: false };
  }
}

// Each built in its own call, so the generator holds neither read while its chunk is consumed.
async function sfCanopyChunk(): Promise<CanopyChunk> {
  const { polygons, fetched, dropped } = await fetchSfCanopyPolygons();
  return { polygons, landCut: false, features: fetched, dropped };
}

async function eastBayCanopyChunk(): Promise<CanopyChunk> {
  const eastBay = await eastBayCanopy();
  const polygons = packPolygons(eastBay.polygons);
  // The memo outlives this stage for the height model, which needs only the height tiles.
  eastBay.polygons = [];
  return {
    polygons,
    landCut: true,
    features: eastBay.fetched,
    dropped: eastBay.dropped,
  };
}

async function* bayAreaCanopy(): AsyncGenerator<CanopyChunk> {
  yield await sfCanopyChunk();
  yield await eastBayCanopyChunk();
}

interface CitySources {
  id: string;
  name: string;
  attribution: string;
  sourceUrl: string;
  streetAttribution: string;
  streetSourceUrl: string;
  fieldAttribution: string;
  fieldSourceUrl: string;
  pathAttribution: string;
  pathSourceUrl: string;
  canopyAttribution: string;
  canopySourceUrl: string;
  land: () => Promise<Polygon[]>;
  // The East Bay reads a county layer, and only the land test decides which rows are in.
  streets: (land: LandContext, paging: Paging) => Promise<Segment[]>;
  trees: (paging: Paging) => Promise<TreeTable>;
  canopy: () => AsyncIterable<CanopyChunk>;
  // Empty means no tree-shade pyramid. A band may measure buildings too; canopy polygons mask them.
  chm: () => Promise<HeightRaster[]>;
  ferries: (() => Promise<FerrySource>) | null;
  // Whether the centerline marks unpaved service ways; SF's "alleys" are streets with sidewalks.
  alleys: boolean;
  landmarks: LandmarkSource | null;
  art: ArtSource | null;
  buildings: BuildingSource | null;
  // Required: OSM's silence can't tell a mapping gap from a bare curb.
  survey: (paging: Paging) => Promise<Survey>;
  elevation: (() => Promise<ElevationRaster>) | null;
  // The curve from the nearest climate region's reference town; the median from the city's register.
  crownAllometry: CrownAllometry;
  medianDbhInches: number;
}

const NYC: CitySources = {
  id: "nyc",
  name: "New York City",
  attribution: "NYC Parks Forestry (ForMS) via NYC Open Data",
  sourceUrl: NYC_OPEN_DATA.page("hn5i-inap"),
  streetAttribution: "NYC DoITT Street Centerline (CSCL) via NYC Open Data",
  streetSourceUrl: NYC_OPEN_DATA.page("inkn-q76z"),
  // ODbL credit for the OSM trees and paths in the field.
  fieldAttribution: "path & tree data © OpenStreetMap contributors",
  fieldSourceUrl: "https://www.openstreetmap.org/copyright",
  pathAttribution: "OpenStreetMap contributors",
  pathSourceUrl: "https://www.openstreetmap.org/copyright",
  canopyAttribution: "Tree canopy © NYC OTI / NYC Parks (2017 LiDAR)",
  canopySourceUrl:
    "https://services3.arcgis.com/xJHn8F2NTtwCMFtX/arcgis/rest/services/TreeCanopy2017_Simplified_1ft/FeatureServer/0",
  land: fetchNycLand,
  streets: fetchNycStreets,
  trees: fetchNycTrees,
  canopy: nycCanopy,
  chm: async () => [
    {
      paths: [await fetchChmRaster()],
      band: null,
      crs: "utm18n",
      attribution: CHM_ATTRIBUTION,
      sourceUrl: CHM_SOURCE_URL,
    },
  ],
  ferries: () => ingestFerries("nyc"),
  alleys: true,
  landmarks: NYC_LANDMARKS,
  art: NYC_ART,
  buildings: NYC_BUILDINGS,
  survey: NYC_SURVEY,
  elevation: null,
  crownAllometry: NOEAST_LONDON_PLANE,
  medianDbhInches: 9, // ForMS median over standing trees
};

// Id stays `sf`: it names every artifact, service-worker cache key and shared link.
const SF: CitySources = {
  id: "sf",
  name: "Bay Area",
  attribution: `SF Public Works street trees via DataSF; ${OAKLAND_TREE_ATTRIBUTION}; ${BERKELEY_TREE_ATTRIBUTION}`,
  sourceUrl: DATA_SF.page("tkzw-k3nq"),
  // The manifest has one source URL, so it stays San Francisco's.
  streetAttribution: `SF basemap street centerlines via DataSF; ${EAST_BAY_STREET_ATTRIBUTION}`,
  streetSourceUrl: DATA_SF.page("3psu-pn9h"),
  fieldAttribution: "path & tree data © OpenStreetMap contributors",
  fieldSourceUrl: "https://www.openstreetmap.org/copyright",
  pathAttribution: "OpenStreetMap contributors",
  pathSourceUrl: "https://www.openstreetmap.org/copyright",
  // SF's 2013 imagery has no height floor; the East Bay's lidar is cut at 15 feet.
  canopyAttribution: `${SF_CANOPY_ATTRIBUTION}; ${ALCC_ATTRIBUTION}`,
  canopySourceUrl: DATA_SF.page("ni2e-vpbg"),
  land: fetchBayAreaLand,
  // Ids can't collide: DataSF `cnn` is in the low millions; county `SEGID` starts at 181,000,001.
  streets: async (land) => [
    ...(await fetchSfStreets()),
    ...(await fetchEastBayStreets(land)),
  ],
  trees: async () =>
    treeTableOf([...(await fetchSfTrees()), ...(await fetchEastBayTrees())]),
  canopy: bayAreaCanopy,
  // SF's band includes buildings; the East Bay's canopy model already zeroes buildings and water.
  chm: async () => {
    const raster = await SF_ELEVATION();
    const eastBay = await eastBayCanopy();
    return [
      {
        paths: raster.paths,
        band: SF_CANOPY_BAND,
        crs: "sf-cs13",
        attribution: raster.attribution,
        sourceUrl: raster.sourceUrl,
      },
      {
        paths: eastBay.heightTiles,
        band: 0,
        crs: "utm10n",
        attribution: ALCC_HEIGHT_ATTRIBUTION,
        sourceUrl: ALCC_SOURCE_URL,
      },
    ];
  },
  ferries: () => ingestFerries("sf"),
  alleys: false,
  landmarks: SF_LANDMARKS,
  art: SF_ART,
  buildings: SF_BUILDINGS,
  survey: SF_SURVEY,
  elevation: SF_ELEVATION,
  crownAllometry: NOCALC_LONDON_PLANE,
  // Oakland's and Berkeley's registers move the combined median by less than an inch.
  medianDbhInches: 7,
};

const CITIES: Record<string, CitySources> = { nyc: NYC, sf: SF };

// Bun's global, declared locally as scripts/build-sw.ts does: its full types clash with the DOM lib.
declare const Bun: { gc(force: boolean): void };

interface Run {
  city: CitySources;
  paging: Paging;
  // Independent stages run side by side; otherwise one at a time, collected between.
  overlap: boolean;
  logMemory: boolean;
}

// A full collection when running one thing at a time, so the next step starts from what is live.
function checkpoint(run: Run, name: string): void {
  if (!run.overlap) {
    Bun.gc(true);
  }
  if (run.logMemory) {
    console.error(`${run.city.id}: ${name} done, ${memoryLine()}`);
  }
}

async function stage<T>(
  run: Run,
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  const value = await work();
  checkpoint(run, name);
  return value;
}

interface LandStage {
  context: LandContext;
  file: SourceFile;
}

async function landStage({ city: CITY }: Run): Promise<LandStage> {
  if (CITY.ferries) {
    const ferries = await CITY.ferries();
    console.error(
      `${CITY.id}: ferries ${ferries.stops} stops, ${ferries.segments} segments (${ferries.bytes} bytes)`,
    );
  }

  console.error(`${CITY.id}: fetching the land polygons`);
  const land = await CITY.land();
  const context: LandContext = {
    onLand: buildLandTest(land),
    box: boxOf(land),
  };
  const landmarks = await ingestLandmarks(CITY.id, CITY.landmarks, context);
  const art = await ingestArt(CITY.id, CITY.art, context);
  const highways = await ingestHighways(CITY.id, context);
  console.error(
    `${CITY.id}: landmarks ${landmarks.count}, art ${art.count}, highways ${highways.count} lines`,
  );
  const file = await writeSource(
    "land",
    `${CITY.id}.bin`,
    LAND_FORMAT,
    land.length,
    encodePolygons("LAND", LAND_FORMAT, land),
  );
  return { context, file };
}

interface CanopyStage {
  file: SourceFile;
  vertices: number;
  squareKm: number;
}

// Packed page by page and streamed out, so neither the polygons as objects nor the blob is ever whole.
async function canopyStage(
  { city: CITY }: Run,
  land: LandContext,
): Promise<CanopyStage> {
  console.error(`${CITY.id}: fetching tree canopy polygons`);
  const collected = new PolygonCollector((land.box.south + land.box.north) / 2);
  let fetched = 0;
  let dropped = 0;
  for await (const chunk of CITY.canopy()) {
    fetched += chunk.features;
    dropped += chunk.dropped;
    collected.add(chunk.polygons, chunk.landCut ? null : land.onLand);
  }
  const squareKm = collected.squareMeters / 1e6;
  console.error(
    `${CITY.id}: canopy ${fetched} polygons fetched, ${collected.polygons} on land, ${collected.vertices} vertices, ${squareKm.toFixed(1)} km² (${dropped} dropped as degenerate or too small)`,
  );

  // Heights are written zeroed; `tiler ingest` fills them in place.
  const file = `${CITY.id}.bin`;
  await mkdir(join(DATA_DIR, "canopy"), { recursive: true });
  const written = await writeChunks(
    join(DATA_DIR, "canopy", file),
    polygonChunks("CNPY", CANOPY_FORMAT, collected, collected.polygons * 2),
  );
  return {
    file: {
      file,
      format: CANOPY_FORMAT,
      count: collected.polygons,
      bytes: written.bytes,
      sha256: written.sha256,
    },
    vertices: collected.vertices,
    squareKm,
  };
}

async function chmStage({ city: CITY }: Run): Promise<HeightRaster[]> {
  console.error(`${CITY.id}: fetching the canopy height model`);
  const chm = await CITY.chm();
  for (const raster of chm) {
    console.error(
      `${CITY.id}: heights from ${raster.paths.length} ${raster.crs} raster${raster.paths.length === 1 ? "" : "s"}`,
    );
  }
  return chm;
}

interface PathsStage {
  ways: number;
  vertices: number;
  km: number;
}

async function pathsStage(
  { city: CITY }: Run,
  land: LandContext,
): Promise<PathsStage> {
  console.error(`${CITY.id}: fetching pedestrian and park paths`);
  const { south, west, north, east } = land.box;
  const pathWays = await fetchPaths(south, west, north, east);
  const { segments, onLandCount } = toPathSegments(pathWays, land.onLand);
  const names = buildNameTable(segments);
  let vertices = 0;
  let km = 0;
  for (const path of segments) {
    vertices += path.points.length;
    km += path.lengthMeters;
  }
  km /= 1000;
  console.error(
    `${CITY.id}: paths ${pathWays.length} fetched, ${onLandCount} on land, ${segments.length} encoded (${km.toFixed(1)} km, ${names.length} distinct names)`,
  );
  await writeAtomic(
    join(DATA_DIR, "paths", `${CITY.id}.bin`),
    encodePaths(segments, names),
  );
  return { ways: segments.length, vertices, km };
}

async function osmTreesStage(
  { city: CITY }: Run,
  land: LandContext,
): Promise<OsmTree[]> {
  console.error(`${CITY.id}: fetching OSM trees`);
  const { south, west, north, east } = land.box;
  return await fetchOsmTrees(south, west, north, east);
}

export interface TreeBlob {
  bytes: Uint8Array;
  count: number;
  box: Bounds; // of the city's trees on land, for the source box
  cityTrees: number;
  clamped: number;
  imputed: number;
  osm: Omit<OsmCrowns, "crowned"> & { kept: number };
  genusTable: { genus: string; common: string; count: number }[];
  otherCount: number;
}

// Drops `trees` off the land in place, crowns the rest and the OSM trees ForMS lacks, and encodes them.
export function treeBlob(
  id: string,
  trees: TreeTable,
  osmTrees: readonly OsmTree[],
  land: LandContext,
  allometry: CrownAllometry,
  medianDbhInches: number,
): TreeBlob {
  // 55 SF trees sit at a placeholder in the north Pacific, which would stretch the city's bounds.
  const fetched = trees.length;
  const probe: Coord = { lat: 0, lng: 0 };
  let onLand = 0;
  for (let tree = 0; tree < fetched; tree++) {
    probe.lat = trees.lat[tree];
    probe.lng = trees.lng[tree];
    if (land.onLand(probe)) {
      trees.lat[onLand] = trees.lat[tree];
      trees.lng[onLand] = trees.lng[tree];
      trees.dbhInches[onLand] = trees.dbhInches[tree];
      trees.genus[onLand] = trees.genus[tree];
      onLand += 1;
    }
  }
  trees.length = onLand;
  if (onLand !== fetched) {
    console.error(
      `${id}: dropped ${fetched - onLand} trees off the city's land`,
    );
  }

  // Genera in first-seen order before the stable sort, as the Map of names this replaced.
  const genusCounts = new Uint32Array(trees.genera.length);
  const seen: number[] = [];
  for (let tree = 0; tree < onLand; tree++) {
    const genus = trees.genus[tree];
    if (genus !== 0) {
      if (genusCounts[genus] === 0) {
        seen.push(genus);
      }
      genusCounts[genus] += 1;
    }
  }
  const topGenera = seen
    .sort((left, right) => genusCounts[right] - genusCounts[left])
    .slice(0, TOP_GENUS_COUNT);
  const genusIdOf = new Uint8Array(trees.genera.length).fill(OTHER_GENUS_ID);
  topGenera.forEach((genus, index) => {
    genusIdOf[genus] = index;
  });
  const genusTable = topGenera.map((index) => {
    const genus = trees.genera[index];
    return {
      genus,
      common: GENUS_COMMON_NAMES[genus] ?? genus,
      count: genusCounts[index],
    };
  });
  const topGenusTotal = genusTable.reduce((sum, { count }) => sum + count, 0);

  const { crownRadiusM, genusId, clamped, imputed } = crownTrees(
    trees,
    genusIdOf,
    allometry,
    medianDbhInches,
  );
  console.error(
    `${id}: sized ${onLand} crowns (clamped ${clamped} trunks past ${MAX_DBH_INCHES} in, imputed ${imputed} missing dbh at ${medianDbhInches} in)`,
  );
  console.error(
    `${id}: top ${genusTable.length} genera ${genusTable.map((entry) => `${entry.genus}:${entry.count}`).join(", ")}`,
  );
  const box = emptyBox();
  for (let tree = 0; tree < onLand; tree++) {
    probe.lat = trees.lat[tree];
    probe.lng = trees.lng[tree];
    swallow(box, probe);
  }

  const osm = crownOsmTrees(
    osmTrees,
    trees,
    land.onLand,
    (land.box.south + land.box.north) / 2,
    allometry,
    medianDbhInches,
  );
  console.error(
    `${id}: OSM trees ${osmTrees.length} fetched, ${osm.onLandCount} on land, ${osm.deduped} deduped against ForMS, ${osm.crowned.length} kept (${osm.imputedCrowns} imputed crown)`,
  );

  const count = onLand + osm.crowned.length;
  const columns: TreeColumns = {
    length: count,
    lat: new Float64Array(count),
    lng: new Float64Array(count),
    crownRadiusM: new Float64Array(count),
    genusId: new Uint8Array(count),
  };
  columns.lat.set(trees.lat.subarray(0, onLand));
  columns.lng.set(trees.lng.subarray(0, onLand));
  columns.crownRadiusM.set(crownRadiusM);
  columns.genusId.set(genusId);
  osm.crowned.forEach((tree, index) => {
    columns.lat[onLand + index] = tree.lat;
    columns.lng[onLand + index] = tree.lng;
    columns.crownRadiusM[onLand + index] = tree.crownRadiusM;
    columns.genusId[onLand + index] = tree.genusId;
  });
  return {
    bytes: encodeTrees(TREE_FORMAT, columns),
    count,
    box,
    cityTrees: onLand,
    clamped,
    imputed,
    osm: {
      onLandCount: osm.onLandCount,
      deduped: osm.deduped,
      imputedCrowns: osm.imputedCrowns,
      kept: osm.crowned.length,
    },
    genusTable,
    otherCount: onLand - topGenusTotal + osm.crowned.length,
  };
}

type TreesStage = Omit<TreeBlob, "bytes" | "count"> & { file: SourceFile };

async function treesStage(
  run: Run,
  land: LandContext,
  osmTrees: readonly OsmTree[],
): Promise<TreesStage> {
  const CITY = run.city;
  console.error(`${CITY.id}: fetching trees`);
  const { bytes, count, ...summary } = treeBlob(
    CITY.id,
    await CITY.trees(run.paging),
    osmTrees,
    land,
    CITY.crownAllometry,
    CITY.medianDbhInches,
  );
  const file = await writeSource(
    "trees",
    `${CITY.id}.bin`,
    TREE_FORMAT,
    count,
    bytes,
  );
  return { ...summary, file };
}

interface Streets {
  segments: Segment[];
  names: string[];
}

async function streetsStage(run: Run, land: LandContext): Promise<Streets> {
  const CITY = run.city;
  console.error(`${CITY.id}: fetching street segments`);
  const segments = await CITY.streets(land, run.paging);
  const names = buildNameTable(segments);
  const unnamed = segments.filter(
    (segment) => segment.nameId === UNNAMED_ID,
  ).length;
  console.error(
    `${CITY.id}: ${names.length} distinct street names, ${unnamed} unnamed segments`,
  );
  return { segments, names };
}

interface SidewalksStage {
  sidewalks: SourceFile;
  segments: number;
  vertices: number;
  box: Bounds;
}

// Sets the streets' per-side sidewalk bits, then writes the streets.
async function sidewalksStage(
  run: Run,
  land: LandContext,
  { segments, names }: Streets,
): Promise<SidewalksStage> {
  const CITY = run.city;
  console.error(`${CITY.id}: fetching sidewalks`);
  const sidewalks = await ingestSidewalks(
    CITY.id,
    segments,
    land,
    () => CITY.survey(run.paging),
    (step) => checkpoint(run, step),
  );
  await writeAtomic(
    join(DATA_DIR, "streets", `${CITY.id}.bin`),
    encodeStreets(segments, names),
  );
  let vertices = 0;
  const box = emptyBox();
  for (const segment of segments) {
    vertices += segment.points.length;
    for (const point of segment.points) {
      swallow(box, point);
    }
  }
  return { sidewalks, segments: segments.length, vertices, box };
}

// Waits out every stage before rethrowing, so a failure never leaves another still writing.
async function settleAll<T extends readonly unknown[]>(
  work: {
    [K in keyof T]: Promise<T[K]>;
  },
): Promise<T> {
  const settled = await Promise.allSettled(work);
  const failures = settled.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (failures.length === 1) {
    throw failures[0];
  } else if (failures.length > 1) {
    throw new AggregateError(failures, `${failures.length} stages failed`);
  }
  return settled.map(
    (outcome) => (outcome as PromiseFulfilledResult<unknown>).value,
  ) as unknown as T;
}

async function fetchCity(run: Run): Promise<void> {
  const started = performance.now();
  const CITY = run.city;
  const file = `${CITY.id}.bin`;

  const land = await stage(run, "land", () => landStage(run));
  const context = land.context;
  const canopyWork = () =>
    stage(run, "canopy", () => canopyStage(run, context));
  const chmWork = () => stage(run, "chm", () => chmStage(run));
  const pathsWork = () => stage(run, "paths", () => pathsStage(run, context));
  const osmWork = () =>
    stage(run, "osm trees", () => osmTreesStage(run, context));
  const treesWork = (osm: OsmTree[]) =>
    stage(run, "trees", () => treesStage(run, context, osm));
  const streetsWork = async () => {
    const streets = await stage(run, "streets", () =>
      streetsStage(run, context),
    );
    return await stage(run, "sidewalks", () =>
      sidewalksStage(run, context, streets),
    );
  };

  let canopy: CanopyStage;
  let chm: HeightRaster[];
  let paths: PathsStage;
  let trees: TreesStage;
  let streets: SidewalksStage;
  if (run.overlap) {
    // The Overpass reads stay back to back: paths, OSM trees, then the sidewalks' two.
    [canopy, chm, [paths, trees, streets]] = await settleAll([
      canopyWork(),
      chmWork(),
      (async () => {
        const paths = await pathsWork();
        const osm = await osmWork();
        const [trees, streets] = await settleAll([
          treesWork(osm),
          streetsWork(),
        ]);
        return [paths, trees, streets] as const;
      })(),
    ]);
  } else {
    // Canopy first, while nothing else is held; streets last, as their segments live through two stages.
    canopy = await canopyWork();
    chm = await chmWork();
    paths = await pathsWork();
    trees = await treesWork(await osmWork());
    streets = await streetsWork();
  }

  const params: IngestParams = {
    canopy: join(DATA_DIR, "canopy", file),
    land: join(DATA_DIR, "land", file),
    streets: join(DATA_DIR, "streets", file),
    paths: join(DATA_DIR, "paths", file),
    chm: chm.map(({ paths, band, crs }) => ({ paths, band, crs })),
    sourceBox: unionBox(streets.box, trees.box),
    landBox: context.box,
    fillSigmaMeters: FILL_SIGMA_METERS,
    tightSigmaAlongMeters: TIGHT_SIGMA_ALONG_METERS,
    tightSigmaAcrossMeters: TIGHT_SIGMA_ACROSS_METERS,
    sidewalkInsetMeters: SIDEWALK_INSET_METERS,
    coverSamples: COVER_SAMPLES,
    coverSeed: COVER_SEED,
    percentiles: PERCENTILES.map((percentile) => Number(percentile.slice(1))),
  };
  const sidecar: TreeDataSidecar = {
    city: {
      id: CITY.id,
      name: CITY.name,
      attribution: CITY.attribution,
      sourceUrl: CITY.sourceUrl,
      streetAttribution: CITY.streetAttribution,
      streetSourceUrl: CITY.streetSourceUrl,
      fieldAttribution: CITY.fieldAttribution,
      fieldSourceUrl: CITY.fieldSourceUrl,
      pathAttribution: CITY.pathAttribution,
      pathSourceUrl: CITY.pathSourceUrl,
      canopyAttribution: CITY.canopyAttribution,
      canopySourceUrl: CITY.canopySourceUrl,
      alleys: CITY.alleys,
    },
    // The manifest has one source URL, so it names the first survey.
    heightSource:
      chm.length > 0
        ? {
            attribution: chm.map((raster) => raster.attribution).join("; "),
            sourceUrl: chm[0].sourceUrl,
          }
        : null,
    trees: trees.file,
    land: land.file,
    canopy: {
      file: canopy.file.file,
      format: canopy.file.format,
      polygons: canopy.file.count,
      vertices: canopy.vertices,
      squareKm: Math.round(canopy.squareKm * 10) / 10,
    },
    streets: {
      file,
      format: STREET_FORMAT,
      segments: streets.segments,
      vertices: streets.vertices,
      densifyMeters: DENSIFY_METERS,
    },
    paths: {
      file,
      format: PATH_FORMAT,
      ways: paths.ways,
      vertices: paths.vertices,
      km: Math.round(paths.km * 10) / 10,
    },
    field: {
      fillSigmaMeters: FILL_SIGMA_METERS,
      tightSigmaAlongMeters: TIGHT_SIGMA_ALONG_METERS,
      tightSigmaAcrossMeters: TIGHT_SIGMA_ACROSS_METERS,
      sidewalkInsetMeters: SIDEWALK_INSET_METERS,
      crownAllometry: CITY.crownAllometry,
      maxDbhInches: MAX_DBH_INCHES,
      imputedDbhInches: CITY.medianDbhInches,
      clampedTrees: trees.clamped,
      imputedTrees: trees.imputed,
      osmTrees: trees.osm.kept,
      osmTreeDedup: trees.osm.deduped,
      osmImputedCrowns: trees.osm.imputedCrowns,
      coverSamples: COVER_SAMPLES,
      coverSeed: COVER_SEED,
      genus: {
        table: trees.genusTable,
        otherCount: trees.otherCount,
      },
    },
    cityTrees: trees.cityTrees,
    sidewalks: streets.sidewalks,
  };

  await writeAtomic(INGEST_PARAMS_PATH, JSON.stringify(params));
  await writeAtomic(SIDECAR_PATH, JSON.stringify(sidecar));

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.error(`${CITY.id}: fetched and encoded in ${seconds}s`);
  if (run.logMemory) {
    console.error(`${CITY.id}: finished, ${memoryLine()}`);
  }
}

if (import.meta.main) {
  // `--refresh` belongs to scripts/cache.ts; it is declared so parseArgs doesn't reject it.
  const { values } = parseArgs({
    options: {
      city: { type: "string" },
      refresh: { type: "boolean" },
      // A byte budget for running ahead, as `tiler build --memory`; small means one thing at a time.
      memory: { type: "string", default: "auto" },
      // RSS, peak RSS and heap after each stage.
      "log-memory": { type: "boolean", default: false },
    },
  });
  const known = Object.keys(CITIES).join(", ");
  if (values.city === undefined) {
    throw new Error(`--city is required, one of: ${known}`);
  }
  const city = CITIES[values.city];
  if (!city) {
    throw new Error(`no city ${values.city}; known: ${known}`);
  }
  const budget = memoryBudget(parseMemory(values.memory));
  const { pageWorkers, overlapStages } = concurrencyOf(budget.bytes);
  console.error(
    `${city.id}: memory budget ${(budget.bytes / 2 ** 30).toFixed(1)} GiB (${budget.why}): ${pageWorkers} Socrata page${pageWorkers === 1 ? "" : "s"} at once, stages ${overlapStages ? "overlapping" : "one at a time"}`,
  );
  await fetchCity({
    city,
    paging: { concurrency: pageWorkers },
    overlap: overlapStages,
    logMemory: values["log-memory"],
  });
}

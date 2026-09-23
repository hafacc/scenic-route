import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { fetchCanopyPolygons } from "./canopy";
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
  encodeCanopy,
  encodeNetwork,
  encodePolygons,
  encodeTrees,
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
import {
  fetchOsmTrees,
  fetchPaths,
  type OsmTree,
  type PathWay,
  type Polygon,
} from "./overpass";
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
  type Tree,
} from "./socrata";
import {
  FLAG_NON_VEHICULAR,
  FLAG_STRUCTURE,
  FLAG_TUNNEL,
  FLAG_VEHICULAR_ONLY,
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

// A missing dbh (0) gets the city's median rather than a zero crown.
function crownTrees(
  trees: readonly Tree[],
  genusId: ReadonlyMap<string, number>,
  allometry: CrownAllometry,
  medianDbhInches: number,
): {
  crowned: CrownedTree[];
  clamped: number;
  imputed: number;
} {
  let clamped = 0;
  let imputed = 0;
  const crowned = trees.map(({ lat, lng, dbhInches, genus }) => {
    let dbh = dbhInches;
    if (dbh <= 0) {
      dbh = medianDbhInches;
      imputed += 1;
    } else if (dbh > MAX_DBH_INCHES) {
      dbh = MAX_DBH_INCHES;
      clamped += 1;
    }
    return {
      lat,
      lng,
      crownRadiusM: crownRadiusMeters(allometry, dbh),
      genusId: genusId.get(genus) ?? OTHER_GENUS_ID,
    };
  });
  return { crowned, clamped, imputed };
}

function haversineMeters(from: Coord, to: Coord): number {
  const fromLat = from.lat * (Math.PI / 180);
  const toLat = to.lat * (Math.PI / 180);
  const deltaLat = toLat - fromLat;
  const deltaLng = (to.lng - from.lng) * (Math.PI / 180);
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

// Grid cells span the dedup radius, so a 3x3 sweep sees every trunk that could be a duplicate.
function crownOsmTrees(
  osmTrees: readonly OsmTree[],
  forms: readonly Coord[],
  onLand: (coord: Coord) => boolean,
  centerLat: number,
  allometry: CrownAllometry,
  medianDbhInches: number,
): OsmCrowns {
  const cellLat = OSM_TREE_DEDUP_METERS / METERS_PER_DEGREE_LAT;
  const cellLng =
    OSM_TREE_DEDUP_METERS /
    (METERS_PER_DEGREE_LAT * Math.cos(centerLat * (Math.PI / 180)));
  const cellOf = (lat: number, lng: number): [number, number] => [
    Math.floor(lat / cellLat),
    Math.floor(lng / cellLng),
  ];
  const buckets = new Map<string, Coord[]>();
  for (const trunk of forms) {
    const [cellY, cellX] = cellOf(trunk.lat, trunk.lng);
    const key = `${cellY},${cellX}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(trunk);
    } else {
      buckets.set(key, [trunk]);
    }
  }

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
    const [cellY, cellX] = cellOf(tree.lat, tree.lng);
    let duplicate = false;
    for (let dy = -1; dy <= 1 && !duplicate; dy++) {
      for (let dx = -1; dx <= 1 && !duplicate; dx++) {
        for (const trunk of buckets.get(`${cellY + dy},${cellX + dx}`) ?? []) {
          if (haversineMeters(tree, trunk) <= OSM_TREE_DEDUP_METERS) {
            duplicate = true;
            break;
          }
        }
      }
    }
    if (duplicate) {
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

// A multi-part CSCL row becomes several records sharing one physicalid.
function toSegments(rows: StreetRow[]): Segment[] {
  const segments: Segment[] = [];
  let degenerate = 0;
  for (const row of rows) {
    const roadType = toInt(row.rw_type) as RoadType;
    if (!row.the_geom || !ROAD_TYPES.includes(roadType)) {
      continue;
    }
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
        physicalId: toInt(row.physicalid),
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
  if (degenerate > 0) {
    console.error(`  dropped ${degenerate} degenerate segments`);
  }
  return segments;
}

async function fetchNycStreets(): Promise<Segment[]> {
  // `*`: the cache keys on the query, so a narrow $select would re-page on every added column.
  const rows = await NYC_OPEN_DATA.dataset<StreetRow>(
    "inkn-q76z",
    {
      $select: "*",
      $where:
        "rw_type in ('1','5','6','7','10') OR (rw_type in ('3','4') AND (nonped IS NULL OR nonped != 'V'))",
    },
    NYC_SEGMENT_COUNT,
  );
  return toSegments(rows);
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

// One vertex decides the whole polygon: fine for crowns, wrong for polygons the coast cuts through.
function clipCanopyToLand(
  polygons: Polygon[],
  onLand: (coord: Coord) => boolean,
): Polygon[] {
  const kept: Polygon[] = [];
  for (const polygon of polygons) {
    const outer = polygon[0];
    const midpoint = outer[Math.floor(outer.length / 2)];
    if (onLand(midpoint)) {
      kept.push(polygon);
    }
  }
  return kept;
}

// Signed by winding; Esri winds holes opposite their outer ring, so a polygon's sum nets them out.
function ringSignedAreaSquareMeters(ring: Coord[], refLat: number): number {
  const metersPerLng =
    METERS_PER_DEGREE_LAT * Math.cos(refLat * (Math.PI / 180));
  let twiceArea = 0;
  for (
    let point = 0, previous = ring.length - 1;
    point < ring.length;
    point++
  ) {
    const currentX = ring[point].lng * metersPerLng;
    const currentY = ring[point].lat * METERS_PER_DEGREE_LAT;
    const previousX = ring[previous].lng * metersPerLng;
    const previousY = ring[previous].lat * METERS_PER_DEGREE_LAT;
    twiceArea += previousX * currentY - currentX * previousY;
    previous = point;
  }
  return twiceArea / 2;
}

function canopySquareKm(polygons: Polygon[], refLat: number): number {
  let squareMeters = 0;
  for (const polygon of polygons) {
    let net = 0;
    for (const ring of polygon) {
      net += ringSignedAreaSquareMeters(ring, refLat);
    }
    squareMeters += Math.abs(net);
  }
  return squareMeters / 1e6;
}

// Paths are left out: the kernel's reach already covers them, and they'd shift the projection.
function sourceBoxOf(segments: Segment[], trees: Coord[]): Bounds {
  let south = Number.POSITIVE_INFINITY;
  let west = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  const swallow = ({ lat, lng }: Coord): void => {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lng);
    east = Math.max(east, lng);
  };
  for (const segment of segments) {
    for (const point of segment.points) {
      swallow(point);
    }
  }
  for (const tree of trees) {
    swallow(tree);
  }
  return { south, west, north, east };
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
  const path = join(DATA_DIR, directory);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, file), bytes);
  return {
    file,
    format,
    count,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
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
  streets: (land: LandContext) => Promise<Segment[]>;
  trees: () => Promise<Tree[]>;
  canopy: () => Promise<{
    // Crowns, kept or dropped whole against the land.
    polygons: Polygon[];
    // Already cut on the land by the source, since `clipCanopyToLand` can't cut a polygon.
    landCut: Polygon[];
    fetched: number;
    dropped: number;
  }>;
  // Empty means no tree-shade pyramid. A band may measure buildings too; canopy polygons mask them.
  chm: () => Promise<HeightRaster[]>;
  ferries: (() => Promise<FerrySource>) | null;
  // Whether the centerline marks unpaved service ways; SF's "alleys" are streets with sidewalks.
  alleys: boolean;
  landmarks: LandmarkSource | null;
  art: ArtSource | null;
  buildings: BuildingSource | null;
  // Required: OSM's silence can't tell a mapping gap from a bare curb.
  survey: () => Promise<Survey>;
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
  canopy: async () => ({ ...(await fetchCanopyPolygons()), landCut: [] }),
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
  trees: async () => [
    ...(await fetchSfTrees()),
    ...(await fetchEastBayTrees()),
  ],
  canopy: async () => {
    const city = await fetchSfCanopyPolygons();
    const eastBay = await eastBayCanopy();
    return {
      polygons: city.polygons,
      landCut: eastBay.polygons,
      fetched: city.fetched + eastBay.fetched,
      dropped: city.dropped + eastBay.dropped,
    };
  },
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

async function fetchCity(CITY: CitySources): Promise<void> {
  const started = performance.now();

  if (CITY.ferries) {
    const ferries = await CITY.ferries();
    console.error(
      `${CITY.id}: ferries ${ferries.stops} stops, ${ferries.segments} segments (${ferries.bytes} bytes)`,
    );
  }

  console.error(`${CITY.id}: fetching the land polygons`);
  const land = await CITY.land();
  const landBox = boxOf(land);

  const onLand = buildLandTest(land);

  const landContext: LandContext = { onLand, box: landBox };
  const landmarks = await ingestLandmarks(CITY.id, CITY.landmarks, landContext);
  const art = await ingestArt(CITY.id, CITY.art, landContext);
  const highways = await ingestHighways(CITY.id, landContext);
  console.error(
    `${CITY.id}: landmarks ${landmarks.count}, art ${art.count}, highways ${highways.count} lines`,
  );

  console.error(`${CITY.id}: fetching tree canopy polygons`);
  const canopy = await CITY.canopy();
  const canopyOnLand = [
    ...clipCanopyToLand(canopy.polygons, onLand),
    ...canopy.landCut,
  ];
  const canopyReferenceLat = (landBox.south + landBox.north) / 2;
  const canopySquareKilometers = canopySquareKm(
    canopyOnLand,
    canopyReferenceLat,
  );
  let canopyVertices = 0;
  for (const polygon of canopyOnLand) {
    for (const ring of polygon) {
      canopyVertices += ring.length;
    }
  }
  console.error(
    `${CITY.id}: canopy ${canopy.fetched} polygons fetched, ${canopyOnLand.length} on land, ${canopyVertices} vertices, ${canopySquareKilometers.toFixed(1)} km² (${canopy.dropped} dropped as degenerate or too small)`,
  );

  console.error(`${CITY.id}: fetching the canopy height model`);
  const chm = await CITY.chm();
  for (const raster of chm) {
    console.error(
      `${CITY.id}: heights from ${raster.paths.length} ${raster.crs} raster${raster.paths.length === 1 ? "" : "s"}`,
    );
  }

  // Overpass queries run back to back while a mirror is warm.
  console.error(`${CITY.id}: fetching pedestrian and park paths`);
  const pathWays = await fetchPaths(
    landBox.south,
    landBox.west,
    landBox.north,
    landBox.east,
  );
  const { segments: pathSegments, onLandCount } = toPathSegments(
    pathWays,
    onLand,
  );
  const pathNames = buildNameTable(pathSegments);
  let pathVertices = 0;
  let pathKm = 0;
  for (const path of pathSegments) {
    pathVertices += path.points.length;
    pathKm += path.lengthMeters;
  }
  pathKm /= 1000;
  console.error(
    `${CITY.id}: paths ${pathWays.length} fetched, ${onLandCount} on land, ${pathSegments.length} encoded (${pathKm.toFixed(1)} km, ${pathNames.length} distinct names)`,
  );

  console.error(`${CITY.id}: fetching OSM trees`);
  const osmTreesRaw = await fetchOsmTrees(
    landBox.south,
    landBox.west,
    landBox.north,
    landBox.east,
  );

  console.error(`${CITY.id}: fetching street segments`);
  const segments = await CITY.streets(landContext);
  const names = buildNameTable(segments);
  const unnamed = segments.filter(
    (segment) => segment.nameId === UNNAMED_ID,
  ).length;
  console.error(
    `${CITY.id}: ${names.length} distinct street names, ${unnamed} unnamed segments`,
  );
  console.error(`${CITY.id}: fetching trees`);
  const allTrees = await CITY.trees();
  // 55 SF trees sit at a placeholder in the north Pacific, which would stretch the city's bounds.
  const trees = allTrees.filter((tree) => onLand(tree));
  if (trees.length !== allTrees.length) {
    console.error(
      `${CITY.id}: dropped ${allTrees.length - trees.length} trees off the city's land`,
    );
  }

  const genusCounts = new Map<string, number>();
  for (const tree of trees) {
    if (tree.genus !== "") {
      genusCounts.set(tree.genus, (genusCounts.get(tree.genus) ?? 0) + 1);
    }
  }
  const topGenera = [...genusCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, TOP_GENUS_COUNT);
  const genusId = new Map(topGenera.map(([genus], index) => [genus, index]));
  const genusTable = topGenera.map(([genus, count]) => ({
    genus,
    common: GENUS_COMMON_NAMES[genus] ?? genus,
    count,
  }));
  const topGenusTotal = topGenera.reduce((sum, [, count]) => sum + count, 0);

  const { crowned, clamped, imputed } = crownTrees(
    trees,
    genusId,
    CITY.crownAllometry,
    CITY.medianDbhInches,
  );
  console.error(
    `${CITY.id}: sized ${crowned.length} crowns (clamped ${clamped} trunks past ${MAX_DBH_INCHES} in, imputed ${imputed} missing dbh at ${CITY.medianDbhInches} in)`,
  );
  console.error(
    `${CITY.id}: top ${genusTable.length} genera ${genusTable.map((entry) => `${entry.genus}:${entry.count}`).join(", ")}`,
  );

  const osm = crownOsmTrees(
    osmTreesRaw,
    trees,
    onLand,
    (landBox.south + landBox.north) / 2,
    CITY.crownAllometry,
    CITY.medianDbhInches,
  );
  console.error(
    `${CITY.id}: OSM trees ${osmTreesRaw.length} fetched, ${osm.onLandCount} on land, ${osm.deduped} deduped against ForMS, ${osm.crowned.length} kept (${osm.imputedCrowns} imputed crown)`,
  );
  const allCrowned = [...crowned, ...osm.crowned];

  const file = `${CITY.id}.bin`;
  const treeFile = await writeSource(
    "trees",
    file,
    TREE_FORMAT,
    allCrowned.length,
    encodeTrees(TREE_FORMAT, allCrowned),
  );
  const landFile = await writeSource(
    "land",
    file,
    LAND_FORMAT,
    land.length,
    encodePolygons("LAND", LAND_FORMAT, land),
  );
  // Heights are written zeroed; `tiler ingest` fills them in place.
  const canopyPath = join(DATA_DIR, "canopy", file);
  const canopyFile = await writeSource(
    "canopy",
    file,
    CANOPY_FORMAT,
    canopyOnLand.length,
    encodeCanopy(CANOPY_FORMAT, canopyOnLand),
  );

  // Sets the streets' per-side sidewalk bits, so it runs before they are encoded.
  console.error(`${CITY.id}: fetching sidewalks`);
  const sidewalks = await ingestSidewalks(
    CITY.id,
    segments,
    landContext,
    CITY.survey,
  );

  const streetPath = join(DATA_DIR, "streets", file);
  await mkdir(join(DATA_DIR, "streets"), { recursive: true });
  await writeFile(streetPath, encodeStreets(segments, names));

  const pathPath = join(DATA_DIR, "paths", file);
  await mkdir(join(DATA_DIR, "paths"), { recursive: true });
  await writeFile(pathPath, encodePaths(pathSegments, pathNames));

  let vertices = 0;
  for (const segment of segments) {
    vertices += segment.points.length;
  }

  const params: IngestParams = {
    canopy: canopyPath,
    land: join(DATA_DIR, "land", file),
    streets: streetPath,
    paths: pathPath,
    chm: chm.map(({ paths, band, crs }) => ({ paths, band, crs })),
    sourceBox: sourceBoxOf(segments, trees),
    landBox,
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
    trees: treeFile,
    land: landFile,
    canopy: {
      file: canopyFile.file,
      format: canopyFile.format,
      polygons: canopyFile.count,
      vertices: canopyVertices,
      squareKm: Math.round(canopySquareKilometers * 10) / 10,
    },
    streets: {
      file,
      format: STREET_FORMAT,
      segments: segments.length,
      vertices,
      densifyMeters: DENSIFY_METERS,
    },
    paths: {
      file,
      format: PATH_FORMAT,
      ways: pathSegments.length,
      vertices: pathVertices,
      km: Math.round(pathKm * 10) / 10,
    },
    field: {
      fillSigmaMeters: FILL_SIGMA_METERS,
      tightSigmaAlongMeters: TIGHT_SIGMA_ALONG_METERS,
      tightSigmaAcrossMeters: TIGHT_SIGMA_ACROSS_METERS,
      sidewalkInsetMeters: SIDEWALK_INSET_METERS,
      crownAllometry: CITY.crownAllometry,
      maxDbhInches: MAX_DBH_INCHES,
      imputedDbhInches: CITY.medianDbhInches,
      clampedTrees: clamped,
      imputedTrees: imputed,
      osmTrees: osm.crowned.length,
      osmTreeDedup: osm.deduped,
      osmImputedCrowns: osm.imputedCrowns,
      coverSamples: COVER_SAMPLES,
      coverSeed: COVER_SEED,
      genus: {
        table: genusTable,
        otherCount: trees.length - topGenusTotal + osm.crowned.length,
      },
    },
    cityTrees: trees.length,
    sidewalks,
  };

  await mkdir(dirname(INGEST_PARAMS_PATH), { recursive: true });
  await writeFile(INGEST_PARAMS_PATH, JSON.stringify(params));
  await writeFile(SIDECAR_PATH, JSON.stringify(sidecar));

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.error(`${CITY.id}: fetched and encoded in ${seconds}s`);
}

// `--refresh` belongs to scripts/cache.ts; it is declared so parseArgs doesn't reject it.
const { values } = parseArgs({
  options: {
    city: { type: "string" },
    refresh: { type: "boolean" },
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
await fetchCity(city);

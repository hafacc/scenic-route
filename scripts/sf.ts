import { densify } from "./geometry";
import { buildLandTest } from "./land-filter";
import type { Polygon } from "./overpass";
import { type Coord, DATA_SF, type Tree } from "./socrata";
import {
  ROAD_PATH,
  ROAD_STEPS,
  ROAD_STREET,
  type RoadType,
  type Segment,
  toInt,
} from "./streets";

// Row-count floors a little below the live count, to catch a page the server quietly cut short.
const NEIGHBORHOOD_COUNT = 40;
const STREET_COUNT = 16_000;
export const SIDEWALK_WIDTH_DATASET = "4g86-grxu";
export const SIDEWALK_WIDTH_COUNT = 16_000;
const ROW_POLYGON_COUNT = 22_000;

export const SF_ATTRIBUTION = "SF Public Works via DataSF";
export const SF_STREET_ATTRIBUTION = "SF Basemap Street Centerlines via DataSF";
export const SF_CANOPY_ATTRIBUTION =
  "Urban tree canopy © SF Planning (2013 Urban Forest Plan)";

// Neighborhoods, not the county, whose boundary runs 45 km offshore to the Farallons.
export async function fetchSfLand(): Promise<Polygon[]> {
  const rows = await DATA_SF.dataset<{
    the_geom?: { type: string; coordinates: [number, number][][][] };
  }>("j2bu-swwd", { $select: "*" }, NEIGHBORHOOD_COUNT);
  const polygons: Polygon[] = [];
  for (const row of rows) {
    for (const parts of row.the_geom?.coordinates ?? []) {
      polygons.push(
        parts.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))),
      );
    }
  }
  return polygons;
}

interface StreetRow {
  line?: { type: string; coordinates: [number, number][] };
  cnn?: string;
  layer?: string;
  classcode?: string;
  streetname?: string;
  st_type?: string;
  active?: boolean;
}

interface SidewalkWidthRow {
  cnn?: string;
  sidewalk_f?: string; // sidewalk (not roadway) width in feet; 0 unknown, negative "varies"
}

interface RowPolygonRow {
  cnn?: string;
  shape_area?: string; // square feet (state plane)
}

// `PAPER*` layers are platted streets never built; freeways return as the HWAY nuisance source.
const WALKABLE_LAYERS: Record<string, RoadType> = {
  STREETS: ROAD_STREET,
  STREETS_TI: ROAD_STREET, // Treasure Island
  STREETS_YBI: ROAD_STREET, // Yerba Buena Island
  STREETS_HUNTERSP: ROAD_STREET,
  PRIVATE: ROAD_STREET,
  STREETS_PEDESTRI: ROAD_PATH,
  PARKS: ROAD_PATH,
  PARKS_NPS_PRESIDIO: ROAD_PATH,
  PARKS_NPS_FTMASON: ROAD_PATH,
  UPROW: ROAD_PATH, // unimproved right of way
};

// No `ALY`: the alley type means New York's pavementless service way; SF's alleys have sidewalks.
const TYPE_OVERRIDES: Record<string, RoadType> = {
  STPS: ROAD_STEPS,
  STWY: ROAD_STEPS,
  WALK: ROAD_PATH,
  PATH: ROAD_PATH,
  PSGE: ROAD_PATH,
  PLZ: ROAD_PATH,
};

function roadTypeOf(row: StreetRow): RoadType | null {
  const layer = WALKABLE_LAYERS[row.layer ?? ""];
  if (layer === undefined) {
    return null;
  }
  const override = TYPE_OVERRIDES[(row.st_type ?? "").toUpperCase()];
  // An override only refines a street; it never promotes a park path to a roadway.
  return override !== undefined && layer === ROAD_STREET ? override : layer;
}

// SF publishes no roadway width, so roadway = right-of-way - 2 * sidewalk; this is the median.
const SF_MEDIAN_ROADWAY_FEET = 26;

function roadwayFeet(
  rightOfWayFeet: number | undefined,
  sidewalkFeet: number | undefined,
): number {
  if (
    rightOfWayFeet === undefined ||
    sidewalkFeet === undefined ||
    rightOfWayFeet <= 0 ||
    sidewalkFeet <= 0
  ) {
    return SF_MEDIAN_ROADWAY_FEET;
  }
  const roadway = rightOfWayFeet - 2 * sidewalkFeet;
  return roadway > 0
    ? Math.min(255, Math.round(roadway))
    : SF_MEDIAN_ROADWAY_FEET;
}

// Summed: a divided street is several polygons under one id.
function rightOfWayAreas(rows: RowPolygonRow[]): Map<string, number> {
  const areas = new Map<string, number>();
  for (const row of rows) {
    const area = Number.parseFloat(row.shape_area ?? "");
    if (row.cnn && Number.isFinite(area) && area > 0) {
      const key = String(toInt(row.cnn));
      areas.set(key, (areas.get(key) ?? 0) + area);
    }
  }
  return areas;
}

function medianOf(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

const METERS_PER_FOOT = 0.3048;
const DENSIFY_METERS = 25;
const DROP_LENGTH_METERS = 0.5;
const UNNAMED_ID = 0xffff;

export async function fetchSfStreets(): Promise<Segment[]> {
  const [rows, widthRows, rowRows] = await Promise.all([
    DATA_SF.dataset<StreetRow>(
      "3psu-pn9h",
      { $select: "*", $where: "active = true" },
      STREET_COUNT,
    ),
    DATA_SF.dataset<SidewalkWidthRow>(
      SIDEWALK_WIDTH_DATASET,
      { $select: "cnn,sidewalk_f" },
      SIDEWALK_WIDTH_COUNT,
    ),
    DATA_SF.dataset<RowPolygonRow>(
      "h8n7-e4ns",
      { $select: "cnn,shape_area" },
      ROW_POLYGON_COUNT,
    ),
  ]);

  // Keyed through `toInt`, like `physicalId`, so a leading zero or ".0" can't break the join.
  const sidewalkFeet = new Map<string, number>();
  const measured: number[] = [];
  for (const row of widthRows) {
    const feet = Number.parseFloat(row.sidewalk_f ?? "");
    if (row.cnn && Number.isFinite(feet) && feet > 0) {
      sidewalkFeet.set(String(toInt(row.cnn)), feet);
      measured.push(feet);
    }
  }
  const areas = rightOfWayAreas(rowRows);
  console.error(
    `  sidewalk widths: ${sidewalkFeet.size} measured (median ${medianOf(measured).toFixed(0)} ft), ${areas.size} right-of-way polygons`,
  );
  const roadways: number[] = [];

  const segments: Segment[] = [];
  let degenerate = 0;
  let offset = 0;
  for (const row of rows) {
    const roadType = roadTypeOf(row);
    if (!row.line || roadType === null) {
      continue;
    }
    const points: Coord[] = [];
    for (const [lng, lat] of row.line.coordinates) {
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
    // A path is its own walking surface, so it carries no offset.
    const area = areas.get(String(toInt(row.cnn)));
    const lengthFeet = dense.lengthMeters / METERS_PER_FOOT;
    const width =
      roadType === ROAD_STREET
        ? roadwayFeet(
            area !== undefined && lengthFeet > 0
              ? area / lengthFeet
              : undefined,
            sidewalkFeet.get(String(toInt(row.cnn))),
          )
        : 0;
    if (width > 0) {
      offset += 1;
      roadways.push(width);
    }
    segments.push({
      physicalId: toInt(row.cnn),
      roadType,
      streetWidth: width,
      postedSpeed: 0, // not on SF's centerline
      // `classcode = 1` occurs only on the dropped FREEWAYS layer, so nothing is vehicular-only.
      flags: 0,
      name: (row.streetname ?? "").trim(),
      nameId: UNNAMED_ID,
      points: dense.points,
      lengthMeters: dense.lengthMeters,
    });
  }
  console.error(
    `  streets: ${segments.length} walkable of ${rows.length} active, ${offset} offsetted (median roadway ${medianOf(roadways).toFixed(0)} ft, ${degenerate} degenerate dropped)`,
  );
  return segments;
}

interface TreeRow {
  latitude?: string;
  longitude?: string;
  dbh?: string;
  qspecies?: string;
  planttype?: string;
}

// DPW street-tree register; `dbh` is on only 76% of rows, so imputation does much of the work.
const SF_TREE_COUNT = 190_000;

// Species read "Fraxinus uhdei :: Shamel Ash"; "Tree(s) ::" (11,818 rows) marks an unidentified one.
const UNIDENTIFIED = new Set(["", "unknown", "tree(s)", "tree", "trees"]);

function sfGenusOf(species: string | undefined): string {
  const scientific = (species ?? "").split("::")[0].trim();
  const genus = scientific.split(/\s+/)[0] ?? "";
  return UNIDENTIFIED.has(genus.toLowerCase()) ? "" : genus;
}

export async function fetchSfTrees(): Promise<Tree[]> {
  const rows = await DATA_SF.dataset<TreeRow>(
    "tkzw-k3nq",
    { $select: "*", $where: "planttype in ('Tree','tree')" },
    SF_TREE_COUNT,
  );
  const trees: Tree[] = [];
  for (const row of rows) {
    const lat = Number.parseFloat(row.latitude ?? "");
    const lng = Number.parseFloat(row.longitude ?? "");
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }
    const dbh = Number.parseFloat(row.dbh ?? "");
    trees.push({
      lat,
      lng,
      dbhInches: Number.isFinite(dbh) && dbh > 0 ? dbh : 0,
      genus: sfGenusOf(row.qspecies),
    });
  }
  return trees;
}

// The 2013 Urban Forest Plan canopy: aerial imagery, not LiDAR.
const SF_CANOPY_COUNT = 285_000;

export async function fetchSfCanopyPolygons(): Promise<{
  polygons: Polygon[];
  fetched: number;
  dropped: number;
}> {
  const rows = await DATA_SF.dataset<{
    the_geom?: { type: string; coordinates: number[][][][] };
  }>("ni2e-vpbg", { $select: "the_geom" }, SF_CANOPY_COUNT);
  const polygons: Polygon[] = [];
  let dropped = 0;
  for (const row of rows) {
    for (const parts of row.the_geom?.coordinates ?? []) {
      const rings = parts
        .map((ring) =>
          ring.map(([lng, lat]) => ({
            lat: lat as number,
            lng: lng as number,
          })),
        )
        .filter((ring) => ring.length >= 4);
      if (rings.length === 0) {
        dropped += 1;
      } else {
        polygons.push(rings);
      }
    }
  }
  return { polygons, fetched: rows.length, dropped };
}

// SF publishes landmarks as parcels, not points.
function centroidOf(
  geometry: { coordinates: number[][][][] } | undefined,
): Coord | null {
  const ring = geometry?.coordinates?.[0]?.[0];
  if (!ring || ring.length < 3) {
    return null;
  }
  let lat = 0;
  let lng = 0;
  for (const [x, y] of ring) {
    lng += x;
    lat += y;
  }
  return { lat: lat / ring.length, lng: lng / ring.length };
}

export interface NamedPoint extends Coord {
  name: string;
}

// Article 10 landmarks, the city's designated historic sites.
export async function fetchSfLandmarks(
  onLand: (coord: Coord) => boolean,
): Promise<NamedPoint[]> {
  const rows = await DATA_SF.dataset<{
    the_geom?: { coordinates: number[][][][] };
    name?: string;
  }>("rzic-39gi", { $select: "*" }, 350);
  const points: NamedPoint[] = [];
  for (const row of rows) {
    const centroid = centroidOf(row.the_geom);
    if (centroid && onLand(centroid)) {
      points.push({ ...centroid, name: (row.name ?? "").trim() });
    }
  }
  return points;
}

// Civic Art Collection, 1% Art Program and StreetSmArts murals; the ingest dedups by proximity.
export async function fetchSfArt(
  onLand: (coord: Coord) => boolean,
): Promise<NamedPoint[]> {
  const [civic, onePercent, murals] = await Promise.all([
    DATA_SF.dataset<{
      latitude?: string;
      longitude?: string;
      display_title?: string;
    }>("r7bn-7v9c", { $select: "*" }, 1_000),
    DATA_SF.dataset<{ the_geom?: { coordinates: number[] }; title?: string }>(
      "cf6e-9e4j",
      { $select: "*" },
      60,
    ),
    DATA_SF.dataset<{ the_geom?: { coordinates: number[] }; title?: string }>(
      "wg8w-68vc",
      { $select: "*" },
      60,
    ),
  ]);
  const points: NamedPoint[] = [];
  for (const row of civic) {
    const lat = Number.parseFloat(row.latitude ?? "");
    const lng = Number.parseFloat(row.longitude ?? "");
    if (Number.isFinite(lat) && Number.isFinite(lng) && onLand({ lat, lng })) {
      points.push({ lat, lng, name: (row.display_title ?? "").trim() });
    }
  }
  for (const rows of [onePercent, murals]) {
    for (const row of rows) {
      const [lng, lat] = row.the_geom?.coordinates ?? [];
      if (
        typeof lat === "number" &&
        typeof lng === "number" &&
        onLand({ lat, lng })
      ) {
        points.push({ lat, lng, name: (row.title ?? "").trim() });
      }
    }
  }
  return points;
}

export interface RawBuilding {
  polygon: Coord[][];
  heightMeters: number;
  baseElevationMeters: number;
}

// SF's footprints carry LiDAR height (`hgt_median_m`) and ground (`gnd_min_m`), so no height join.
const SF_BUILDING_COUNT = 170_000;

export async function fetchSfBuildings(
  onLand: (coord: Coord) => boolean,
): Promise<RawBuilding[]> {
  const rows = await DATA_SF.dataset<{
    shape?: { type: string; coordinates: number[][][][] };
    hgt_median_m?: string;
    gnd_min_m?: string;
  }>(
    "ynuv-fyni",
    { $select: "shape,hgt_median_m,gnd_min_m" },
    SF_BUILDING_COUNT,
  );
  const buildings: RawBuilding[] = [];
  for (const row of rows) {
    const height = Number.parseFloat(row.hgt_median_m ?? "");
    if (!Number.isFinite(height) || height <= 0) {
      continue;
    }
    const ground = Number.parseFloat(row.gnd_min_m ?? "");
    for (const parts of row.shape?.coordinates ?? []) {
      const polygon = parts.map((ring) =>
        ring.map(([lng, lat]) => ({ lat: lat as number, lng: lng as number })),
      );
      const outer = polygon[0] ?? [];
      if (outer.length >= 4 && outer.some(onLand)) {
        buildings.push({
          polygon,
          heightMeters: height,
          baseElevationMeters: Number.isFinite(ground) ? ground : 0,
        });
      }
    }
  }
  return buildings;
}

// SF has no land-use code: industrial is PDR-dominant floor area, or unbuilt in industrial zoning.
const SF_PARCEL_COUNT = 8_500;
const SF_INDUSTRIAL_ZONE_COUNT = 370;
// `analytical` rows are whole analysis districts with modeled floor areas, not parcels.
const SF_PARCEL_GEOGRAPHIES = "('parcel', 'multiple_parcels')";
// A 25 m x 19 m Financial District rollup recording 43% of the city's PDR floor area.
const PDR_ROLLUP_PARCEL = "0253021";
// 66 ha of parkland whose only floor area is Fort Mason Center's pier sheds.
const FORT_MASON_PARCEL = "0900003";
// Parcels with exactly 1 sq ft of PDR (Ocean Beach, Golden Gate Park) record a placeholder.
const PDR_PLACEHOLDER_SQUARE_FEET = 1;

interface LandUseRow {
  the_geom?: { type: string; coordinates: number[][][][] };
  mapblklot?: string;
  centroid_l?: string; // latitude; `centroid_1` is longitude (truncated column names)
  centroid_1?: string;
  pdr?: string;
  retail?: string;
  mips?: string;
  cie?: string;
  med?: string;
  visitor?: string;
  total_comm?: string; // sum of the six categories above
  resunits?: string;
}

const PDR_RIVALS = ["retail", "mips", "cie", "med", "visitor"] as const;

function squareFeet(value: string | undefined): number {
  const feet = Number.parseFloat(value ?? "");
  return Number.isFinite(feet) ? feet : 0;
}

export interface SfIndustrial {
  polygons: Polygon[];
  parcels: number;
  dominant: number;
  zoned: number;
  offLand: number;
}

export async function fetchSfIndustrial(
  onLand: (coord: Coord) => boolean,
): Promise<SfIndustrial> {
  // `residentia` names a housing subtype, not an area, so `resunits` is the only residential signal.
  const unused =
    "(total_comm IS NULL OR total_comm = 0) AND (resunits IS NULL OR resunits = 0)";
  const [rows, zones] = await Promise.all([
    DATA_SF.dataset<LandUseRow>(
      "c5ge-t6pj",
      {
        $select: "*",
        $where: `geography_type in ${SF_PARCEL_GEOGRAPHIES} AND (pdr > 0 OR (${unused}))`,
      },
      SF_PARCEL_COUNT,
    ),
    DATA_SF.dataset<{ the_geom?: { coordinates: number[][][][] } }>(
      "3i4a-hu95",
      { $select: "the_geom", $where: "gen = 'Industrial'" },
      SF_INDUSTRIAL_ZONE_COUNT,
    ),
  ]);

  const zonePolygons: Polygon[] = [];
  for (const zone of zones) {
    for (const parts of zone.the_geom?.coordinates ?? []) {
      zonePolygons.push(
        parts.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))),
      );
    }
  }
  const inIndustrialZone = buildLandTest(zonePolygons);

  const polygons: Polygon[] = [];
  let parcels = 0;
  let dominant = 0;
  let zoned = 0;
  let offLand = 0;
  for (const row of rows) {
    if (
      row.mapblklot === PDR_ROLLUP_PARCEL ||
      row.mapblklot === FORT_MASON_PARCEL
    ) {
      continue;
    }
    const pdr = squareFeet(row.pdr);
    const lat = Number.parseFloat(row.centroid_l ?? "");
    const lng = Number.parseFloat(row.centroid_1 ?? "");
    let branch: "dominant" | "zoned" | null = null;
    if (
      pdr > PDR_PLACEHOLDER_SQUARE_FEET &&
      PDR_RIVALS.every((rival) => pdr >= squareFeet(row[rival]))
    ) {
      branch = "dominant";
    } else if (
      squareFeet(row.total_comm) === 0 &&
      squareFeet(row.resunits) === 0 &&
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      inIndustrialZone({ lat, lng })
    ) {
      branch = "zoned";
    }
    if (branch === null) {
      continue;
    }
    // Any vertex on land, not the centroid, so a pier reaching past the shoreline is kept.
    const parts = (row.the_geom?.coordinates ?? [])
      .map((part) =>
        part
          .map((ring) => ring.map(([lng, lat]) => ({ lat, lng })))
          .filter((ring) => ring.length >= 4),
      )
      .filter(
        (part) => part.length > 0 && part.some((ring) => ring.some(onLand)),
      );
    if (parts.length === 0) {
      offLand += 1;
      continue;
    }
    parcels += 1;
    if (branch === "dominant") {
      dominant += 1;
    } else {
      zoned += 1;
    }
    polygons.push(...parts);
  }
  return { polygons, parcels, dominant, zoned, offLand };
}

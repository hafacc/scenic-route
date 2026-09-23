// No East Bay sidewalk survey is published, so per-side sidewalk bits here rest on OSM alone.

import { readFile } from "node:fs/promises";
import { allFeatures, envelopeQuery, fetchFeatures } from "./arcgis";
import { cached, cachedFile } from "./cache";
import { parseCsv } from "./csv";
import { densify, type NamedPoint } from "./geometry";
import { USER_AGENT } from "./http";
import type { LandContext } from "./land";
import type { Polygon } from "./overpass";
import type { Coord } from "./socrata";
import {
  ROAD_PATH,
  ROAD_STREET,
  type RoadType,
  type Segment,
  toInt,
} from "./streets";

const REQUEST_TIMEOUT_MS = 120_000;

export const EAST_BAY_ATTRIBUTION = "Alameda County GIS";
export const EAST_BAY_STREET_ATTRIBUTION =
  "Alameda County Street Centerlines via Alameda County GIS";
export const EAST_BAY_LAND_ATTRIBUTION =
  "City limits © Alameda County GIS, shoreline from US Census TIGER hydrography, " +
  "parkland from the California Protected Areas Database (CPAD - www.calands.org). June 2024.";
export const EAST_BAY_STREET_SOURCE_URL =
  "https://services5.arcgis.com/ROBnTHSNjoZ2Wm1P/arcgis/rest/services/Street_Centerlines/FeatureServer/0";

// Stops at San Leandro to keep the bbox on the bayshore; Piedmont, an Oakland enclave, fills a hole.
const EAST_BAY_CITY_LIMITS: readonly string[] = [
  "CITY OF ALBANY",
  "CITY OF BERKELEY",
  "CITY OF EMERYVILLE",
  "CITY OF OAKLAND",
  "CITY OF PIEDMONT",
  "CITY OF ALAMEDA",
  "CITY OF SAN LEANDRO",
];

// County municipality code -> display name; the county's `CITY` column is a postal guess, not this.
export const ALAMEDA_PLACES: Readonly<Record<string, string>> = {
  AA: "Alameda",
  AB: "Albany",
  BE: "Berkeley",
  EM: "Emeryville",
  OA: "Oakland",
  PI: "Piedmont",
  SL: "San Leandro",
};

const CITY_LIMITS_SERVICE =
  "https://services5.arcgis.com/ROBnTHSNjoZ2Wm1P/arcgis/rest/services/Administrative_Boundaries/FeatureServer/2/query";

// CPAD (GreenInfo Network): a "holding" is one parcel, so a park is dozens of polygons to union.
const PARKLAND_SERVICE =
  "https://services1.arcgis.com/4ZKi1B1zTblbwgWB/arcgis/rest/services/cpad_2024a_holdingsgdb/FeatureServer/0/query";

// Only parks the 2021 county lidar covers (Tilden, Sibley are mostly nodata); Roberts is in Redwood.
const EAST_BAY_PARKLANDS: readonly string[] = [
  "Reinhardt Redwood Regional Park",
  "Roberts Regional Recreation Area",
];

// CPAD parcel edges don't quite meet, so the union's holes are dropped and tiny pieces discarded.
const MIN_PARKLAND_PIECE_SQUARE_METERS = 10_000;
const METERS_PER_DEGREE_LAT = 111_320;

// Holes where CPAD and city edges disagree (largest 25,491 m²) are filled; water leaves no holes.
const MAX_SEAM_HOLE_SQUARE_METERS = 100_000;

// Flat-earth shoelace, with longitude scaled at the ring's mean latitude.
function ringAreaSquareMeters(ring: Ring): number {
  let doubled = 0;
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index++
  ) {
    doubled +=
      ring[previous][0] * ring[index][1] - ring[index][0] * ring[previous][1];
  }
  const latitude =
    ring.reduce((sum, [, lat]) => sum + lat, 0) / Math.max(ring.length, 1);
  return (
    (Math.abs(doubled) / 2) *
    METERS_PER_DEGREE_LAT *
    METERS_PER_DEGREE_LAT *
    Math.cos((latitude * Math.PI) / 180)
  );
}

// MTFCC H2051 is bay/estuary/gulf/sound, H2053 ocean; lakes stay in the land, as holes add rings.
const HYDRO_SERVICE =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Hydro/MapServer/1/query";
const TIDAL_WATER_CODES = "('H2051','H2053')";
// So a bay polygon starting outside the box still trims the shore inside it.
const WATER_MARGIN_DEGREES = 0.1;

type GeoJsonGeometry =
  | { type: "Polygon"; coordinates: [number, number][][] }
  | { type: "MultiPolygon"; coordinates: [number, number][][][] };

interface GeoJsonFeature<Properties> {
  geometry?: GeoJsonGeometry | null;
  properties?: Properties;
}

function ringsOf(geometry: GeoJsonGeometry | null | undefined): Ring[][] {
  if (!geometry) {
    return [];
  } else if (geometry.type === "Polygon") {
    return [geometry.coordinates];
  } else {
    return geometry.coordinates;
  }
}

// polygon-clipping's closed ring of [lng, lat] pairs.
type Ring = [number, number][];

function toPolygons(multi: Ring[][]): Polygon[] {
  return multi.map((polygon) =>
    polygon.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))),
  );
}

interface Box {
  west: number;
  south: number;
  east: number;
  north: number;
}

function boxOfRings(multi: Ring[][]): Box {
  const box: Box = {
    west: Number.POSITIVE_INFINITY,
    south: Number.POSITIVE_INFINITY,
    east: Number.NEGATIVE_INFINITY,
    north: Number.NEGATIVE_INFINITY,
  };
  for (const polygon of multi) {
    for (const ring of polygon) {
      for (const [lng, lat] of ring) {
        box.west = Math.min(box.west, lng);
        box.east = Math.max(box.east, lng);
        box.south = Math.min(box.south, lat);
        box.north = Math.max(box.north, lat);
      }
    }
  }
  return box;
}

async function fetchCityLimits(): Promise<Ring[][]> {
  const url = new URL(CITY_LIMITS_SERVICE);
  const names = EAST_BAY_CITY_LIMITS.map((name) => `'${name}'`).join(",");
  url.searchParams.set("where", `DIST_NAME IN (${names})`);
  url.searchParams.set("outFields", "DIST_NAME");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("f", "geojson");
  const features = await cached("alameda-city-limits", url.toString(), () =>
    fetchFeatures<GeoJsonFeature<{ DIST_NAME?: string }>>(url.toString()),
  );
  const named = new Set(
    features.map((feature) => feature.properties?.DIST_NAME ?? ""),
  );
  const missing = EAST_BAY_CITY_LIMITS.filter((name) => !named.has(name));
  if (missing.length > 0) {
    // A renamed row would otherwise silently leave a city-sized hole in the land mask.
    throw new Error(
      `Alameda County's City_Limits has no row for ${missing.join(", ")}`,
    );
  }
  return features.flatMap((feature) => ringsOf(feature.geometry));
}

async function fetchParkland(): Promise<Ring[][]> {
  const url = new URL(PARKLAND_SERVICE);
  const names = EAST_BAY_PARKLANDS.map((name) => `'${name}'`).join(",");
  url.searchParams.set("where", `UNIT_NAME IN (${names})`);
  url.searchParams.set("outFields", "UNIT_NAME");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("f", "geojson");
  const features = await cached("cpad-east-bay-parkland", url.toString(), () =>
    fetchFeatures<GeoJsonFeature<{ UNIT_NAME?: string }>>(url.toString()),
  );
  const named = new Set(
    features.map((feature) => feature.properties?.UNIT_NAME ?? ""),
  );
  const missing = EAST_BAY_PARKLANDS.filter((name) => !named.has(name));
  if (missing.length > 0) {
    // CPAD renames units between releases (Redwood became Reinhardt Redwood).
    throw new Error(`CPAD has no holding named ${missing.join(", ")}`);
  }
  const { union } = await import("polygon-clipping");
  const holdings = features.flatMap((feature) => ringsOf(feature.geometry));
  const merged = union(holdings as Parameters<typeof union>[0]) as Ring[][];
  const solid = merged
    .map((polygon): Ring[] => [polygon[0]])
    .filter(
      ([outer]) =>
        ringAreaSquareMeters(outer) >= MIN_PARKLAND_PIECE_SQUARE_METERS,
    );
  console.error(
    `  east bay parkland: ${features.length} CPAD holdings across` +
      ` ${EAST_BAY_PARKLANDS.length} parks = ${solid.length} pieces` +
      ` (${merged.length - solid.length} under ${MIN_PARKLAND_PIECE_SQUARE_METERS} m² dropped)`,
  );
  return solid;
}

async function fetchTidalWater(box: Box): Promise<Ring[][]> {
  const url = new URL(HYDRO_SERVICE);
  url.searchParams.set("where", `MTFCC IN ${TIDAL_WATER_CODES}`);
  envelopeQuery(url, {
    west: box.west - WATER_MARGIN_DEGREES,
    south: box.south - WATER_MARGIN_DEGREES,
    east: box.east + WATER_MARGIN_DEGREES,
    north: box.north + WATER_MARGIN_DEGREES,
  });
  url.searchParams.set("outFields", "NAME");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("f", "geojson");
  const features = await cached("tigerweb-east-bay-water", url.toString(), () =>
    fetchFeatures<GeoJsonFeature<{ NAME?: string }>>(url.toString()),
  );
  if (features.length === 0) {
    throw new Error("TIGERweb returned no water over the East Bay");
  }
  return features.flatMap((feature) => ringsOf(feature.geometry));
}

// City limits are legal limits that run out over the tidelands, so tidal water is subtracted.
export async function fetchEastBayLand(): Promise<Polygon[]> {
  const limits = await fetchCityLimits();
  const parks = await fetchParkland();
  const ground = [...limits, ...parks];
  const water = await fetchTidalWater(boxOfRings(ground));
  // Lazy: a devDependency every other consumer of this module would otherwise load.
  const { difference } = await import("polygon-clipping");
  const cut = difference(
    ground as Parameters<typeof difference>[0],
    water as Parameters<typeof difference>[0],
  ) as Ring[][];
  let seams = 0;
  const land = cut.map(([outer, ...holes]) => [
    outer,
    ...holes.filter((hole) => {
      const seam = ringAreaSquareMeters(hole) < MAX_SEAM_HOLE_SQUARE_METERS;
      seams += seam ? 1 : 0;
      return !seam;
    }),
  ]);
  console.error(
    `  east bay: ${EAST_BAY_CITY_LIMITS.length} city limits and ${parks.length} parkland pieces` +
      ` less ${water.length} water polygons = ${land.length} land polygons` +
      ` (${seams} boundary seams filled)`,
  );
  return toPolygons(land);
}

interface StreetRow {
  CLASS?: string | null;
  SFEATYP?: string | null;
  STREET?: string | null;
  SEGID?: number | null;
}

// Every `CLASS` but motorways, which come back via scripts/highways.ts as a nuisance, never routed.
const WALKABLE_CLASSES = new Set([
  "Local",
  "Principal Arterial",
  "Minor Arterial",
  "Major Collector",
  "Minor Collector",
]);

// `SFEATYP` walk, path and plaza; there is no step-street type, so stairs come only from OSM.
const PEDESTRIAN_TYPES = new Set(["WK", "PA", "PZ"]);
// Ramp, connector, freeway, highway: catches motorway rows misfiled under a walkable `CLASS`.
const MOTORWAY_TYPES = new Set(["RAMP", "CONN", "FW", "HW"]);

function roadTypeOf(row: StreetRow): RoadType | null {
  const type = (row.SFEATYP ?? "").trim().toUpperCase();
  if (MOTORWAY_TYPES.has(type) || !WALKABLE_CLASSES.has(row.CLASS ?? "")) {
    return null;
  } else {
    return PEDESTRIAN_TYPES.has(type) ? ROAD_PATH : ROAD_STREET;
  }
}

// No width column and OSM `width` on four Oakland ways, so every street takes SF's median roadway.
export const EAST_BAY_ROADWAY_FEET = 26;

const PAGE_SIZE = 2_000;
const DENSIFY_METERS = 25;
const DROP_LENGTH_METERS = 0.5;
const UNNAMED_ID = 0xffff;
// Fails a truncated read; the box held ~25k segments on 2026-08-27.
const EAST_BAY_SEGMENT_FLOOR = 20_000;

function streetPageUrl(offset: number, box: Box): string {
  const url = new URL(`${EAST_BAY_STREET_SOURCE_URL}/query`);
  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", "CLASS,SFEATYP,STREET,SEGID");
  envelopeQuery(url, box);
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  // Without an order, ArcGIS may repeat or skip rows between pages.
  url.searchParams.set("orderByFields", "SEGID");
  url.searchParams.set("f", "geojson");
  url.searchParams.set("resultOffset", String(offset));
  url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
  return url.toString();
}

async function fetchCountyStreets(
  box: Box,
): Promise<GeoJsonFeature<StreetRow>[]> {
  return await allFeatures<GeoJsonFeature<StreetRow>>({
    pageUrl: (offset) => streetPageUrl(offset, box),
    pageSize: PAGE_SIZE,
    cacheName: "alameda-streets",
  });
}

// Kept when either end or the middle is on land, so estuary bridges survive the water cut.
export async function fetchEastBayStreets(
  land: LandContext,
): Promise<Segment[]> {
  const { onLand, box } = land;
  const features = await fetchCountyStreets(box);
  if (features.length < EAST_BAY_SEGMENT_FLOOR) {
    throw new Error(
      `Alameda County's centerline answered ${features.length} segments over the city's box, too few to be the whole of it`,
    );
  }

  const segments: Segment[] = [];
  let offLand = 0;
  let unwalkable = 0;
  let degenerate = 0;
  for (const feature of features) {
    const row = feature.properties ?? {};
    for (const part of lineStringsOf(feature.geometry)) {
      const points: Coord[] = [];
      for (const [lng, lat] of part) {
        const previous = points[points.length - 1];
        if (!previous || previous.lng !== lng || previous.lat !== lat) {
          points.push({ lat, lng });
        }
      }
      if (points.length < 2) {
        degenerate += 1;
        continue;
      }
      const middle = points[Math.floor(points.length / 2)];
      if (
        !onLand(points[0]) &&
        !onLand(points[points.length - 1]) &&
        !onLand(middle)
      ) {
        offLand += 1;
        continue;
      }
      const roadType = roadTypeOf(row);
      if (roadType === null) {
        unwalkable += 1;
        continue;
      }
      const dense = densify(points, DENSIFY_METERS);
      if (dense.lengthMeters < DROP_LENGTH_METERS) {
        degenerate += 1;
        continue;
      }
      segments.push({
        physicalId: toInt(String(row.SEGID ?? "")),
        roadType,
        streetWidth: roadType === ROAD_STREET ? EAST_BAY_ROADWAY_FEET : 0,
        // No speed limit or non-walkable flag published; motorways are dropped by class instead.
        postedSpeed: 0,
        flags: 0,
        name: (row.STREET ?? "").trim(),
        nameId: UNNAMED_ID,
        points: dense.points,
        lengthMeters: dense.lengthMeters,
      });
    }
  }
  console.error(
    `  east bay streets: ${segments.length} walkable of ${features.length} in the box` +
      ` (${offLand} off land, ${unwalkable} motorway or unclassified, ${degenerate} degenerate)`,
  );
  return segments;
}

function lineStringsOf(
  geometry: GeoJsonGeometry | null | undefined,
): [number, number][][] {
  if (!geometry) {
    return [];
  }
  const shape = geometry as unknown as {
    type: string;
    coordinates: [number, number][] | [number, number][][];
  };
  if (shape.type === "LineString") {
    return [shape.coordinates as [number, number][]];
  } else if (shape.type === "MultiLineString") {
    return shape.coordinates as [number, number][][];
  } else {
    return [];
  }
}

// Assessor parcels with `UseCode`: what a parcel is, unlike zoning, which says what it may become.
const PARCEL_SERVICE =
  "https://services5.arcgis.com/ROBnTHSNjoZ2Wm1P/arcgis/rest/services/Parcels/FeatureServer/0/query";

// The 4xxx band of `Assessor_Office_Use_Codes` is industrial, including 4000 vacant land.
const INDUSTRIAL_USE_CODES = "UseCode LIKE '4%'";
// 4240 is a live-work condominium and 4500 a plant nursery.
const NON_INDUSTRIAL_USE_CODES: ReadonlySet<string> = new Set(["4240", "4500"]);
// Fails a truncated read; the box held 3,454 on 2026-08-29.
const EAST_BAY_INDUSTRIAL_FLOOR = 3_000;

interface ParcelRow {
  UseCode?: string | null;
}

function polygonPartsOf(
  geometry: GeoJsonGeometry | null | undefined,
): Polygon[] {
  return ringsOf(geometry)
    .map((part) =>
      part
        .map((ring) => ring.map(([lng, lat]) => ({ lat, lng })))
        .filter((ring) => ring.length >= 4),
    )
    .filter((part) => part.length > 0);
}

function parcelPageUrl(offset: number, box: Box, where: string): string {
  const url = new URL(PARCEL_SERVICE);
  url.searchParams.set("where", where);
  url.searchParams.set("outFields", "UseCode");
  envelopeQuery(url, box);
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  // Without an order, ArcGIS may repeat or skip rows between pages.
  url.searchParams.set("orderByFields", "OBJECTID");
  url.searchParams.set("f", "geojson");
  url.searchParams.set("resultOffset", String(offset));
  url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
  return url.toString();
}

// SFEI Existing Land Use 2020, only for public land: tax-exempt parcels carry no assessor code.
// `county='Alameda'` because the region's box also takes in SF.
const REGIONAL_LAND_USE_SERVICE =
  "https://services3.arcgis.com/i2dkYWmb4wHvYPda/arcgis/rest/services/sfei_elu_2020_rel1/FeatureServer/0/query";
// SFEI's own codes, not the assessor's; 6510 (Harbour & Marine) is out: here it's the Berkeley Marina.
const REGIONAL_INDUSTRIAL_USE_CODES =
  "elu_use_code IN (5000,5001,5002,5003,6000,6004,6508,8003)";
const REGIONAL_PUBLIC_INDUSTRIAL = `county='Alameda' AND Ownership='Public' AND ${REGIONAL_INDUSTRIAL_USE_CODES}`;
// 318 polygons on 2026-08-29.
const EAST_BAY_PUBLIC_INDUSTRIAL_FLOOR = 250;

export interface EastBayIndustrial {
  polygons: Polygon[];
  parcels: number; // features, not polygon parts
  publicParcels: number;
  offLand: number;
}

// Any vertex on land, not the centroid: waterfront yards reach past the shoreline cut.
export async function fetchEastBayIndustrial(
  land: LandContext,
): Promise<EastBayIndustrial> {
  const { onLand, box } = land;
  const features = await allFeatures<GeoJsonFeature<ParcelRow>>({
    pageUrl: (offset) => parcelPageUrl(offset, box, INDUSTRIAL_USE_CODES),
    pageSize: PAGE_SIZE,
    cacheName: "alameda-industrial",
  });
  if (features.length < EAST_BAY_INDUSTRIAL_FLOOR) {
    throw new Error(
      `Alameda County's parcels answered ${features.length} industrial parcels over the city's box, too few to be the whole of it`,
    );
  }

  const polygons: Polygon[] = [];
  let parcels = 0;
  let offLand = 0;
  let excluded = 0;
  for (const feature of features) {
    const useCode = (feature.properties?.UseCode ?? "").trim();
    if (NON_INDUSTRIAL_USE_CODES.has(useCode)) {
      excluded += 1;
      continue;
    }
    const parts = polygonPartsOf(feature.geometry).filter((part) =>
      part.some((ring) => ring.some(onLand)),
    );
    if (parts.length === 0) {
      offLand += 1;
      continue;
    }
    parcels += 1;
    polygons.push(...parts);
  }

  const publicLand = await fetchPublicIndustrial(box);
  let publicParcels = 0;
  for (const feature of publicLand) {
    const parts = polygonPartsOf(feature.geometry).filter((part) =>
      part.some((ring) => ring.some(onLand)),
    );
    if (parts.length === 0) {
      offLand += 1;
      continue;
    }
    publicParcels += 1;
    polygons.push(...parts);
  }

  console.error(
    `  east bay industrial: ${parcels} assessed parcels of ${features.length} in the box` +
      ` plus ${publicParcels} tax-exempt of ${publicLand.length}` +
      ` (${offLand} off land, ${excluded} live-work or nursery)`,
  );
  return { polygons, parcels: parcels + publicParcels, publicParcels, offLand };
}

function regionalPageUrl(offset: number, box: Box): string {
  const url = new URL(REGIONAL_LAND_USE_SERVICE);
  url.searchParams.set("where", REGIONAL_PUBLIC_INDUSTRIAL);
  url.searchParams.set("outFields", "elu_use_code");
  envelopeQuery(url, box);
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("orderByFields", "OBJECTID");
  url.searchParams.set("f", "geojson");
  url.searchParams.set("resultOffset", String(offset));
  url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
  return url.toString();
}

async function fetchPublicIndustrial(
  box: Box,
): Promise<GeoJsonFeature<unknown>[]> {
  const features = await allFeatures<GeoJsonFeature<unknown>>({
    pageUrl: (offset) => regionalPageUrl(offset, box),
    pageSize: PAGE_SIZE,
    cacheName: "sfei-public-industrial",
  });
  if (features.length < EAST_BAY_PUBLIC_INDUSTRIAL_FLOOR) {
    throw new Error(
      `MTC's land use answered ${features.length} publicly-owned industrial polygons over the city's box, too few to be the whole of it`,
    );
  }
  return features;
}

// Primary-importance areas and S-7/S-20 zones; secondary areas would speckle half of Oakland.
const OAKLAND_SERVICES =
  "https://services.arcgis.com/9tC74aDHuml0x5Yz/arcgis/rest/services";
const PRESERVATION_ZONES = "CZ_label IN ('S-7', 'S-20')";
// Floors against a truncated read; 58 and 8 on 2026-08-29.
const OAKLAND_API_FLOOR = 50;
const OAKLAND_PRESERVATION_ZONE_FLOOR = 6;

export interface EastBayHistoric {
  polygons: Polygon[];
  districts: number; // features, not polygon parts
  offLand: number;
}

async function fetchOaklandLayer(
  service: string,
  where: string,
  cacheName: string,
): Promise<GeoJsonFeature<unknown>[]> {
  const url = new URL(`${service}/query`);
  url.searchParams.set("where", where);
  url.searchParams.set("outFields", "FID");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("orderByFields", "FID");
  url.searchParams.set("f", "geojson");
  url.searchParams.set("resultRecordCount", String(PAGE_SIZE));
  return await cached(cacheName, url.toString(), () =>
    fetchFeatures<GeoJsonFeature<unknown>>(url.toString()),
  );
}

// Any vertex on land: the Jack London and Estuary districts run out over the water.
export async function fetchEastBayHistoric(
  land: LandContext,
): Promise<EastBayHistoric> {
  const [areas, zones] = await Promise.all([
    fetchOaklandLayer(
      `${OAKLAND_SERVICES}/HistoricDistrict_API_shp/FeatureServer/0`,
      "1=1",
      "oakland-historic-api",
    ),
    fetchOaklandLayer(
      `${OAKLAND_SERVICES}/Combining_Zone_Set_4/FeatureServer/0`,
      PRESERVATION_ZONES,
      "oakland-preservation-zones",
    ),
  ]);
  if (
    areas.length < OAKLAND_API_FLOOR ||
    zones.length < OAKLAND_PRESERVATION_ZONE_FLOOR
  ) {
    throw new Error(
      `Oakland answered ${areas.length} primary-importance areas and ${zones.length} preservation zones, too few to be the whole of either`,
    );
  }

  const polygons: Polygon[] = [];
  let districts = 0;
  let offLand = 0;
  for (const feature of [...areas, ...zones]) {
    const parts = polygonPartsOf(feature.geometry).filter((part) =>
      part.some((ring) => ring.some(land.onLand)),
    );
    if (parts.length === 0) {
      offLand += 1;
      continue;
    }
    districts += 1;
    polygons.push(...parts);
  }
  console.error(
    `  east bay historic: ${areas.length} primary-importance areas and ${zones.length} preservation zones,` +
      ` ${districts} on land`,
  );
  return { polygons, districts, offLand };
}

// No local register is published, so this is the state's BERD: mostly federal and state listings.
// OHP status codes for individual listing; district contributors and "eligible" codes are out.
const BERD_URL = "https://ohp.parks.ca.gov/pages/1068/files/Alameda.csv";
const DESIGNATED_STATUS_CODES: ReadonlySet<string> = new Set([
  "1S",
  "1CL",
  "1CP",
  "1CS",
  "5S1",
]);
// `Evaluation Info` is pipe-separated "<code>, <date>, <ref>"; anchored as a ref can start with a digit.
const STATUS_CODE = /(?:^|\|)\s*([0-9][A-Z0-9]{0,3})\s*,/g;
// Uppercased city name -> county municipality code.
const BERD_MUNICIPALITIES: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(ALAMEDA_PLACES).map(([code, name]) => [
      name.toUpperCase(),
      code,
    ]),
  );
// Fails a truncated download; 15,134 rows on 2026-08-29.
const BERD_ROW_FLOOR = 12_000;
// The state appends these to street names; address points keep the type in `FEATYP`, not `FEANME`.
const STREET_TYPES: ReadonlySet<string> = new Set([
  "ST",
  "AVE",
  "AV",
  "WY",
  "WAY",
  "BLVD",
  "BL",
  "DR",
  "RD",
  "PL",
  "CT",
  "LN",
  "TER",
  "TERR",
  "CIR",
  "PKWY",
  "SQ",
  "ALY",
  "HWY",
  "PLZ",
  "LOOP",
  "ROW",
  "PATH",
  "WALK",
  "CRES",
  "MALL",
]);
const STREET_ALIASES: Record<string, string> = {
  "M L KING JR": "MARTIN LUTHER KING JR",
};
const ADDRESS_POINT_SERVICE =
  "https://services5.arcgis.com/ROBnTHSNjoZ2Wm1P/arcgis/rest/services/Address_Points/FeatureServer/0/query";
// Keys OR'd per POSTed query, so the limit is `where` complexity, not URL length.
const GEOCODE_BATCH = 30;

interface BerdRow {
  name: string;
  city: string; // uppercased
  streetNumber: string;
  streetName: string; // type token stripped
  situsStreetName: string; // type kept, as the parcel roll has it
  apnSort: string | null;
}

// County APN_SORT: "BBB PPPPNNNSS"; the state writes it many ways ("8 649 5", "070-0196-022").
export function apnSortKey(raw: string): string | null {
  const groups = raw.match(/\d+/g) ?? [];
  if (groups.length < 3) {
    return null;
  }
  const [book, page, parcel] = groups as [string, string, string];
  const sub = groups[3] ?? "0";
  if (
    book.length > 3 ||
    page.length > 4 ||
    parcel.length > 3 ||
    sub.length > 2
  ) {
    return null;
  }
  const pad = (value: string, width: number): string =>
    Number.parseInt(value, 10).toString().padStart(width, "0");
  return `${pad(book, 3)} ${pad(page, 4)}${pad(parcel, 3)}${pad(sub, 2)}`;
}

export function featureName(streetName: string): string {
  const tokens = streetName
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 0 && STREET_TYPES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  const name = tokens.join(" ");
  return STREET_ALIASES[name] ?? name;
}

// Keeps the name before any `|` alias; recases only all-caps names, per letter run so "U.S." survives.
export function prettyLandmarkName(raw: string): string {
  const name = (raw.split("|")[0] ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N})\].]+$/u, "");
  if (/[a-z]/.test(name)) {
    return name;
  }
  return name.replace(/\p{L}+/gu, (run, offset: number) => {
    const before = name[offset - 1];
    if (before === "'" || before === "\u2019") {
      return run.toLowerCase();
    }
    return run.charAt(0) + run.slice(1).toLowerCase();
  });
}

async function fetchBerdRows(): Promise<BerdRow[]> {
  const path = await cachedFile("ohp-berd-alameda", BERD_URL, async () => {
    const response = await fetch(BERD_URL, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  });
  // The export is windows-1252 (curly apostrophes as 0x92), not UTF-8.
  const text = new TextDecoder("windows-1252").decode(await readFile(path));
  const rows = parseCsv(text);
  if (rows.length < BERD_ROW_FLOOR) {
    throw new Error(
      `the OHP's Alameda inventory answered ${rows.length} rows, too few to be the whole of it`,
    );
  }

  const kept: BerdRow[] = [];
  for (const row of rows) {
    const city = (row.City ?? "").trim().toUpperCase();
    if (!(city in BERD_MUNICIPALITIES)) {
      continue;
    }
    const codes = [...(row["Evaluation Info"] ?? "").matchAll(STATUS_CODE)].map(
      (match) => match[1],
    );
    if (!codes.some((code) => DESIGNATED_STATUS_CODES.has(code))) {
      continue;
    }
    const name = prettyLandmarkName(row.Name ?? "");
    // Districts are drawn as areas by data/historic.
    if (name === "" || /\bdistrict\b/i.test(name)) {
      continue;
    }
    const streetName = (row["St Name"] ?? "").trim();
    kept.push({
      name,
      city,
      streetNumber: (row["St Number"] ?? "").trim().toUpperCase(),
      streetName: featureName(streetName),
      situsStreetName: streetName.toUpperCase(),
      apnSort: apnSortKey(row["Parcel Num"] ?? ""),
    });
  }
  return kept;
}

async function geocodeBatches<Key>(
  service: string,
  cacheName: string,
  keys: readonly Key[],
  clauseOf: (key: Key) => string,
  outFields: string,
): Promise<GeoJsonFeature<Record<string, string>>[]> {
  const features: GeoJsonFeature<Record<string, string>>[] = [];
  for (let start = 0; start < keys.length; start += GEOCODE_BATCH) {
    const where = keys
      .slice(start, start + GEOCODE_BATCH)
      .map(clauseOf)
      .join(" OR ");
    const body = new URLSearchParams({
      where,
      outFields,
      returnGeometry: "true",
      outSR: "4326",
      f: "geojson",
      resultRecordCount: String(PAGE_SIZE),
    });
    features.push(
      ...(await cached(
        `${cacheName}-${start}`,
        where,
        () =>
          fetchFeatures<GeoJsonFeature<Record<string, string>>>(service, {
            body,
          }),
        { quiet: true },
      )),
    );
  }
  return features;
}

function centroidOf(
  geometry: GeoJsonGeometry | null | undefined,
): Coord | null {
  const point = geometry as unknown as { type: string; coordinates: number[] };
  if (point?.type === "Point") {
    const [lng, lat] = point.coordinates;
    return { lat, lng };
  }
  const rings = ringsOf(geometry);
  const ring = rings[0]?.[0];
  if (!ring || ring.length === 0) {
    return null;
  }
  let lat = 0;
  let lng = 0;
  for (const [pointLng, pointLat] of ring) {
    lng += pointLng;
    lat += pointLat;
  }
  return { lat: lat / ring.length, lng: lng / ring.length };
}

// BERD has no coordinates: exact joins on address point, then APN, then parcel situs; never proximity.
export async function fetchEastBayLandmarks(
  land: LandContext,
): Promise<NamedPoint[]> {
  const rows = await fetchBerdRows();

  const addressKeys = [
    ...new Map(
      rows
        .filter((row) => row.streetNumber !== "" && row.streetName !== "")
        .map((row) => [
          `${BERD_MUNICIPALITIES[row.city]}|${row.streetNumber}|${row.streetName}`,
          row,
        ]),
    ).values(),
  ];
  const apnKeys = [
    ...new Set(rows.map((row) => row.apnSort).filter((key) => key !== null)),
  ];
  const situsKeys = [
    ...new Map(
      rows
        .filter((row) => row.streetNumber !== "" && row.situsStreetName !== "")
        .map((row) => [
          `${row.city}|${row.streetNumber}|${row.situsStreetName}`,
          row,
        ]),
    ).values(),
  ];

  const quote = (value: string): string => value.replace(/'/g, "''");
  const [addressPoints, parcelsByApn, parcelsBySitus] = await Promise.all([
    geocodeBatches(
      ADDRESS_POINT_SERVICE,
      "alameda-landmark-addresses",
      addressKeys,
      (row) =>
        `(MUN='${BERD_MUNICIPALITIES[row.city]}' AND ST_NUM='${quote(row.streetNumber)}' AND FEANME='${quote(row.streetName)}')`,
      "MUN,ST_NUM,FEANME",
    ),
    geocodeBatches(
      PARCEL_SERVICE,
      "alameda-landmark-apns",
      apnKeys,
      (key) => `APN_SORT='${key}'`,
      "APN_SORT",
    ),
    geocodeBatches(
      PARCEL_SERVICE,
      "alameda-landmark-situs",
      situsKeys,
      (row) =>
        `(SitusCity='${quote(row.city)}' AND SitusStreetNumber='${quote(row.streetNumber)}' AND SitusStreetName='${quote(row.situsStreetName)}')`,
      "SitusCity,SitusStreetNumber,SitusStreetName",
    ),
  ]);

  const placed = new Map<string, Coord>();
  const remember = (key: string, feature: GeoJsonFeature<unknown>): void => {
    const centroid = centroidOf(feature.geometry);
    if (centroid !== null && !placed.has(key)) {
      placed.set(key, centroid);
    }
  };
  for (const feature of addressPoints) {
    const row = feature.properties ?? {};
    remember(`address|${row.MUN}|${row.ST_NUM}|${row.FEANME}`, feature);
  }
  for (const feature of parcelsByApn) {
    remember(`apn|${feature.properties?.APN_SORT}`, feature);
  }
  for (const feature of parcelsBySitus) {
    const row = feature.properties ?? {};
    remember(
      `situs|${row.SitusCity}|${row.SitusStreetNumber}|${row.SitusStreetName}`,
      feature,
    );
  }

  const points: NamedPoint[] = [];
  const seen = new Set<string>();
  let offLand = 0;
  let ungeocoded = 0;
  for (const row of rows) {
    const coord =
      placed.get(
        `address|${BERD_MUNICIPALITIES[row.city]}|${row.streetNumber}|${row.streetName}`,
      ) ??
      (row.apnSort === null ? undefined : placed.get(`apn|${row.apnSort}`)) ??
      placed.get(
        `situs|${row.city}|${row.streetNumber}|${row.situsStreetName}`,
      );
    if (coord === undefined) {
      ungeocoded += 1;
      continue;
    }
    if (!land.onLand(coord)) {
      offLand += 1;
      continue;
    }
    // A building is filed under every name it held; the export's alphabetical first wins.
    const at = `${coord.lat.toFixed(6)},${coord.lng.toFixed(6)}`;
    if (seen.has(at)) {
      continue;
    }
    seen.add(at);
    points.push({ ...coord, name: row.name });
  }
  console.error(
    `  east bay landmarks: ${rows.length} designated, ${points.length} placed` +
      ` (${ungeocoded} with no address or parcel to place them, ${offLand} off land)`,
  );
  return points;
}

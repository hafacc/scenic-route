// Heights are measured off the 2021 LiDAR: Overture's machine-learned heights cap out at 32.5 m.
// Footprints are Overture's (ODbL), clipped by its own outlines since the land mask comes later.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { cached } from "./cache";
import type { HeightedBuilding } from "./geometry";
import { EAST_BAY_WINDOW } from "./lidar";
import type { Polygon } from "./overpass";

// Pinned so a rebuild reads the rows the counts in scripts/README.md were measured against.
const PINNED_RELEASE = "2026-08-19.0";
const OVERTURE_RELEASE = process.env.OVERTURE_RELEASE || PINNED_RELEASE;
const OVERTURE_BUCKET = "s3://overturemaps-us-west-2/release";
const BUILDINGS_PARQUET = `${OVERTURE_BUCKET}/${OVERTURE_RELEASE}/theme=buildings/type=building/*.parquet`;
const DIVISIONS_PARQUET = `${OVERTURE_BUCKET}/${OVERTURE_RELEASE}/theme=divisions/type=division_area/*.parquet`;

const BUILD_DIR = join(import.meta.dirname, "..", ".build");
// The tiler's input and output; gitignored build glue.
export const FOOTPRINTS_FILE = join(BUILD_DIR, "east-bay-footprints.geojson");
export const READINGS_FILE = join(BUILD_DIR, "east-bay-heights.json");

// Unioned, so a building on the line between two of them is one building.
const EAST_BAY_DIVISIONS = [
  "Albany",
  "Berkeley",
  "Emeryville",
  "Oakland",
  "Piedmont",
  "Alameda",
  "San Leandro",
];
const DIVISION_SUBTYPE = "locality";

// Towers built after the 2021 flight measure far under their OSM tag; real ones measure >= 0.93.
const OSM_PATCH_RATIO = 0.7;

export interface Footprint {
  polygon: Polygon;
  name: string | null;
  heightMeters: number | null;
  surveyed: boolean; // an OSM tag rather than a model's guess
}

// From `tiler ndsm`; missing where the surface model held no cell under the footprint.
export interface Reading {
  feature: number;
  roofMeters?: number;
  baseMeters?: number;
  cells: number;
}

interface GeoJsonPolygon {
  type: string;
  coordinates: number[][][] | number[][][][];
}

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Intersection, not containment: a locality's box can be wider than the window.
function outlineSql(): string {
  const names = EAST_BAY_DIVISIONS.map(sqlText).join(", ");
  return `SELECT geometry FROM read_parquet(${sqlText(DIVISIONS_PARQUET)})
    WHERE country = 'US'
      AND class = 'land'
      AND subtype = ${sqlText(DIVISION_SUBTYPE)}
      AND names.primary IN (${names})
      AND bbox.xmin < ${EAST_BAY_WINDOW.east} AND bbox.xmax > ${EAST_BAY_WINDOW.west}
      AND bbox.ymin < ${EAST_BAY_WINDOW.north} AND bbox.ymax > ${EAST_BAY_WINDOW.south}`;
}

// A height with its own non-OSM source entry is a model's; one with none came with the OSM feature.
function buildingsSql(): string {
  return `WITH outline AS (SELECT ST_Union_Agg(geometry) AS geometry FROM (${outlineSql()}))
    SELECT
      ST_AsGeoJSON(building.geometry) AS geometry,
      building.names.primary AS name,
      building.height AS height,
      len(
        list_filter(
          building.sources,
          source -> source.property = '/properties/height'
            AND source.dataset <> 'OpenStreetMap'
        )
      ) = 0 AS surveyed
    FROM read_parquet(${sqlText(BUILDINGS_PARQUET)}) AS building, outline
    WHERE building.bbox.xmin > ${EAST_BAY_WINDOW.west}
      AND building.bbox.xmax < ${EAST_BAY_WINDOW.east}
      AND building.bbox.ymin > ${EAST_BAY_WINDOW.south}
      AND building.bbox.ymax < ${EAST_BAY_WINDOW.north}
      AND ST_Intersects(outline.geometry, building.geometry)`;
}

async function connect(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run(
    "INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';",
  );
  return connection;
}

function toParts(geometry: GeoJsonPolygon): Polygon[] {
  const parts =
    geometry.type === "MultiPolygon"
      ? (geometry.coordinates as number[][][][])
      : [geometry.coordinates as number[][][]];
  return parts.map((part) =>
    part.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))),
  );
}

// One per disjoint part, cached against the query, so a changed release or window misses.
export async function fetchFootprints(): Promise<Footprint[]> {
  const sql = buildingsSql();
  return await cached("east-bay-buildings", sql, async () => {
    const connection = await connect();
    try {
      const outlines = await connection.runAndReadAll(
        `SELECT count(*) AS found FROM (${outlineSql()})`,
      );
      const found = Number(outlines.getRowObjects()[0].found);
      if (found !== EAST_BAY_DIVISIONS.length) {
        // Overture renames divisions between releases, which would silently drop a city.
        throw new Error(
          `${found} outlines found for ${EAST_BAY_DIVISIONS.length} named cities`,
        );
      }
      const reader = await connection.runAndReadAll(sql);
      const footprints: Footprint[] = [];
      for (const row of reader.getRowObjects()) {
        const geometry = JSON.parse(String(row.geometry)) as GeoJsonPolygon;
        const height =
          typeof row.height === "number" && Number.isFinite(row.height)
            ? row.height
            : null;
        for (const polygon of toParts(geometry)) {
          if ((polygon[0]?.length ?? 0) >= 4) {
            footprints.push({
              polygon,
              name: typeof row.name === "string" ? row.name : null,
              heightMeters: height,
              surveyed: row.surveyed === true,
            });
          }
        }
      }
      return footprints;
    } finally {
      connection.closeSync();
    }
  });
}

// One feature per part, so a reading comes back on the index it was asked for.
export async function writeFootprints(
  path: string,
  footprints: readonly Footprint[],
): Promise<void> {
  const features = footprints.map((footprint) => ({
    type: "Feature",
    properties: {
      name: footprint.name,
      height: footprint.heightMeters,
      surveyed: footprint.surveyed,
    },
    geometry: {
      type: "Polygon",
      coordinates: footprint.polygon.map((ring) =>
        ring.map(({ lat, lng }) => [lng, lat]),
      ),
    },
  }));
  await writeFile(
    path,
    JSON.stringify({ type: "FeatureCollection", features }),
  );
}

export interface Merged {
  buildings: HeightedBuilding[];
  measured: number;
  published: number;
  patched: number;
  dropped: number;
}

// Measurement wins; only an OSM tag can override it. A footprint with neither is a tiny shed.
export function merge(
  footprints: readonly Footprint[],
  readings: readonly Reading[],
): Merged {
  const measured = new Map(
    readings.map((reading) => [reading.feature, reading]),
  );
  const merged: Merged = {
    buildings: [],
    measured: 0,
    published: 0,
    patched: 0,
    dropped: 0,
  };
  for (const [index, footprint] of footprints.entries()) {
    const reading = measured.get(index);
    const roof = reading?.roofMeters ?? 0;
    const published = footprint.heightMeters ?? 0;
    if (roof > 0) {
      merged.measured += 1;
    }
    if (published > 0) {
      merged.published += 1;
    }
    let heightMeters = roof;
    if (roof <= 0) {
      heightMeters = published;
    } else if (
      published > 0 &&
      footprint.surveyed &&
      roof < OSM_PATCH_RATIO * published
    ) {
      heightMeters = published;
      merged.patched += 1;
    }
    if (heightMeters > 0) {
      merged.buildings.push({
        polygon: footprint.polygon,
        heightMeters,
        baseElevationMeters: reading?.baseMeters ?? 0,
      });
    } else {
      merged.dropped += 1;
    }
  }
  return merged;
}

// A missing file is a build run out of order; separate so a caller checks before fetching.
export async function readEastBayHeights(): Promise<Reading[]> {
  const readings = await readFile(READINGS_FILE, "utf-8").catch(() => {
    throw new Error(
      `${READINGS_FILE} is not there; run \`bun run build-east-bay-heights\` first`,
    );
  });
  return JSON.parse(readings) as Reading[];
}

export async function fetchEastBayBuildings(
  readings: readonly Reading[],
): Promise<HeightedBuilding[]> {
  const footprints = await fetchFootprints();
  const merged = merge(footprints, readings);
  const share = (count: number) =>
    `${((100 * count) / Math.max(1, footprints.length)).toFixed(1)}%`;
  console.error(
    `east bay: ${merged.buildings.length} of ${footprints.length} footprints kept — ${merged.measured} measured (${share(merged.measured)}), ${merged.published} published by Overture (${share(merged.published)}), ${merged.patched} patched by an OSM tag, ${merged.dropped} dropped`,
  );
  return merged.buildings;
}

if (import.meta.main) {
  const footprints = await fetchFootprints();
  await writeFootprints(FOOTPRINTS_FILE, footprints);
  const withHeight = footprints.filter(
    (footprint) => (footprint.heightMeters ?? 0) > 0,
  );
  const surveyed = withHeight.filter((footprint) => footprint.surveyed);
  console.error(
    `east bay: ${footprints.length} footprints, ${withHeight.length} with a published height (${((100 * withHeight.length) / footprints.length).toFixed(1)}%), ${surveyed.length} of those an OSM tag; wrote ${FOOTPRINTS_FILE}`,
  );
}

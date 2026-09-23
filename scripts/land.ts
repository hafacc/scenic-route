import { fetchEastBayLand } from "./alameda";
import { boxOf } from "./geometry";
import { buildLandTest } from "./land-filter";
import type { Bounds } from "./manifest";
import type { Polygon } from "./overpass";
import { fetchSfLand } from "./sf";
import { type Coord, NYC_OPEN_DATA } from "./socrata";

const NYC_BOROUGH_COUNT = 5;

interface BoroughRow {
  boroname?: string;
  the_geom?: { type: string; coordinates: [number, number][][][] };
}

export interface NamedArea {
  name: string;
  polygons: Polygon[];
}

// Names must match the spellings src/search/address-format.ts writes.
export async function fetchNycBoroughs(): Promise<NamedArea[]> {
  // `*` because the disk cache keys on the query, so a narrower select would refetch per column.
  const rows = await NYC_OPEN_DATA.dataset<BoroughRow>(
    "gthc-hcne",
    { $select: "*" },
    NYC_BOROUGH_COUNT,
  );
  return rows.map((row) => ({
    name: row.boroname ?? "",
    polygons: (row.the_geom?.coordinates ?? []).map((parts) =>
      parts.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))),
    ),
  }));
}

export async function fetchNycLand(): Promise<Polygon[]> {
  const boroughs = await fetchNycBoroughs();
  return boroughs.flatMap((borough) => borough.polygons);
}

export interface LandContext {
  onLand: (coord: Coord) => boolean;
  box: Bounds;
}

export async function landContextOf(
  fetchLand: () => Promise<Polygon[]>,
): Promise<LandContext> {
  const land = await fetchLand();
  return { onLand: buildLandTest(land), box: boxOf(land) };
}

// A plain concatenation: SF and the East Bay don't touch. Marin is inside the bbox but never read.
export async function fetchBayAreaLand(): Promise<Polygon[]> {
  const [sanFrancisco, eastBay] = await Promise.all([
    fetchSfLand(),
    fetchEastBayLand(),
  ]);
  return [...sanFrancisco, ...eastBay];
}

export async function loadLandContext(cityId: string): Promise<LandContext> {
  const fetchLand = cityId === "sf" ? fetchBayAreaLand : fetchNycLand;
  return await landContextOf(fetchLand);
}

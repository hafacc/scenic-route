// Overture places is CDLA-Permissive-2.0: the license text must travel with the data.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import {
  type HouseNumber,
  parseHouseNumber,
} from "../src/search/address-format";
import { decodeAddresses, streetAddresses } from "../src/search/addresses";
import { cached } from "./cache";
import { haversineMeters } from "./geometry";
import type { Coord } from "./socrata";

const PLACES_DIR = join(import.meta.dirname, "..", "data", "places");
// Duplicated in scripts/search-index.ts, since importing this module would load DuckDB there.
const NEIGHBORHOOD_SUFFIX = "-neighborhoods.jsonl";
const ADDRESS_DIR = join(import.meta.dirname, "..", "public", "addresses");

// Pinned for local runs; the monthly job overrides it, since Overture keeps only two releases.
const PINNED_RELEASE = "2026-08-19.0";
const OVERTURE_RELEASE = process.env.OVERTURE_RELEASE || PINNED_RELEASE;
const OVERTURE_BUCKET = "s3://overturemaps-us-west-2/release";
const PLACES_PARQUET = `${OVERTURE_BUCKET}/${OVERTURE_RELEASE}/theme=places/type=place/*.parquet`;
const DIVISIONS_PARQUET = `${OVERTURE_BUCKET}/${OVERTURE_RELEASE}/theme=divisions/type=division_area/*.parquet`;
// A division is the named point; a division_area is the outline.
const DIVISION_PARQUET = `${OVERTURE_BUCKET}/${OVERTURE_RELEASE}/theme=divisions/type=division/*.parquet`;

// The tier is nesting, not fame: Williamsburg, Harlem and Times Square are microhoods.
const NEIGHBORHOOD_SUBTYPES = ["macrohood", "neighborhood", "microhood"];

// Administrative units Overture files as neighborhoods; only the name gives them away.
const NOT_A_NEIGHBORHOOD = /\bcommunity (board|district)\b/i;

// Duplicates sit within 1.2 km; the nearest real pair (the two Chelseas) is 10 km apart.
const SAME_NEIGHBORHOOD_METERS = 2000;

// Below this, names turn into phone numbers and half-transcribed shopfronts.
const MIN_CONFIDENCE = 0.5;

const CLOSED = "permanently_closed";

// A shared street name can join a place to another borough's house; wide enough for a campus gate.
const MAX_JOIN_METERS = 1000;

export interface PlaceRow {
  name: string;
  category: string | null;
  lat: number;
  lng: number;
  // The address file's spelling, not Overture's; null on both where the place didn't join.
  street: string | null;
  houseNumber: HouseNumber | null;
}

export interface NeighborhoodRow {
  name: string;
  lat: number;
  lng: number;
}

interface RawPlace {
  name: string;
  category: string | null;
  lat: number;
  lng: number;
  address: string | null;
  confidence: number;
  status: string | null;
}

// Applied to both sides of the join, so a wrong fold can't invent a match.
const STREET_WORDS: Readonly<Record<string, string>> = {
  AVENUE: "AVE",
  STREET: "ST",
  ROAD: "RD",
  BOULEVARD: "BLVD",
  PLACE: "PL",
  DRIVE: "DR",
  PARKWAY: "PKWY",
  TERRACE: "TER",
  COURT: "CT",
  LANE: "LN",
  HIGHWAY: "HWY",
  PLAZA: "PLZ",
  SQUARE: "SQ",
  TURNPIKE: "TPKE",
  EXPRESSWAY: "EXPY",
  CIRCLE: "CIR",
  ALLEY: "ALY",
  SAINT: "ST",
  NORTH: "N",
  SOUTH: "S",
  EAST: "E",
  WEST: "W",
};

// NYC files "W 39 ST" for "W 39th St"; SF files "03 ST" and drops apostrophes that NYC keeps.
export function normalizeStreet(text: string): string {
  return text
    .toUpperCase()
    .replace(/[.,']/g, "")
    .replace(/([0-9])(?:ST|ND|RD|TH)\b/g, "$1")
    .split(/\s+/)
    .filter((word) => word !== "")
    .map((word) => STREET_WORDS[word] ?? word.replace(/^0+(?=[0-9])/, ""))
    .join(" ");
}

// Overture's spelling -> the address file's, each checked against the published street list.
const STREET_ALIASES: Readonly<Record<string, string>> = {
  "Grand Concourse": "Grand Conc",
  "Beach Channel Dr": "Bch Channel Dr",
  "MacDougal St": "Mac Dougal St",
  "MacDougal Aly": "Mac Dougal Aly",
  "Crossbay Blvd": "Cross Bay Blvd",
  "Fashion Ave": "7 Ave", // honorary
  "Bayshore Blvd": "Bay Shore Blvd",
  "La Playa St": "La Playa",
  "South Park St": "South Park",
  Embarcadero: "The Embarcadero",
  "Cesar Chavez": "Cesar Chavez St",
};

const ALIASED_STREETS = new Map(
  Object.entries(STREET_ALIASES).map(([overture, published]) => [
    normalizeStreet(overture),
    normalizeStreet(published),
  ]),
);

// "305 W 39th St Ste 210": the address file carries no units.
const UNIT_TAIL =
  /\s+(?:STE|SUITE|APT|UNIT|FL|FLOOR|RM|ROOM|BLDG|LBBY|PH|BSMT|SPC|#)\b.*$/i;

export interface SplitAddress {
  number: HouseNumber;
  street: string; // normalized, ready to look up
}

// A US address is one line, number first; parks get lines like "Ocean Beach Parking".
export function splitAddress(freeform: string): SplitAddress | null {
  const match = /^\s*([0-9]{1,7}(?:\s*-\s*[0-9]{1,4})?[A-Za-z]?)\s+(.+)$/.exec(
    freeform,
  );
  if (match === null) {
    return null;
  } else {
    const number = parseHouseNumber(match[1]);
    const street = normalizeStreet(match[2].replace(UNIT_TAIL, ""));
    if (number === null || street === "") {
      return null;
    } else {
      return { number, street };
    }
  }
}

export interface PlacedAddress extends Coord {
  number: HouseNumber;
}

export interface StreetAddresses {
  name: string;
  // A list per number, since boroughs merge and NYC has a 312 on more than one Court Street.
  numbers: Map<string, PlacedAddress[]>;
  // Apart from `numbers`, so "12610" prefers a real 12610 over a 126-10.
  runTogether: Map<string, PlacedAddress[]>;
}

export type PlaceAddressIndex = Map<string, StreetAddresses>;

function numberKey({ major, minor, suffix }: HouseNumber): string {
  return `${major}/${minor}/${suffix}`;
}

function addHouse(
  houses: Map<string, PlacedAddress[]>,
  key: string,
  address: PlacedAddress,
): void {
  const existing = houses.get(key);
  if (existing === undefined) {
    houses.set(key, [address]);
  } else {
    existing.push(address);
  }
}

// Overture writes Queens' "126-10" either way; the minor's padding is restored, so "25-07" is 2507.
function runTogetherKey(number: HouseNumber): string | null {
  if (number.minor === 0) {
    return null;
  } else {
    const digits = `${number.major}${String(number.minor).padStart(2, "0")}`;
    return numberKey({
      major: Number(digits),
      minor: 0,
      suffix: number.suffix,
    });
  }
}

// Boroughs merge by name, since that's all an address line gives; the join settles them by distance.
export function buildAddressIndex(
  streets: Iterable<{ name: string; addresses: Iterable<PlacedAddress> }>,
): PlaceAddressIndex {
  const index: PlaceAddressIndex = new Map();
  for (const { name, addresses } of streets) {
    const key = normalizeStreet(name);
    let street = index.get(key);
    if (street === undefined) {
      street = { name, numbers: new Map(), runTogether: new Map() };
      index.set(key, street);
    }
    for (const address of addresses) {
      addHouse(street.numbers, numberKey(address.number), address);
      const alias = runTogetherKey(address.number);
      if (alias !== null) {
        addHouse(street.runTogether, alias, address);
      }
    }
  }
  return index;
}

export interface JoinedAddress {
  street: string;
  houseNumber: HouseNumber;
  meters: number; // judged against MAX_JOIN_METERS by the caller
}

// `at` is the only thing that tells the boroughs' same-named streets apart.
export function matchAddress(
  freeform: string,
  at: Coord,
  index: PlaceAddressIndex,
): JoinedAddress | null {
  const split = splitAddress(freeform);
  if (split === null) {
    return null;
  }
  const alias = ALIASED_STREETS.get(split.street);
  const street =
    index.get(split.street) ??
    (alias === undefined ? undefined : index.get(alias));
  const key = numberKey(split.number);
  // A house of that number outranks a hyphenated one that happens to spell it.
  const houses = street?.numbers.get(key) ?? street?.runTogether.get(key);
  if (street === undefined || houses === undefined) {
    return null;
  } else {
    let nearest = houses[0];
    let meters = haversineMeters(at, nearest);
    for (const house of houses) {
      const distance = haversineMeters(at, house);
      if (distance < meters) {
        nearest = house;
        meters = distance;
      }
    }
    return { street: street.name, houseNumber: nearest.number, meters };
  }
}

// The box only prefilters the parquet; the division's outline decides.
interface Source {
  id: string;
  name: string;
  west: number;
  south: number;
  east: number;
  north: number;
  // NYC is a locality of all five boroughs; SF is a county, whose land class leaves out the bay.
  division: { name: string; subtype: string };
}

const SOURCES: readonly Source[] = [
  {
    id: "nyc",
    name: "New York",
    west: -74.3,
    south: 40.47,
    east: -73.68,
    north: 40.93,
    division: { name: "New York", subtype: "locality" },
  },
  {
    id: "sf",
    name: "San Francisco",
    west: -122.53,
    south: 37.69,
    east: -122.34,
    north: 37.84,
    division: { name: "San Francisco", subtype: "county" },
  },
];

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Intersection, not containment: SF's county polygon reaches out to the Farallon Islands.
function outlineSql(source: Source): string {
  const { name, subtype } = source.division;
  return `SELECT geometry FROM read_parquet(${sqlText(DIVISIONS_PARQUET)})
    WHERE country = 'US'
      AND subtype = ${sqlText(subtype)}
      AND class = 'land'
      AND names.primary = ${sqlText(name)}
      AND bbox.xmin < ${source.east} AND bbox.xmax > ${source.west}
      AND bbox.ymin < ${source.north} AND bbox.ymax > ${source.south}`;
}

function placesSql(source: Source): string {
  return `WITH outline AS (${outlineSql(source)})
    SELECT
      place.names.primary AS name,
      place.categories.primary AS category,
      ST_Y(place.geometry) AS lat,
      ST_X(place.geometry) AS lng,
      place.addresses[1].freeform AS address,
      place.confidence AS confidence,
      place.operating_status AS status
    FROM read_parquet(${sqlText(PLACES_PARQUET)}) AS place, outline
    WHERE place.bbox.xmin > ${source.west} AND place.bbox.xmax < ${source.east}
      AND place.bbox.ymin > ${source.south} AND place.bbox.ymax < ${source.north}
      AND place.names.primary IS NOT NULL
      AND ST_Contains(outline.geometry, place.geometry)`;
}

function neighborhoodsSql(source: Source): string {
  const subtypes = NEIGHBORHOOD_SUBTYPES.map(sqlText).join(", ");
  return `WITH outline AS (${outlineSql(source)})
    SELECT
      area.names.primary AS name,
      ST_Y(area.geometry) AS lat,
      ST_X(area.geometry) AS lng
    FROM read_parquet(${sqlText(DIVISION_PARQUET)}) AS area, outline
    WHERE area.country = 'US'
      AND area.subtype IN (${subtypes})
      AND area.bbox.xmin > ${source.west} AND area.bbox.xmax < ${source.east}
      AND area.bbox.ymin > ${source.south} AND area.bbox.ymax < ${source.north}
      AND area.names.primary IS NOT NULL
      AND ST_Contains(outline.geometry, area.geometry)`;
}

// Sorted first, so which of a repeated pair survives doesn't depend on parquet order.
export function toNeighborhoods(
  rows: readonly NeighborhoodRow[],
): NeighborhoodRow[] {
  const kept: NeighborhoodRow[] = [];
  const ordered = [...rows].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.lat - right.lat ||
      left.lng - right.lng,
  );
  for (const row of ordered) {
    if (NOT_A_NEIGHBORHOOD.test(row.name)) {
      continue;
    }
    const twice = kept.some(
      (other) =>
        other.name === row.name &&
        haversineMeters(other, row) <= SAME_NEIGHBORHOOD_METERS,
    );
    if (!twice) {
      kept.push(row);
    }
  }
  return kept;
}

async function connect(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run(
    "INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';",
  );
  return connection;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function coordinate(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`a place came back with no ${field}`);
  } else {
    return value;
  }
}

// Cached against the query, so a changed release, box or outline misses.
async function fetchPlaces(
  connection: DuckDBConnection,
  source: Source,
): Promise<RawPlace[]> {
  const sql = placesSql(source);
  return await cached(`places.${source.id}`, sql, async () => {
    const outlines = await connection.runAndReadAll(
      `SELECT count(*) AS found FROM (${outlineSql(source)})`,
    );
    const found = Number(outlines.getRowObjects()[0].found);
    if (found !== 1) {
      // Overture renames divisions between releases, which would silently clip every place away.
      throw new Error(
        `${source.name}: ${found} divisions named ${source.division.name}, expected 1`,
      );
    }
    const reader = await connection.runAndReadAll(sql);
    return reader.getRowObjects().map((row) => ({
      name: String(row.name),
      category: text(row.category),
      lat: coordinate(row.lat, "latitude"),
      lng: coordinate(row.lng, "longitude"),
      address: text(row.address),
      confidence: typeof row.confidence === "number" ? row.confidence : 0,
      status: text(row.status),
    }));
  });
}

async function fetchNeighborhoods(
  connection: DuckDBConnection,
  source: Source,
): Promise<NeighborhoodRow[]> {
  const sql = neighborhoodsSql(source);
  return await cached(`neighborhoods.${source.id}`, sql, async () => {
    const reader = await connection.runAndReadAll(sql);
    return reader.getRowObjects().map((row) => ({
      name: String(row.name),
      lat: coordinate(row.lat, "latitude"),
      lng: coordinate(row.lng, "longitude"),
    }));
  });
}

// The shipped file, not the city's export, so a place joins to the spelling the client looks up.
async function loadAddressIndex(cityId: string): Promise<PlaceAddressIndex> {
  const gzipped = await readFile(join(ADDRESS_DIR, `${cityId}.bin.gz`));
  const addresses = decodeAddresses(gunzipSync(gzipped));
  return buildAddressIndex(
    addresses.streetName.entries().map(([street, name]) => ({
      name: addresses.sourceNames[name],
      addresses: streetAddresses(addresses, street),
    })),
  );
}

interface Summary {
  fetched: number;
  kept: number;
  joined: number;
  tooFar: number;
  categories: number;
}

function toRows(
  places: readonly RawPlace[],
  index: PlaceAddressIndex,
): { rows: PlaceRow[]; summary: Summary } {
  const rows: PlaceRow[] = [];
  const categories = new Set<string>();
  let joined = 0;
  let tooFar = 0;
  for (const place of places) {
    if (place.confidence < MIN_CONFIDENCE || place.status === CLOSED) {
      continue;
    }
    const match =
      place.address === null ? null : matchAddress(place.address, place, index);
    const address =
      match !== null && match.meters <= MAX_JOIN_METERS ? match : null;
    if (address !== null) {
      joined += 1;
    } else if (match !== null) {
      tooFar += 1;
    }
    if (place.category !== null) {
      categories.add(place.category);
    }
    rows.push({
      name: place.name,
      category: place.category,
      lat: place.lat,
      lng: place.lng,
      street: address?.street ?? null,
      houseNumber: address?.houseNumber ?? null,
    });
  }
  return {
    rows,
    summary: {
      fetched: places.length,
      kept: rows.length,
      joined,
      tooFar,
      categories: categories.size,
    },
  };
}

export async function updatePlaces(): Promise<void> {
  await mkdir(PLACES_DIR, { recursive: true });
  const connection = await connect();
  for (const source of SOURCES) {
    console.error(
      `places: reading ${source.name} from Overture ${OVERTURE_RELEASE}`,
    );
    const places = await fetchPlaces(connection, source);
    const index = await loadAddressIndex(source.id);
    const { rows, summary } = toRows(places, index);
    const lines = rows.map((row) => JSON.stringify(row));
    await writeFile(
      join(PLACES_DIR, `${source.id}.jsonl`),
      `${lines.join("\n")}\n`,
    );
    const found = await fetchNeighborhoods(connection, source);
    const neighborhoods = toNeighborhoods(found);
    await writeFile(
      join(PLACES_DIR, `${source.id}${NEIGHBORHOOD_SUFFIX}`),
      `${neighborhoods.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const rate = ((100 * summary.joined) / summary.kept).toFixed(1);
    console.error(
      `places: ${source.id}: ${summary.fetched} in the city, ${summary.kept} kept, ` +
        `${summary.joined} joined to an address (${rate}%), ` +
        `${summary.kept - summary.joined} with coordinates only, ` +
        `${summary.tooFar} of those a house too far off to be theirs, ` +
        `${summary.categories} categories, ` +
        `${neighborhoods.length} neighborhoods of ${found.length} named parts`,
    );
  }
  connection.closeSync();
}

if (import.meta.main) {
  await updatePlaces();
}

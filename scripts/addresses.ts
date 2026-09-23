// Gzipped because Pages serves .bin uncompressed.
// A rebuild renumbers streets, so public/search/<city>.bin.gz must be rebuilt in the same change.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { constants, gzipSync } from "node:zlib";
import {
  ADDRESS_FORMAT,
  ADDRESS_MAGIC,
  COORD_SCALE,
  compareHouseNumbers,
  type HouseNumber,
  NYC_BOROUGHS,
  packExtra,
  parseHouseNumber,
} from "../src/search/address-format";
import { ALAMEDA_PLACES } from "./alameda";
import { featurePages } from "./arcgis";
import { cachedFile } from "./cache";
import { writeVarint, zigzag } from "./geometry";
import { parseWktPoint } from "./socrata";

const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const ADDRESS_DIR = join(PUBLIC_DIR, "addresses");

// An address is four varints: number, extra, latitude, longitude.
const MAX_VARINT_BYTES = 5;
const MAX_ADDRESS_BYTES = 4 * MAX_VARINT_BYTES;
const REQUEST_TIMEOUT_MS = 300_000;

export interface AddressRow {
  street: string; // upper case, as the source writes it
  place: string; // borough or municipality
  number: HouseNumber;
  lat: number;
  lng: number;
}

// Quantized before the sort so duplicate rows become identical, not merely close.
interface Placed {
  number: HouseNumber;
  latUnits: number;
  lngUnits: number;
}

// A name in one place: New York's five Court Streets are five of these.
interface Street {
  name: string;
  place: string;
  addresses: Placed[];
}

export interface EncodedAddresses {
  bytes: Uint8Array;
  names: number; // distinct street names
  streets: number; // (name, place) pairs
  addresses: number; // after the dedupe
}

// NUL: street names may contain any printable character.
const KEY_SEPARATOR = "\u0000";

// By code unit: the order clients binary-search the blobs in.
function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  } else {
    return left < right ? -1 : 1;
  }
}

function samePlace(left: Placed, right: Placed | undefined): boolean {
  return (
    right !== undefined &&
    compareHouseNumbers(left.number, right.number) === 0 &&
    left.latUnits === right.latUnits &&
    left.lngUnits === right.lngUnits
  );
}

export function encodeAddresses(rows: readonly AddressRow[]): EncodedAddresses {
  const byStreet = new Map<string, Street>();
  for (const { street, place, number, lat, lng } of rows) {
    const placed = {
      number,
      latUnits: Math.round(lat * COORD_SCALE),
      lngUnits: Math.round(lng * COORD_SCALE),
    };
    const key = [street, place].join(KEY_SEPARATOR);
    const existing = byStreet.get(key);
    if (existing === undefined) {
      byStreet.set(key, { name: street, place, addresses: [placed] });
    } else {
      existing.addresses.push(placed);
    }
  }

  const streets = [...byStreet.values()].sort(
    (left, right) =>
      compareText(left.name, right.name) ||
      compareText(left.place, right.place),
  );
  for (const street of streets) {
    street.addresses.sort(
      (left, right) =>
        compareHouseNumbers(left.number, right.number) ||
        left.latUnits - right.latUnits ||
        left.lngUnits - right.lngUnits,
    );
    // The sources list one row per unit, so a six-flat is six identical rows.
    street.addresses = street.addresses.filter(
      (address, index) => !samePlace(address, street.addresses[index - 1]),
    );
  }
  const addresses = streets.reduce(
    (sum, street) => sum + street.addresses.length,
    0,
  );

  const names = [...new Set(streets.map((street) => street.name))].sort();
  const nameIndex = new Map(names.map((name, index) => [name, index]));
  const places = [...new Set(streets.map((street) => street.place))].sort();
  const placeIndex = new Map(places.map((place, index) => [place, index]));

  const encoder = new TextEncoder();
  const nameBlob = encoder.encode(names.join("\n"));
  const placeBlob = encoder.encode(places.join("\n"));
  const bytes = new Uint8Array(
    ADDRESS_MAGIC.length +
      1 +
      3 * MAX_VARINT_BYTES +
      nameBlob.length +
      placeBlob.length +
      streets.length * 3 * MAX_VARINT_BYTES +
      addresses * MAX_ADDRESS_BYTES,
  );

  let offset = 0;
  for (const character of ADDRESS_MAGIC) {
    bytes[offset] = character.charCodeAt(0);
    offset += 1;
  }
  bytes[offset] = ADDRESS_FORMAT;
  offset += 1;
  for (const blob of [nameBlob, placeBlob]) {
    offset = writeVarint(bytes, offset, blob.length);
    bytes.set(blob, offset);
    offset += blob.length;
  }
  offset = writeVarint(bytes, offset, streets.length);

  for (const street of streets) {
    offset = writeVarint(bytes, offset, nameIndex.get(street.name) ?? 0);
    offset = writeVarint(bytes, offset, placeIndex.get(street.place) ?? 0);
    offset = writeVarint(bytes, offset, street.addresses.length);
    let previousMajor = 0;
    let previousLat = 0;
    let previousLng = 0;
    for (const { number, latUnits, lngUnits } of street.addresses) {
      const extra = packExtra(number);
      offset = writeVarint(
        bytes,
        offset,
        zigzag(number.major - previousMajor) * 2 + (extra === 0 ? 0 : 1),
      );
      if (extra !== 0) {
        offset = writeVarint(bytes, offset, extra);
      }
      offset = writeVarint(bytes, offset, zigzag(latUnits - previousLat));
      offset = writeVarint(bytes, offset, zigzag(lngUnits - previousLng));
      previousMajor = number.major;
      previousLat = latUnits;
      previousLng = lngUnits;
    }
  }

  return {
    bytes: bytes.subarray(0, offset),
    names: names.length,
    streets: streets.length,
    addresses,
  };
}

// RFC 4180; the header row names the columns.
function* csvRecords(
  text: string,
  columns: readonly string[],
): Generator<string[]> {
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let indices: number[] | null = null;

  const endRecord = (): string[] | null => {
    record.push(field);
    field = "";
    const finished = record;
    record = [];
    if (finished.length === 1 && finished[0] === "") {
      return null;
    } else if (indices === null) {
      indices = columns.map((column) => {
        const index = finished.indexOf(column);
        if (index < 0) {
          throw new Error(`the export has no ${column} column`);
        }
        return index;
      });
      return null;
    } else {
      return indices.map((index) => finished[index] ?? "");
    }
  };

  for (let cursor = 0; cursor < text.length; cursor++) {
    const character = text[cursor];
    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (text[cursor + 1] === '"') {
        field += '"';
        cursor += 1;
      } else {
        quoted = false;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[cursor + 1] === "\n") {
        cursor += 1;
      }
      const fields = endRecord();
      if (fields !== null) {
        yield fields;
      }
    } else {
      field += character;
    }
  }
  if (record.length > 0 || field !== "") {
    const fields = endRecord();
    if (fields !== null) {
      yield fields;
    }
  }
}

interface Feed {
  name: string;
  collect(): Promise<Collected>;
}

// One CSV export, so the whole dataset comes in one request rather than pages.
interface CsvFeed {
  id: string; // cache entry name
  name: string;
  url: string;
  limit: number;
  columns: readonly string[];
  read(fields: string[]): AddressRow | null;
}

// Null, not 0, where blank: `Number("")` is 0.
function coordinate(text: string): number | null {
  const value = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(value)) {
    return null;
  } else {
    return value;
  }
}

const NYC_LIMIT = 1_200_000;
const SF_LIMIT = 500_000;

const NYC_ADDRESS_POINT: CsvFeed = {
  id: "nyc",
  name: "NYC AddressPoint",
  url:
    "https://data.cityofnewyork.us/resource/uf93-f8nk.csv?$select=house_number," +
    `full_street_name,boroughcode,the_geom&$limit=${NYC_LIMIT}`,
  limit: NYC_LIMIT,
  columns: ["house_number", "full_street_name", "boroughcode", "the_geom"],
  // Queens hyphenates ("25-07" is house 7 on block 25); "2701-B8" style numbers can't be encoded.
  read([houseNumber, street, boroughCode, geometry]) {
    const number = parseHouseNumber(houseNumber);
    const point = parseWktPoint(geometry);
    const borough = boroughCode.trim();
    const place = Object.hasOwn(NYC_BOROUGHS, borough)
      ? NYC_BOROUGHS[borough]
      : null;
    if (
      number === null ||
      point === null ||
      place === null ||
      street.trim() === ""
    ) {
      return null;
    } else {
      return { street: street.trim(), place, number, ...point };
    }
  },
};

const SAN_FRANCISCO = "San Francisco";

const SF_EAS: CsvFeed = {
  id: "sf",
  name: "SF EAS",
  url:
    "https://data.sfgov.org/resource/ramy-di5m.csv?$select=address_number," +
    `address_number_suffix,street_full_street_name,latitude,longitude&$limit=${SF_LIMIT}`,
  limit: SF_LIMIT,
  columns: [
    "address_number",
    "address_number_suffix",
    "street_full_street_name",
    "latitude",
    "longitude",
  ],
  // "269" plus suffix "B" is 269B; a "½" suffix can't be encoded.
  read([addressNumber, suffix, street, latitude, longitude]) {
    const number = parseHouseNumber(`${addressNumber.trim()}${suffix.trim()}`);
    const lat = coordinate(latitude);
    const lng = coordinate(longitude);
    if (
      number === null ||
      lat === null ||
      lng === null ||
      street.trim() === ""
    ) {
      return null;
    } else {
      return { street: street.trim(), place: SAN_FRANCISCO, number, lat, lng };
    }
  },
};

const ALAMEDA_ADDRESS_SERVICE =
  "https://services5.arcgis.com/ROBnTHSNjoZ2Wm1P/arcgis/rest/services/Address_Points/FeatureServer/0";

// 5x the layer's 2,000-row page, allowed by `maxRecordCountFactor`.
const ALAMEDA_PAGE_SIZE = 10_000;
// A floor that catches a truncated read; 296,494 rows at the 2026-08-28 read.
const ALAMEDA_ADDRESS_FLOOR = 250_000;

interface AlamedaRow {
  ST_NUM?: string | null;
  FEANME?: string | null;
  FEATYP?: string | null;
  DIRPRE?: string | null;
  DIRSUF?: string | null;
  MUN?: string | null;
}

interface AlamedaFeature {
  geometry?: { coordinates?: [number, number] } | null;
  properties?: AlamedaRow;
}

function alamedaPageUrl(offset: number): string {
  const url = new URL(`${ALAMEDA_ADDRESS_SERVICE}/query`);
  const codes = Object.keys(ALAMEDA_PLACES)
    .map((code) => `'${code}'`)
    .join(",");
  url.searchParams.set("where", `MUN IN (${codes})`);
  url.searchParams.set("outFields", "ST_NUM,FEANME,FEATYP,DIRPRE,DIRSUF,MUN");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  // Without an order, an ArcGIS layer may repeat or skip rows between `resultOffset` pages.
  url.searchParams.set("orderByFields", "OBJECTID");
  url.searchParams.set("resultOffset", String(offset));
  url.searchParams.set("resultRecordCount", String(ALAMEDA_PAGE_SIZE));
  url.searchParams.set("maxRecordCountFactor", "5");
  url.searchParams.set("f", "geojson");
  return url.toString();
}

// Spelled as the county centerline, which the routing graph's street names come from: "E 38TH ST".
function alamedaStreet(row: AlamedaRow): string {
  return [row.DIRPRE, row.FEANME, row.FEATYP, row.DIRSUF]
    .map((part) => (part ?? "").trim())
    .filter((part) => part !== "")
    .join(" ")
    .toUpperCase();
}

function alamedaRow(feature: AlamedaFeature): AddressRow | null {
  const row = feature.properties ?? {};
  const place = ALAMEDA_PLACES[(row.MUN ?? "").trim().toUpperCase()];
  const number = parseHouseNumber(row.ST_NUM ?? "");
  const street = alamedaStreet(row);
  const point = feature.geometry?.coordinates;
  if (place === undefined || number === null || street === "" || !point) {
    return null;
  } else {
    const [lng, lat] = point;
    return { street, place, number, lat, lng };
  }
}

const ALAMEDA_ADDRESS_POINTS: Feed = {
  name: "Alameda County Address_Points",
  async collect(): Promise<Collected> {
    const rows: AddressRow[] = [];
    let total = 0;
    const pages = featurePages<AlamedaFeature>({
      pageUrl: alamedaPageUrl,
      pageSize: ALAMEDA_PAGE_SIZE,
      cacheName: "addresses.alameda",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    for await (const page of pages) {
      for (const feature of page) {
        total += 1;
        const row = alamedaRow(feature);
        if (row !== null) {
          rows.push(row);
        }
      }
      console.error(`  alameda: ${total} addresses`);
    }
    if (total < ALAMEDA_ADDRESS_FLOOR) {
      throw new Error(
        `Alameda County's Address_Points answered ${total} rows over the seven municipalities, too few to be all of them`,
      );
    }
    return { rows, unparsed: total - rows.length };
  },
};

function csvFeed(feed: CsvFeed): Feed {
  return { name: feed.name, collect: () => collectCsv(feed) };
}

interface CityAddresses {
  id: string;
  feeds: readonly Feed[];
}

const CITIES: readonly CityAddresses[] = [
  { id: "nyc", feeds: [csvFeed(NYC_ADDRESS_POINT)] },
  { id: "sf", feeds: [csvFeed(SF_EAS), ALAMEDA_ADDRESS_POINTS] },
];

async function fetchCsv(feed: CsvFeed): Promise<string> {
  const path = await cachedFile(`addresses.${feed.id}`, feed.url, async () => {
    const response = await fetch(feed.url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  });
  return await readFile(path, "utf-8");
}

interface Collected {
  rows: AddressRow[];
  unparsed: number;
}

async function collectCsv(feed: CsvFeed): Promise<Collected> {
  const text = await fetchCsv(feed);
  const rows: AddressRow[] = [];
  let total = 0;
  for (const fields of csvRecords(text, feed.columns)) {
    total += 1;
    const row = feed.read(fields);
    if (row !== null) {
      rows.push(row);
    }
  }
  if (total >= feed.limit) {
    // A dataset that grew past the limit would come back truncated and look complete.
    throw new Error(
      `${feed.name} returned ${total} rows, its whole $limit: raise it, the export was truncated`,
    );
  }
  return { rows, unparsed: total - rows.length };
}

export async function updateAddresses(): Promise<void> {
  await mkdir(ADDRESS_DIR, { recursive: true });
  for (const city of CITIES) {
    const rows: AddressRow[] = [];
    let unparsed = 0;
    for (const feed of city.feeds) {
      console.error(`addresses: fetching ${feed.name}`);
      const collected = await feed.collect();
      console.error(
        `addresses: ${feed.name}: ${collected.rows.length} rows, ${collected.unparsed} unparsed`,
      );
      // Spreading a million rows into `push` overflows the stack.
      for (const row of collected.rows) {
        rows.push(row);
      }
      unparsed += collected.unparsed;
    }
    const { bytes, names, streets, addresses } = encodeAddresses(rows);
    const gzipped = gzipSync(bytes, { level: constants.Z_BEST_COMPRESSION });
    await writeFile(join(ADDRESS_DIR, `${city.id}.bin.gz`), gzipped);
    console.error(
      `addresses: ${city.id}: ${names} names in ${streets} streets, ` +
        `${addresses} addresses, ${unparsed} unparsed, ${bytes.length} bytes raw, ` +
        `${gzipped.length} gzipped (${(gzipped.length / addresses).toFixed(2)} B/address)`,
    );
  }
}

if (import.meta.main) {
  await updateAddresses();
}

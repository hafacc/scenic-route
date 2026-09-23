// Committed; no build writes it. Gzipped on disk because Pages serves .bin uncompressed.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { constants, gunzipSync, gzipSync } from "node:zlib";
import { cityById } from "../src/cities";
import type { OverlayId } from "../src/overlays/registry";
import {
  decodeGraph,
  edgeKind,
  type GraphIdentity,
} from "../src/routing/graph";
import { decodePois } from "../src/routing/pois";
import { prettifyStreetName } from "../src/routing/street-names";
import {
  COORD_SCALE,
  type HouseNumber,
  packExtra,
} from "../src/search/address-format";
import {
  type AddressIndex,
  decodeAddresses,
  streetAddresses,
} from "../src/search/addresses";
import {
  DICT_BLOCK,
  type DocKind,
  MAX_NAME_TOKENS,
  ordinalValue,
  ordinalWords,
  packKindFlags,
  packTokenInfo,
  RESTART_BYTES,
  SEARCH_FORMAT,
  SEARCH_MAGIC,
  tokenize,
} from "../src/search/search-format";
import {
  decodeSubway,
  mergeStations,
  stationRoutes,
} from "../src/subway/format";
import { writeVarint, zigzag } from "./geometry";
import { fetchNycBoroughs, loadLandContext } from "./land";
import { buildLandTest } from "./land-filter";

const ROOT = join(import.meta.dirname, "..");
const DATA_DIR = join(ROOT, "data");
const PLACES_DIR = join(DATA_DIR, "places");
const ADDRESS_DIR = join(ROOT, "public", "addresses");
const GRAPH_DIR = join(ROOT, "public", "routing");
// public/ copies, not the data/ LFS originals, so the refresh job can fetch them off the site.
const POINT_DIR = join(ROOT, "public");
const SEARCH_DIR = join(ROOT, "public", "search");

const CITIES = ["nyc", "sf"] as const;

const MAX_VARINT_BYTES = 5;

// Cells across the city's box, so a cell is a few meters.
const HILBERT_SIZE = 1 << 16;

// Whole underscore-joined words: a substring test ranked `gas_station` with Penn Station.
function slugWords(...words: readonly string[]): RegExp {
  return new RegExp(`(^|_)(${words.join("|")})(_|$)`);
}

// Exact slugs, for tiers where a word is too broad: every third slug ends in `_station`.
function slugs(...names: readonly string[]): RegExp {
  return new RegExp(`^(${names.join("|")})$`);
}

// First match wins. Tiers are spread wide because the distance term they multiply swings 4:1.
const PROMINENCE_RULES: readonly { prominence: number; slug: RegExp }[] = [
  // Named individually: `station` also matches gas, radio and EV-charging stations.
  {
    prominence: 240,
    slug: slugs(
      "train_station",
      "metro_station",
      "bus_station",
      "light_rail_and_subway_stations",
      "airport",
      "airport_terminal",
      "heliports",
      "ferry_service",
      "public_transportation",
    ),
  },
  // Named individually: `^park` also matches `parking`, `^garden` matches `gardener`.
  {
    prominence: 235,
    slug: slugs(
      "park",
      "national_park",
      "state_park",
      "beach",
      "public_plaza",
      "forest",
      "nature_reserve",
      "botanical_garden",
      "community_gardens",
      "memorial_park",
      "pier",
    ),
  },
  {
    prominence: 220,
    slug: slugWords(
      "museum",
      "zoo",
      "aquarium",
      "stadium",
      "arena",
      "monument",
    ),
  },
  {
    prominence: 195,
    slug: slugs(
      "theatre",
      "theaters_and_performance_venues",
      "playground",
      "dog_park",
      "skate_park",
      "water_park",
      "amusement_park",
      "campground",
      "hiking_trail",
      "mountain_bike_trails",
    ),
  },
  // Exact: `school` as a word includes driving schools, and `medical_center` is a walk-in clinic.
  {
    prominence: 170,
    slug: slugs(
      "hospital",
      "childrens_hospital",
      "library",
      "post_office",
      "police_department",
      "fire_department",
      "college_university",
      "university",
      "school",
      "elementary_school",
      "middle_school",
      "high_school",
      "public_school",
      "private_school",
      "charter_school",
      "montessori_school",
      "religious_school",
      "courthouse",
      "city_hall",
      "community_center",
    ),
  },
  {
    prominence: 170,
    slug: slugWords("church", "cathedral", "synagogue", "mosque", "temple"),
  },
  // Offices. Ahead of the shops because `wholesale_store` would otherwise match `store`.
  {
    prominence: 40,
    slug: slugWords(
      "professional",
      "contractor",
      "contractors",
      "lawyer",
      "lawyers",
      "attorney",
      "attorneys",
      "accountant",
      "accountants",
      "financial",
      "insurance",
      "advertising",
      "trusts",
      "consulting",
      "notary",
      "staffing",
      "wholesale",
      "wholesaler",
      "wholesalers",
      "estate",
      "corporate",
      "courier",
      "transfer",
    ),
  },
  {
    prominence: 120,
    slug: slugWords(
      "restaurant",
      "restaurants",
      "food",
      "cafe",
      "coffee",
      "bar",
      "bars",
      "bakery",
      "delicatessen",
      "pub",
      "brewery",
      "nightlife",
      "club",
      "store",
      "stores",
      "shop",
      "shopping",
      "market",
      "grocery",
      "pharmacy",
      "hotel",
      "hotels",
      "salon",
      "barber",
      "gym",
      "spa",
      "spas",
    ),
  },
];

// Open-space tiers, which a house number demotes: it means a shop named after the park.
const AREA_PROMINENCE: readonly number[] = [235, 195];

// Includes `landmark_and_historical_building` on purpose: in NYC it's mostly apartment blocks.
const DEFAULT_PROMINENCE = 80;
const STREET_PROMINENCE = 170;

const STATION_PROMINENCE = 240;
// Corner-named stops ("Judah St & 40th Ave", most Muni stops) are a curb, not a destination.
const STOP_PROMINENCE = 150;
const CORNER_NAME = /&/;
const LANDMARK_PROMINENCE = 210;
const LEGACY_PROMINENCE = 180;
const ART_PROMINENCE = 150;
const DINING_PROMINENCE = 120;
// Below the park or station a reader named exactly.
const NEIGHBORHOOD_PROMINENCE = 150;

// Same name within this is one place across sources; an NYC block is about 80 m.
const SAME_PLACE_METERS = 150;
const LOGGED_DUPLICATES = 25;

// Overture takes addresses from business listings, so a park with a house number is a shop.
export function prominenceOf(
  category: string | null,
  hasNumber: boolean,
): number {
  if (category === null) {
    return DEFAULT_PROMINENCE;
  }
  const rule = PROMINENCE_RULES.find(({ slug }) => slug.test(category));
  if (rule === undefined) {
    return DEFAULT_PROMINENCE;
  } else if (hasNumber && AREA_PROMINENCE.includes(rule.prominence)) {
    return DEFAULT_PROMINENCE;
  } else {
    return rule.prominence;
  }
}

// Row types are redeclared, not imported: scripts/places.ts opens DuckDB on load.
const NEIGHBORHOOD_SUFFIX = "-neighborhoods.jsonl";

interface NeighborhoodRow {
  name: string;
  lat: number;
  lng: number;
}

export interface PlaceRow {
  name: string;
  category: string | null;
  lat: number;
  lng: number;
  street: string | null; // the ADDR file's spelling
  houseNumber: HouseNumber | null;
}

export interface SearchDoc {
  name: string;
  kind: DocKind;
  tokens: readonly string[]; // deduplicated, so one posting per (token, doc)
  lat: number;
  lng: number;
  prominence: number;
  category: string | null; // the Overture slug, or the routes a station serves
  placeIndex: number; // into the ADDR place blob, or -1
  streetIndex: number; // into the ADDR street table, or -1
  number: HouseNumber | null;
}

export interface EncodedSearch {
  bytes: Uint8Array;
  docCount: number;
  tokenCount: number;
  postingCount: number;
  largestList: { token: string; postings: number };
  nameBytes: number;
  dictBytes: number;
  postingBytes: number;
}

// Standard xy2d. Multiplied, not shifted, because a 16-level curve runs past 2^31.
function hilbertIndex(cellX: number, cellY: number): number {
  let column = cellX;
  let row = cellY;
  let distance = 0;
  for (let step = HILBERT_SIZE / 2; step >= 1; step /= 2) {
    const right = (column & step) > 0 ? 1 : 0;
    const up = (row & step) > 0 ? 1 : 0;
    distance += step * step * ((3 * right) ^ up);
    if (up === 0) {
      if (right === 1) {
        column = step - 1 - column;
        row = step - 1 - row;
      }
      const swap = column;
      column = row;
      row = swap;
    }
  }
  return distance;
}

interface Quantized {
  doc: SearchDoc;
  latUnits: number;
  lngUnits: number;
  order: number;
}

function quantize(docs: readonly SearchDoc[]): Quantized[] {
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const { lat, lng } of docs) {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lng);
    east = Math.max(east, lng);
  }
  const latSpan = Math.max(north - south, 1e-9);
  const lngSpan = Math.max(east - west, 1e-9);
  const cell = HILBERT_SIZE - 1;
  return docs.map((doc) => {
    const column = Math.round(((doc.lng - west) / lngSpan) * cell);
    const row = Math.round(((doc.lat - south) / latSpan) * cell);
    return {
      doc,
      latUnits: Math.round(doc.lat * COORD_SCALE),
      lngUnits: Math.round(doc.lng * COORD_SCALE),
      order: hilbertIndex(column, row),
    };
  });
}

// Bytewise: JS string comparison sorts by UTF-16 units, which misorders astral-plane characters.
function compareTokens(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return left.length - right.length;
}

function sharedPrefix(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  let length = 0;
  while (length < shared && left[length] === right[length]) {
    length += 1;
  }
  return length;
}

export function encodeSearch(docs: readonly SearchDoc[]): EncodedSearch {
  const ordered = quantize(docs).sort(
    (left, right) => left.order - right.order,
  );

  const encoder = new TextEncoder();
  const names = ordered.map(({ doc }) => encoder.encode(doc.name));
  const nameBytes = names.reduce((sum, name) => sum + name.length, 0);

  const categories = [
    ...new Set(
      ordered
        .map(({ doc }) => doc.category)
        .filter((category): category is string => category !== null),
    ),
  ].sort();
  const categoryIndex = new Map(
    categories.map((category, index) => [category, index]),
  );
  const categoryBlob = encoder.encode(categories.join("\n"));

  const postings = new Map<string, number[]>();
  ordered.forEach(({ doc }, id) => {
    for (const token of doc.tokens) {
      const list = postings.get(token);
      if (list === undefined) {
        postings.set(token, [id]);
      } else {
        list.push(id);
      }
    }
  });
  const tokens = [...postings.keys()]
    .map((token) => ({ token, bytes: encoder.encode(token) }))
    .sort((left, right) => compareTokens(left.bytes, right.bytes));
  const postingCount = [...postings.values()].reduce(
    (sum, list) => sum + list.length,
    0,
  );
  const tailBytes = tokens.reduce((sum, entry) => sum + entry.bytes.length, 0);
  const restartCount = Math.ceil(tokens.length / DICT_BLOCK);

  const bytes = new Uint8Array(
    SEARCH_MAGIC.length +
      1 +
      MAX_VARINT_BYTES +
      categoryBlob.length +
      MAX_VARINT_BYTES +
      nameBytes +
      ordered.length * (3 + 6 * MAX_VARINT_BYTES) +
      3 * MAX_VARINT_BYTES +
      restartCount * RESTART_BYTES +
      tokens.length * 4 * MAX_VARINT_BYTES +
      tailBytes +
      postingCount * MAX_VARINT_BYTES,
  );

  let offset = 0;
  for (const character of SEARCH_MAGIC) {
    bytes[offset] = character.charCodeAt(0);
    offset += 1;
  }
  bytes[offset] = SEARCH_FORMAT;
  offset += 1;
  offset = writeVarint(bytes, offset, categoryBlob.length);
  bytes.set(categoryBlob, offset);
  offset += categoryBlob.length;
  offset = writeVarint(bytes, offset, ordered.length);

  let previousLat = 0;
  let previousLng = 0;
  ordered.forEach(({ doc, latUnits, lngUnits }, id) => {
    const name = names[id];
    offset = writeVarint(bytes, offset, name.length);
    bytes.set(name, offset);
    offset += name.length;
    bytes[offset] = packKindFlags(
      doc.kind,
      doc.streetIndex >= 0,
      doc.number !== null,
    );
    offset += 1;
    // The display name's word count; `tokens` is deduplicated and holds a street's other spellings.
    bytes[offset] = packTokenInfo(tokenize(doc.name).length, doc.placeIndex);
    offset += 1;
    bytes[offset] = doc.prominence;
    offset += 1;
    offset = writeVarint(
      bytes,
      offset,
      doc.category === null ? 0 : (categoryIndex.get(doc.category) ?? -1) + 1,
    );
    offset = writeVarint(bytes, offset, zigzag(latUnits - previousLat));
    offset = writeVarint(bytes, offset, zigzag(lngUnits - previousLng));
    previousLat = latUnits;
    previousLng = lngUnits;
    if (doc.streetIndex >= 0) {
      offset = writeVarint(bytes, offset, doc.streetIndex);
    }
    if (doc.number !== null) {
      const extra = packExtra(doc.number);
      offset = writeVarint(
        bytes,
        offset,
        doc.number.major * 2 + (extra === 0 ? 0 : 1),
      );
      if (extra !== 0) {
        offset = writeVarint(bytes, offset, extra);
      }
    }
  });

  // Scratch buffers first: the restart table precedes both and holds offsets into them.
  const entries = new Uint8Array(
    tokens.length * 4 * MAX_VARINT_BYTES + tailBytes,
  );
  const lists = new Uint8Array(postingCount * MAX_VARINT_BYTES);
  const restarts = new Uint8Array(restartCount * RESTART_BYTES);
  const restartView = new DataView(restarts.buffer);
  let entryOffset = 0;
  let listOffset = 0;
  let largest = { token: "", postings: 0 };
  tokens.forEach(({ token, bytes: tokenBytes }, index) => {
    const list = postings.get(token) ?? [];
    if (list.length > largest.postings) {
      largest = { token, postings: list.length };
    }
    const block = index % DICT_BLOCK;
    if (block === 0) {
      const restart = (index / DICT_BLOCK) * RESTART_BYTES;
      restartView.setUint32(restart, entryOffset, true);
      restartView.setUint32(restart + 4, listOffset, true);
    }
    const previous = block === 0 ? new Uint8Array(0) : tokens[index - 1].bytes;
    const lcp = sharedPrefix(previous, tokenBytes);
    const listStart = listOffset;
    let previousId = 0;
    for (const id of list) {
      listOffset = writeVarint(lists, listOffset, id - previousId);
      previousId = id;
    }
    entryOffset = writeVarint(entries, entryOffset, lcp);
    entryOffset = writeVarint(entries, entryOffset, tokenBytes.length - lcp);
    entries.set(tokenBytes.subarray(lcp), entryOffset);
    entryOffset += tokenBytes.length - lcp;
    entryOffset = writeVarint(entries, entryOffset, list.length);
    entryOffset = writeVarint(entries, entryOffset, listOffset - listStart);
  });

  offset = writeVarint(bytes, offset, tokens.length);
  offset = writeVarint(bytes, offset, entryOffset);
  offset = writeVarint(bytes, offset, restartCount);
  bytes.set(restarts, offset);
  offset += restarts.length;
  bytes.set(entries.subarray(0, entryOffset), offset);
  offset += entryOffset;
  bytes.set(lists.subarray(0, listOffset), offset);
  offset += listOffset;

  return {
    bytes: bytes.subarray(0, offset),
    docCount: ordered.length,
    tokenCount: tokens.length,
    postingCount,
    largestList: largest,
    nameBytes,
    dictBytes: entryOffset + restarts.length,
    postingBytes: listOffset,
  };
}

interface StreetDoc {
  street: number; // the ADDR ordinal
  name: string;
  tokens: string[];
  lat: number;
  lng: number;
  placeIndex: number;
}

// "5 AV" is stored, "5th Avenue" shown, and neither contains "fifth", so all spellings are indexed.
export function streetTokens(source: string, pretty: string): string[] {
  const tokens = new Set([...tokenize(source), ...tokenize(pretty)]);
  for (const token of [...tokens]) {
    const value = ordinalValue(token);
    if (value !== null) {
      for (const word of ordinalWords(value)) {
        tokens.add(word);
      }
    }
  }
  return [...tokens];
}

// Placed at the mean of its addresses, the only coordinate ADDR has for a street.
function streetDocs(addresses: AddressIndex): StreetDoc[] {
  const docs: StreetDoc[] = [];
  const streetCount = addresses.starts.length - 1;
  for (let street = 0; street < streetCount; street += 1) {
    const houses = streetAddresses(addresses, street);
    if (houses.length === 0) {
      continue;
    }
    const nameId = addresses.streetName[street];
    const pretty = addresses.names[nameId];
    docs.push({
      street,
      name: pretty,
      tokens: streetTokens(addresses.sourceNames[nameId], pretty),
      lat: houses.reduce((sum, house) => sum + house.lat, 0) / houses.length,
      lng: houses.reduce((sum, house) => sum + house.lng, 0) / houses.length,
      placeIndex:
        addresses.places.length === 0 ? -1 : addresses.streetPlace[street],
    });
  }
  return docs;
}

// A street the routing graph names and ADDR doesn't: alleys, footbridges, park paths.
export interface GraphStreet {
  name: string;
  tokens: string[];
  lat: number;
  lng: number;
}

// Lower wins a shared name. Dining trails Overture, which has the same restaurants with more data.
const CURATED_PRIORITY = 0;
const OVERTURE_PRIORITY = 1;
const DINING_PRIORITY = 2;

export interface NamedPoint {
  name: string;
  lat: number;
  lng: number;
  detail?: string; // rides in the category slot, e.g. a station's routes
}

export interface PointSet {
  kind: DocKind;
  source: string; // for the log
  prominence: number;
  priority: number;
  points: readonly NamedPoint[];
}

function numberKey({ major, minor, suffix }: HouseNumber): string {
  return `${major}/${minor}/${suffix}`;
}

// places.ts joins by name only (NYC has five Court Streets); the nearest matching house decides.
class StreetLookup {
  private readonly byName = new Map<string, number[]>();
  private readonly houses = new Map<
    string,
    Map<string, { street: number; lat: number; lng: number }[]>
  >();

  constructor(private readonly addresses: AddressIndex) {
    const streetCount = addresses.starts.length - 1;
    for (let street = 0; street < streetCount; street += 1) {
      const name = addresses.sourceNames[addresses.streetName[street]];
      const existing = this.byName.get(name);
      if (existing === undefined) {
        this.byName.set(name, [street]);
      } else {
        existing.push(street);
      }
    }
  }

  private houseIndex(
    name: string,
    streets: readonly number[],
  ): Map<string, { street: number; lat: number; lng: number }[]> {
    const cached = this.houses.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const index = new Map<
      string,
      { street: number; lat: number; lng: number }[]
    >();
    for (const street of streets) {
      for (const { number, lat, lng } of streetAddresses(
        this.addresses,
        street,
      )) {
        const key = numberKey(number);
        const entry = { street, lat, lng };
        const existing = index.get(key);
        if (existing === undefined) {
          index.set(key, [entry]);
        } else {
          existing.push(entry);
        }
      }
    }
    this.houses.set(name, index);
    return index;
  }

  find(
    name: string,
    number: HouseNumber,
    at: { lat: number; lng: number },
  ): number | null {
    const streets = this.byName.get(name);
    if (streets === undefined) {
      return null;
    } else if (streets.length === 1) {
      return streets[0];
    }
    const houses = this.houseIndex(name, streets).get(numberKey(number));
    if (houses === undefined || houses.length === 0) {
      return null;
    }
    let nearest = houses[0];
    let best = Infinity;
    for (const house of houses) {
      const north = house.lat - at.lat;
      const east = house.lng - at.lng;
      const distance = north * north + east * east;
      if (distance < best) {
        best = distance;
        nearest = house;
      }
    }
    return nearest.street;
  }
}

export interface Summary {
  places: number;
  streets: number;
  graphStreets: number;
  points: number;
  duplicates: number;
  joined: number;
  unplaced: number; // joined places whose street could not be told from its namesakes
  bounded: number; // borough from the boundaries rather than an address
  homeless: number;
  untokenized: number;
  longNames: number; // more words than the four-bit token count can hold
}

export interface PlaceArea {
  placeIndex: number;
  contains: (at: { lat: number; lng: number }) => boolean;
}

// Borough boundaries, for places with no address; Overture rows don't say which borough.
export async function placeAreas(
  cityId: string,
  addresses: AddressIndex,
): Promise<PlaceArea[]> {
  if (addresses.places.length === 0 || cityId !== "nyc") {
    return [];
  }
  const boroughs = await fetchNycBoroughs();
  const areas: PlaceArea[] = [];
  for (const borough of boroughs) {
    const placeIndex = addresses.places.indexOf(borough.name);
    if (placeIndex < 0) {
      throw new Error(
        `${borough.name} is not a place of the ${cityId} addresses`,
      );
    }
    areas.push({ placeIndex, contains: buildLandTest(borough.polygons) });
  }
  return areas;
}

async function readPlaces(cityId: string): Promise<PlaceRow[]> {
  const text = await readFile(join(PLACES_DIR, `${cityId}.jsonl`), "utf-8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as PlaceRow);
}

async function readAddresses(cityId: string): Promise<AddressIndex> {
  const gzipped = await readFile(join(ADDRESS_DIR, `${cityId}.bin.gz`));
  return decodeAddresses(gunzipSync(gzipped));
}

// A missing file is fatal if the city offers the overlay: it means the build didn't run.
async function pointFile(
  set: string,
  overlay: OverlayId,
  cityId: string,
): Promise<ArrayBuffer | null> {
  const path = join(POINT_DIR, set, `${cityId}.bin`);
  const file = await readFile(path).catch(() => null);
  if (file !== null) {
    return file.buffer.slice(
      file.byteOffset,
      file.byteOffset + file.byteLength,
    );
  } else if (cityById(cityId)?.overlays.includes(overlay) === true) {
    throw new Error(
      `${path} is missing, and ${cityId} offers the ${overlay} layer, so it should be there:` +
        " the tile build copies these out of data/ (bun run build-tiles)",
    );
  } else {
    return null;
  }
}

async function readPoints(
  directory: string,
  overlay: OverlayId,
  cityId: string,
  magic: string,
): Promise<NamedPoint[] | null> {
  const file = await pointFile(directory, overlay, cityId);
  if (file === null) {
    return null;
  }
  const { lats, lngs, names } = decodePois(file, magic);
  const points: NamedPoint[] = [];
  for (let point = 0; point < names.length; point += 1) {
    if (names[point] !== "") {
      points.push({ name: names[point], lat: lats[point], lng: lngs[point] });
    }
  }
  return points;
}

async function neighborhoodPoints(
  cityId: string,
): Promise<NamedPoint[] | null> {
  const path = join(PLACES_DIR, `${cityId}${NEIGHBORHOOD_SUFFIX}`);
  const text = await readFile(path, "utf-8").catch(() => null);
  if (text === null) {
    return null;
  }
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as NeighborhoodRow);
}

// Clipped to land: the rail artifact holds whole networks, and the graph can't route off its land.
async function stationPoints(cityId: string): Promise<NamedPoint[] | null> {
  const file = await pointFile("subway", "subway", cityId);
  if (file === null) {
    return null;
  }
  const { onLand } = await loadLandContext(cityId);
  const { routes, stations } = decodeSubway(file);
  return mergeStations(stations)
    .filter((station) => onLand(station))
    .map((station) => {
      const serving = stationRoutes(station, routes).join("/");
      return {
        name: station.name,
        lat: station.lat,
        lng: station.lng,
        detail: serving === "" ? undefined : serving,
      };
    });
}

async function citySets(cityId: string): Promise<PointSet[]> {
  const sets: PointSet[] = [];
  const add = (
    kind: DocKind,
    source: string,
    prominence: number,
    priority: number,
    points: NamedPoint[] | null,
  ) => {
    if (points !== null && points.length > 0) {
      sets.push({ kind, source, prominence, priority, points });
    }
  };
  const stations = await stationPoints(cityId);
  add(
    "station",
    "subway",
    STATION_PROMINENCE,
    CURATED_PRIORITY,
    stations?.filter(({ name }) => !CORNER_NAME.test(name)) ?? null,
  );
  add(
    "station",
    "subway stops",
    STOP_PROMINENCE,
    CURATED_PRIORITY,
    stations?.filter(({ name }) => CORNER_NAME.test(name)) ?? null,
  );
  add(
    "landmark",
    "landmarks",
    LANDMARK_PROMINENCE,
    CURATED_PRIORITY,
    await readPoints("landmarks", "landmarks", cityId, "LMRK"),
  );
  add(
    "legacy-business",
    "legacy",
    LEGACY_PROMINENCE,
    CURATED_PRIORITY,
    await readPoints("legacy", "legacy", cityId, "LGCY"),
  );
  add(
    "art",
    "art",
    ART_PROMINENCE,
    CURATED_PRIORITY,
    await readPoints("art", "art", cityId, "ARTW"),
  );
  add(
    "neighborhood",
    "neighborhoods",
    NEIGHBORHOOD_PROMINENCE,
    CURATED_PRIORITY,
    await neighborhoodPoints(cityId),
  );
  add(
    "place",
    "dining",
    DINING_PROMINENCE,
    DINING_PRIORITY,
    await readPoints("dining", "commercial", cityId, "DINE"),
  );
  return sets;
}

// The first edge carrying a name decides where it points.
async function graphStreets(
  cityId: string,
  addresses: AddressIndex,
): Promise<GraphStreet[]> {
  const path = join(GRAPH_DIR, `${cityId}.bin`);
  const file = await readFile(path).catch(() => null);
  if (file === null) {
    throw new Error(
      `${path} is missing: the graph names are part of the index, so build it first (bun run build-tiles:graph)`,
    );
  }
  const identity = JSON.parse(
    await readFile(join(GRAPH_DIR, `${cityId}.version.json`), "utf-8"),
  ) as GraphIdentity;
  const graph = decodeGraph(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    identity,
  );
  const known = new Set(
    addresses.sourceNames.map((name) => name.toUpperCase()),
  );
  const seen = new Set<number>();
  const streets: GraphStreet[] = [];
  for (let edge = 0; edge < graph.edgeCount; edge += 1) {
    // Ferry and rail edges are named after routes and stations, not streets.
    if (edgeKind(graph, edge) !== "sidewalk" && !graph.edgeGeomCount[edge]) {
      continue;
    }
    const nameId = graph.edgeNameId[edge];
    const name = graph.names[nameId];
    if (name === undefined || name === "" || seen.has(nameId)) {
      continue;
    }
    seen.add(nameId);
    if (known.has(name.toUpperCase())) {
      continue;
    }
    const node = graph.edgeNodeA[edge];
    const pretty = prettifyStreetName(name);
    streets.push({
      name: pretty,
      tokens: streetTokens(name, pretty),
      lat: graph.originLat + graph.nodeQy[node] * graph.scale,
      lng: graph.originLng + graph.nodeQx[node] * graph.scale,
    });
  }
  return streets;
}

const METERS_PER_DEGREE = 111_320;

function metersApart(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): number {
  const north = from.lat - to.lat;
  const east = (from.lng - to.lng) * Math.cos((from.lat * Math.PI) / 180);
  return Math.sqrt(north * north + east * east) * METERS_PER_DEGREE;
}

interface Candidate {
  doc: SearchDoc;
  source: string;
  priority: number;
}

function tokenKey(tokens: readonly string[]): string {
  return [...tokens].sort().join(" ");
}

// Fills only empty fields: a station's routes in the category slot must not become a slug.
function inherit(kept: SearchDoc, dropped: SearchDoc): void {
  kept.prominence = Math.max(kept.prominence, dropped.prominence);
  if (kept.placeIndex < 0) {
    kept.placeIndex = dropped.placeIndex;
  }
  // A neighborhood has no front door, whatever a namesake shop on its corner has.
  if (kept.kind !== "neighborhood") {
    if (kept.streetIndex < 0 && dropped.streetIndex >= 0) {
      kept.streetIndex = dropped.streetIndex;
      kept.number = dropped.number;
    }
    if (kept.category === null) {
      kept.category = dropped.category;
    }
  }
}

// Only across sources: same-source namesakes nearby are as often chain branches as duplicates.
function dedupe(candidates: readonly Candidate[]): {
  docs: SearchDoc[];
  dropped: string[];
} {
  const byName = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = tokenKey(candidate.doc.tokens);
    if (key === "") {
      continue;
    }
    const group = byName.get(key);
    if (group === undefined) {
      byName.set(key, [candidate]);
    } else {
      group.push(candidate);
    }
  }

  const duplicates = new Set<SearchDoc>();
  const dropped: string[] = [];
  for (const group of byName.values()) {
    if (
      group.length < 2 ||
      group.every((one) => one.priority === group[0].priority)
    ) {
      continue;
    }
    const ordered = [...group].sort(
      (left, right) => left.priority - right.priority,
    );
    const kept: Candidate[] = [];
    for (const candidate of ordered) {
      const winner = kept.find(
        (other) =>
          other.priority < candidate.priority &&
          metersApart(other.doc, candidate.doc) <= SAME_PLACE_METERS,
      );
      if (winner === undefined) {
        kept.push(candidate);
      } else {
        inherit(winner.doc, candidate.doc);
        duplicates.add(candidate.doc);
        dropped.push(
          `${candidate.doc.name} (${candidate.source}) for ${winner.doc.name} (${winner.source}), ` +
            `${metersApart(winner.doc, candidate.doc).toFixed(0)} m apart`,
        );
      }
    }
  }
  return {
    docs: candidates
      .filter(({ doc }) => !duplicates.has(doc))
      .map(({ doc }) => doc),
    dropped,
  };
}

export interface DocSources {
  areas?: readonly PlaceArea[];
  sets?: readonly PointSet[];
  streets?: readonly GraphStreet[];
}

export function buildDocs(
  rows: readonly PlaceRow[],
  addresses: AddressIndex,
  { areas = [], sets = [], streets = [] }: DocSources = {},
): { docs: SearchDoc[]; summary: Summary; dropped: string[] } {
  const lookup = new StreetLookup(addresses);
  const candidates: Candidate[] = [];
  const summary: Summary = {
    places: 0,
    streets: 0,
    graphStreets: 0,
    points: 0,
    duplicates: 0,
    joined: 0,
    unplaced: 0,
    bounded: 0,
    homeless: 0,
    untokenized: 0,
    longNames: 0,
  };
  const boroughOf = (at: { lat: number; lng: number }): number =>
    areas.find(({ contains }) => contains(at))?.placeIndex ?? -1;

  for (const row of rows) {
    const street =
      row.street === null || row.houseNumber === null
        ? null
        : lookup.find(row.street, row.houseNumber, row);
    if (row.street !== null && street === null) {
      summary.unplaced += 1;
    }
    summary.places += 1;
    const tokens = [...new Set(tokenize(row.name))];
    // Unfindable, and reverse geocoding would otherwise answer a dropped pin with "?".
    if (tokens.length === 0) {
      summary.untokenized += 1;
      continue;
    }
    if (tokens.length > MAX_NAME_TOKENS) {
      summary.longNames += 1;
    }
    if (street !== null) {
      summary.joined += 1;
    }
    let placeIndex = -1;
    if (addresses.places.length > 0) {
      if (street !== null) {
        placeIndex = addresses.streetPlace[street];
      } else {
        placeIndex = boroughOf(row);
        if (placeIndex >= 0) {
          summary.bounded += 1;
        } else {
          summary.homeless += 1;
        }
      }
    }
    candidates.push({
      source: "overture",
      priority: OVERTURE_PRIORITY,
      doc: {
        name: row.name,
        kind: "place",
        tokens,
        lat: row.lat,
        lng: row.lng,
        prominence: prominenceOf(row.category, row.houseNumber !== null),
        category: row.category,
        placeIndex,
        streetIndex: street ?? -1,
        number: street === null ? null : row.houseNumber,
      },
    });
  }

  for (const set of sets) {
    for (const point of set.points) {
      const tokens = [...new Set(tokenize(point.name))];
      if (tokens.length === 0) {
        continue;
      }
      summary.points += 1;
      candidates.push({
        source: set.source,
        priority: set.priority,
        doc: {
          name: point.name,
          kind: set.kind,
          tokens,
          lat: point.lat,
          lng: point.lng,
          prominence: set.prominence,
          category: point.detail ?? null,
          placeIndex: boroughOf(point),
          streetIndex: -1,
          number: null,
        },
      });
    }
  }

  for (const street of streetDocs(addresses)) {
    summary.streets += 1;
    candidates.push({
      source: "addresses",
      priority: CURATED_PRIORITY,
      doc: {
        name: street.name,
        kind: "street",
        tokens: street.tokens,
        lat: street.lat,
        lng: street.lng,
        prominence: STREET_PROMINENCE,
        category: null,
        placeIndex: street.placeIndex,
        streetIndex: street.street,
        number: null,
      },
    });
  }

  for (const street of streets) {
    summary.graphStreets += 1;
    candidates.push({
      source: "graph",
      priority: CURATED_PRIORITY,
      doc: {
        name: street.name,
        kind: "street",
        tokens: street.tokens,
        lat: street.lat,
        lng: street.lng,
        prominence: STREET_PROMINENCE,
        category: null,
        placeIndex: boroughOf(street),
        streetIndex: -1,
        number: null,
      },
    });
  }

  const { docs, dropped } = dedupe(candidates);
  summary.duplicates = dropped.length;
  return { docs, summary, dropped };
}

async function buildCity(
  cityId: string,
): Promise<{ docs: SearchDoc[]; summary: Summary; dropped: string[] }> {
  const [rows, addresses, sets] = await Promise.all([
    readPlaces(cityId),
    readAddresses(cityId),
    citySets(cityId),
  ]);
  return buildDocs(rows, addresses, {
    areas: await placeAreas(cityId, addresses),
    sets,
    streets: await graphStreets(cityId, addresses),
  });
}

export async function updateSearchIndex(): Promise<void> {
  await mkdir(SEARCH_DIR, { recursive: true });
  for (const cityId of CITIES) {
    console.error(`search-index: reading ${cityId}`);
    const { docs, summary, dropped } = await buildCity(cityId);
    const encoded = encodeSearch(docs);
    const gzipped = gzipSync(encoded.bytes, {
      level: constants.Z_BEST_COMPRESSION,
    });
    await writeFile(join(SEARCH_DIR, `${cityId}.bin.gz`), gzipped);
    const megabytes = (value: number) => (value / 1e6).toFixed(2);
    for (const pair of dropped.slice(0, LOGGED_DUPLICATES)) {
      console.error(`search-index: ${cityId}: dropped ${pair}`);
    }
    console.error(
      `search-index: ${cityId}: ${encoded.docCount} docs ` +
        `(${summary.places} places, ${summary.streets} streets, ` +
        `${summary.graphStreets} the graph names and ADDR does not, ` +
        `${summary.points} curated points, ${summary.duplicates} dropped as duplicates, ` +
        `${summary.joined} at an address), ` +
        `${encoded.tokenCount} tokens, ${encoded.postingCount} postings, ` +
        `largest list ${encoded.largestList.token} ${encoded.largestList.postings}, ` +
        `${summary.unplaced} places whose street was ambiguous, ` +
        `${summary.bounded} placed by the city's boundaries, ` +
        `${summary.homeless} with no place at all, ` +
        `${summary.untokenized} names with no searchable word, ` +
        `${summary.longNames} names past ${MAX_NAME_TOKENS} words`,
    );
    console.error(
      `search-index: ${cityId}: ${megabytes(encoded.bytes.length)} MB raw ` +
        `(names ${megabytes(encoded.nameBytes)}, dictionary ${megabytes(encoded.dictBytes)}, ` +
        `postings ${megabytes(encoded.postingBytes)}), ` +
        `${megabytes(gzipped.length)} MB gzipped ` +
        `(${(gzipped.length / encoded.docCount).toFixed(1)} B/doc)`,
    );
  }
}

if (import.meta.main) {
  await updateSearchIndex();
}

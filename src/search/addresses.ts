// Reads ADDR (./address-format.ts), decoding a street's run only on demand: NYC is ~6 MB of runs.

import { prettifyStreetName } from "../routing/street-names";
import {
  type Cursor,
  readUnsignedVarint,
  readVarint,
  unzigzag,
} from "../tiles/varint";
import {
  ADDRESS_FORMAT,
  ADDRESS_MAGIC,
  COORD_SCALE,
  compareHouseNumbers,
  type HouseNumber,
  parseHouseNumber,
  unpackExtra,
} from "./address-format";

export interface Address {
  number: HouseNumber;
  lat: number;
  lng: number;
}

// In 1e-5 degree units; a street with no addresses reports the origin, an ocean from either city.
export interface StreetBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

// The last entry of `starts` is the end of the last run; streets sharing a name differ by place.
export interface AddressIndex {
  names: string[]; // prettified, which is what the search box shows
  sourceNames: string[]; // as the city publishes them, which is also how "5 Av" gets typed
  places: string[]; // empty for a city that is one place, and then no street carries one
  streetName: Uint32Array;
  streetPlace: Uint32Array;
  starts: Uint32Array;
  // Per-street address box, so reverse lookup skips streets farther than the best address found.
  minLatUnits: Int32Array;
  maxLatUnits: Int32Array;
  minLngUnits: Int32Array;
  maxLngUnits: Int32Array;
  bytes: Uint8Array;
}

function readRun(
  bytes: Uint8Array,
  cursor: Cursor,
  into: Address[] | null,
): StreetBounds {
  const count = readUnsignedVarint(bytes, cursor);
  let major = 0;
  let latUnits = 0;
  let lngUnits = 0;
  const bounds: StreetBounds = { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 };
  for (let index = 0; index < count; index += 1) {
    const packed = readUnsignedVarint(bytes, cursor);
    // The low bit says a minor number or a letter suffix rides in the next varint.
    const extra = packed % 2 === 1 ? readUnsignedVarint(bytes, cursor) : 0;
    major += unzigzag(Math.floor(packed / 2));
    latUnits += readVarint(bytes, cursor);
    lngUnits += readVarint(bytes, cursor);
    if (index === 0) {
      bounds.minLat = latUnits;
      bounds.maxLat = latUnits;
      bounds.minLng = lngUnits;
      bounds.maxLng = lngUnits;
    } else {
      bounds.minLat = Math.min(bounds.minLat, latUnits);
      bounds.maxLat = Math.max(bounds.maxLat, latUnits);
      bounds.minLng = Math.min(bounds.minLng, lngUnits);
      bounds.maxLng = Math.max(bounds.maxLng, lngUnits);
    }
    into?.push({
      number: { major, ...unpackExtra(extra) },
      lat: latUnits / COORD_SCALE,
      lng: lngUnits / COORD_SCALE,
    });
  }
  return bounds;
}

// Empty is no entries, not one empty string.
function readBlob(bytes: Uint8Array, cursor: Cursor): string[] {
  const length = readUnsignedVarint(bytes, cursor);
  const text = new TextDecoder().decode(
    bytes.subarray(cursor.offset, cursor.offset + length),
  );
  cursor.offset += length;
  return text === "" ? [] : text.split("\n");
}

export function decodeAddresses(bytes: Uint8Array): AddressIndex {
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== ADDRESS_MAGIC || bytes[4] !== ADDRESS_FORMAT) {
    throw new Error(`not a v${ADDRESS_FORMAT} address file`);
  }
  const cursor: Cursor = { offset: ADDRESS_MAGIC.length + 1 };
  const sourceNames = readBlob(bytes, cursor);
  const names = sourceNames.map(prettifyStreetName);
  const places = readBlob(bytes, cursor);
  const streetCount = readUnsignedVarint(bytes, cursor);
  const streetName = new Uint32Array(streetCount);
  const streetPlace = new Uint32Array(streetCount);
  const starts = new Uint32Array(streetCount + 1);
  const minLatUnits = new Int32Array(streetCount);
  const maxLatUnits = new Int32Array(streetCount);
  const minLngUnits = new Int32Array(streetCount);
  const maxLngUnits = new Int32Array(streetCount);
  for (let street = 0; street < streetCount; street += 1) {
    streetName[street] = readUnsignedVarint(bytes, cursor);
    streetPlace[street] = readUnsignedVarint(bytes, cursor);
    starts[street] = cursor.offset;
    const bounds = readRun(bytes, cursor, null);
    minLatUnits[street] = bounds.minLat;
    maxLatUnits[street] = bounds.maxLat;
    minLngUnits[street] = bounds.minLng;
    maxLngUnits[street] = bounds.maxLng;
  }
  starts[streetCount] = cursor.offset;
  return {
    names,
    sourceNames,
    places,
    streetName,
    streetPlace,
    starts,
    minLatUnits,
    maxLatUnits,
    minLngUnits,
    maxLngUnits,
    bytes,
  };
}

export function streetAddresses(
  index: AddressIndex,
  street: number,
): Address[] {
  const addresses: Address[] = [];
  readRun(index.bytes, { offset: index.starts[street] }, addresses);
  return addresses;
}

export interface AddressQuery {
  number: HouseNumber;
  street: string;
}

// The number must be one token: "269 B Street" is house 269 on B Street, not 269B on "Street".
const ADDRESS_QUERY = /^([0-9]{1,7}(?:-[0-9]{1,4})?[A-Za-z]?)\s+(.+)$/;

export function parseAddressQuery(query: string): AddressQuery | null {
  const match = ADDRESS_QUERY.exec(query.trim());
  if (match === null) {
    return null;
  }
  const number = parseHouseNumber(match[1]);
  return number === null ? null : { number, street: match[2].trim() };
}

// Queens' block number dominates: 12-34 and 12-36 are neighbors, 12-34 and 13-02 are not.
const BLOCK_SPAN = 10000;

function numberKey({ major, minor }: HouseNumber): number {
  return major * BLOCK_SPAN + minor;
}

function numberDistance(left: HouseNumber, right: HouseNumber): number {
  return Math.abs(numberKey(left) - numberKey(right));
}

// The exact number or the nearer neighbor; past either end is null: 9999 Broadway isn't at its top.
export function findNumber(
  addresses: readonly Address[],
  wanted: HouseNumber,
): { address: Address; exact: boolean } | null {
  let below: Address | null = null;
  let above: Address | null = null;
  for (const address of addresses) {
    const order = compareHouseNumbers(address.number, wanted);
    if (order === 0) {
      return { address, exact: true };
    } else if (order < 0) {
      below = address;
    } else {
      above = address;
      break;
    }
  }
  if (below === null || above === null) {
    return null;
  } else {
    const nearer =
      numberDistance(below.number, wanted) <=
      numberDistance(above.number, wanted)
        ? below
        : above;
    return { address: nearer, exact: false };
  }
}

// Takes an absolute URL, since in the worker a relative one resolves against the worker's chunk.
export async function fetchAddresses(url: string): Promise<AddressIndex> {
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`${url}: ${response.status} ${response.statusText}`);
  }
  // Gzipped because Pages serves .bin uncompressed.
  const unpacked = response.body.pipeThrough(new DecompressionStream("gzip"));
  const bytes = await new Response(unpacked).arrayBuffer();
  return decodeAddresses(new Uint8Array(bytes));
}

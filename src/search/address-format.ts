// ADDR: every street address from NYC AddressPoint (uf93-f8nk) and SF EAS (ramy-di5m), ~3 bytes each.
// Gzipped because Pages serves .bin uncompressed. Layout, LEB128 varints unless stated:
//
//   "ADDR"                      magic, 4 bytes
//   format                      1 byte
//   nameBytes                   length of the name blob
//   <names>                     street names, "\n"-joined, UTF-8, ascending
//   placeBytes                  length of the place blob
//   <places>                    "\n"-joined; empty for a one-place city, where every placeIndex is 0
//   streetCount
//   per street, ordered by (name, place):
//     nameIndex                 into <names>
//     placeIndex                into <places>
//     count                     addresses on the street
//     per address, ascending by house number:
//       number                  (zigzag(majorDelta) << 1) | hasExtra
//       extra                   only when hasExtra: minor * 32 + suffix
//       latDelta                zigzag, units of 1e-5 degrees
//       lngDelta                zigzag
//
// Deltas reset per street, so a query decodes only the street it names.
// A street is a name and a place: NYC has five Court Streets, and merging them would silently pick one.
// `minor` is Queens' hyphen ("12-34"), `suffix` SF's letter ("269B"); most addresses have neither.

export const ADDRESS_MAGIC = "ADDR";
export const ADDRESS_FORMAT = 1;

// 1.1 m north-south, 0.85 m across at these latitudes; finer would record noise the sources lack.
export const COORD_SCALE = 1e5;

export const MINOR_SCALE = 32;

export interface HouseNumber {
  major: number;
  minor: number; // 0 where the address has no hyphen
  suffix: number; // 0 none, 1-26 for A-Z
}

export function formatHouseNumber({
  major,
  minor,
  suffix,
}: HouseNumber): string {
  const digits = minor > 0 ? `${major}-${minor}` : String(major);
  return suffix > 0 ? `${digits}${String.fromCharCode(64 + suffix)}` : digits;
}

export function parseHouseNumber(text: string): HouseNumber | null {
  const match = /^([0-9]{1,7})(?:\s*-\s*([0-9]{1,4}))?\s*([A-Za-z])?$/.exec(
    text.trim(),
  );
  if (match === null) {
    return null;
  } else {
    return {
      major: Number(match[1]),
      minor: match[2] === undefined ? 0 : Number(match[2]),
      suffix:
        match[3] === undefined ? 0 : match[3].toUpperCase().charCodeAt(0) - 64,
    };
  }
}

export function compareHouseNumbers(
  left: HouseNumber,
  right: HouseNumber,
): number {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.suffix - right.suffix
  );
}

export function packExtra({ minor, suffix }: HouseNumber): number {
  return minor * MINOR_SCALE + suffix;
}

export function unpackExtra(extra: number): { minor: number; suffix: number } {
  return {
    minor: Math.floor(extra / MINOR_SCALE),
    suffix: extra % MINOR_SCALE,
  };
}

// Keyed by the `boroughcode` in NYC's address file.
export const NYC_BOROUGHS: Readonly<Record<string, string>> = {
  "1": "Manhattan",
  "2": "Bronx",
  "3": "Brooklyn",
  "4": "Queens",
  "5": "Staten Island",
};

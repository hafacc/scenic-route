// SRCH: every name in a city, for offline search; gzipped because Pages serves .bin uncompressed.
// Addresses are excluded to keep postings small: a street is one doc, numbers come from its ADDR run.
// Layout, LEB128 varints unless stated:
//
//   "SRCH"                      magic, 4 bytes
//   format                      1 byte
//   categoryBytes               length of the category blob
//   <categories>                "\n"-joined UTF-8: a place's Overture slug, a station's routes
//   docCount
//   per doc, in Hilbert order over its quantized coordinates:
//     nameLen                   the display name, UTF-8, original case and punctuation
//     <name>
//     kindFlags                 1 byte: kind (low 4 bits) | hasStreet (0x10) | hasNumber (0x20)
//     tokenInfo                 1 byte: display-name words ≤ 15 (high 4) | ADDR place + 1 or 0 (low 4)
//     prominence                1 byte, how much a name outranks another on an equal match
//     category                  index into <categories> plus one; 0 where the doc has none
//     latDelta, lngDelta        zigzag, units of 1e-5°, from the previous doc
//     streetIndex               only when hasStreet: ordinal into the ADDR street table
//     number                    only when hasNumber: major * 2 + hasExtra
//     extra                     only when `number`'s low bit is set: minor * 32 + suffix, as in ADDR
//   tokenCount
//   dictBytes                   length of the token entries, which locates the postings behind them
//   restartCount                ceil(tokenCount / 16)
//   per restart, fixed width, u32 LE x 2:
//     dictOffset                the block's first entry, from the start of the token entries
//     postingsOffset            that entry's posting list, from the start of the postings region
//   per token, sorted bytewise, front-coded in blocks of 16:
//     lcp                       bytes shared with the predecessor; 0 at a block start
//     tailLen
//     <tail>                    UTF-8 bytes after the shared prefix
//     postingCount              documents carrying the token
//     postingBytes              the list's length, so a list can be skipped undecoded
//   per token, concatenated in dictionary order:
//     <postings>                ascending doc ids, delta varints, the first absolute
//
// Documents are in Hilbert order only so coordinate deltas are small; queries don't depend on it.
// No positions or payloads: match quality comes from which token matched, known before postings.

export const SEARCH_MAGIC = "SRCH";
export const SEARCH_FORMAT = 1;

// Imported so pins from this file and from ADDR land on the same grid.
export { COORD_SCALE } from "./address-format";

// Sixteen trades the restart table (8 bytes a block) against the decode per hit (≤ 16 entries).
export const DICT_BLOCK = 16;
export const RESTART_BYTES = 8;

// Longer names count as 15, which only blunts the coverage term.
export const MAX_NAME_TOKENS = 15;

// Stored as an index in the low nibble of `kindFlags`, so the order is frozen; append only.
export const DOC_KINDS = [
  "place",
  "street",
  "station",
  "landmark",
  "art",
  "historic-district",
  "legacy-business",
  "neighborhood",
] as const;

export type DocKind = (typeof DOC_KINDS)[number];

export const KIND_MASK = 0x0f;
// The document names an ADDR street, and `streetIndex` follows.
export const HAS_STREET = 0x10;
// The ADDR number pair follows; a street doc has only an ordinal, a graph-only street neither.
export const HAS_NUMBER = 0x20;

export function packKindFlags(
  kind: DocKind,
  hasStreet: boolean,
  hasNumber: boolean,
): number {
  return (
    DOC_KINDS.indexOf(kind) |
    (hasStreet ? HAS_STREET : 0) |
    (hasNumber ? HAS_NUMBER : 0)
  );
}

export function unpackKind(kindFlags: number): DocKind {
  return DOC_KINDS[kindFlags & KIND_MASK];
}

// Zero in the low nibble means no place, leaving 15.
export const MAX_PLACES = 15;

export function packTokenInfo(tokenCount: number, placeIndex: number): number {
  return Math.min(tokenCount, MAX_NAME_TOKENS) * 16 + (placeIndex + 1);
}

export function unpackTokenInfo(tokenInfo: number): {
  tokenCount: number;
  placeIndex: number; // -1 where the document has none
} {
  return {
    tokenCount: Math.floor(tokenInfo / 16),
    placeIndex: (tokenInfo % 16) - 1,
  };
}

// Stripped, not split on: splitting "Joe's" would make `s` the largest posting list in the corpus.
const APOSTROPHES = /['‘’ʼ`]/gu;
const COMBINING_MARKS = /\p{M}/gu;
const SEPARATORS = /[^\p{L}\p{N}]+/gu;

// Builder and client share this and must never diverge, or names become unfindable.
export function normalizeText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(APOSTROPHES, "")
    .toLowerCase();
}

export function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(SEPARATORS)
    .filter((token) => token !== "");
}

const CARDINALS = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];

const ORDINALS = [
  "",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
];

const TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];

const TEN_ORDINALS = [
  "",
  "",
  "twentieth",
  "thirtieth",
  "fortieth",
  "fiftieth",
  "sixtieth",
  "seventieth",
  "eightieth",
  "ninetieth",
];

// The highest numbered street either city has, plus room: New York files a West 271st.
export const MAX_ORDINAL = 999;

// Streets are indexed spelled out too, since sources write "5 AV", "5th Avenue" and "Fifth Avenue".
export function ordinalWords(value: number): string[] {
  if (!Number.isInteger(value) || value < 1 || value > MAX_ORDINAL) {
    return [];
  }
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  const words: string[] = [];
  if (hundreds > 0) {
    words.push(CARDINALS[hundreds], rest === 0 ? "hundredth" : "hundred");
  }
  if (rest > 0 && rest < 20) {
    words.push(ORDINALS[rest]);
  } else if (rest >= 20) {
    const tens = Math.floor(rest / 10);
    const unit = rest % 10;
    if (unit === 0) {
      words.push(TEN_ORDINALS[tens]);
    } else {
      words.push(TENS[tens], ORDINALS[unit]);
    }
  }
  return words;
}

// Suffix optional: ADDR writes "5 AV", display names "5th Avenue".
const NUMBERED_WORD = /^([0-9]+)(?:st|nd|rd|th)?$/u;

export function ordinalValue(word: string): number | null {
  const digits = NUMBERED_WORD.exec(word);
  return digits === null ? null : Number(digits[1]);
}

// A name with its numbers spelled out, or null if none; the query side uses it to tell 5th from 55th.
export function spelledOrdinals(words: readonly string[]): string[] | null {
  const spelled: string[] = [];
  let numbered = false;
  for (const word of words) {
    const value = ordinalValue(word);
    const asWords = value === null ? [] : ordinalWords(value);
    if (asWords.length === 0) {
      spelled.push(word);
    } else {
      spelled.push(...asWords);
      numbered = true;
    }
  }
  return numbered ? spelled : null;
}

// The dictionary's sort order; UTF-8 byte order matches code point order.
export function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return left.length - right.length;
}

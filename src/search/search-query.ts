// Queries the SRCH index (./search-format.ts); pure, so its worker is only a message loop around it.

import { type Cursor, readUnsignedVarint, unzigzag } from "../tiles/varint";
import {
  COORD_SCALE,
  formatHouseNumber,
  type HouseNumber,
  unpackExtra,
} from "./address-format";
import {
  type AddressIndex,
  type AddressQuery,
  findNumber,
  parseAddressQuery,
  streetAddresses,
} from "./addresses";
import {
  blockToken,
  dictCursorAt,
  dictToken,
  fuzzyMatches,
  maxEditDistance,
  reachesWithinEdits,
  stepDict,
} from "./dictionary";
import {
  compareBytes,
  type DocKind,
  HAS_NUMBER,
  HAS_STREET,
  MAX_NAME_TOKENS,
  MAX_PLACES,
  RESTART_BYTES,
  SEARCH_FORMAT,
  SEARCH_MAGIC,
  spelledOrdinals,
  tokenize,
  unpackKind,
  unpackTokenInfo,
} from "./search-format";

// One letter of a name matches half a city.
export const MIN_QUERY_CHARS = 2;

// Past eight the intersection is already tiny; eight is also the width of the per-document byte mask.
const MAX_QUERY_TOKENS = 8;

export const DEFAULT_LIMIT = 20;

// Names are decoded only for this pool, where the order bonuses can still reorder it.
const POOL_FACTOR = 4;
// Wider after a correction, whose matches may double up on one name word the cheap order can't see.
const FUZZY_POOL_FACTOR = 4;

// Fixed-point so quality fits a Uint16Array: eight tokens at 1.0 is 8,000.
const QUALITY_SCALE = 1000;

const EXACT_QUALITY = 1;
// A prefix of the word being typed scores higher the more of the word it covers.
const PREFIX_FLOOR = 0.8;
const PREFIX_SPAN = 0.2;
// A prefix of an earlier word was left unfinished or mistyped, so it counts for less.
const INNER_PREFIX_QUALITY = 0.7;
// What a result keeps when one query word is in neither its name nor its street.
const RELAXED_PENALTY = 0.4;
// A word answered by the street a place is on: below any name match, above the relaxation.
const STREET_QUALITY = 0.6;

// Small so "Joe's Pizza" beats a longer name without the longer one becoming unfindable.
const COVERAGE_EXPONENT = 0.3;
const FIRST_WORD_BONUS = 1.1;
const WHOLE_NAME_BONUS = 1.15;

// Prominence spans 3.3:1 so a station outranks a nail salon on an equal match without hiding it.
const PROMINENCE_FLOOR = 0.3;
const PROMINENCE_SPAN = 0.7;
const PROMINENCE_MAX = 255;

// Distance spans 4:1, wider than any text penalty; the floor keeps a unique far-off name findable.
const DISTANCE_FLOOR = 0.25;
const DISTANCE_SPAN = 0.75;
const DISTANCE_SCALE_METERS = 1500;

// For something named exactly (a house number, a whole area name): 1.6:1, to order but not hide.
const NAMED_DISTANCE_FLOOR = 0.6;
const NAMED_DISTANCE_SPAN = 0.4;

// Filed at one point standing in for an area, so distance to that point is loose.
const AREA_KINDS: ReadonlySet<DocKind> = new Set(["street", "neighborhood"]);

// A bare street or neighborhood name wants the area, not the places named after it.
const WHOLE_AREA_PROMINENCE = 255;

const METERS_PER_DEGREE = 111_320;

export function prominenceFactor(prominence: number): number {
  return PROMINENCE_FLOOR + (PROMINENCE_SPAN * prominence) / PROMINENCE_MAX;
}

export function distanceFactor(meters: number): number {
  return (
    DISTANCE_FLOOR + DISTANCE_SPAN * Math.exp(-meters / DISTANCE_SCALE_METERS)
  );
}

// The distance curve flattened onto the named-exactly range.
export function namedDistanceFactor(meters: number): number {
  return (
    NAMED_DISTANCE_FLOOR +
    (NAMED_DISTANCE_SPAN * (distanceFactor(meters) - DISTANCE_FLOOR)) /
      DISTANCE_SPAN
  );
}

// The map center: available signed out and without a permission prompt.
export interface SearchCenter {
  lat: number;
  lng: number;
}

export interface SearchHit {
  doc: number;
  kind: DocKind;
  name: string;
  lat: number;
  lng: number;
  score: number;
  // The match-quality part of the score, before prominence and distance.
  text: number;
  category: string | null;
  // Into the ADDR place blob, or -1.
  placeIndex: number;
  streetIndex: number; // into the ADDR street table, or -1
  number: HouseNumber | null;
}

// Sized once per index; `touched` makes clearing cost the documents reached, not the city.
interface Accumulators {
  // One bit per query word; also dedups several tokens under one prefix reaching one document.
  matched: Uint8Array;
  hitCount: Uint8Array;
  quality: Uint16Array;
  touched: number[];
}

export interface SearchIndex {
  bytes: Uint8Array;
  restarts: DataView; // over the fixed-width restart table, which is the only region read as u32
  categories: string[];
  docCount: number;
  nameOffset: Uint32Array;
  nameLength: Uint16Array; // bytes; the longest name either city has is 306
  kindFlags: Uint8Array;
  tokenInfo: Uint8Array;
  prominence: Uint8Array;
  category: Uint32Array;
  latUnits: Int32Array;
  lngUnits: Int32Array;
  payload: Uint32Array; // where streetIndex and the house number sit, or 0 for neither
  // Mean of each ADDR place's documents, or null; where a query ending in a borough is measured from.
  placeCenters: (SearchCenter | null)[];
  tokenCount: number;
  restartCount: number;
  restartStart: number;
  dictStart: number;
  postingsStart: number;
  accumulators: Accumulators;
}

function readBlob(bytes: Uint8Array, cursor: Cursor): string[] {
  const length = readUnsignedVarint(bytes, cursor);
  const text = new TextDecoder().decode(
    bytes.subarray(cursor.offset, cursor.offset + length),
  );
  cursor.offset += length;
  return text === "" ? [] : text.split("\n");
}

export function decodeSearchIndex(bytes: Uint8Array): SearchIndex {
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== SEARCH_MAGIC || bytes[4] !== SEARCH_FORMAT) {
    throw new Error(`not a v${SEARCH_FORMAT} search index`);
  }
  const cursor: Cursor = { offset: SEARCH_MAGIC.length + 1 };
  const categories = readBlob(bytes, cursor);
  const docCount = readUnsignedVarint(bytes, cursor);

  const nameOffset = new Uint32Array(docCount);
  const nameLength = new Uint16Array(docCount);
  const kindFlags = new Uint8Array(docCount);
  const tokenInfo = new Uint8Array(docCount);
  const prominence = new Uint8Array(docCount);
  const category = new Uint32Array(docCount);
  const latUnits = new Int32Array(docCount);
  const lngUnits = new Int32Array(docCount);
  const payload = new Uint32Array(docCount);

  const placeLat = new Array<number>(MAX_PLACES).fill(0);
  const placeLng = new Array<number>(MAX_PLACES).fill(0);
  const placeCount = new Array<number>(MAX_PLACES).fill(0);

  let lat = 0;
  let lng = 0;
  for (let doc = 0; doc < docCount; doc += 1) {
    const length = readUnsignedVarint(bytes, cursor);
    nameOffset[doc] = cursor.offset;
    nameLength[doc] = length;
    cursor.offset += length;
    const flags = bytes[cursor.offset];
    kindFlags[doc] = flags;
    tokenInfo[doc] = bytes[cursor.offset + 1];
    prominence[doc] = bytes[cursor.offset + 2];
    cursor.offset += 3;
    category[doc] = readUnsignedVarint(bytes, cursor);
    lat += unzigzag(readUnsignedVarint(bytes, cursor));
    lng += unzigzag(readUnsignedVarint(bytes, cursor));
    latUnits[doc] = lat;
    lngUnits[doc] = lng;
    const { placeIndex } = unpackTokenInfo(tokenInfo[doc]);
    if (placeIndex >= 0) {
      placeLat[placeIndex] += lat;
      placeLng[placeIndex] += lng;
      placeCount[placeIndex] += 1;
    }
    if ((flags & (HAS_STREET | HAS_NUMBER)) !== 0) {
      payload[doc] = cursor.offset;
      if ((flags & HAS_STREET) !== 0) {
        readUnsignedVarint(bytes, cursor);
      }
      if ((flags & HAS_NUMBER) !== 0) {
        const packed = readUnsignedVarint(bytes, cursor);
        if (packed % 2 === 1) {
          readUnsignedVarint(bytes, cursor);
        }
      }
    }
  }

  const tokenCount = readUnsignedVarint(bytes, cursor);
  const dictBytes = readUnsignedVarint(bytes, cursor);
  const restartCount = readUnsignedVarint(bytes, cursor);
  const restartStart = cursor.offset;
  const dictStart = restartStart + restartCount * RESTART_BYTES;

  return {
    bytes,
    restarts: new DataView(
      bytes.buffer,
      bytes.byteOffset + restartStart,
      restartCount * RESTART_BYTES,
    ),
    categories,
    docCount,
    nameOffset,
    nameLength,
    kindFlags,
    tokenInfo,
    prominence,
    category,
    latUnits,
    lngUnits,
    payload,
    tokenCount,
    restartCount,
    restartStart,
    dictStart,
    postingsStart: dictStart + dictBytes,
    placeCenters: placeCount.map((count, place) =>
      count === 0
        ? null
        : {
            lat: placeLat[place] / count / COORD_SCALE,
            lng: placeLng[place] / count / COORD_SCALE,
          },
    ),
    accumulators: {
      matched: new Uint8Array(docCount),
      hitCount: new Uint8Array(docCount),
      quality: new Uint16Array(docCount),
      touched: [],
    },
  };
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function docName(index: SearchIndex, doc: number): string {
  const start = index.nameOffset[doc];
  return decoder.decode(
    index.bytes.subarray(start, start + index.nameLength[doc]),
  );
}

// Decoded only for shown results; most documents have neither, hence an offset not two arrays.
function docPayload(
  index: SearchIndex,
  doc: number,
): { streetIndex: number; number: HouseNumber | null } {
  const flags = index.kindFlags[doc];
  const offset = index.payload[doc];
  if (offset === 0) {
    return { streetIndex: -1, number: null };
  }
  const cursor: Cursor = { offset };
  const streetIndex =
    (flags & HAS_STREET) === 0 ? -1 : readUnsignedVarint(index.bytes, cursor);
  if ((flags & HAS_NUMBER) === 0) {
    return { streetIndex, number: null };
  } else {
    const packed = readUnsignedVarint(index.bytes, cursor);
    const extra =
      packed % 2 === 1 ? readUnsignedVarint(index.bytes, cursor) : 0;
    return {
      streetIndex,
      number: { major: Math.floor(packed / 2), ...unpackExtra(extra) },
    };
  }
}

// Just the street ordinal, for every document the street link checks, without decoding the number.
function docStreetIndex(index: SearchIndex, doc: number): number {
  const offset = index.payload[doc];
  if (offset === 0 || (index.kindFlags[doc] & HAS_STREET) === 0) {
    return -1;
  } else {
    return readUnsignedVarint(index.bytes, { offset });
  }
}

function compareToPrefix(
  token: Uint8Array,
  length: number,
  prefix: Uint8Array,
): number {
  const shared = Math.min(length, prefix.length);
  for (let at = 0; at < shared; at += 1) {
    if (token[at] !== prefix[at]) {
      return token[at] - prefix[at];
    }
  }
  return length < prefix.length ? -1 : 0;
}

interface Match {
  postings: number;
  postingCount: number;
  quality: number;
}

// `edits` is zero until the fuzzy pass runs, and for words too short for it.
interface QueryWord {
  text: string;
  bytes: Uint8Array;
  // Fixed per word, so the fuzzy pass lands on the bit the first pass used.
  mark: number;
  last: boolean;
  edits: number;
  matches: Match[];
}

// The tokens carrying a prefix are a contiguous run; only the block the search lands in is decoded.
function expand(
  index: SearchIndex,
  prefix: Uint8Array,
  last: boolean,
): Match[] {
  let block = 0;
  let low = 0;
  let high = index.restartCount - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    // Strictly less: the entry before a block that starts with the prefix can carry it too.
    if (compareBytes(blockToken(index, middle), prefix) < 0) {
      block = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const matches: Match[] = [];
  const cursor = dictCursorAt(index, block);
  while (stepDict(index, cursor)) {
    dictToken(index, cursor);
    const order = compareToPrefix(cursor.token, cursor.length, prefix);
    if (order > 0) {
      break;
    } else if (order === 0) {
      const exact = cursor.length === prefix.length;
      matches.push({
        postings: cursor.posting,
        postingCount: cursor.postingCount,
        quality: exact
          ? EXACT_QUALITY
          : last
            ? PREFIX_FLOOR + (PREFIX_SPAN * prefix.length) / cursor.length
            : INNER_PREFIX_QUALITY,
      });
    }
  }
  // Descending, so the first posting to reach a document is its best from this query token.
  return matches.sort((left, right) => right.quality - left.quality);
}

export interface SearchRequest {
  text: string;
  center: SearchCenter;
  limit?: number;
  // Which kinds may be answers; every kind is still matched, since the street link reads streets.
  kinds?: readonly DocKind[];
}

interface Ranked {
  doc: number;
  score: number;
}

interface Candidate extends Ranked {
  // Snapshots of the accumulators, which are cleared before the pool is rescored.
  quality: number;
  named: number;
  linked: number;
  // Meters, not a factor: the rescore may move a street from the flat curve to the ordinary one.
  meters: number;
}

function metersBetween(at: SearchCenter, center: SearchCenter): number {
  const north = at.lat - center.lat;
  const east = (at.lng - center.lng) * Math.cos((center.lat * Math.PI) / 180);
  return Math.sqrt(north * north + east * east) * METERS_PER_DEGREE;
}

function metersFrom(
  index: SearchIndex,
  doc: number,
  center: SearchCenter,
): number {
  return metersBetween(
    {
      lat: index.latUnits[doc] / COORD_SCALE,
      lng: index.lngUnits[doc] / COORD_SCALE,
    },
    center,
  );
}

function betterThan(index: SearchIndex, left: Ranked, right: Ranked): number {
  return (
    right.score - left.score ||
    index.prominence[right.doc] - index.prominence[left.doc] ||
    index.nameLength[left.doc] - index.nameLength[right.doc] ||
    left.doc - right.doc
  );
}

// Past the cap keep the longest words, and always the last, which is the one being typed.
function queryTokens(text: string): string[] {
  const tokens = tokenize(text);
  if (tokens.length <= MAX_QUERY_TOKENS) {
    return tokens;
  }
  const last = tokens[tokens.length - 1];
  const rest = tokens
    .slice(0, -1)
    .sort((left, right) => right.length - left.length)
    .slice(0, MAX_QUERY_TOKENS - 1);
  return [...rest, last];
}

// Places whose missing query words their street matched, and how many: "Katz's Deli E Houston St".
function streetLinked(
  index: SearchIndex,
  tokenCount: number,
  everyToken: number,
): Map<number, number> {
  const linked = new Map<number, number>();
  if (tokenCount < 2) {
    return linked; // one word cannot be split between a name and a street
  }
  const { matched, touched } = index.accumulators;
  const streets = new Map<number, number>();
  for (const doc of touched) {
    if (unpackKind(index.kindFlags[doc]) === "street") {
      if (matched[doc] === everyToken) {
        // The query was a street name; lending it to every shop on the street would bury the street.
        return linked;
      }
      const street = docStreetIndex(index, doc);
      if (street >= 0) {
        streets.set(street, (streets.get(street) ?? 0) | matched[doc]);
      }
    }
  }
  if (streets.size === 0) {
    return linked;
  }
  for (const doc of touched) {
    if (matched[doc] === everyToken) {
      continue; // the name answered the whole query on its own
    }
    const street = streets.get(docStreetIndex(index, doc));
    if (street !== undefined && (matched[doc] | street) === everyToken) {
      let words = 0;
      for (let rest = everyToken & ~matched[doc]; rest !== 0; rest >>= 1) {
        words += rest & 1;
      }
      linked.set(doc, words);
    }
  }
  return linked;
}

function textScore(
  quality: number, // summed over the query's words, each at the best it matched
  named: number, // query words the name answered
  linked: number, // query words the street the document sits on answered
  queryWords: number,
  nameWords: number,
): number {
  const coverage = Math.min(1, named / Math.max(nameWords, 1));
  return (
    ((quality + linked * STREET_QUALITY) / queryWords) *
    coverage ** COVERAGE_EXPONENT *
    (named + linked === queryWords ? 1 : RELAXED_PENALTY)
  );
}

// Every query word on a distinct name word, from the first, only the last a prefix (5th Av vs 57th).
// Before names are decoded it can only overstate, which is the side the pool must err on.
function namedWholeArea(
  kind: DocKind,
  named: number,
  quality: number, // summed over the query's words, each at the best it matched
  leads: boolean,
  queryWords: number,
  nameWords: number,
): boolean {
  return (
    AREA_KINDS.has(kind) &&
    named === queryWords &&
    named === nameWords &&
    leads &&
    quality >= (queryWords - 1) * EXACT_QUALITY + PREFIX_FLOOR
  );
}

function placeFactor(
  index: SearchIndex,
  doc: number,
  meters: number,
  wholeArea: boolean,
): number {
  return wholeArea
    ? prominenceFactor(WHOLE_AREA_PROMINENCE) * namedDistanceFactor(meters)
    : prominenceFactor(index.prominence[doc]) * distanceFactor(meters);
}

// Streets also read spelled out, as indexed, so "fifth avenue" names all of 5th Ave but not 55th Ave.
function spellingsOf(kind: DocKind, name: string): string[][] {
  const words = tokenize(name);
  const spelled = kind === "street" ? spelledOrdinals(words) : null;
  return spelled === null ? [words] : [words, spelled];
}

// Query words that only matched a name word another query word claimed ("shake sh" on "Shake Top").
// Kuhn's augmenting-path matching over the decoded name, since the index stores no word positions.
function doubledWords(
  queryWords: readonly QueryWord[],
  nameWords: readonly string[],
): number {
  const encoded = new Array<Uint8Array | null>(nameWords.length).fill(null);
  // The dictionary's rule, fuzzy included; else a corrected word claims nothing and doubling returns.
  const reaches = (word: number, name: number): boolean => {
    if (nameWords[name].startsWith(queryWords[word].text)) {
      return true;
    } else if (queryWords[word].edits === 0) {
      return false;
    } else {
      encoded[name] ??= encoder.encode(nameWords[name]);
      return reachesWithinEdits(
        queryWords[word].bytes,
        encoded[name] as Uint8Array,
        queryWords[word].edits,
      );
    }
  };
  const takenBy = new Array<number>(nameWords.length).fill(-1);
  const walked = new Array<boolean>(nameWords.length).fill(false);
  const claim = (word: number): boolean => {
    for (let name = 0; name < nameWords.length; name += 1) {
      if (walked[name] || !reaches(word, name)) {
        continue;
      }
      walked[name] = true;
      if (takenBy[name] === -1 || claim(takenBy[name])) {
        takenBy[name] = word;
        return true;
      }
    }
    return false;
  };

  let reached = 0;
  let paired = 0;
  for (let word = 0; word < queryWords.length; word += 1) {
    if (!nameWords.some((_, name) => reaches(word, name))) {
      continue; // this word is answered by something other than the name, or by nothing
    }
    reached += 1;
    walked.fill(false);
    if (claim(word)) {
      paired += 1;
    }
  }
  return reached - paired;
}

// Misspellings scale the would-be prefix quality down, so they only add answers below correct ones.
const EDIT_PENALTY = [1, 0.55, 0.3];

// Tokens within an edit or two; zero-edit hits are prefix matches `expand` already returned.
function fuzzyExpand(
  index: SearchIndex,
  token: Uint8Array,
  last: boolean,
  distance: number,
): Match[] {
  const matches: Match[] = [];
  for (const near of fuzzyMatches(index, token, distance)) {
    if (near.distance === 0) {
      continue;
    }
    matches.push({
      postings: near.postings,
      postingCount: near.postingCount,
      quality:
        (last
          ? PREFIX_FLOOR + (PREFIX_SPAN * near.matchedLength) / near.tokenLength
          : INNER_PREFIX_QUALITY) * EDIT_PENALTY[near.distance],
    });
  }
  return matches;
}

// Cheapest first, so pricier lists are walked once most documents have already failed out.
function byMass(words: readonly QueryWord[]): readonly QueryWord[] {
  return [...words].sort(
    (left, right) => postingMass(left) - postingMass(right),
  );
}

function postingMass(word: QueryWord): number {
  return word.matches.reduce((sum, match) => sum + match.postingCount, 0);
}

// Collects each document into `candidates` as it completes the query, saving a sweep afterward.
// Reruns get only corrections: a document keeps its first quality, which is its best.
function accumulate(
  index: SearchIndex,
  words: readonly QueryWord[],
  queryWords: number,
  candidates: number[],
): void {
  const { matched, hitCount, quality, touched } = index.accumulators;
  for (const word of words) {
    const mark = 1 << word.mark;
    for (const match of word.matches) {
      const cursor: Cursor = { offset: match.postings };
      const points = Math.round(match.quality * QUALITY_SCALE);
      let doc = 0;
      for (let read = 0; read < match.postingCount; read += 1) {
        doc += readUnsignedVarint(index.bytes, cursor);
        if ((matched[doc] & mark) !== 0) {
          continue;
        }
        if (matched[doc] === 0) {
          touched.push(doc);
        }
        matched[doc] |= mark;
        hitCount[doc] += 1;
        quality[doc] += points;
        if (hitCount[doc] === queryWords) {
          candidates.push(doc);
        }
      }
    }
  }
}

export function searchNames(
  index: SearchIndex,
  { text, center, limit = DEFAULT_LIMIT, kinds }: SearchRequest,
): SearchHit[] {
  const tokens = queryTokens(text);
  if (tokens.join("").length < MIN_QUERY_CHARS) {
    return [];
  }
  const wanted = kinds === undefined ? null : new Set(kinds);
  const queryWords: QueryWord[] = tokens.map((token, position) => {
    const bytes = encoder.encode(token);
    const last = position === tokens.length - 1;
    return {
      text: token,
      bytes,
      mark: position,
      last,
      edits: 0,
      matches: expand(index, bytes, last),
    };
  });

  const { matched, hitCount, quality, touched } = index.accumulators;
  const everyToken = (1 << queryWords.length) - 1;
  const candidates: number[] = [];
  accumulate(index, byMass(queryWords), tokens.length, candidates);
  // Few results, so try corrections; rerun since one can complete a document a correct word reached.
  let corrected = false;
  if (candidates.length < limit) {
    for (const word of queryWords) {
      const edits = maxEditDistance(word.bytes.length);
      // Descending, since a document keeps the first quality to reach it.
      word.matches =
        edits === 0
          ? []
          : fuzzyExpand(index, word.bytes, word.last, edits).sort(
              (left, right) => right.quality - left.quality,
            );
      if (word.matches.length > 0) {
        word.edits = edits;
        corrected = true;
      }
    }
    if (corrected) {
      accumulate(index, byMass(queryWords), tokens.length, candidates);
    }
  }
  const viaStreet = streetLinked(index, tokens.length, everyToken);
  for (const doc of viaStreet.keys()) {
    candidates.push(doc);
  }
  // Allow one missing word, which keeps "joes pizza brooklyn" answering.
  if (candidates.length < limit && tokens.length >= 2) {
    for (const doc of touched) {
      if (hitCount[doc] === tokens.length - 1 && !viaStreet.has(doc)) {
        candidates.push(doc);
      }
    }
  }

  const pool: Candidate[] = [];
  const poolSize = limit * POOL_FACTOR * (corrected ? FUZZY_POOL_FACTOR : 1);
  for (const doc of candidates) {
    if (wanted !== null && !wanted.has(unpackKind(index.kindFlags[doc]))) {
      continue;
    }
    const named = hitCount[doc];
    const linked = viaStreet.get(doc) ?? 0;
    const points = quality[doc] / QUALITY_SCALE;
    const { tokenCount } = unpackTokenInfo(index.tokenInfo[doc]);
    const meters = metersFrom(index, doc, center);
    // An upper bound, since the rescore can only lower it, so the cut never drops a real answer.
    const place = placeFactor(
      index,
      doc,
      meters,
      namedWholeArea(
        unpackKind(index.kindFlags[doc]),
        named,
        points,
        true,
        tokens.length,
        // The table counts the display name, shorter than a spelled-out street; err long.
        Math.max(tokenCount, named),
      ),
    );
    const candidate = {
      doc,
      quality: points,
      named,
      linked,
      meters,
      score:
        textScore(points, named, linked, tokens.length, tokenCount) * place,
    };
    // Bounded insertion, not a heap: most candidates fail one comparison against the worst entry.
    if (pool.length < poolSize) {
      pool.push(candidate);
    } else if (betterThan(index, candidate, pool[poolSize - 1]) < 0) {
      pool[poolSize - 1] = candidate;
    } else {
      continue;
    }
    let at = pool.length - 1;
    while (at > 0 && betterThan(index, candidate, pool[at - 1]) < 0) {
      pool[at] = pool[at - 1];
      at -= 1;
    }
    pool[at] = candidate;
  }

  for (const doc of touched) {
    matched[doc] = 0;
    hitCount[doc] = 0;
    quality[doc] = 0;
  }
  touched.length = 0;

  // The order bonuses need the decoded name, which is why they apply only to the pool.
  const typed = new Set(tokens);
  const finalists = pool.map(({ doc, quality, named, linked, meters }) => {
    const name = docName(index, doc);
    const kind = unpackKind(index.kindFlags[doc]);
    let best = { text: 0, score: 0 };
    for (const nameWords of spellingsOf(kind, name)) {
      const answered = named - doubledWords(queryWords, nameWords);
      const leads = nameWords.length > 0 && nameWords[0].startsWith(tokens[0]);
      const whole =
        nameWords.length > 0 && nameWords.every((word) => typed.has(word));
      const place = placeFactor(
        index,
        doc,
        meters,
        namedWholeArea(
          kind,
          answered,
          (quality * answered) / named,
          leads,
          tokens.length,
          nameWords.length,
        ),
      );
      // A word that doubled up takes its share of quality with it: the accumulator holds one sum.
      const text =
        textScore(
          (quality * answered) / named,
          answered,
          linked,
          tokens.length,
          Math.min(nameWords.length, MAX_NAME_TOKENS),
        ) *
        (leads ? FIRST_WORD_BONUS : 1) *
        (whole ? WHOLE_NAME_BONUS : 1);
      if (text * place > best.score) {
        best = { text, score: text * place };
      }
    }
    return { doc, name, text: best.text, score: best.score };
  });
  finalists.sort((left, right) => betterThan(index, left, right));

  return finalists.slice(0, limit).map(({ doc, name, text, score }) => {
    const { placeIndex } = unpackTokenInfo(index.tokenInfo[doc]);
    return {
      doc,
      kind: unpackKind(index.kindFlags[doc]),
      name,
      lat: index.latUnits[doc] / COORD_SCALE,
      lng: index.lngUnits[doc] / COORD_SCALE,
      score,
      text,
      category:
        index.category[doc] === 0
          ? null
          : index.categories[index.category[doc] - 1],
      placeIndex,
      ...docPayload(index, doc),
    };
  });
}

// An exact number on a fully named street tops the scale; a near miss or a prefix like "5 Av" doesn't.
const EXACT_ADDRESS_PROMINENCE = 255;
const NEAREST_ADDRESS_PROMINENCE = 60;

// "100 av" names every avenue, so cap how many streets' addresses are decoded.
const MAX_SCANNED_STREETS = 24;

// Labels are built here so callers need not hold the address file.
export interface CityHit {
  kind: DocKind;
  name: string;
  label: string; // "205 E Houston St, Manhattan", or "" where nothing places it
  lat: number;
  lng: number;
  score: number;
  category: string | null; // the Overture slug, or a station's routes
  // Whether the found number is the one asked; null when no number was asked.
  exact: boolean | null;
}

export interface CityRequest {
  text: string;
  center: SearchCenter;
  limit?: number;
}

// The door and borough under a result's name; a place with no address still gets its borough.
function labelOf(
  addresses: AddressIndex,
  hit: Pick<SearchHit, "placeIndex" | "streetIndex" | "number">,
): string {
  const parts: string[] = [];
  if (hit.streetIndex >= 0 && hit.number !== null) {
    const name = addresses.names[addresses.streetName[hit.streetIndex]];
    parts.push(`${formatHouseNumber(hit.number)} ${name}`);
  }
  const place = addresses.places[hit.placeIndex];
  if (place !== undefined) {
    parts.push(place);
  }
  return parts.join(", ");
}

// For ./reverse.ts, so a dropped pin reads exactly as the same place typed into search.
export function docLabel(
  index: SearchIndex,
  addresses: AddressIndex,
  doc: number,
): string {
  const { placeIndex } = unpackTokenInfo(index.tokenInfo[doc]);
  return labelOf(addresses, { ...docPayload(index, doc), placeIndex });
}

// A place name ending the query ("312 Court St Brooklyn") and the rest; the longest wins.
export function splitTrailingPlace(
  places: readonly string[],
  text: string,
): { text: string; placeIndex: number } | null {
  let best: { text: string; placeIndex: number; length: number } | null = null;
  for (let place = 0; place < places.length; place += 1) {
    const name = places[place];
    // Measured on the original text: Turkish İ lowercases to two code points.
    const at = text.length - name.length;
    // On a word boundary, or "Court St Islander" would match "Island".
    if (
      at <= 0 ||
      text.slice(at).toLowerCase() !== name.toLowerCase() ||
      !/[\s,]/.test(text[at - 1])
    ) {
      continue;
    }
    const rest = text.slice(0, at).replace(/[\s,]+$/, "");
    // What remains must still name something, or "Brooklyn" alone would answer from a borough center.
    if (
      rest.length >= MIN_QUERY_CHARS &&
      (best === null || name.length > best.length)
    ) {
      best = { text: rest, placeIndex: place, length: name.length };
    }
  }
  return best === null
    ? null
    : { text: best.text, placeIndex: best.placeIndex };
}

function namesWholeStreet(asked: readonly string[], street: string): boolean {
  return tokenize(street).every((word) =>
    asked.some((token) => word.startsWith(token)),
  );
}

// Answered with the number the file has, never the typed one; a number past a street's ends isn't.
function addressAnswers(
  index: SearchIndex,
  addresses: AddressIndex,
  { number, street }: AddressQuery,
  center: SearchCenter,
  limit: number,
): CityHit[] {
  const named = splitTrailingPlace(addresses.places, street);
  const text = named === null ? street : named.text;
  if (text.length < MIN_QUERY_CHARS) {
    return [];
  }
  const from =
    named === null ? center : (index.placeCenters[named.placeIndex] ?? center);
  const streets = searchNames(index, {
    text,
    center: from,
    limit: MAX_SCANNED_STREETS,
    kinds: ["street"],
  });
  const asked = tokenize(text);
  const hits: CityHit[] = [];
  for (const match of streets) {
    // No ADDR run means no number lookup, and a borough the reader named is a requirement.
    if (
      match.streetIndex < 0 ||
      (named !== null && match.placeIndex !== named.placeIndex)
    ) {
      continue;
    }
    const found = findNumber(
      streetAddresses(addresses, match.streetIndex),
      number,
    );
    // Guess a nearby number only for a fully named street: "5 Av" prefix-matches every avenue.
    const wholeStreet = namesWholeStreet(asked, match.name);
    if (found === null || (!found.exact && !wholeStreet)) {
      continue;
    }
    const { address, exact } = found;
    hits.push({
      kind: "street",
      name: `${formatHouseNumber(address.number)} ${match.name}`,
      label: addresses.places[match.placeIndex] ?? "",
      lat: address.lat,
      lng: address.lng,
      score:
        match.text *
        prominenceFactor(
          exact && wholeStreet
            ? EXACT_ADDRESS_PROMINENCE
            : NEAREST_ADDRESS_PROMINENCE,
        ) *
        namedDistanceFactor(metersBetween(address, from)),
      category: null,
      exact,
    });
    if (hits.length >= limit) {
      break;
    }
  }
  return hits;
}

// Run as typed and again without a trailing borough, measured from it; scores decide which was meant.
function nameAnswers(
  index: SearchIndex,
  addresses: AddressIndex,
  text: string,
  center: SearchCenter,
  limit: number,
): SearchHit[] {
  const direct = searchNames(index, { text, center, limit });
  const named = splitTrailingPlace(addresses.places, text);
  if (named === null) {
    return direct;
  } else {
    const nearby = searchNames(index, {
      text: named.text,
      center: index.placeCenters[named.placeIndex] ?? center,
      limit,
    });
    const best = new Map<number, SearchHit>();
    for (const hit of [...direct, ...nearby]) {
      const seen = best.get(hit.doc);
      if (seen === undefined || hit.score > seen.score) {
        best.set(hit.doc, hit);
      }
    }
    return [...best.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }
}

// House numbers and names ranked against each other by one score.
export function searchCity(
  index: SearchIndex,
  addresses: AddressIndex,
  { text, center, limit = DEFAULT_LIMIT }: CityRequest,
): CityHit[] {
  const parsed = parseAddressQuery(text);
  const doors =
    parsed === null
      ? []
      : addressAnswers(index, addresses, parsed, center, limit);
  // Names run even after an address parse: "5 Guys" is a name, and scores tell the two apart.
  const named = nameAnswers(index, addresses, text, center, limit).map(
    (hit) => ({
      kind: hit.kind,
      name: hit.name,
      label: labelOf(addresses, hit),
      lat: hit.lat,
      lng: hit.lng,
      score: hit.score,
      category: hit.category,
      exact: null,
    }),
  );
  return [...doors, ...named]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

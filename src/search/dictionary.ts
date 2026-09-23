// The front-coded dictionary is a trie on disk, so fuzzy lookup shares edit-distance rows per prefix.

import { type Cursor, readUnsignedVarint } from "../tiles/varint";
import { DICT_BLOCK, RESTART_BYTES } from "./search-format";

// Just the index's regions, so this module doesn't depend on the query code.
export interface TokenDictionary {
  bytes: Uint8Array;
  restarts: DataView; // the fixed-width restart table, the only region read as u32
  restartCount: number;
  tokenCount: number;
  dictStart: number;
  postingsStart: number;
}

// `lcp` is what the entry shares with its predecessor, which the fuzzy walk pops rows by.
export interface DictCursor {
  token: Uint8Array;
  length: number;
  lcp: number;
  tailStart: number; // where the bytes this entry does not share with the one before it are
  entry: number;
  posting: number;
  index: number;
  postingCount: number;
  postingBytes: number;
}

export function dictCursorAt(
  dictionary: TokenDictionary,
  block: number,
): DictCursor {
  const restart = block * RESTART_BYTES;
  return {
    token: new Uint8Array(64),
    length: 0,
    lcp: 0,
    tailStart: 0,
    entry: dictionary.dictStart + dictionary.restarts.getUint32(restart, true),
    posting:
      dictionary.postingsStart +
      dictionary.restarts.getUint32(restart + 4, true),
    index: block * DICT_BLOCK,
    postingCount: 0,
    postingBytes: 0,
  };
}

// Shared because the fuzzy walk steps ~100k entries; never outlives the call it is used in.
const reading: Cursor = { offset: 0 };

// False at the end; skips the previous entry's postings but does not assemble the token.
export function stepDict(
  dictionary: TokenDictionary,
  cursor: DictCursor,
): boolean {
  if (cursor.index >= dictionary.tokenCount) {
    return false;
  }
  cursor.posting += cursor.postingBytes;
  reading.offset = cursor.entry;
  const lcp = readUnsignedVarint(dictionary.bytes, reading);
  const tail = readUnsignedVarint(dictionary.bytes, reading);
  cursor.lcp = lcp;
  cursor.length = lcp + tail;
  cursor.tailStart = reading.offset;
  reading.offset += tail;
  cursor.postingCount = readUnsignedVarint(dictionary.bytes, reading);
  cursor.postingBytes = readUnsignedVarint(dictionary.bytes, reading);
  cursor.entry = reading.offset;
  cursor.index += 1;
  return true;
}

// Writes only the tail: the shared prefix is still in the buffer, even across skipped entries.
export function dictToken(
  dictionary: TokenDictionary,
  cursor: DictCursor,
): void {
  if (cursor.length > cursor.token.length) {
    const grown = new Uint8Array(cursor.length + 64);
    grown.set(cursor.token);
    cursor.token = grown;
  }
  for (let at = cursor.lcp; at < cursor.length; at += 1) {
    cursor.token[at] = dictionary.bytes[cursor.tailStart + at - cursor.lcp];
  }
}

// A block's first entry has lcp 0, so its tail is the whole token.
export function blockToken(
  dictionary: TokenDictionary,
  block: number,
): Uint8Array {
  const entry: Cursor = {
    offset:
      dictionary.dictStart +
      dictionary.restarts.getUint32(block * RESTART_BYTES, true),
  };
  readUnsignedVarint(dictionary.bytes, entry);
  const tail = readUnsignedVarint(dictionary.bytes, entry);
  return dictionary.bytes.subarray(entry.offset, entry.offset + tail);
}

// Below four letters nearly every word is one edit from another ("the": "she", "tea", "th").
export const FUZZY_MIN_LENGTH = 4;
// Two edits of a five-letter word is most of it; two of "delicatessen" is still that word.
export const FUZZY_FAR_LENGTH = 7;

// Zero means don't look.
export function maxEditDistance(length: number): number {
  if (length < FUZZY_MIN_LENGTH) {
    return 0;
  } else if (length < FUZZY_FAR_LENGTH) {
    return 1;
  } else {
    return 2;
  }
}

export interface FuzzyMatch {
  postings: number;
  postingCount: number;
  // Edits against the token's first `matchedLength` bytes; zero when it carries the word as a prefix.
  distance: number;
  // At least one.
  matchedLength: number;
  tokenLength: number;
}

// Tokens whose some prefix is within `maxDistance` edits of `query`, as the query may be unfinished.
// Edits are byte insert, delete, substitute or adjacent swap; bytes hold CJK to exact spelling.
export function fuzzyMatches(
  dictionary: TokenDictionary,
  query: Uint8Array,
  maxDistance: number,
): FuzzyMatch[] {
  const queryLength = query.length;
  // Distances clamp here: the table only has to tell within from not.
  const unreachable = maxDistance + 1;

  // Row `depth` is the query against the token's first `depth` bytes; shared prefixes are measured once.
  const rows: Int32Array[] = [new Int32Array(queryLength + 1)];
  for (let cell = 0; cell <= queryLength; cell += 1) {
    rows[0][cell] = Math.min(cell, unreachable);
  }

  const matches: FuzzyMatch[] = [];
  const cursor = dictCursorAt(dictionary, 0);
  let depth = 0;
  // Prefix lengths where the walk gave up or succeeded; entries still sharing them skip or match unread.
  let doomed = -1;
  let accepted = -1;
  let acceptedDistance = 0;

  while (stepDict(dictionary, cursor)) {
    if (accepted >= 0) {
      if (cursor.lcp >= accepted) {
        matches.push({
          postings: cursor.posting,
          postingCount: cursor.postingCount,
          distance: acceptedDistance,
          matchedLength: accepted,
          tokenLength: cursor.length,
        });
        continue;
      }
      accepted = -1;
    } else if (doomed >= 0) {
      if (cursor.lcp >= doomed) {
        continue;
      }
      doomed = -1;
    }
    // Block starts store lcp 0, so the rows are rebuilt there; at most one token in sixteen.
    depth = Math.min(depth, cursor.lcp);
    dictToken(dictionary, cursor);

    let distance = -1;
    let hopeless = false;
    while (depth < cursor.length) {
      const previous = rows[depth];
      const swapped = depth >= 1 ? rows[depth - 1] : null;
      const tokenByte = cursor.token[depth];
      const beforeByte = depth >= 1 ? cursor.token[depth - 1] : -1;
      depth += 1;
      if (rows.length === depth) {
        rows.push(new Int32Array(queryLength + 1));
      }
      const row = rows[depth];
      // Only cells within `maxDistance` of the diagonal matter: cell j of row i is ≥ |i − j|.
      const low = Math.max(1, depth - maxDistance);
      const high = Math.min(queryLength, depth + maxDistance);
      row[0] = Math.min(depth, unreachable);
      // Guard cells beside the band, which later rows read and an earlier token may have left dirty.
      if (low >= 2) {
        row[low - 1] = unreachable;
      }
      if (high < queryLength) {
        row[high + 1] = unreachable;
      }
      let best = row[0];
      for (let cell = low; cell <= high; cell += 1) {
        let value = Math.min(
          previous[cell] + 1, // a byte of the token the query does not have
          row[cell - 1] + 1, // a byte of the query the token does not have
          previous[cell - 1] + (query[cell - 1] === tokenByte ? 0 : 1), // the same byte, or one for the other
        );
        if (
          swapped !== null &&
          cell >= 2 &&
          query[cell - 1] === beforeByte &&
          query[cell - 2] === tokenByte
        ) {
          value = Math.min(value, swapped[cell - 2] + 1); // the two bytes the other way round
        }
        row[cell] = Math.min(value, unreachable);
        if (row[cell] < best) {
          best = row[cell];
        }
      }
      // The query is spent within distance, so this token and everything under it match.
      if (
        low <= queryLength &&
        high === queryLength &&
        row[queryLength] <= maxDistance
      ) {
        distance = row[queryLength];
        break;
      }
      // Rows only grow, so nothing carrying these bytes can come back.
      if (best > maxDistance) {
        hopeless = true;
        break;
      }
    }

    if (distance >= 0) {
      accepted = depth;
      acceptedDistance = distance;
      matches.push({
        postings: cursor.posting,
        postingCount: cursor.postingCount,
        distance,
        matchedLength: depth,
        tokenLength: cursor.length,
      });
    } else if (hopeless) {
      doomed = depth;
    }
  }
  return matches;
}

// The walk's rule for one pair; the two must agree, or a matched word would score as unmatched.
export function reachesWithinEdits(
  query: Uint8Array,
  token: Uint8Array,
  maxDistance: number,
): boolean {
  const unreachable = maxDistance + 1;
  const rows = [
    new Int32Array(query.length + 1),
    new Int32Array(query.length + 1),
    new Int32Array(query.length + 1),
  ];
  for (let cell = 0; cell <= query.length; cell += 1) {
    rows[0][cell] = Math.min(cell, unreachable);
  }
  if (rows[0][query.length] <= maxDistance) {
    return true;
  }
  for (let depth = 1; depth <= token.length; depth += 1) {
    const row = rows[depth % 3];
    const previous = rows[(depth + 2) % 3];
    const swapped = rows[(depth + 1) % 3];
    row[0] = Math.min(depth, unreachable);
    let best = row[0];
    for (let cell = 1; cell <= query.length; cell += 1) {
      let value = Math.min(
        previous[cell] + 1,
        row[cell - 1] + 1,
        previous[cell - 1] + (query[cell - 1] === token[depth - 1] ? 0 : 1),
      );
      if (
        depth >= 2 &&
        cell >= 2 &&
        query[cell - 1] === token[depth - 2] &&
        query[cell - 2] === token[depth - 1]
      ) {
        value = Math.min(value, swapped[cell - 2] + 1);
      }
      row[cell] = Math.min(value, unreachable);
      if (row[cell] < best) {
        best = row[cell];
      }
    }
    if (row[query.length] <= maxDistance) {
      return true;
    }
    if (best > maxDistance) {
      return false;
    }
  }
  return false;
}

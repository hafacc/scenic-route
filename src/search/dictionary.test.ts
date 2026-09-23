// The fuzzy walk (./dictionary.ts) prunes and takes whole runs, so it is checked against brute force.

import { expect, test } from "bun:test";
import { encodeSearch, type SearchDoc } from "../../scripts/search-index";
import {
  type DictCursor,
  dictToken,
  fuzzyMatches,
  maxEditDistance,
  stepDict,
} from "./dictionary";
import { decodeSearchIndex, type SearchIndex } from "./search-query";

const encoder = new TextEncoder();

// Deterministic, so a failing corpus is the same corpus next run.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function dictionaryOf(tokens: readonly string[]): SearchIndex {
  const docs: SearchDoc[] = tokens.map((token, at) => ({
    name: token,
    kind: "place",
    tokens: [token],
    lat: 40.73 + at * 1e-4,
    lng: -73.99,
    prominence: 120,
    category: null,
    placeIndex: -1,
    streetIndex: -1,
    number: null,
  }));
  return decodeSearchIndex(encodeSearch(docs).bytes);
}

// The walk reports only where a token's postings are, so that is how a match is named.
function tokensByPostings(index: SearchIndex): Map<number, string> {
  const decoder = new TextDecoder();
  const cursor: DictCursor = {
    token: new Uint8Array(64),
    length: 0,
    lcp: 0,
    tailStart: 0,
    entry: index.dictStart,
    posting: index.postingsStart,
    index: 0,
    postingCount: 0,
    postingBytes: 0,
  };
  const byPostings = new Map<number, string>();
  while (stepDict(index, cursor)) {
    dictToken(index, cursor);
    byPostings.set(
      cursor.posting,
      decoder.decode(cursor.token.subarray(0, cursor.length)),
    );
  }
  return byPostings;
}

// Restricted edit distance (no stretch edited twice), written the slow obvious way.
function editDistance(left: Uint8Array, right: Uint8Array): number {
  const table = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let row = 0; row <= left.length; row += 1) {
    table[row][0] = row;
  }
  for (let column = 0; column <= right.length; column += 1) {
    table[0][column] = column;
  }
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const same = left[row - 1] === right[column - 1] ? 0 : 1;
      let best = Math.min(
        table[row - 1][column] + 1,
        table[row][column - 1] + 1,
        table[row - 1][column - 1] + same,
      );
      if (
        row >= 2 &&
        column >= 2 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        best = Math.min(best, table[row - 2][column - 2] + 1);
      }
      table[row][column] = best;
    }
  }
  return table[left.length][right.length];
}

// At least one letter: a query shorter than the distance is within it of every word.
function bruteForce(
  query: Uint8Array,
  token: string,
  maxDistance: number,
): { matchedLength: number; distance: number } | null {
  const bytes = encoder.encode(token);
  for (let length = 1; length <= bytes.length; length += 1) {
    const distance = editDistance(query, bytes.subarray(0, length));
    if (distance <= maxDistance) {
      return { matchedLength: length, distance };
    }
  }
  return null;
}

function expectSameAsBruteForce(
  index: SearchIndex,
  tokens: readonly string[],
  query: string,
  maxDistance: number,
): void {
  const bytes = encoder.encode(query);
  const byPostings = tokensByPostings(index);
  const walked = new Map(
    fuzzyMatches(index, bytes, maxDistance).map((match) => [
      byPostings.get(match.postings) as string,
      { matchedLength: match.matchedLength, distance: match.distance },
    ]),
  );
  const expected = new Map(
    tokens
      .map((token) => [token, bruteForce(bytes, token, maxDistance)] as const)
      .filter(
        (pair): pair is [string, { matchedLength: number; distance: number }] =>
          pair[1] !== null,
      ),
  );
  expect(walked).toEqual(expected);
}

test("the walk finds exactly the words a brute-force count of edits finds", () => {
  const next = random(20260825);
  // A small alphabet makes shared prefixes and near misses dense, exercising the pruning.
  const alphabet = "abcd";
  const tokens = [
    ...new Set(
      Array.from({ length: 600 }, () => {
        const length = 1 + Math.floor(next() * 8);
        return Array.from(
          { length },
          () => alphabet[Math.floor(next() * alphabet.length)],
        ).join("");
      }),
    ),
  ].sort();
  const index = dictionaryOf(tokens);

  for (let trial = 0; trial < 120; trial += 1) {
    // Half are typos of real words; half random, to reach cases a typo never produces.
    const length = 1 + Math.floor(next() * 8);
    const query =
      next() < 0.5
        ? Array.from(
            { length },
            () => alphabet[Math.floor(next() * alphabet.length)],
          ).join("")
        : mutate(tokens[Math.floor(next() * tokens.length)], next);
    for (const maxDistance of [1, 2]) {
      expectSameAsBruteForce(index, tokens, query, maxDistance);
    }
  }
});

function mutate(token: string, next: () => number): string {
  if (token.length < 2) {
    return token;
  }
  const at = Math.floor(next() * (token.length - 1));
  const kind = Math.floor(next() * 4);
  if (kind === 0) {
    return `${token.slice(0, at)}x${token.slice(at + 1)}`;
  } else if (kind === 1) {
    return `${token.slice(0, at)}${token.slice(at + 1)}`;
  } else if (kind === 2) {
    return `${token.slice(0, at)}x${token.slice(at)}`;
  } else {
    return `${token.slice(0, at)}${token[at + 1]}${token[at]}${token.slice(at + 2)}`;
  }
}

test("a run taken on one accepted prefix crosses the front-coded blocks whole", () => {
  // Sixty tokens span four blocks, where lcp resets to zero.
  const tokens = [
    ...Array.from(
      { length: 60 },
      (_, at) => `theater${String(at).padStart(3, "0")}`,
    ),
    "zulu",
  ].sort();
  const index = dictionaryOf(tokens);
  const matches = fuzzyMatches(index, encoder.encode("theatr"), 1);
  expect(matches).toHaveLength(60);
  expect(new Set(matches.map((match) => match.distance))).toEqual(new Set([1]));
  expectSameAsBruteForce(index, tokens, "theatr", 1);
});

test("real words are reached by the ways a real word is typed wrong", () => {
  const tokens = [
    "delicatessen",
    "delicatessens",
    "pizza",
    "pizzeria",
    "brooklyn",
    "theater",
    "theatre",
    "williamsburg",
  ].sort();
  const index = dictionaryOf(tokens);
  const byPostings = tokensByPostings(index);
  const found = (query: string): string[] =>
    fuzzyMatches(index, encoder.encode(query), maxEditDistance(query.length))
      .map((match) => byPostings.get(match.postings) as string)
      .sort();

  expect(found("delicatesen")).toEqual(["delicatessen", "delicatessens"]);
  expect(found("brooklny")).toEqual(["brooklyn"]);
  expect(found("theatr")).toEqual(["theater", "theatre"]);
  expect(found("izza")).toEqual(["pizza"]);
  expect(maxEditDistance(3)).toBe(0);
});

test("the walk reports the fewest letters of a word that the query reaches", () => {
  const tokens = ["pizza", "pizzas", "pizzeria"].sort();
  const index = dictionaryOf(tokens);
  const byPostings = tokensByPostings(index);
  const matches = new Map(
    fuzzyMatches(index, encoder.encode("pizzz"), 1).map((match) => [
      byPostings.get(match.postings) as string,
      match,
    ]),
  );
  // One accepted prefix takes the whole run, but each is reported at its own length.
  expect([...matches.keys()].sort()).toEqual(tokens);
  for (const token of tokens) {
    expect(matches.get(token)?.matchedLength).toBe(4);
    expect(matches.get(token)?.distance).toBe(1);
    expect(matches.get(token)?.tokenLength).toBe(token.length);
  }
  expectSameAsBruteForce(index, tokens, "pizzz", 1);
});

test("a letter written in two bytes is measured in the bytes it is written in", () => {
  // Past normalization the walk counts bytes; a half-decoded character must never match.
  const tokens = ["cafe", "cafes", "café", "καφε", "καφές"].sort();
  const index = dictionaryOf(tokens);
  for (const query of ["cafe", "cafés", "καφε", "kaφe"]) {
    for (const maxDistance of [1, 2]) {
      expectSameAsBruteForce(index, tokens, query, maxDistance);
    }
  }
});

// Only the random-corpus property test checks that front-coding, restarts and postings all agree.

import { expect, test } from "bun:test";
import { encodeAddresses } from "../../scripts/addresses";
import {
  encodeSearch,
  type SearchDoc,
  streetTokens,
} from "../../scripts/search-index";
import { decodeAddresses } from "./addresses";
import { spelledOrdinals, tokenize } from "./search-format";
import {
  decodeSearchIndex,
  distanceFactor,
  prominenceFactor,
  type SearchIndex,
  searchCity,
  searchNames,
  splitTrailingPlace,
} from "./search-query";

// Documents sit on the center unless a test says otherwise, so distance drops out of the ordering.
const HERE = { lat: 40.73, lng: -73.99 };

const DEFAULT_PROMINENCE = 120;

function place(name: string, overrides: Partial<SearchDoc> = {}): SearchDoc {
  return {
    name,
    kind: "place",
    tokens: [...new Set(tokenize(name))],
    lat: HERE.lat,
    lng: HERE.lng,
    prominence: DEFAULT_PROMINENCE,
    category: null,
    placeIndex: -1,
    streetIndex: -1,
    number: null,
    ...overrides,
  };
}

function build(docs: readonly SearchDoc[]): SearchIndex {
  return decodeSearchIndex(encodeSearch(docs).bytes);
}

function names(
  index: SearchIndex,
  text: string,
  limit = 20,
  center = HERE,
): string[] {
  return searchNames(index, { text, center, limit }).map((hit) => hit.name);
}

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

const WORDS = [
  "joes",
  "pizza",
  "pizzeria",
  "cafe",
  "coffee",
  "bakery",
  "park",
  "playground",
  "bridge",
  "broadway",
  "court",
  "carmine",
  "bryant",
  "williamsburg",
  "atlantic",
  "avenue",
  "street",
  "corner",
  "corp",
  "company",
  "cosmetics",
  "grand",
  "central",
  "terminal",
];

test("every word of every name finds its own document, whole or as a prefix", () => {
  const next = random(20260824);
  const docs = Array.from({ length: 120 }, () => {
    const count = 1 + Math.floor(next() * 4);
    const words = Array.from(
      { length: count },
      () => WORDS[Math.floor(next() * WORDS.length)],
    );
    return place(words.join(" "), {
      lat: HERE.lat + (next() - 0.5) * 0.2,
      lng: HERE.lng + (next() - 0.5) * 0.2,
      prominence: Math.floor(next() * 256),
    });
  });
  const index = build(docs);
  // Wide enough that nothing is cut: the claim is findability, not ordering.
  const limit = docs.length * 2;
  for (const doc of docs) {
    for (const word of doc.tokens) {
      expect(names(index, word, limit)).toContain(doc.name);
      for (let length = 2; length < word.length; length += 1) {
        expect(names(index, word.slice(0, length), limit)).toContain(doc.name);
      }
    }
    expect(names(index, doc.name, limit)).toContain(doc.name);
  }
});

test("a prefix run spanning several front-coded blocks comes back whole", () => {
  // Forty-one tokens: the run starts inside one block, crosses two boundaries and stops in another.
  const docs = Array.from({ length: 41 }, (_, index) =>
    place(`alpha${String(index).padStart(3, "0")}`),
  );
  const index = build([...docs, place("beta"), place("zulu")]);
  expect(names(index, "alpha", 100)).toHaveLength(41);
  expect(names(index, "alpha007", 100)[0]).toBe("alpha007");
});

test("binary search reaches a token in the last block", () => {
  const docs = Array.from({ length: 200 }, (_, index) =>
    place(`token${String(index).padStart(3, "0")}`),
  );
  const index = build(docs);
  expect(names(index, "token199", 10)[0]).toBe("token199");
  expect(names(index, "token000", 10)[0]).toBe("token000");
});

test("a token on hundreds of documents decodes as one ascending posting list", () => {
  const docs = Array.from({ length: 300 }, (_, index) =>
    place(`common thing${String(index).padStart(3, "0")}`),
  );
  const index = build(docs);
  const found = names(index, "common", 400);
  expect(new Set(found).size).toBe(300);
});

test("two words find a document in either order, and one that matches nothing does not", () => {
  const index = build([
    place("Joes Pizza"),
    place("Pizza Palace"),
    place("Joes Bakery"),
  ]);
  expect(names(index, "joes pizza")[0]).toBe("Joes Pizza");
  expect(names(index, "pizza joes")[0]).toBe("Joes Pizza");
  expect(names(index, "joes pizza broadway")[0]).toBe("Joes Pizza");
});

test("a word the name does not contain still answers, below anything that matched them all", () => {
  const index = build([place("Joes Pizza"), place("Pizza Corner Cafe")]);
  const hits = searchNames(index, {
    text: "pizza corner",
    center: HERE,
    limit: 20,
  });
  expect(hits[0].name).toBe("Pizza Corner Cafe");
  expect(hits.map((hit) => hit.name)).toContain("Joes Pizza");
  expect(hits[0].score).toBeGreaterThan(hits[1].score);
});

test("two words of a query cannot both be answered by one word of a name", () => {
  // Both words reach the one word "Shake", which must not count as answering the whole query.
  const index = build([
    place("Shake Top DeLite", { lat: HERE.lat, lng: HERE.lng }),
    place("Shake Shack", { lat: HERE.lat + 0.02, lng: HERE.lng }),
  ]);
  expect(names(index, "shake sh")[0]).toBe("Shake Shack");
  expect(names(index, "shake sh")).toContain("Shake Top DeLite");
  expect(names(index, "shake")[0]).toBe("Shake Top DeLite");
});

test("a word may take a name word from an earlier one that has another", () => {
  // The first word could take "Shake" and starve the second; the pairing must be the best one.
  const index = build([place("Shake Shack")]);
  const hits = searchNames(index, { text: "sh shake", center: HERE, limit: 5 });
  const whole = searchNames(index, {
    text: "shake shack",
    center: HERE,
    limit: 5,
  });
  expect(hits[0].score).toBeGreaterThan(0.5 * whole[0].score);
});

test("the shorter name wins on the same words", () => {
  const index = build([
    place("Joes Pizza and Pasta Palace"),
    place("Joes Pizza"),
  ]);
  expect(names(index, "joes pizza")[0]).toBe("Joes Pizza");
});

test("a prefix scores by how much of the word it is", () => {
  const index = build([place("Pizzeria Uno"), place("Pizza")]);
  expect(names(index, "pizz")).toEqual(["Pizza", "Pizzeria Uno"]);
});

test("distance outranks prominence, and prominence breaks an equal match", () => {
  const far = { lat: HERE.lat + 0.05, lng: HERE.lng };
  const index = build([
    place("Starbucks", { lat: far.lat, lng: far.lng, prominence: 240 }),
    place("Starbucks"),
  ]);
  const hits = searchNames(index, {
    text: "starbucks",
    center: HERE,
    limit: 5,
  });
  expect(hits[0].lat).toBe(HERE.lat);

  const tie = build([
    place("Chambers Street", { prominence: 240 }),
    place("Chambers Street", { prominence: 80 }),
  ]);
  const ordered = searchNames(tie, {
    text: "chambers street",
    center: HERE,
    limit: 5,
  });
  expect(ordered[0].score).toBeGreaterThan(ordered[1].score);
});

test("the two ranking factors are monotone over their whole range", () => {
  expect(prominenceFactor(0)).toBeCloseTo(0.3, 6);
  expect(prominenceFactor(255)).toBeCloseTo(1, 6);
  expect(prominenceFactor(240)).toBeGreaterThan(prominenceFactor(120));
  expect(distanceFactor(0)).toBeCloseTo(1, 6);
  expect(distanceFactor(0)).toBeGreaterThan(distanceFactor(500));
  expect(distanceFactor(500)).toBeGreaterThan(distanceFactor(5000));
  expect(distanceFactor(1e6)).toBeCloseTo(0.25, 6);
});

test("a name is found the way it would be typed rather than the way it is spelled", () => {
  const index = build([place("Café Grumpy"), place("Joe's Coffee")]);
  expect(names(index, "cafe")).toContain("Café Grumpy");
  expect(names(index, "joes")).toContain("Joe's Coffee");
  expect(names(index, "grumpy")[0]).toBe("Café Grumpy");
});

test("one character answers nothing", () => {
  const index = build([place("Pizza")]);
  expect(names(index, "p")).toEqual([]);
  expect(names(index, " ")).toEqual([]);
});

test("the address a place sits at survives the round trip", () => {
  const index = build([
    place("Joes Pizza", {
      streetIndex: 4211,
      number: { major: 7, minor: 0, suffix: 0 },
      placeIndex: 0,
    }),
    place("Bridge Cafe", {
      streetIndex: 12,
      number: { major: 126, minor: 10, suffix: 2 },
      placeIndex: 3,
    }),
    place("Prospect Park", { kind: "street", streetIndex: 9 }),
  ]);
  const [pizza] = searchNames(index, {
    text: "joes pizza",
    center: HERE,
    limit: 1,
  });
  expect(pizza.streetIndex).toBe(4211);
  expect(pizza.number).toEqual({ major: 7, minor: 0, suffix: 0 });
  expect(pizza.placeIndex).toBe(0);

  const [bridge] = searchNames(index, {
    text: "bridge cafe",
    center: HERE,
    limit: 1,
  });
  expect(bridge.number).toEqual({ major: 126, minor: 10, suffix: 2 });
  expect(bridge.placeIndex).toBe(3);

  const [park] = searchNames(index, {
    text: "prospect",
    center: HERE,
    limit: 1,
  });
  expect(park.kind).toBe("street");
  expect(park.streetIndex).toBe(9);
  expect(park.number).toBeNull();
  expect(park.placeIndex).toBe(-1);
});

test("a category comes back as the slug it was baked from", () => {
  const index = build([
    place("Joes Pizza", { category: "pizza_restaurant" }),
    place("Washington Square Park", { category: "park" }),
    place("Bow Bridge", { kind: "street" }),
  ]);
  const hits = searchNames(index, {
    text: "bow",
    center: HERE,
    limit: 5,
  });
  expect(hits[0].category).toBeNull();
  expect(
    searchNames(index, { text: "joes", center: HERE, limit: 5 })[0].category,
  ).toBe("pizza_restaurant");
});

test("coordinates come back where the documents were, whatever order they were written in", () => {
  const docs = Array.from({ length: 60 }, (_, at) =>
    place(`spot${String(at).padStart(2, "0")}`, {
      lat: 40.5 + at * 0.007,
      lng: -74.2 + ((at * 37) % 60) * 0.008,
    }),
  );
  const index = build(docs);
  for (const doc of docs) {
    const [hit] = searchNames(index, {
      text: doc.name,
      center: HERE,
      limit: 1,
    });
    expect(hit.lat).toBeCloseTo(doc.lat, 4);
    expect(hit.lng).toBeCloseTo(doc.lng, 4);
  }
});

function street(name: string, streetIndex: number): SearchDoc {
  return place(name, { kind: "street", streetIndex, prominence: 110 });
}

test("a place is found by its name and the street it is on, which its name never says", () => {
  const index = build([
    place("Katz's Delicatessen", {
      streetIndex: 7,
      number: { major: 205, minor: 0, suffix: 0 },
    }),
    place("Houston Street Cleaners", { streetIndex: 12 }),
    street("E Houston St", 7),
    street("Grand St", 12),
  ]);
  expect(names(index, "Katz's Delicatessen E Houston St")).toEqual([
    "Katz's Delicatessen",
  ]);
  // The deli is not on Grand Street.
  expect(names(index, "Katz's Delicatessen Grand St")).toEqual([]);
});

test("the street link needs the street, not merely the words the street is made of", () => {
  const index = build([
    place("Joes Pizza", { streetIndex: 3 }),
    street("Carmine St", 3),
    street("Bleecker St", 4),
  ]);
  expect(names(index, "joes pizza carmine st")).toEqual(["Joes Pizza"]);
  expect(names(index, "joes pizza bleecker st")).toEqual([]);
});

test("a street that answers the whole query is not buried under the shops on it", () => {
  const index = build([
    place("Bedford Hall", { streetIndex: 3 }),
    place("Bedford Galleries", { streetIndex: 3 }),
    street("Bedford Avenue", 3),
  ]);
  // Every shop on Bedford Avenue can borrow "av" from it, which must not bury the street itself.
  expect(names(index, "bedford av")[0]).toBe("Bedford Avenue");
});

test("a street the query names in full leads the places that only carry its words", () => {
  const index = build([
    place("Court Street Post Office", { prominence: 200 }),
    place("Kings County Court House", { prominence: 200 }),
    street("Court Street", 3),
    street("Stable Court", 4),
  ]);
  // Stable Court has the same two words, but what was typed must start where the name does.
  expect(names(index, "court st")).toEqual([
    "Court Street",
    "Court Street Post Office",
    "Stable Court",
    "Kings County Court House",
  ]);
});

test("the avenue the query spells in full beats the one it only opens", () => {
  const index = build([
    place("5th Avenue", {
      kind: "street",
      streetIndex: 3,
      prominence: 110,
      tokens: streetTokens("5 AVE", "5th Avenue"),
    }),
    place("57th Avenue", {
      kind: "street",
      streetIndex: 4,
      prominence: 110,
      tokens: streetTokens("57 AVE", "57th Avenue"),
    }),
  ]);
  // "5" is a word of 5 AVE but only the first character of 57 AVE.
  expect(names(index, "5 av")).toEqual(["5th Avenue", "57th Avenue"]);
});

test("a name spells out the numbers in it, and only a name that has one", () => {
  expect(spelledOrdinals(["5th", "avenue"])).toEqual(["fifth", "avenue"]);
  expect(spelledOrdinals(["5", "ave"])).toEqual(["fifth", "ave"]);
  expect(spelledOrdinals(["west", "21st", "street"])).toEqual([
    "west",
    "twenty",
    "first",
    "street",
  ]);
  expect(spelledOrdinals(["court", "street"])).toBeNull();
  expect(spelledOrdinals(["10000", "street"])).toBeNull();
});

test("the place a query ends in is cut at an offset into the query itself", () => {
  expect(splitTrailingPlace(["Brooklyn"], "312 Court St Brooklyn")).toEqual({
    text: "312 Court St",
    placeIndex: 0,
  });
  // Turkish İ lowercases to two code points.
  expect(splitTrailingPlace(["Brooklyn"], "İstiklal Caddesi Brooklyn")).toEqual(
    {
      text: "İstiklal Caddesi",
      placeIndex: 0,
    },
  );
});

test("a door on a street the query only opened is not the top of the scale", () => {
  // The doorway is underfoot and the avenue is three kilometers north.
  const AVENUE_A = HERE;
  const FIFTH = { lat: HERE.lat + 0.027, lng: HERE.lng };
  const addresses = decodeAddresses(
    encodeAddresses([
      {
        street: "5 AVE",
        place: "",
        number: { major: 5, minor: 0, suffix: 0 },
        ...FIFTH,
      },
      {
        street: "AVENUE A",
        place: "",
        number: { major: 5, minor: 0, suffix: 0 },
        ...AVENUE_A,
      },
    ]).bytes,
  );
  const ordinalOf = (name: string): number =>
    addresses.streetName.findIndex(
      (nameId) => addresses.names[nameId] === name,
    );
  const index = build([
    place("5th Avenue", {
      kind: "street",
      streetIndex: ordinalOf("5th Avenue"),
      prominence: 110,
      tokens: streetTokens("5 AVE", "5th Avenue"),
      ...FIFTH,
    }),
    place("Avenue A", {
      kind: "street",
      streetIndex: ordinalOf("Avenue A"),
      prominence: 110,
      tokens: streetTokens("AVENUE A", "Avenue A"),
      ...AVENUE_A,
    }),
  ]);
  const answers = (text: string): string[] =>
    searchCity(index, addresses, { text, center: HERE, limit: 5 }).map(
      (hit) => hit.name,
    );
  expect(answers("5 Av")[0]).toBe("5th Avenue");
  expect(answers("5 Avenue A")[0]).toBe("5 Avenue A");
});

test("a neighborhood the query names is not the school named after it", () => {
  const away = { lat: HERE.lat + 0.027, lng: HERE.lng };
  const index = build([
    place("Williamsburg Montessori School", { prominence: 150 }),
    place("Williamsburg", { kind: "neighborhood", prominence: 150, ...away }),
  ]);
  // The district is 3 km off and the school underfoot, since a district is filed at its middle.
  expect(names(index, "williamsburg")[0]).toBe("Williamsburg");
});

test("a name that answered on its own outranks one that needed its street", () => {
  const index = build([
    place("Carmine Pizza", { streetIndex: 9 }),
    place("Joes Pizza", { streetIndex: 3 }),
    street("Carmine St", 3),
    street("Bleecker St", 9),
  ]);
  expect(names(index, "carmine pizza")[0]).toBe("Carmine Pizza");
});

test("the kinds a caller asks for are the only ones answered, and every kind still matches", () => {
  const index = build([
    place("Joes Pizza", { streetIndex: 3 }),
    street("Carmine St", 3),
  ]);
  expect(names(index, "carmine")).toEqual(["Carmine St"]);
  const places = searchNames(index, {
    text: "carmine",
    center: HERE,
    limit: 5,
    kinds: ["place"],
  });
  expect(places).toEqual([]);
  // Still matched, since it answers the place on it.
  const linked = searchNames(index, {
    text: "joes pizza carmine",
    center: HERE,
    limit: 5,
    kinds: ["place"],
  });
  expect(linked.map((hit) => hit.name)).toEqual(["Joes Pizza"]);
});

const BOROUGHS = decodeAddresses(
  encodeAddresses([
    {
      street: "COURT ST",
      place: "Brooklyn",
      number: { major: 312, minor: 0, suffix: 0 },
      lat: 40.688,
      lng: -73.993,
    },
    {
      street: "5 AVE",
      place: "Manhattan",
      number: { major: 350, minor: 0, suffix: 0 },
      lat: 40.748,
      lng: -73.985,
    },
  ]).bytes,
);

const BROOKLYN = { lat: 40.688, lng: -73.993 };
const MANHATTAN = { lat: 40.748, lng: -73.985 };

test("a borough named at the end of a query is where the answer is measured from", () => {
  const index = build([
    place("Joes Pizza", { ...BROOKLYN, placeIndex: 0 }),
    place("Joes Pizza", { ...MANHATTAN, placeIndex: 1 }),
  ]);
  const named = (text: string): { lat: number; lng: number } => {
    const [hit] = searchCity(index, BOROUGHS, {
      text,
      center: MANHATTAN,
      limit: 5,
    });
    return { lat: hit.lat, lng: hit.lng };
  };
  // No pizzeria is called "Brooklyn", so the word says which of the two was meant.
  expect(named("joes pizza brooklyn").lat).toBeCloseTo(BROOKLYN.lat, 3);
  expect(named("joes pizza").lat).toBeCloseTo(MANHATTAN.lat, 3);
});

test("a query that only names a borough keeps its words", () => {
  const index = build([
    place("Brooklyn Bagel", { ...MANHATTAN, placeIndex: 1 }),
    place("Bagel Shop", { ...BROOKLYN, placeIndex: 0 }),
  ]);
  // The whole text is searched too, so a name carrying the borough wins over stripping it.
  const [hit] = searchCity(index, BOROUGHS, {
    text: "brooklyn bagel",
    center: MANHATTAN,
    limit: 5,
  });
  expect(hit.name).toBe("Brooklyn Bagel");
});

test("a station is answered with the routes it serves, out of the category slot", () => {
  const index = build([
    place("14 St-Union Sq", {
      kind: "station",
      category: "4/5/6/L/N/Q/R/W",
      prominence: 240,
    }),
  ]);
  const [hit] = searchCity(index, BOROUGHS, {
    text: "union sq",
    center: HERE,
    limit: 5,
  });
  expect(hit.kind).toBe("station");
  expect(hit.category).toBe("4/5/6/L/N/Q/R/W");
  expect(hit.exact).toBeNull();
});

test("a word spelled wrong finds the name, under the one spelled right", () => {
  const index = build([
    place("Katzs Delicatessen"),
    place("Kanz Express Delicatessen"),
  ]);
  // Two edits in eleven letters, which the walk allows a word this long.
  expect(names(index, "katzs delicatesen")).toEqual([
    "Katzs Delicatessen",
    "Kanz Express Delicatessen",
  ]);
  // A match one edit away is worth a little over half of the same match spelled right.
  expect(names(index, "katzs delicatessen")[0]).toBe("Katzs Delicatessen");
});

test("a word of three letters is never corrected, a word of four is", () => {
  const index = build([place("Bath House"), place("Path House")]);
  expect(names(index, "bath")).toEqual(["Bath House", "Path House"]);
  expect(names(index, "bat")).toEqual(["Bath House"]);
});

test("a query that is already answered plentifully is not corrected", () => {
  // The fuzzy pass costs a dictionary walk, so it is skipped when enough results match outright.
  const docs = Array.from({ length: 25 }, (_, at) =>
    place(`Pizza Place ${String(at).padStart(2, "0")}`),
  );
  // Prominent enough to lead if matched at all, so its absence means the pass never ran.
  const index = build([...docs, place("Pizzo Place", { prominence: 255 })]);
  expect(names(index, "pizza place")).not.toContain("Pizzo Place");
  expect(names(index, "pizza place 07")).toContain("Pizzo Place");
});

test("a street spelled out in words is the one whose every word was spelled", () => {
  // The fully named street is 3 km off and the half-named one underfoot; only the words can win.
  const away = { lat: HERE.lat + 0.027, lng: HERE.lng };
  const index = build([
    place("5th Avenue", {
      kind: "street",
      streetIndex: 3,
      prominence: 110,
      tokens: streetTokens("5 AVE", "5th Avenue"),
      ...away,
    }),
    place("55th Avenue", {
      kind: "street",
      streetIndex: 4,
      prominence: 110,
      tokens: streetTokens("55 AVE", "55th Avenue"),
    }),
  ]);
  // 55 AVE carries `fifth` too; only the spelled-out reading shows it is two thirds named.
  expect(names(index, "fifth avenue")).toEqual(["5th Avenue", "55th Avenue"]);
  expect(names(index, "fifth ave")).toEqual(["5th Avenue", "55th Avenue"]);
  expect(names(index, "fifty fifth avenue")[0]).toBe("55th Avenue");
});

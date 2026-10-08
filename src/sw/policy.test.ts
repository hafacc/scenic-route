import { afterEach, expect, jest, test } from "bun:test";
import {
  chunked,
  contentUnit,
  coversACity,
  dropsMost,
  fileRequest,
  freshThenStored,
  isGraph,
  missRequest,
  NETWORK_WAIT_MS,
  outdated,
  pageFor,
  sameStamps,
  shadeKey,
} from "./policy";

// Paths are filed relative to the worker's scope, which in production is the origin root.
const SCOPE = "https://scenic.hafa.cc/";

test("the exported app goes in the shell store", () => {
  for (const path of [
    "",
    "index.html",
    "manifest.webmanifest",
    "explorer",
    "explorer.html",
    "_app/immutable/entry/start.abc123.js",
    // The routing worker is a content-hashed chunk too.
    "_app/immutable/workers/worker-7kq3ldz9.js",
    "icons/icon-512.png",
  ]) {
    expect(fileRequest(`${SCOPE}${path}`, SCOPE)).toEqual({
      path,
      store: "shell",
      fresh: false,
    });
  }
});

test("routing is its own store, so a shade binge cannot evict the graph", () => {
  expect(fileRequest(`${SCOPE}routing/nyc.bin`, SCOPE)?.store).toBe("routing");
  expect(fileRequest(`${SCOPE}routing/shade/nyc/12.bin`, SCOPE)?.store).toBe(
    "routing",
  );
});

test("the search files are kept with the graph, not with the evictable tiles", () => {
  expect(fileRequest(`${SCOPE}addresses/nyc.bin.gz`, SCOPE)?.store).toBe(
    "routing",
  );
  expect(fileRequest(`${SCOPE}search/nyc.bin.gz`, SCOPE)?.store).toBe(
    "routing",
  );
});

test("data the worker has never heard of still lands in the overlay store", () => {
  expect(fileRequest(`${SCOPE}some-future-layer/nyc.bin`, SCOPE)).toEqual({
    path: "some-future-layer/nyc.bin",
    store: "overlay",
    fresh: false,
  });
});

test("the worker never serves itself", () => {
  expect(fileRequest(`${SCOPE}sw.js`, SCOPE)).toBeNull();
});

test("another origin is left alone entirely", () => {
  for (const url of [
    "https://basemaps.cartocdn.com/light_all/14/4825/6162.png",
    "https://firestore.googleapis.com/v1/projects/scenic/databases",
    "https://hafa.cc/scenic-route/index.html",
  ]) {
    expect(fileRequest(url, SCOPE)).toBeNull();
  }
});

test("the daily feeds are cached, but network first", () => {
  const base = "https://raw.githubusercontent.com/hafacc/scenic-route/main";
  expect(fileRequest(`${base}/public/sheds/nyc/open.bin`, SCOPE)).toEqual({
    path: "sheds/nyc/open.bin",
    store: "routing",
    fresh: true,
  });
  expect(
    fileRequest(`${base}/public/ferry-schedule/nyc.bin`, SCOPE)?.fresh,
  ).toBe(true);
  expect(fileRequest(`${base}/README.md`, SCOPE)).toBeNull();
});

test("a query string does not become part of the path", () => {
  expect(fileRequest(`${SCOPE}trees/nyc.bin?v=3`, SCOPE)?.path).toBe(
    "trees/nyc.bin",
  );
});

test("the three shade shapes give up their city and bin", () => {
  expect(shadeKey("tiles/shade/nyc/12/16/19301/24650.webp")).toEqual({
    city: "nyc",
    bin: 12,
  });
  expect(shadeKey("tiles/tree-shade/sf/7/14/2620/6333.webp")).toEqual({
    city: "sf",
    bin: 7,
  });
  expect(shadeKey("routing/shade/nyc/57.bin")).toEqual({
    city: "nyc",
    bin: 57,
  });
});

// Filing it under a bin would let the purge delete the map it purges by.
test("the bin manifests are not themselves bins", () => {
  expect(shadeKey("tiles/shade/nyc/buckets.json")).toBeNull();
  expect(shadeKey("routing/shade/nyc/bins.json")).toBeNull();
});

test("nothing else claims to be shade", () => {
  for (const path of [
    "tiles/canopy/14/4825/6162.webp",
    "routing/nyc.bin",
    "casters/5232/6162.bin",
  ]) {
    expect(shadeKey(path)).toBeNull();
  }
});

test("a fragment does not become part of the path either", () => {
  expect(
    fileRequest(`${SCOPE}#at=40.7484,-73.9857,17&layers=shade`, SCOPE),
  ).toEqual({ path: "", store: "shell", fresh: false });
});

test("a city graph is recognizable, so eviction can leave it alone", () => {
  expect(isGraph("routing/nyc.bin")).toBe(true);
  expect(isGraph("routing/sf.bin")).toBe(true);
  expect(isGraph("routing/nyc.stranded.bin")).toBe(true); // tiny, so it shares the graph's fate
  expect(isGraph("routing/shade/nyc/12.bin")).toBe(false);
  expect(isGraph("casters/5232/6162.bin")).toBe(false);
});

const CITIES = [
  { west: -74.2555, south: 40.4968, east: -73.6995, north: 40.9155 }, // New York
  { west: -122.5141, south: 37.6655, east: -122.114, north: 37.9059 }, // the Bay Area
];

test("a basemap tile over a city is cached, under a key without its API key", () => {
  // z15 over midtown Manhattan.
  expect(
    fileRequest(
      "https://api.protomaps.com/tiles/v4/15/9649/12315.mvt?key=abc123",
      SCOPE,
      CITIES,
    ),
  ).toEqual({
    path: "tiles/v4/15/9649/12315.mvt",
    store: "overlay",
    fresh: false,
    cacheKey: "https://api.protomaps.com/tiles/v4/15/9649/12315.mvt",
  });
});

test("a basemap tile somewhere else is not cached at all", () => {
  for (const tile of [
    "15/17000/11000", // the Atlantic
    "15/5000/12000", // the Pacific
    "15/9649/12000", // upstate, north of the New York box
  ]) {
    expect(
      fileRequest(
        `https://api.protomaps.com/tiles/v4/${tile}.mvt?key=abc123`,
        SCOPE,
        CITIES,
      ),
    ).toBeNull();
  }
});

test("a low-zoom tile that merely covers a city is kept", () => {
  expect(coversACity("tiles/v4/0/0/0.mvt", CITIES)).toBe(true);
  expect(coversACity("tiles/v4/4/4/6.mvt", CITIES)).toBe(true); // eastern US
  expect(coversACity("tiles/v4/4/8/6.mvt", CITIES)).toBe(false); // north Africa
});

test("nothing else on that host is a tile", () => {
  expect(coversACity("tiles/v4.json", CITIES)).toBe(false);
  expect(coversACity("tiles/v4/15/9649/12315.mvt/extra", CITIES)).toBe(false);
});

// Reverse geocoding reads only files under the scope.
test("no outside host is cached to name a point", () => {
  expect(
    fileRequest(
      "https://nominatim.openstreetmap.org/reverse?lat=40.7&lon=-74",
      SCOPE,
    ),
  ).toBeNull();
});

test("a navigation to explorer is answered by explorer's own page", () => {
  expect(pageFor("explorer")).toBe("explorer.html");
  expect(pageFor("explorer.html")).toBe("explorer.html");
  for (const path of ["", "index.html", "404.html"]) {
    expect(pageFor(path)).toBe("index.html");
  }
});

test("one city's graph and one shade bin are stamped apart from the rest", () => {
  expect(contentUnit("routing/nyc.bin")).toBe("routing/nyc.bin");
  expect(contentUnit("routing/shade/nyc/12.bin")).toBe(
    "routing/shade/nyc/12.bin",
  );
  expect(contentUnit("tiles/shade/nyc/12/16/19301/24650.webp")).toBe(
    "tiles/shade/nyc/12",
  );
  expect(contentUnit("tiles/tree-shade/sf/7/14/2620/6333.webp")).toBe(
    "tiles/tree-shade/sf/7",
  );
  expect(contentUnit("tiles/shade/nyc/buckets.json")).toBe("tiles/shade/nyc");
  expect(contentUnit("tiles/elevation/sf/11/327/791.webp")).toBe(
    "tiles/elevation/sf",
  );
  expect(contentUnit("casters/5232/6162.bin")).toBe("casters/5232");
  expect(contentUnit("trees/nyc.bin")).toBe("trees/nyc.bin");
});

const BEFORE = {
  "routing/nyc.bin": "aaaa",
  "routing/sf.bin": "bbbb",
  "tiles/shade/nyc/12": "cccc",
  "casters/5232": "dddd",
};

test("a deploy keeps what it didn't change", () => {
  const after = { ...BEFORE, "routing/sf.bin": "eeee" };
  for (const path of [
    "routing/nyc.bin",
    "tiles/shade/nyc/12/16/19301/24650.webp",
    "casters/5232/6162.bin",
  ]) {
    expect(outdated(`${SCOPE}${path}`, SCOPE, BEFORE, after)).toBe(false);
  }
  expect(outdated(`${SCOPE}routing/sf.bin`, SCOPE, BEFORE, after)).toBe(true);
});

test("a deploy drops what it no longer serves or never vouched for", () => {
  const { "casters/5232": _, ...after } = BEFORE;
  expect(outdated(`${SCOPE}casters/5232/6162.bin`, SCOPE, BEFORE, after)).toBe(
    true,
  );
  const added = { ...BEFORE, "routing/shade/nyc/3.bin": "ffff" };
  expect(
    outdated(`${SCOPE}routing/shade/nyc/3.bin`, SCOPE, BEFORE, added),
  ).toBe(true);
});

test("another host's files go with every deploy, since they change under one URL", () => {
  for (const url of [
    "https://api.protomaps.com/tiles/v4/15/9649/12315.mvt",
    "https://raw.githubusercontent.com/hafacc/scenic-route/main/public/sheds/nyc/open.bin",
  ]) {
    expect(outdated(url, SCOPE, BEFORE, BEFORE)).toBe(true);
  }
});

test("the worker's own markers outlive a deploy", () => {
  for (const url of [`${SCOPE}__sw/shade-season/nyc`, `${SCOPE}__sw/stamps`]) {
    expect(outdated(url, SCOPE, BEFORE, {})).toBe(false);
  }
});

test("a stamp is the unit's own key, never an inherited property", () => {
  expect(outdated(`${SCOPE}toString`, SCOPE, {}, { toString: "a" })).toBe(true);
  expect(outdated(`${SCOPE}toString`, SCOPE, {}, {})).toBe(false);
});

test("under a sub-path scope, units are named from the scope", () => {
  const scope = "https://hafa.cc/scenic-route/";
  const after = { ...BEFORE, "routing/nyc.bin": "zzzz" };
  expect(outdated(`${scope}routing/nyc.bin`, scope, BEFORE, after)).toBe(true);
  expect(outdated(`${scope}routing/sf.bin`, scope, BEFORE, after)).toBe(false);
});

test("a marker vouches only for exactly the baked stamps", () => {
  const reordered = Object.fromEntries(Object.entries(BEFORE).reverse());
  expect(sameStamps(reordered, BEFORE)).toBe(true);
  expect(sameStamps(null, BEFORE)).toBe(false);
  expect(sameStamps({ ...BEFORE, "routing/sf.bin": "eeee" }, BEFORE)).toBe(
    false,
  );
  const { "casters/5232": _, ...fewer } = BEFORE;
  expect(sameStamps(fewer, BEFORE)).toBe(false);
  expect(sameStamps(BEFORE, fewer)).toBe(false);
});

test("a miss on this origin revalidates past the HTTP cache", () => {
  const own = missRequest(new Request(`${SCOPE}routing/nyc.bin`), SCOPE);
  expect(own.cache).toBe("no-cache");
  expect(own.url).toBe(`${SCOPE}routing/nyc.bin`);
  const basemap = new Request(
    "https://api.protomaps.com/tiles/v4/15/9649/12315.mvt",
  );
  expect(missRequest(basemap, SCOPE)).toBe(basemap);
});

test("a sweep drops the whole cache only when it loses most of it", () => {
  expect(dropsMost(0, 0)).toBe(false);
  expect(dropsMost(5, 10)).toBe(false);
  expect(dropsMost(6, 10)).toBe(true);
  expect(dropsMost(1, 1)).toBe(true);
});

test("deletes are batched in order, with a short last batch", () => {
  expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  expect(chunked([], 64)).toEqual([]);
});

const SCRIPT = new Request(`${SCOPE}_app/immutable/workers/tiles-abc123.js`);

// Keyed by URL and holding `SCRIPT`'s copy, so a read or write under another key finds nothing.
function scriptCache(stored: Response | undefined) {
  const puts: Promise<void>[] = [];
  const held = new Map<string, Response>();
  if (stored) {
    held.set(SCRIPT.url, stored);
  }
  return {
    puts,
    cache: {
      match: async (request: Request) => held.get(request.url),
      put: async (request: Request, response: Response) => {
        held.set(request.url, response);
      },
    },
    keep: (put: Promise<void>) => {
      puts.push(put);
    },
    held: () => held.get(SCRIPT.url),
  };
}

test("a worker script the network has is served from it and stored", async () => {
  const { cache, keep, puts, held } = scriptCache(new Response("old"));
  const served = await freshThenStored(
    SCRIPT,
    async () => new Response("new"),
    cache,
    keep,
  );
  expect(await served.text()).toBe("new");
  expect(puts).toHaveLength(1);
  await puts[0];
  expect(await held()?.text()).toBe("new");
});

test("a worker script a deploy took away is served from the stored copy", async () => {
  const { cache, keep, puts } = scriptCache(new Response("old"));
  const served = await freshThenStored(
    SCRIPT,
    async () => new Response("gone", { status: 404 }),
    cache,
    keep,
  );
  expect(await served.text()).toBe("old");
  // The 404 is not kept over the working copy.
  expect(puts).toHaveLength(0);
});

test("a worker script asked for offline is served from the stored copy", async () => {
  const { cache, keep } = scriptCache(new Response("old"));
  const served = await freshThenStored(
    SCRIPT,
    async () => {
      throw new TypeError("offline");
    },
    cache,
    keep,
  );
  expect(await served.text()).toBe("old");
});

test("with no stored copy the network's own answer or failure stands", async () => {
  const missing = scriptCache(undefined);
  const served = await freshThenStored(
    SCRIPT,
    async () => new Response("gone", { status: 404 }),
    missing.cache,
    missing.keep,
  );
  expect(served.status).toBe(404);
  const offline = scriptCache(undefined);
  await expect(
    freshThenStored(
      SCRIPT,
      async () => {
        throw new TypeError("offline");
      },
      offline.cache,
      offline.keep,
    ),
  ).rejects.toThrow("offline");
});

afterEach(() => {
  jest.useRealTimers();
});

// A network the test answers by hand, and a served response watched without awaiting it.
function slowNetwork() {
  let answer: (response: Response) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const pending = new Promise<Response>((resolve, reject) => {
    answer = resolve;
    fail = reject;
  });
  return { load: () => pending, answer, fail };
}

function watched(serving: Promise<Response>) {
  const state: { served: Response | null } = { served: null };
  void serving.then((response) => {
    state.served = response;
  });
  return state;
}

// Past the cache lookup that precedes the timer, and past the race once a timer or the network fires.
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
}

test("a network answering inside the limit is served and stored over the copy", async () => {
  jest.useFakeTimers();
  const { cache, keep, puts, held } = scriptCache(new Response("old"));
  const network = slowNetwork();
  const serving = freshThenStored(SCRIPT, network.load, cache, keep);
  const state = watched(serving);
  await settle();
  jest.advanceTimersByTime(NETWORK_WAIT_MS - 1);
  await settle();
  expect(state.served).toBeNull();
  network.answer(new Response("new"));
  expect(await (await serving).text()).toBe("new");
  expect(puts).toHaveLength(1);
  await puts[0];
  expect(await held()?.text()).toBe("new");
  // The limit passing afterwards changes nothing.
  jest.advanceTimersByTime(NETWORK_WAIT_MS);
  await settle();
  expect(puts).toHaveLength(1);
});

test("a network slower than the limit is answered from the copy, and still refreshes it", async () => {
  jest.useFakeTimers();
  const { cache, keep, puts, held } = scriptCache(new Response("old"));
  const network = slowNetwork();
  const serving = freshThenStored(SCRIPT, network.load, cache, keep);
  const state = watched(serving);
  await settle();
  jest.advanceTimersByTime(NETWORK_WAIT_MS - 1);
  await settle();
  expect(state.served).toBeNull();
  jest.advanceTimersByTime(1);
  expect(await (await serving).text()).toBe("old");
  // Handed to `waitUntil` at the limit, so the worker outlives the late write.
  expect(puts).toHaveLength(1);
  network.answer(new Response("new"));
  await puts[0];
  expect(await held()?.text()).toBe("new");
});

test("a network that never answers is answered from the copy, and nothing fails later", async () => {
  jest.useFakeTimers();
  const { cache, keep, puts, held } = scriptCache(new Response("old"));
  const serving = freshThenStored(
    SCRIPT,
    () => new Promise<Response>(() => {}),
    cache,
    keep,
  );
  await settle();
  jest.advanceTimersByTime(NETWORK_WAIT_MS);
  expect(await (await serving).text()).toBe("old");
  jest.advanceTimersByTime(NETWORK_WAIT_MS * 100);
  await settle();
  expect(puts).toHaveLength(1);
  expect(held()).toBeDefined();
  expect(jest.getTimerCount()).toBe(0);
});

test("a late failure or a late 404 leaves the copy alone and rejects nothing", async () => {
  jest.useFakeTimers();
  for (const late of ["fails", "gone"] as const) {
    const old = new Response("old");
    const { cache, keep, puts, held } = scriptCache(old);
    const network = slowNetwork();
    const serving = freshThenStored(SCRIPT, network.load, cache, keep);
    await settle();
    jest.advanceTimersByTime(NETWORK_WAIT_MS);
    expect(await serving).toBe(old);
    if (late === "fails") {
      network.fail(new TypeError("reset"));
    } else {
      network.answer(new Response("gone", { status: 404 }));
    }
    await expect(puts[0]).resolves.toBeUndefined();
    expect(held()).toBe(old);
  }
});

test("with no stored copy the network is waited on however long", async () => {
  jest.useFakeTimers();
  const { cache, keep, puts, held } = scriptCache(undefined);
  const network = slowNetwork();
  const serving = freshThenStored(SCRIPT, network.load, cache, keep);
  const state = watched(serving);
  await settle();
  // No timer is even set, since there is nothing to fall back to.
  expect(jest.getTimerCount()).toBe(0);
  jest.advanceTimersByTime(NETWORK_WAIT_MS * 100);
  await settle();
  expect(state.served).toBeNull();
  network.answer(new Response("new"));
  expect(await (await serving).text()).toBe("new");
  await puts[0];
  expect(await held()?.text()).toBe("new");
});

test("with no stored copy a stalled network that then fails still rejects", async () => {
  jest.useFakeTimers();
  const { cache, keep } = scriptCache(undefined);
  const network = slowNetwork();
  const serving = freshThenStored(SCRIPT, network.load, cache, keep);
  await settle();
  jest.advanceTimersByTime(NETWORK_WAIT_MS * 100);
  network.fail(new TypeError("offline"));
  await expect(serving).rejects.toThrow("offline");
});

test("a rejection or a 404 inside the limit falls back at once, not at the limit", async () => {
  jest.useFakeTimers();
  for (const early of ["fails", "gone"] as const) {
    const { cache, keep, puts } = scriptCache(new Response("old"));
    const network = slowNetwork();
    const serving = freshThenStored(SCRIPT, network.load, cache, keep);
    await settle();
    if (early === "fails") {
      network.fail(new TypeError("offline"));
    } else {
      network.answer(new Response("gone", { status: 404 }));
    }
    // No timer is advanced: the copy is served as soon as the network settles.
    expect(await (await serving).text()).toBe("old");
    expect(puts).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  }
});

test("a feed's 404 stands over the copy, but a failure or a stall still falls back", async () => {
  jest.useFakeTimers();
  const feed = { notOkStands: true };
  const gone = scriptCache(new Response("old"));
  const served = await freshThenStored(
    SCRIPT,
    async () => new Response("gone", { status: 404 }),
    gone.cache,
    gone.keep,
    feed,
  );
  expect(served.status).toBe(404);
  expect(gone.puts).toHaveLength(0);
  const offline = scriptCache(new Response("old"));
  const fallen = await freshThenStored(
    SCRIPT,
    async () => {
      throw new TypeError("offline");
    },
    offline.cache,
    offline.keep,
    feed,
  );
  expect(await fallen.text()).toBe("old");
  const stalled = scriptCache(new Response("old"));
  const serving = freshThenStored(
    SCRIPT,
    () => new Promise<Response>(() => {}),
    stalled.cache,
    stalled.keep,
    feed,
  );
  await settle();
  jest.advanceTimersByTime(NETWORK_WAIT_MS);
  expect(await (await serving).text()).toBe("old");
});

test("a store that cannot be read does not cost the network's answer", async () => {
  const { keep } = scriptCache(undefined);
  const served = await freshThenStored(
    SCRIPT,
    async () => new Response("new"),
    {
      match: async () => {
        throw new Error("no storage");
      },
      put: async () => {},
    },
    keep,
  );
  expect(await served.text()).toBe("new");
});

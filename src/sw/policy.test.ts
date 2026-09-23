import { expect, test } from "bun:test";
import { coversACity, fileRequest, isGraph, pageFor, shadeKey } from "./policy";

// Production always deploys under a basePath, and paths are filed relative to the worker's scope.
const SCOPE = "https://hafa.cc/scenic-route/";

test("the exported app goes in the shell store", () => {
  for (const path of [
    "",
    "index.html",
    "manifest.webmanifest",
    "explorer",
    "explorer.html",
    "_next/static/chunks/main-abc123.js",
    // The routing worker is a content-hashed chunk too.
    "_next/static/chunks/7kq3ldz9wcvbt.js",
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
    "https://hafa.cc/other-app/index.html",
  ]) {
    expect(fileRequest(url, SCOPE)).toBeNull();
  }
});

test("the daily feeds are cached, but network first", () => {
  const base = "https://raw.githubusercontent.com/hafaio/scenic-route/main";
  expect(fileRequest(`${base}/public/sheds/nyc.bin`, SCOPE)).toEqual({
    path: "sheds/nyc.bin",
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

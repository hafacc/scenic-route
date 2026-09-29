import { afterAll, expect, test } from "bun:test";
import { setBaseUrl } from "./base-url";
import { commercialRenderer } from "./commercial";
import { chunksAround, loadAround, loadStreets } from "./street-score";

// At z17 a z12 chunk is 32 tiles across.
const CHUNK_TILES = 32;

// Every chunk 404s, so a load resolves empty and only the requested paths matter.
const fetched: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request) => {
  fetched.push(new URL(String(url)).pathname);
  return new Response(null, { status: 404 });
}) as typeof fetch;
setBaseUrl("http://tiles.test/");
afterAll(() => {
  globalThis.fetch = realFetch;
  setBaseUrl("");
});

// Paths under `prefix` a load asks for; each test uses its own chunks, so the caches never answer.
async function requested(
  prefix: string,
  load: () => Promise<unknown>,
): Promise<string[]> {
  fetched.length = 0;
  await load();
  return fetched.filter((path) => path.startsWith(prefix)).sort();
}

test("a street tile on a chunk edge pulls its neighbour, one a tile in doesn't", async () => {
  const y = 210 * CHUNK_TILES + 9;
  expect(
    await requested("/streets/", () =>
      loadStreets({ x: 110 * CHUNK_TILES, y, z: 17 }),
    ),
  ).toEqual(["/streets/109/210.bin", "/streets/110/210.bin"]);
  expect(
    await requested("/streets/", () =>
      loadStreets({ x: 111 * CHUNK_TILES + 1, y, z: 17 }),
    ),
  ).toEqual(["/streets/111/210.bin"]);
});

test("a commercial tile on a chunk edge pulls its neighbour, one a tile in doesn't", async () => {
  const params = { kind: "commercial" } as const;
  const y = 220 * CHUNK_TILES + 9;
  expect(
    await requested("/commercial/", () =>
      commercialRenderer.load(params, { x: 120 * CHUNK_TILES, y, z: 17 }),
    ),
  ).toEqual(["/commercial/119/220.bin", "/commercial/120/220.bin"]);
  expect(
    await requested("/commercial/", () =>
      commercialRenderer.load(params, { x: 121 * CHUNK_TILES + 1, y, z: 17 }),
    ),
  ).toEqual(["/commercial/121/220.bin"]);
});

test("a commercial overview tile loads only the chunks under it", async () => {
  expect(
    await requested("/commercial/", () =>
      commercialRenderer.load({ kind: "commercial" }, { x: 70, y: 115, z: 11 }),
    ),
  ).toEqual([
    "/commercial/140/230.bin",
    "/commercial/140/231.bin",
    "/commercial/141/230.bin",
    "/commercial/141/231.bin",
  ]);
});

test("an interior tile needs only its own chunk, however wide its margin", () => {
  const coords = { x: 100 * CHUNK_TILES + 5, y: 200 * CHUNK_TILES + 9, z: 17 };
  expect(chunksAround(coords, 0)).toEqual([{ x: 100, y: 200 }]);
  expect(chunksAround(coords, 200)).toEqual([{ x: 100, y: 200 }]);
});

test("a tile on a chunk's corner takes its neighbours once the margin crosses", () => {
  const coords = { x: 100 * CHUNK_TILES, y: 201 * CHUNK_TILES - 1, z: 17 };
  expect(chunksAround(coords, 0)).toEqual([{ x: 100, y: 200 }]);
  expect(chunksAround(coords, 1)).toEqual([
    { x: 99, y: 200 },
    { x: 99, y: 201 },
    { x: 100, y: 200 },
    { x: 100, y: 201 },
  ]);
});

test("an overview tile spans the chunks under it", () => {
  expect(chunksAround({ x: 3, y: 5, z: 11 }, 0)).toEqual([
    { x: 6, y: 10 },
    { x: 6, y: 11 },
    { x: 7, y: 10 },
    { x: 7, y: 11 },
  ]);
});

test("a neighbour that fails to load leaves the tile drawing without it", async () => {
  const coords = { x: 100 * CHUNK_TILES, y: 200 * CHUNK_TILES + 9, z: 17 };
  const loaded = await loadAround(
    coords,
    10,
    (x) => (x === 100 ? Promise.resolve([x]) : Promise.reject(new Error("x"))),
    [],
  );
  expect(loaded).toEqual([[], [100]]);
  await expect(
    loadAround(coords, 10, () => Promise.reject(new Error("own")), []),
  ).rejects.toThrow("own");
});

test("a missing chunk is remembered, so it isn't fetched again", async () => {
  const tile = { x: 130 * CHUNK_TILES + 9, y: 230 * CHUNK_TILES + 9, z: 17 };
  expect(await requested("/streets/", () => loadStreets(tile))).toEqual([
    "/streets/130/230.bin",
  ]);
  expect(await requested("/streets/", () => loadStreets(tile))).toEqual([]);
});

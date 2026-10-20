import { expect, test } from "bun:test";
import { WALK_HALF_LIFE_MS } from "../routing/familiar";
import { WalkHistory, type WalkStorage } from "./history";

const NOW = Date.UTC(2026, 9, 14);

function memoryStorage(): WalkStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

test("a sighting is kept per city and read back after a reload", () => {
  const storage = memoryStorage();
  const history = new WalkHistory(() => storage);
  history.record("nyc", 42, NOW);
  history.record("nyc", 42, NOW + WALK_HALF_LIFE_MS);
  history.record("sf", 7, NOW);
  const reread = new WalkHistory(() => storage);
  const nyc = reread.records("nyc");
  expect(nyc.size).toBe(1);
  expect(nyc.get(42)?.weight).toBeCloseTo(1.5, 12);
  expect(nyc.get(42)?.at).toBe(NOW + WALK_HALF_LIFE_MS);
  expect(reread.records("sf").get(7)?.weight).toBe(1);
  expect(reread.count()).toBe(2);
});

test("a faded street is dropped on the next write", () => {
  const history = new WalkHistory(() => memoryStorage());
  history.record("nyc", 1, NOW);
  history.record("nyc", 2, NOW + 10 * WALK_HALF_LIFE_MS);
  expect([...history.records("nyc").keys()]).toEqual([2]);
});

test("forgetting clears every city, from memory and from storage", () => {
  const storage = memoryStorage();
  const history = new WalkHistory(() => storage);
  let heard = 0;
  history.subscribe(() => {
    heard += 1;
  });
  history.record("nyc", 1, NOW);
  history.record("sf", 2, NOW);
  history.forget();
  expect(history.count()).toBe(0);
  expect(history.records("nyc").size).toBe(0);
  expect(storage.items.size).toBe(0);
  expect(new WalkHistory(() => storage).count()).toBe(0);
  expect(heard).toBe(3);
});

test("storage that throws or holds junk costs persistence, not the session", () => {
  const throwing: WalkStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("full");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  const history = new WalkHistory(() => throwing);
  history.record("nyc", 1, NOW);
  expect(history.records("nyc").get(1)?.weight).toBe(1);
  history.forget();
  expect(history.count()).toBe(0);

  const junk = memoryStorage();
  junk.setItem("scenic-route:walks.v1", '{"nyc":{"1":"x","2":[1,2]}');
  expect(new WalkHistory(() => junk).count()).toBe(0);
  junk.setItem("scenic-route:walks.v1", '{"nyc":{"1":"x","2":[1,2]}}');
  expect([...new WalkHistory(() => junk).records("nyc").keys()]).toEqual([2]);
  expect(new WalkHistory(() => null).records("nyc").size).toBe(0);
});

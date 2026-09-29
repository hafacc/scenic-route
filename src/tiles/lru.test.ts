import { expect, test } from "bun:test";
import { cachedLru } from "./lru";

// A promise settled by hand, so a test decides when a load lands.
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test("a hit is refreshed, so the oldest untouched entry is evicted first", async () => {
  const cache = new Map<string, Promise<string>>();
  const load = (key: string) =>
    cachedLru(cache, key, 2, () => Promise.resolve(key));
  await load("a");
  await load("b");
  await load("a"); // now the most recent
  await load("c");
  expect([...cache.keys()]).toEqual(["a", "c"]);
  await load("d");
  expect([...cache.keys()]).toEqual(["c", "d"]);
});

test("a hit returns the cached load without calling make", async () => {
  const cache = new Map<string, Promise<number>>();
  let made = 0;
  const load = () => cachedLru(cache, "k", 2, () => Promise.resolve(++made));
  expect(await load()).toBe(1);
  expect(await load()).toBe(1);
  expect(made).toBe(1);
});

test("a rejection removes only its own entry", async () => {
  const cache = new Map<string, Promise<string>>();
  await cachedLru(cache, "good", 4, () => Promise.resolve("good"));
  await expect(
    cachedLru(cache, "bad", 4, () => Promise.reject(new Error("bad"))),
  ).rejects.toThrow("bad");
  expect([...cache.keys()]).toEqual(["good"]);
});

test("an evicted load's late rejection doesn't delete its replacement", async () => {
  const cache = new Map<string, Promise<string>>();
  const first = deferred<string>();
  const evicted = cachedLru(cache, "k", 1, () => first.promise);
  await cachedLru(cache, "other", 1, () => Promise.resolve("other"));
  expect(cache.has("k")).toBe(false);
  const replacement = cachedLru(cache, "k", 1, () => Promise.resolve("new"));
  first.reject(new Error("late"));
  await expect(evicted).rejects.toThrow("late");
  expect(cache.get("k")).toBe(replacement);
  expect(await replacement).toBe("new");
});

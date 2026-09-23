import { expect, test } from "bun:test";

// These modules read storage at import, and CI has a window with no `localStorage`; restore globals.

async function importingUnder(
  globals: Record<string, unknown>,
  path: string,
): Promise<unknown> {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  }
  try {
    // A fresh query string defeats the loader's cache, so the top-level read runs again.
    return await import(`${path}?env=${Math.random()}`);
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[name];
      }
    }
  }
}

test("the settings store survives a window with no localStorage on it", async () => {
  const store = (await importingUnder({ window: {} }, "./store")) as {
    settings: () => { layerOrder: readonly string[]; allowFerries: boolean };
  };
  expect(store.settings().layerOrder).toEqual([]);
  expect(store.settings().allowFerries).toBe(true);
});

test("the settings store survives a localStorage that throws on access", async () => {
  const hostile = {
    getItem() {
      throw new Error("storage is blocked in this context");
    },
    setItem() {
      throw new Error("storage is blocked in this context");
    },
  };
  const store = (await importingUnder(
    { window: { localStorage: hostile }, localStorage: hostile },
    "./store",
  )) as { settings: () => { layerOrder: readonly string[] } };
  expect(store.settings().layerOrder).toEqual([]);
});

test("the theme store survives a document with no documentElement", async () => {
  const theme = (await importingUnder(
    { document: {} },
    "../theme/current",
  )) as { currentTheme: () => string };
  expect(theme.currentTheme()).toBe("light");
});

test("the pre-document keys still migrate when there is no document at all", async () => {
  const held = new Map<string, string>([
    ["scenic-route:tree-weight", "0.35"],
    ["scenic-route:allow-sheds", "false"],
  ]);
  const shim = {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => held.set(key, value),
  };
  const store = (await importingUnder({ localStorage: shim }, "./store")) as {
    settings: () => { weights: Record<string, number>; allowSheds: boolean };
  };
  expect(store.settings().weights.tree).toBe(0.35);
  expect(store.settings().allowSheds).toBe(false);
  expect(held.get("scenic-route:settings.v1")).toContain('"tree":0.35');
});

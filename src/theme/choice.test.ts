import { expect, test } from "bun:test";

type Choice = typeof import("./choice");

interface Browser {
  held: Map<string, string>;
  classes: Set<string>;
  style: { colorScheme?: string };
  styles: Set<unknown>; // the transition-disabling <style>s now in <head>
  system: { dark: boolean };
  systemChanged(): void;
  storageChanged(key: string, newValue: string | null): void;
}

// The module reads the page at import and again on every change, so the globals stay for the body.
async function inBrowser(
  start: { held?: [string, string][]; dark?: boolean },
  body: (browser: Browser, choice: Choice) => void | Promise<void>,
): Promise<void> {
  const held = new Map(start.held ?? []);
  const classes = new Set<string>();
  const style: { colorScheme?: string } = {};
  const styles = new Set<unknown>();
  const system = { dark: start.dark ?? false };
  const media: (() => void)[] = [];
  const storage: ((event: { key: string; newValue: string | null }) => void)[] =
    [];
  const globals: Record<string, unknown> = {
    localStorage: {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => held.set(key, value),
    },
    document: {
      documentElement: {
        classList: {
          add: (name: string) => classes.add(name),
          remove: (...names: string[]) => {
            for (const name of names) {
              classes.delete(name);
            }
          },
        },
        style,
      },
      body: {},
      head: {
        appendChild: (node: unknown) => styles.add(node),
        removeChild: (node: unknown) => styles.delete(node),
      },
      createElement: () => ({ appendChild() {} }),
      createTextNode: (text: string) => text,
    },
    window: {
      matchMedia: () => ({
        get matches() {
          return system.dark;
        },
        addEventListener: (_: string, listener: () => void) =>
          media.push(listener),
      }),
      getComputedStyle() {},
      addEventListener: (_: string, listener: (typeof storage)[number]) =>
        storage.push(listener),
    },
  };
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
    const choice: Choice = await import(`./choice?env=${Math.random()}`);
    await body(
      {
        held,
        classes,
        style,
        styles,
        system,
        systemChanged: () => {
          for (const listener of media) {
            listener();
          }
        },
        storageChanged: (key, newValue) => {
          for (const listener of storage) {
            listener({ key, newValue });
          }
        },
      },
      choice,
    );
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

test("with nothing stored the choice is system, drawn as the system's theme", async () => {
  await inBrowser({ dark: true }, (browser, choice) => {
    expect(choice.themeChoice()).toBe("system");
    expect([...browser.classes]).toEqual(["dark"]);
    expect(browser.style.colorScheme).toBe("dark");
    expect(browser.held.has("theme")).toBe(false);
  });
});

test("a stored choice wins over the system's", async () => {
  await inBrowser(
    { held: [["theme", "light"]], dark: true },
    (browser, choice) => {
      expect(choice.themeChoice()).toBe("light");
      expect([...browser.classes]).toEqual(["light"]);
      expect(browser.style.colorScheme).toBe("light");
    },
  );
});

test("setting a choice stores it, swaps the class and tells subscribers once", async () => {
  await inBrowser({}, (browser, choice) => {
    let told = 0;
    const unsubscribe = choice.subscribeThemeChoice(() => {
      told += 1;
    });
    choice.setThemeChoice("dark");
    choice.setThemeChoice("dark");
    expect(choice.themeChoice()).toBe("dark");
    expect(browser.held.get("theme")).toBe("dark");
    expect([...browser.classes]).toEqual(["dark"]);
    expect(browser.style.colorScheme).toBe("dark");
    expect(told).toBe(1);
    unsubscribe();
    choice.setThemeChoice("light");
    expect(told).toBe(1);
  });
});

test("the system's theme is followed only while the choice is system", async () => {
  await inBrowser({}, (browser, choice) => {
    browser.system.dark = true;
    browser.systemChanged();
    expect([...browser.classes]).toEqual(["dark"]);
    choice.setThemeChoice("light");
    browser.systemChanged();
    expect([...browser.classes]).toEqual(["light"]);
    choice.setThemeChoice("system");
    expect([...browser.classes]).toEqual(["dark"]);
    expect(browser.held.get("theme")).toBe("system");
  });
});

test("another tab's choice is adopted without being written back", async () => {
  await inBrowser({}, (browser, choice) => {
    browser.storageChanged("scenic-route:settings.v1", "dark");
    expect(choice.themeChoice()).toBe("system");
    browser.storageChanged("theme", "dark");
    expect(choice.themeChoice()).toBe("dark");
    expect([...browser.classes]).toEqual(["dark"]);
    expect(browser.held.has("theme")).toBe(false);
  });
});

test("a cleared key goes back to system and is stored again", async () => {
  await inBrowser({ held: [["theme", "dark"]] }, (browser, choice) => {
    browser.storageChanged("theme", null);
    expect(choice.themeChoice()).toBe("system");
    expect([...browser.classes]).toEqual(["light"]);
    expect(browser.held.get("theme")).toBe("system");
  });
});

test("an unknown stored string is system and never a class", async () => {
  await inBrowser(
    { held: [["theme", "sepia dusk"]], dark: true },
    (browser, choice) => {
      expect(choice.themeChoice()).toBe("system");
      expect([...browser.classes]).toEqual(["dark"]);
      expect(browser.style.colorScheme).toBe("dark");
      expect(browser.held.get("theme")).toBe("sepia dusk");
    },
  );
});

test("another tab's unknown string is adopted as system", async () => {
  await inBrowser({ held: [["theme", "dark"]] }, (browser, choice) => {
    browser.storageChanged("theme", "sepia dusk");
    expect(choice.themeChoice()).toBe("system");
    expect([...browser.classes]).toEqual(["light"]);
  });
});

test("transitions are off only for the moment of a change", async () => {
  await inBrowser({}, async (browser, choice) => {
    choice.setThemeChoice("dark");
    expect(browser.styles.size).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(browser.styles.size).toBe(0);
  });
});

test("without a window the choice is system", async () => {
  const choice: Choice = await import(`./choice?env=${Math.random()}`);
  expect(choice.themeChoice()).toBe("system");
});

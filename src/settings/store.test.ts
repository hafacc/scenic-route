import { expect, test } from "bun:test";
import { DEFAULT_LENS, DEFAULT_TOGGLES } from "../lenses/lenses";
import type { OverlayId } from "../overlays/registry";
import {
  mergeOrder,
  orderedOverlays,
  type Settings,
  settings,
  settingsFrom,
  updateSettings,
} from "./store";

const registry = ["canopy", "shade", "historic", "genus"] as OverlayId[];

test("an order the reader arranged is kept", () => {
  const stored = ["genus", "canopy", "shade", "historic"] as OverlayId[];
  expect(mergeOrder(stored, registry)).toEqual(stored);
});

test("a layer the registry has dropped goes", () => {
  const stored = [
    "genus",
    "ferries",
    "canopy",
    "shade",
    "historic",
  ] as OverlayId[];
  expect(mergeOrder(stored, registry)).toEqual([
    "genus",
    "canopy",
    "shade",
    "historic",
  ]);
});

test("a new layer lands where the registry puts it, not at the end", () => {
  const stored = ["genus", "canopy", "shade"] as OverlayId[];
  expect(mergeOrder(stored, registry)).toEqual([
    "genus",
    "canopy",
    "shade",
    "historic",
  ]);
});

test("new layers at the front of the registry stay at the front", () => {
  const stored = ["historic", "genus"] as OverlayId[];
  expect(mergeOrder(stored, registry)).toEqual([
    "canopy",
    "shade",
    "historic",
    "genus",
  ]);
});

test("nothing stored is the registry's own order", () => {
  expect(mergeOrder([], registry)).toEqual(registry);
});

test("a city shows its own subset, in the reader's order, minus what they hid", () => {
  expect(
    orderedOverlays(["canopy", "genus", "shade"] as OverlayId[], {
      layerOrder: ["genus", "canopy", "shade", "historic"] as OverlayId[],
      hiddenLayers: ["shade"] as OverlayId[],
    }),
  ).toEqual(["genus", "canopy"]);
});

// The old keys are folded in exactly when the document has no weights, and never again.

const legacy: Record<string, string> = {
  "scenic-route:tree-weight": "0.6",
  "scenic-route:shade-weight": "-0.4",
  "scenic-route:allow-ferries": "false",
};
const fromLegacy = (key: string): string | null => legacy[key] ?? null;
const fromNothing = (): string | null => null;

test("weights the old keys hold are folded in, and written back", () => {
  const { settings, migrated } = settingsFrom({}, fromLegacy);
  expect(settings.weights).toEqual({ tree: 0.6, shade: -0.4 });
  expect(settings.allowFerries).toBe(false);
  expect(settings.allowSheds).toBe(true); // never written, so it keeps the default
  expect(migrated).toBe(true);
});

test("a document that carries weights ignores the old keys", () => {
  const { settings, migrated } = settingsFrom(
    { weights: { tree: 0.2 }, allowFerries: true },
    fromLegacy,
  );
  expect(settings.weights).toEqual({ tree: 0.2 });
  expect(settings.allowFerries).toBe(true);
  expect(migrated).toBe(false);
});

test("a reader with neither gets the defaults, and nothing is written", () => {
  const { settings, migrated } = settingsFrom({}, fromNothing);
  expect(settings.weights).toEqual({});
  expect(settings.allowFerries).toBe(true);
  expect(settings.allowSheds).toBe(true);
  expect(settings.hiddenFactors).toEqual([]);
  expect(settings.lens).toBe(DEFAULT_LENS.id);
  expect(settings.toggles).toEqual(DEFAULT_TOGGLES);
  expect(migrated).toBe(false);
});

// Documents from a newer build: unknown ids and factors must not discard what the reader set.

test("an id this build does not know costs its own place, not the whole order", () => {
  const { settings } = settingsFrom(
    {
      layerOrder: ["genus", "moonlight", "canopy"] as OverlayId[],
      hiddenLayers: ["moonlight", "shade"] as OverlayId[],
    },
    () => null,
  );
  expect(settings.layerOrder).toEqual(["genus", "canopy"] as OverlayId[]);
  expect(settings.hiddenLayers).toEqual(["shade"] as OverlayId[]);
});

test("weights a newer build wrote survive a factor this one cannot name", () => {
  const legacy = (key: string): string | null =>
    key === "scenic-route:tree-weight" ? "0.05" : null;
  const { settings, migrated } = settingsFrom(
    { weights: { tree: 0.9, moonlight: 0.5 } as Record<string, number> },
    legacy,
  );
  expect(settings.weights).toEqual({ tree: 0.9 });
  expect(migrated).toBe(false); // nothing folded, so nothing is written back
});

test("the pre-document keys are folded in exactly once", () => {
  const legacy = (key: string): string | null =>
    ({
      "scenic-route:tree-weight": "0.4",
      "scenic-route:allow-sheds": "false",
    })[key] ?? null;

  const first = settingsFrom({}, legacy);
  expect(first.migrated).toBe(true);
  expect(first.settings.weights).toEqual({ tree: 0.4 });
  expect(first.settings.allowSheds).toBe(false);

  // The old keys are never deleted, so even an empty `{}` weights field must stop a second fold.
  const second = settingsFrom({ weights: {}, allowSheds: true }, legacy);
  expect(second.migrated).toBe(false);
  expect(second.settings.weights).toEqual({});
  expect(second.settings.allowSheds).toBe(true);
});

test("a document saved before the crossings flag was inverted is turned round, not dropped", () => {
  const before = settingsFrom(
    { weights: {}, fewerCrossings: false } as Partial<Settings>,
    () => null,
  );
  expect(before.settings.allowCrossings).toBe(true); // "not fewer" meant free

  const after = settingsFrom(
    { weights: {}, allowCrossings: true } as Partial<Settings>,
    () => null,
  );
  expect(after.settings.allowCrossings).toBe(true);

  // The new spelling wins where a document carries both.
  const both = settingsFrom(
    {
      weights: {},
      fewerCrossings: false,
      allowCrossings: false,
    } as Partial<Settings>,
    () => null,
  );
  expect(both.settings.allowCrossings).toBe(false);
});

test("a gate hidden under its old name stays hidden after the rename", () => {
  const { settings } = settingsFrom(
    {
      weights: {},
      hiddenGates: ["fewerCrossings"],
    } as unknown as Partial<Settings>,
    () => null,
  );
  expect(settings.hiddenGates).toEqual(["allowCrossings"]);

  const both = settingsFrom(
    {
      weights: {},
      hiddenGates: ["fewerCrossings", "allowCrossings", "allowFerries"],
    } as Partial<Settings>,
    () => null,
  );
  expect(both.settings.hiddenGates).toEqual(["allowCrossings", "allowFerries"]);
});

test("a lens this build does not offer opens the default one", () => {
  const stored = (lens: unknown): string =>
    settingsFrom({ weights: {}, lens } as Partial<Settings>, () => null)
      .settings.lens;
  expect(stored("rain")).toBe("rain");
  expect(stored("cartographer")).toBe(DEFAULT_LENS.id);
  expect(stored(7)).toBe(DEFAULT_LENS.id);
  expect(stored(undefined)).toBe(DEFAULT_LENS.id);
});

// Documents saved before the rename say `mode` and `modeLayers`, in the fields and the stamps.
test("a choice stored under the old `mode` names is kept", () => {
  const { settings } = settingsFrom(
    {
      weights: {},
      mode: "rain",
      modeLayers: { historic: ["legacy"] },
      updatedAt: { mode: 100, "modeLayers.historic": 200, coverage: 300 },
    } as unknown as Partial<Settings>,
    () => null,
  );
  expect(settings.lens).toBe("rain");
  expect(settings.lensLayers).toEqual({ historic: ["legacy"] });
  expect(settings.updatedAt).toEqual({
    lens: 100,
    "lensLayers.historic": 200,
    coverage: 300,
  });
  expect("mode" in settings).toBe(false);
  expect("modeLayers" in settings).toBe(false);
});

test("the current names win over the old ones beside them", () => {
  const { settings } = settingsFrom(
    {
      weights: {},
      mode: "rain",
      lens: "historic",
      modeLayers: { rain: ["canopy"] },
      lensLayers: { historic: ["legacy"] },
      updatedAt: { mode: 100, lens: 400 },
    } as unknown as Partial<Settings>,
    () => null,
  );
  expect(settings.lens).toBe("historic");
  expect(settings.lensLayers).toEqual({ historic: ["legacy"] });
  expect(settings.updatedAt).toEqual({ lens: 400 });
});

test("a switch a newer build wrote costs its own position, not the other two", () => {
  const { settings } = settingsFrom(
    {
      weights: {},
      toggles: { sun: "moonlight", hills: "none", ferries: false },
    } as unknown as Partial<Settings>,
    () => null,
  );
  expect(settings.toggles).toEqual({
    sun: DEFAULT_TOGGLES.sun,
    hills: "none",
    ferries: false,
  });
});

test("toggles that are not an object at all read as the defaults", () => {
  const { settings } = settingsFrom(
    { weights: {}, toggles: ["sun"] } as unknown as Partial<Settings>,
    () => null,
  );
  expect(settings.toggles).toEqual(DEFAULT_TOGGLES);
});

test("a layer list drops an overlay and a lens this build cannot name", () => {
  const { settings } = settingsFrom(
    {
      weights: {},
      lensLayers: {
        historic: ["legacy", "zeppelins"],
        cartographer: ["canopy"],
      },
    } as unknown as Partial<Settings>,
    () => null,
  );
  expect(settings.lensLayers).toEqual({ historic: ["legacy"] });
});

test("a lens's layer list is stamped on its own, not with the other lenses'", () => {
  updateSettings({ lensLayers: { historic: ["legacy"] } }, 2345);
  const { updatedAt } = settings();
  expect(updatedAt["lensLayers.historic"]).toBe(2345);
  expect(updatedAt["lensLayers.naturalist"]).toBeUndefined();
  expect(updatedAt.lensLayers).toBeUndefined();
});

test("a switch is stamped on its own, not with the other two", () => {
  const before = settings().toggles;
  updateSettings({ toggles: { ...before, ferries: !before.ferries } }, 1234);
  const { updatedAt } = settings();
  expect(updatedAt["toggles.ferries"]).toBe(1234);
  expect(updatedAt["toggles.sun"]).toBeUndefined();
  expect(updatedAt.toggles).toBeUndefined();
});

test("a weight with no legacy key of its own still survives the document", () => {
  const { settings, migrated } = settingsFrom(
    { weights: { bridge: 0.8 } },
    fromLegacy,
  );

  expect(settings.weights.bridge).toBe(0.8);
  expect(migrated).toBe(false);
});

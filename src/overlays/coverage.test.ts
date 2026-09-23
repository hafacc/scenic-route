import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CITIES } from "../cities";
import { OVERLAYS, type OverlayId } from "./registry";

// City overlay lists are authored, so check both directions against committed sources.
// Not public/: the pyramids are gitignored build output, so the check would pass vacuously in CI.

const ROOT = join(import.meta.dirname, "..", "..");

// `null` isn't a per-city repo file: elevation fetches a DEM, and scaffolding is a daily feed.
const SOURCE_DIR: Record<OverlayId, string | null> = {
  canopy: "canopy",
  genus: "trees",
  landmarks: "landmarks",
  art: "art",
  ferries: "ferries",
  subway: "subway",
  highways: "highways",
  commercial: "dining",
  industrial: "industrial",
  historic: "historic",
  legacy: "legacy",
  shade: "buildings",
  elevation: null,
  scaffolding: null,
};

// Layers deliberately withheld from a city that has the data, each with its reason.
const WITHHELD: Record<string, Partial<Record<OverlayId, string>>> = {};

const hasSource = (overlay: OverlayId, city: string): boolean => {
  const dir = SOURCE_DIR[overlay];
  return dir !== null && existsSync(join(ROOT, "data", dir, `${city}.bin`));
};

test("every overlay declares where its source lives", () => {
  const declared = new Set(Object.keys(SOURCE_DIR));
  expect(
    OVERLAYS.map((overlay) => overlay.id).filter((id) => !declared.has(id)),
  ).toEqual([]);
});

describe.each(CITIES.map((city) => city.id))("%s", (city) => {
  const offered = new Set(CITIES.find(({ id }) => id === city)?.overlays ?? []);

  test("offers every layer it has the data for", () => {
    const missing = OVERLAYS.map(({ id }) => id).filter(
      (id) => hasSource(id, city) && !offered.has(id) && !WITHHELD[city]?.[id],
    );
    expect(missing).toEqual([]);
  });

  test("has the data for every layer it offers", () => {
    const empty = [...offered].filter(
      (id) => SOURCE_DIR[id] !== null && !hasSource(id, city),
    );
    expect(empty).toEqual([]);
  });

  test("withholds nothing it has no data for", () => {
    const stale = Object.keys(WITHHELD[city] ?? {}).filter(
      (id) => !hasSource(id as OverlayId, city),
    );
    expect(stale).toEqual([]);
  });
});

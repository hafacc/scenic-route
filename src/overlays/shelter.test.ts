import { expect, test } from "bun:test";
import { cityById } from "../cities";
import { RAIN_IN_LEAF, rainTau } from "../shade/phenology";
import { OVERLAYS, overlayOpacity } from "./registry";
import { hasShelter, SHED_OPACITY, treeCoverOpacity } from "./shelter";

// Cover is drawn at the router's shelter weight, so the two cannot disagree about a season.

const JULY = new Date(2026, 6, 15);
const JANUARY = new Date(2026, 0, 15);
const APRIL = new Date(2026, 3, 24);

function city(id: string): NonNullable<ReturnType<typeof cityById>> {
  const found = cityById(id);
  if (!found) {
    throw new Error(`no city ${id}`);
  }
  return found;
}

test("a deck draws at full strength and a crown in leaf at its rain weight", () => {
  expect(SHED_OPACITY).toBe(1);
  expect(RAIN_IN_LEAF).toBe(0.35);
  expect(treeCoverOpacity(city("nyc"), JULY)).toBeCloseTo(RAIN_IN_LEAF, 12);
});

test("New York's tree cover fades to 15% bare and is the router's weight between", () => {
  const nyc = city("nyc");
  expect(treeCoverOpacity(nyc, JANUARY)).toBeCloseTo(0.15, 12);
  const spring = treeCoverOpacity(nyc, APRIL);
  expect(spring).toBeGreaterThan(treeCoverOpacity(nyc, JANUARY));
  expect(spring).toBeLessThan(treeCoverOpacity(nyc, JULY));
  expect(spring).toBe(rainTau(APRIL, nyc));
});

test("an evergreen city's tree cover draws at the in-leaf strength all year", () => {
  const bay = city("sf");
  expect(treeCoverOpacity(bay, JANUARY)).toBe(treeCoverOpacity(bay, JULY));
  expect(treeCoverOpacity(bay, JANUARY)).toBe(RAIN_IN_LEAF);
});

test("the key reads a layer's opacity off the layer, and 1 for one that never fades", () => {
  const overlay = (id: string) => {
    const found = OVERLAYS.find((entry) => entry.id === id);
    if (!found) {
      throw new Error(`no overlay ${id}`);
    }
    return found;
  };
  const nyc = city("nyc");
  expect(overlayOpacity(overlay("treecover"), nyc, JANUARY)).toBe(
    treeCoverOpacity(nyc, JANUARY),
  );
  expect(overlayOpacity(overlay("scaffolding"), nyc, JANUARY)).toBe(1);
  expect(overlay("treecover").label).toBe("Tree cover");
  expect(overlay("scaffolding").label).toBe("Scaffolding");
});

test("a city has shelter where it has either kind of cover, and scaffolding only where it has the feed", () => {
  expect(hasShelter(city("nyc"))).toBe(true);
  // Trees alone: the Bay Area has no shed feed, so no scaffolding gate, and shelter all the same.
  expect(city("sf").overlays.includes("scaffolding")).toBe(false);
  expect(hasShelter(city("sf"))).toBe(true);
  expect(hasShelter({ overlays: ["scaffolding"] })).toBe(true);
  expect(hasShelter({ overlays: ["canopy", "shade"] })).toBe(false);
});

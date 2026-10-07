import { expect, test } from "bun:test";
import { cityById, DEFAULT_CITY } from "../../src/cities";
import { OVERLAYS, type OverlayId } from "../../src/overlays/registry";
import { shownOverlays, toggleOverlay } from "./overlays";

const NYC = DEFAULT_CITY;
const SF = cityById("sf") ?? DEFAULT_CITY;
const EXCLUSIVE = OVERLAYS.find((overlay) => overlay.exclusive)
  ?.id as OverlayId;
// Offered in New York and not in San Francisco.
const NYC_ONLY = NYC.overlays.find(
  (id) => !SF.overlays.includes(id) && id !== EXCLUSIVE,
) as OverlayId;
const set = (...ids: OverlayId[]): ReadonlySet<OverlayId> => new Set(ids);

test("the fixtures name real layers", () => {
  expect(EXCLUSIVE).toBeDefined();
  expect(NYC_ONLY).toBeDefined();
  expect(NYC.overlays).toContain("canopy");
  expect(SF.overlays).toContain("canopy");
});

test("a layer switches on beside the others and off again", () => {
  const on = toggleOverlay(set("canopy"), NYC_ONLY);
  expect(on).toEqual(new Set<OverlayId>(["canopy", NYC_ONLY]));
  expect([...toggleOverlay(on, NYC_ONLY)]).toEqual(["canopy"]);
});

test("the exclusive layer replaces every other, and any other replaces it", () => {
  const solo = toggleOverlay(set("canopy", NYC_ONLY), EXCLUSIVE);
  expect([...solo]).toEqual([EXCLUSIVE]);
  expect([...toggleOverlay(solo, "canopy")]).toEqual(["canopy"]);
});

test("a layer the city doesn't offer isn't drawn there, and is back with its city", () => {
  const chosen = set("canopy", NYC_ONLY);
  expect([...shownOverlays(chosen, SF, [])]).toEqual(["canopy"]);
  expect(shownOverlays(chosen, NYC, [])).toEqual(chosen);
});

test("a layer hidden from the menu is not drawn, since it would have no row to turn it off", () => {
  expect([...shownOverlays(set("canopy", NYC_ONLY), NYC, ["canopy"])]).toEqual([
    NYC_ONLY,
  ]);
});

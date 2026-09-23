import { expect, test } from "bun:test";
import { paintRules } from "protomaps-leaflet";
import { VOYAGER } from "./flavor";
import { basemapPaintRules } from "./rules";

// Pins that the library still has boundary rules and none survive, so a layer rename fails here.
const boundaries = (rules: readonly { dataLayer: string }[]) =>
  rules.filter((rule) => rule.dataLayer === "boundaries");

test("the library draws boundaries and we draw none of them", () => {
  expect(boundaries(paintRules(VOYAGER as never)).length).toBeGreaterThan(0);
  expect(boundaries(basemapPaintRules(VOYAGER))).toEqual([]);
});

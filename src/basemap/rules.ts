import {
  type LabelRule,
  labelRules,
  type PaintRule,
  paintRules,
} from "protomaps-leaflet";
import { type Flavor, VOYAGER } from "./flavor";

// Adjustments on top of Protomaps' own rules so a library upgrade keeps its improvements.
// Voyager's street ribbons are visibly fatter than Protomaps'.
const ROAD_WIDTH = 1.45;

// Voyager names about twice as many streets at z15; streets with no name in the tile still can't be.
const LABEL_ZOOM_SHIFT = 2;

// Protomaps exports no type for the symbolizer's fields.
type Width = number | ((zoom: number) => number);

function scaled(width: unknown, factor: number): Width | undefined {
  if (typeof width === "number") {
    return width * factor;
  }
  if (typeof width === "function") {
    const original = width as (zoom: number) => number;
    return (zoom: number) => original(zoom) * factor;
  }
  return undefined; // not a width this rule uses; leave it alone
}

// Boundaries are dropped: in range only county lines draw, which in New York cut through the boroughs.
export function basemapPaintRules(flavor: Flavor = VOYAGER): PaintRule[] {
  return paintRules(flavor as never)
    .filter((rule) => rule.dataLayer !== "boundaries")
    .map((rule) => {
      if (rule.dataLayer !== "roads") {
        return rule;
      }
      const symbolizer = rule.symbolizer as unknown as { width?: unknown };
      const width = scaled(symbolizer.width, ROAD_WIDTH);
      if (width === undefined) {
        return rule;
      }
      // Copied rather than mutated so a caller reusing a rule doesn't get it widened twice.
      return {
        ...rule,
        symbolizer: Object.assign(
          Object.create(Object.getPrototypeOf(rule.symbolizer)),
          rule.symbolizer,
          { width },
        ),
      };
    });
}

export function basemapLabelRules(
  flavor: Flavor = VOYAGER,
  lang = "en",
): LabelRule[] {
  return labelRules(flavor as never, lang).map((rule) =>
    rule.dataLayer === "roads" && rule.minzoom !== undefined
      ? { ...rule, minzoom: Math.max(0, rule.minzoom - LABEL_ZOOM_SHIFT) }
      : rule,
  );
}

import type { City } from "../cities";
import {
  MdAccountBalance,
  MdConstruction,
  MdDirectionsCar,
  MdFactory,
  MdMapsHomeWork,
  MdPalette,
  MdStorefront,
  MdTerrain,
  MdWbShade,
  PiBoatFill,
  PiTrainSimpleFill,
  PiTreeFill,
  PiTreeStructureFill,
} from "../icons/glyphs";
import type { IconData, IconSpec } from "../icons/types";
import {
  CANOPY_HEX,
  ELEVATION_SUMMIT_HEX,
  PALETTES,
  rgbCss,
  type ThemeName,
} from "../theme/palette";
import {
  ART_COLOR,
  COMMERCIAL_COLOR,
  FERRY_COLOR,
  HIGHWAY_COLOR,
  HISTORIC_COLOR,
  INDUSTRIAL_COLOR,
  LANDMARK_COLOR,
  LEGACY_COLOR,
  SHED_COLOR,
  SUBWAY_COLOR,
} from "./colors";

export type OverlayId =
  | "canopy"
  | "genus"
  | "landmarks"
  | "art"
  | "ferries"
  | "subway"
  | "highways"
  | "commercial"
  | "industrial"
  | "historic"
  | "legacy"
  | "shade"
  | "scaffolding"
  | "elevation";

// Tinted per map theme, since a Tailwind tint shows only one half of the light/dark pair.
function layerIcon(
  glyph: IconData,
  color: Record<ThemeName, string>,
): IconSpec {
  return { glyph, class: "h-4 w-4", color };
}

// The canopy ramp's mid stop, the tree slider's color too.
const CANOPY_ICON: Record<ThemeName, string> = {
  light: CANOPY_HEX.light[5],
  dark: CANOPY_HEX.dark[5],
};

export function overlayLabel(overlay: OverlayDef, city: City): string {
  return typeof overlay.label === "string"
    ? overlay.label
    : overlay.label(city);
}

export function overlaySwatch(
  overlay: OverlayDef,
  theme: ThemeName,
): string | null {
  return overlay.swatch?.(theme) ?? null;
}

// A link or stored set can name genus with others; an exclusive layer named at all wins.
export function applyExclusivity(ids: readonly OverlayId[]): OverlayId[] {
  const solo = ids.find(
    (id) => OVERLAYS.find((overlay) => overlay.id === id)?.exclusive,
  );
  return solo ? [solo] : [...ids];
}

export interface OverlayDef {
  id: OverlayId;
  // A function where the name varies by city (the subway vs. Muni and BART).
  label: string | ((city: City) => string);
  icon: IconSpec; // menu glyph, drawn aria-hidden; a tinted one shows the layer's color code
  // Read off what the layer paints so the two can't drift; null for a layer with no single color.
  swatch: ((theme: ThemeName) => string) | null;
  // When on, no other overlay is.
  exclusive?: boolean;
}

// Drives the layers menu; components/overlay-views.ts holds what each id mounts on the map.
export const OVERLAYS: readonly OverlayDef[] = [
  {
    id: "canopy",
    label: "Tree canopy",
    // Tinted with what the layer paints, unlike the other overlays' plain icons.
    icon: layerIcon(PiTreeFill, CANOPY_ICON),
    // The stop a leafy street lands on; the faint end is bare ground and the full end rare.
    swatch: (theme) => rgbCss(PALETTES[theme].canopy.stops[4]),
  },
  {
    id: "commercial",
    label: "Commercial",
    icon: layerIcon(MdStorefront, COMMERCIAL_COLOR),
    swatch: (theme) => COMMERCIAL_COLOR[theme],
  },
  {
    id: "shade",
    label: "Shade",
    icon: { glyph: MdWbShade, class: "h-4 w-4 text-slate-500" },
    swatch: (theme) => rgbCss(PALETTES[theme].shade.stops[0]),
  },
  {
    id: "elevation",
    label: "Elevation",
    icon: layerIcon(MdTerrain, ELEVATION_SUMMIT_HEX),
    // The summit end, since the valley green would be mistaken for canopy.
    swatch: (theme) => {
      const { stops } = PALETTES[theme].elevation;
      return rgbCss(stops[stops.length - 1]);
    },
  },
  {
    id: "historic",
    // Whole landmarked neighborhoods, not the individual buildings the "Landmarks" overlay dots.
    label: "Historic",
    icon: layerIcon(MdMapsHomeWork, HISTORIC_COLOR),
    swatch: (theme) => HISTORIC_COLOR[theme],
  },
  {
    id: "legacy",
    // Every one has traded fifty years, which is the entry condition, so the label needn't say so.
    label: "Businesses",
    icon: layerIcon(MdStorefront, LEGACY_COLOR),
    swatch: (theme) => LEGACY_COLOR[theme],
  },
  {
    id: "landmarks",
    label: "Landmarks",
    icon: layerIcon(MdAccountBalance, LANDMARK_COLOR),
    swatch: (theme) => LANDMARK_COLOR[theme],
  },
  {
    id: "art",
    label: "Public art",
    icon: layerIcon(MdPalette, ART_COLOR),
    swatch: (theme) => ART_COLOR[theme],
  },
  {
    id: "ferries",
    label: "Ferry routes",
    icon: layerIcon(PiBoatFill, FERRY_COLOR),
    swatch: (theme) => FERRY_COLOR[theme],
  },
  {
    id: "subway",
    label: (city) => (city.id === "sf" ? "Muni & BART" : "Subway"),
    icon: layerIcon(PiTrainSimpleFill, SUBWAY_COLOR),
    swatch: (theme) => SUBWAY_COLOR[theme],
  },
  {
    id: "highways",
    label: "Highways",
    icon: layerIcon(MdDirectionsCar, HIGHWAY_COLOR),
    swatch: (theme) => HIGHWAY_COLOR[theme],
  },
  {
    id: "industrial",
    label: "Industrial",
    icon: layerIcon(MdFactory, INDUSTRIAL_COLOR),
    swatch: (theme) => INDUSTRIAL_COLOR[theme],
  },
  {
    id: "scaffolding",
    label: "Scaffolding",
    icon: layerIcon(MdConstruction, SHED_COLOR),
    swatch: (theme) => SHED_COLOR[theme],
  },
  // Genus recolors every tree, so it doesn't compose with the other layers.
  {
    id: "genus",
    label: "Genus canopy",
    icon: { glyph: PiTreeStructureFill, class: "h-4 w-4" },
    swatch: null, // a color per genus, in its own key
    exclusive: true,
  },
];

export function isOverlayId(value: string): value is OverlayId {
  return OVERLAYS.some((overlay) => overlay.id === value);
}

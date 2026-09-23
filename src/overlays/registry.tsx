"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import type { IconType } from "react-icons";
import type { City } from "../cities";
import {
  MdAccountBalance,
  MdConstruction,
  MdDirectionsCar,
  MdFactory,
  MdMapsHomeWork,
  MdPalette,
  MdTerrain,
  MdStorefront,
  MdWbShade,
} from "react-icons/md";
import {
  PiBoatFill,
  PiTrainSimpleFill,
  PiTreeFill,
  PiTreeStructureFill,
} from "react-icons/pi";
import ElevationLegend from "../../components/elevation-legend";
import TreeLegend from "../../components/tree-legend";
import { useMapTheme } from "../../components/use-map-theme";
import { PALETTES, rgbCss, type ThemeName } from "../theme/palette";
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

// The layers touch `window` at import; browser-only also keeps Leaflet out of the server bundle.
const StreetScoreLayer = dynamic(
  () => import("../../components/street-score-layer"),
  { ssr: false },
);
const CanopyLayer = dynamic(() => import("../../components/canopy-layer"), {
  ssr: false,
});
const GenusLayer = dynamic(() => import("../../components/genus-gl-layer"), {
  ssr: false,
});
const DiningLayer = dynamic(() => import("../../components/dining-layer"), {
  ssr: false,
});
const ShadeLayer = dynamic(() => import("../../components/shade-layer"), {
  ssr: false,
});
const PoiLayer = dynamic(() => import("../../components/poi-layer"), {
  ssr: false,
});
const LinesLayer = dynamic(() => import("../../components/lines-layer"), {
  ssr: false,
});
const SubwayLayer = dynamic(() => import("../../components/subway-layer"), {
  ssr: false,
});
const ShedLayer = dynamic(() => import("../../components/shed-layer"), {
  ssr: false,
});
const IndustrialLayer = dynamic(
  () => import("../../components/industrial-layer"),
  { ssr: false },
);
const HistoricLayer = dynamic(() => import("../../components/historic-layer"), {
  ssr: false,
});
const ElevationLayer = dynamic(
  () => import("../../components/elevation-layer"),
  { ssr: false },
);

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

// Reads the map's theme, since a Tailwind tint shows only one half of the light/dark pair.
function LayerIcon({
  Icon,
  color,
}: {
  Icon: IconType;
  color: Record<ThemeName, string>;
}) {
  const theme = useMapTheme();
  return (
    <Icon
      className="h-4 w-4"
      style={{ color: color[theme] }}
      aria-hidden="true"
    />
  );
}

export function overlayLabel(overlay: OverlayDef, city: City): string {
  return typeof overlay.label === "string" ? overlay.label : overlay.label(city);
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
  icon: ReactNode; // menu glyph; a tinted one shows the layer's color code
  render: () => ReactNode; // the Leaflet layer(s) this overlay mounts on the map
// Read off what the layer paints so the two can't drift; null for a layer with no single color.
  swatch: ((theme: ThemeName) => string) | null;
  legend?: ReactNode; // floating key shown while this overlay is active
// When on, no other overlay is.
  exclusive?: boolean;
}

// Drives both the layers menu and what the map mounts.
export const OVERLAYS: readonly OverlayDef[] = [
  {
    id: "canopy",
    label: "Tree canopy",
// Tinted with what the layer paints, unlike the other overlays' plain icons.
    icon: <PiTreeFill className="h-4 w-4 text-teal-600" aria-hidden="true" />,
// The stop a leafy street lands on; the faint end is bare ground and the full end rare.
    swatch: (theme) => rgbCss(PALETTES[theme].canopy.stops[4]),
    render: () => (
      <>
        <CanopyLayer />
        <StreetScoreLayer />
      </>
    ),
  },
  {
    id: "commercial",
    label: "Commercial",
    icon: <LayerIcon Icon={MdStorefront} color={COMMERCIAL_COLOR} />,
    swatch: (theme) => COMMERCIAL_COLOR[theme],
    render: () => <DiningLayer />,
  },
  {
    id: "shade",
    label: "Shade",
    icon: <MdWbShade className="h-4 w-4 text-slate-500" aria-hidden="true" />,
    swatch: (theme) => rgbCss(PALETTES[theme].shade.stops[0]),
    render: () => <ShadeLayer />,
  },
  {
    id: "elevation",
    label: "Elevation",
    icon: <MdTerrain className="h-4 w-4 text-amber-700" aria-hidden="true" />,
// The summit end, since the valley green would be mistaken for canopy.
    swatch: (theme) => {
      const { stops } = PALETTES[theme].elevation;
      return rgbCss(stops[stops.length - 1]);
    },
    render: () => <ElevationLayer />,
    legend: <ElevationLegend />,
  },
  {
    id: "historic",
// Whole landmarked neighborhoods, not the individual buildings the "Landmarks" overlay dots.
    label: "Historic",
    icon: <LayerIcon Icon={MdMapsHomeWork} color={HISTORIC_COLOR} />,
    swatch: (theme) => HISTORIC_COLOR[theme],
    render: () => <HistoricLayer />,
  },
  {
    id: "legacy",
// Every one has traded fifty years, which is the entry condition, so the label needn't say so.
    label: "Businesses",
    icon: <LayerIcon Icon={MdStorefront} color={LEGACY_COLOR} />,
    swatch: (theme) => LEGACY_COLOR[theme],
    render: () => (
      <PoiLayer
        overlay="legacy"
        dir="legacy"
        magic="LGCY"
        color={LEGACY_COLOR}
        labelAnchor="top"
      />
    ),
  },
  {
    id: "landmarks",
    label: "Landmarks",
    icon: <LayerIcon Icon={MdAccountBalance} color={LANDMARK_COLOR} />,
    swatch: (theme) => LANDMARK_COLOR[theme],
    render: () => (
      <PoiLayer
        overlay="landmarks"
        dir="landmarks"
        magic="LMRK"
        color={LANDMARK_COLOR}
        labelAnchor="top"
      />
    ),
  },
  {
    id: "art",
    label: "Public art",
    icon: <LayerIcon Icon={MdPalette} color={ART_COLOR} />,
    swatch: (theme) => ART_COLOR[theme],
    render: () => (
      <PoiLayer overlay="art" dir="art" magic="ARTW" color={ART_COLOR} labelAnchor="bottom" />
    ),
  },
  {
    id: "ferries",
    label: "Ferry routes",
    icon: <LayerIcon Icon={PiBoatFill} color={FERRY_COLOR} />,
    swatch: (theme) => FERRY_COLOR[theme],
    render: () => <LinesLayer overlay="ferries" dir="ferries" format="ferr" color={FERRY_COLOR} />,
  },
  {
    id: "subway",
    label: (city) => (city.id === "sf" ? "Muni & BART" : "Subway"),
    icon: <LayerIcon Icon={PiTrainSimpleFill} color={SUBWAY_COLOR} />,
    swatch: (theme) => SUBWAY_COLOR[theme],
    render: () => <SubwayLayer />,
  },
  {
    id: "highways",
    label: "Highways",
    icon: <LayerIcon Icon={MdDirectionsCar} color={HIGHWAY_COLOR} />,
    swatch: (theme) => HIGHWAY_COLOR[theme],
    render: () => <LinesLayer overlay="highways" dir="highways" format="hway" color={HIGHWAY_COLOR} />,
  },
  {
    id: "industrial",
    label: "Industrial",
    icon: <LayerIcon Icon={MdFactory} color={INDUSTRIAL_COLOR} />,
    swatch: (theme) => INDUSTRIAL_COLOR[theme],
    render: () => <IndustrialLayer />,
  },
  {
    id: "scaffolding",
    label: "Scaffolding",
    icon: <LayerIcon Icon={MdConstruction} color={SHED_COLOR} />,
    swatch: (theme) => SHED_COLOR[theme],
    render: () => <ShedLayer />,
  },
// Genus recolors every tree, so it doesn't compose with the other layers.
  {
    id: "genus",
    label: "Tree genus",
    icon: <PiTreeStructureFill className="h-4 w-4" aria-hidden="true" />,
    swatch: null, // a color per genus, in its own key
    render: () => <GenusLayer />,
    legend: <TreeLegend />,
    exclusive: true,
  },
];

export function isOverlayId(value: string): value is OverlayId {
  return OVERLAYS.some((overlay) => overlay.id === value);
}

// Overlay tiles ship values, not colors; src/tiles/theme-gl.ts colors them with these ramps at draw.
// Both palettes are authored: an inverted light one made dense cover dark where dark means empty.

export type ThemeName = "light" | "dark";

export interface Rgb {
  red: number;
  green: number;
  blue: number;
}

// Per layer, so the shader is told rather than knowing.
export type Channel = "red" | "green" | "alpha";

export interface Ramp {
  // Low to high, at most STOPS_LIMIT; one stop is a flat color the value only sets the opacity of.
  stops: readonly Rgb[];
  value: Channel; // picks the color
  // On the channel's own 0..1; the ramp spans the range the city occupies.
  valueFull: number;
  alpha: Channel; // sets the opacity, often the same channel as the color
  alphaFull: number;
  // Exponent on the normalized value; below 1 spends the opacity budget on the faint low end.
  alphaCurve: number;
  maxAlpha: number; // 0..1, the opacity a saturated value reaches
  relief: Channel | null; // multiplies the color, for a layer that carries its own shading
  reliefScale: number; // what that channel is multiplied back out by
}

// The size of the shader's uniform array; raising it is a shader edit too.
export const STOPS_LIMIT = 8;

export function hexToRgb(hex: string): Rgb {
  return {
    red: Number.parseInt(hex.slice(1, 3), 16),
    green: Number.parseInt(hex.slice(3, 5), 16),
    blue: Number.parseInt(hex.slice(5, 7), 16),
  };
}

function stops(...hexes: string[]): readonly Rgb[] {
  return hexes.map(hexToRgb);
}

// Monotonic in lightness and mintier than the emerald route line; darkens on paper, brightens at
// night, and the night ramp is grayer since saturation shouts on a dark ground.
export const CANOPY_HEX: Record<ThemeName, readonly string[]> = {
  light: [
    "#ccfbf1",
    "#99f6e4",
    "#5eead4",
    "#2dd4bf",
    "#14b8a6",
    "#0d9488",
    "#0f766e",
  ],
  dark: [
    "#1c4b47",
    "#23625c",
    "#2d7a71",
    "#3a9488",
    "#4dada0",
    "#6cc6b8",
    "#94ded1",
  ],
};

const CANOPY_STOPS: Record<ThemeName, readonly Rgb[]> = {
  light: stops(...CANOPY_HEX.light),
  dark: stops(...CANOPY_HEX.dark),
};

// Hypsometric, interpolated not banded; the dark set stays mid-light so relief can darken it further.
const ELEVATION_STOPS: Record<ThemeName, readonly Rgb[]> = {
  light: stops(
    "#568460", // valley green
    "#8ca870", // low slope
    "#c4be82", // tan
    "#d6b07a", // ochre
    "#ba8a68", // brown
    "#966c5c", // summit
  ),
  dark: stops(
    "#4a6152", // valley green
    "#5c6f4e", // low slope
    "#7a7654", // olive
    "#8f7452", // tan
    "#9c6f56", // ochre
    "#a2705f", // summit
  ),
};

// Mean cover is single digits and leafy streets 30-60%, so full green is pinned here.
const COVER_FULL = 0.55;

export interface Palette {
  canopy: Ramp;
  elevation: Ramp;
  shade: Ramp;
}

function paletteFor(theme: ThemeName): Palette {
  return {
    // Cover in alpha (crates/tiler/src/canopy.rs); concave since 15% cover reads tree-lined.
    canopy: {
      stops: CANOPY_STOPS[theme],
      value: "alpha",
      valueFull: COVER_FULL,
      alpha: "alpha",
      alphaFull: COVER_FULL,
      alphaCurve: 0.5,
      // A lit wash on a dark ground carries further at the same opacity.
      maxAlpha: theme === "dark" ? 0.58 : 0.62,
      relief: null,
      reliefScale: 1,
    },
    // Height in red, relief in green, ground share in alpha (crates/tiler/src/elevation.rs); relief
    // exceeds 1 to brighten lit faces, matching HILLSHADE_MAX, and opacity keeps the basemap legible.
    elevation: {
      stops: ELEVATION_STOPS[theme],
      value: "red",
      valueFull: 1,
      alpha: "alpha",
      alphaFull: 1,
      alphaCurve: 1,
      maxAlpha: theme === "dark" ? 0.72 : 170 / 255,
      relief: "green",
      reliefScale: 1.15,
    },
    // Light lost in alpha, pre-scaled by sun intensity at bake (crates/tiler/src/shade.rs).
    shade: {
      // A shadow must be darker than the ground, and the night ground is darker than the day slate.
      stops: stops(theme === "dark" ? "#060a12" : "#334155"),
      value: "alpha",
      valueFull: 1,
      alpha: "alpha",
      alphaFull: 1,
      alphaCurve: 1,
      maxAlpha: 1,
      relief: null,
      reliefScale: 1,
    },
  };
}

export const PALETTES: Record<ThemeName, Palette> = {
  light: paletteFor("light"),
  dark: paletteFor("dark"),
};

// A thin line needs more opacity than the field on paper, and less at night, where it blooms to neon.
export const ROAD_OPACITY: Record<ThemeName, number> = {
  light: 1.2,
  dark: 0.9,
};

// The shader's per-pixel math, for ramps drawn in CSS: canopy street lines and the elevation key.
export function rampAt(
  ramp: Ramp,
  value: number,
): { color: Rgb; alpha: number } {
  const { stops: points } = ramp;
  const position =
    Math.min(1, Math.max(0, value / ramp.valueFull)) * (points.length - 1);
  const low = Math.max(0, Math.min(points.length - 2, Math.floor(position)));
  const blend = position - low;
  const from = points[low];
  const to = points[Math.min(points.length - 1, low + 1)];
  return {
    color: {
      red: from.red + (to.red - from.red) * blend,
      green: from.green + (to.green - from.green) * blend,
      blue: from.blue + (to.blue - from.blue) * blend,
    },
    alpha:
      ramp.maxAlpha *
      Math.min(1, Math.max(0, value / ramp.alphaFull)) ** ramp.alphaCurve,
  };
}

export function rgbCss({ red, green, blue }: Rgb): string {
  return `rgb(${Math.round(red)} ${Math.round(green)} ${Math.round(blue)})`;
}

export function rampCss(ramp: Ramp, value: number, opacity = 1): string {
  const { color, alpha } = rampAt(ramp, value);
  const painted = Math.min(1, alpha * opacity);
  return `rgba(${Math.round(color.red)}, ${Math.round(color.green)}, ${Math.round(color.blue)}, ${painted.toFixed(3)})`;
}

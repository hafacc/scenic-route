import type { ThemeName } from "../theme/palette";

// One color per layer in every mode; night halves lift for contrast, day halves hold 3:1 on white.

// Ochre, apart from the sun slider's amber.
export const LANDMARK_COLOR: Record<ThemeName, string> = {
  light: "#bd8c1d",
  dark: "#d7b16d",
};

// Dusty rose, shared by Historic and Street life.
export const LEGACY_COLOR: Record<ThemeName, string> = {
  light: "#c46e83",
  dark: "#e5a2b0",
};

// Ultramarine ink, the one cool dot beside Historic's warm layers.
export const ART_COLOR: Record<ThemeName, string> = {
  light: "#2552aa",
  dark: "#92b8fd",
};

// Also the route layer's ferry-leg color.
export const FERRY_COLOR: Record<ThemeName, string> = {
  light: "#2563eb", // blue-600
  dark: "#60a5fa", // blue-400
};

export const HIGHWAY_COLOR: Record<ThemeName, string> = {
  light: "#ef4444", // red-500
  dark: "#f87171", // red-400
};

// Binary, no intensity grading; dusk violet, Street life's family.
export const COMMERCIAL_COLOR: Record<ThemeName, string> = {
  light: "#8e3eae",
  dark: "#c28bdb",
};

// Brick, Historic's accent; warm against commercial's violet after compositing.
export const HISTORIC_COLOR: Record<ThemeName, string> = {
  light: "#9c3a11",
  dark: "#d98f75",
};

// Muted at night so the full-strength key swatch doesn't shout beside the other washes.
export const INDUSTRIAL_COLOR: Record<ThemeName, string> = {
  light: "#db2777", // pink-600
  dark: "#e085b3",
};

export const SHED_COLOR: Record<ThemeName, string> = {
  light: "#ea580c", // orange-600
  dark: "#fb923c", // orange-400
};

// Routes draw in the agency's colors (src/tiles/subway.ts); this is the feed's A/C/E blue.
export const SUBWAY_COLOR: Record<ThemeName, string> = {
  light: "#0062cf",
  dark: "#4d94ff",
};

// The app's destination green, since the directions control turns a found place into a destination.
export const SEARCH_PIN_COLOR: Record<ThemeName, string> = {
  light: "#34d399", // emerald-400
  dark: "#6ee7b7", // emerald-300
};

import type { ThemeName } from "../theme/palette";

// Night halves lift a step for contrast; the 0.45 area washes are hand-mixed to stay distinct.

// Matches the route panel's scenery sliders.
export const LANDMARK_COLOR: Record<ThemeName, string> = {
  light: "#f59e0b", // amber-500
  dark: "#fbbf24", // amber-400
};

// Darker than landmark amber by day; paler at night, since labels sit on a black halo.
export const LEGACY_COLOR: Record<ThemeName, string> = {
  light: "#ca8a04", // yellow-600
  dark: "#fde047", // yellow-300
};

export const ART_COLOR: Record<ThemeName, string> = {
  light: "#d946ef", // fuchsia-500
  dark: "#e879f9", // fuchsia-400
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

// Binary, no intensity grading; the night violet is hand-mixed to stay apart from historic at 0.45.
export const COMMERCIAL_COLOR: Record<ThemeName, string> = {
  light: "#6d28d9", // violet-700
  dark: "#ac89e6",
};

// The deepest wash day and night, which keeps it apart from commercial after compositing.
export const HISTORIC_COLOR: Record<ThemeName, string> = {
  light: "#4338ca", // indigo-700
  dark: "#6c7eda",
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

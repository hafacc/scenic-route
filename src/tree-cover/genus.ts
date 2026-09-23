// Ids 0..10 are the top genera by rank, 11 is "Other"; categorical, so one palette for both themes.
import { hexToRgb, type Rgb } from "../theme/palette";

export const OTHER_GENUS_ID = 11;

// Spaced around the wheel so a blend of a few never averages onto a third hue.
export const GENUS_HEX: readonly string[] = [
  "#e15759", // red
  "#f28e2b", // orange
  "#edc948", // yellow
  "#8cb43a", // lime
  "#4e9f50", // green
  "#3fb0a0", // teal
  "#4b8fc9", // blue
  "#6a5bd0", // indigo
  "#9b57c4", // violet
  "#c353b0", // magenta
  "#db5478", // rose
  "#9ca3af", // Other — neutral medium gray
];

export const GENUS_COLORS: readonly Rgb[] = GENUS_HEX.map(hexToRgb);

export const GENUS_COUNT = GENUS_COLORS.length;

// A stray id falls to "Other" rather than throwing or borrowing another genus's hue.
export function genusColor(id: number): Rgb {
  if (id < 0 || id >= OTHER_GENUS_ID || !Number.isInteger(id)) {
    return GENUS_COLORS[OTHER_GENUS_ID];
  }
  return GENUS_COLORS[id];
}

export function genusCss(id: number, alpha = 1): string {
  const { red, green, blue } = genusColor(id);
  const bounded = Math.min(1, Math.max(0, alpha));
  return `rgba(${Math.round(red)}, ${Math.round(green)}, ${Math.round(blue)}, ${bounded.toFixed(3)})`;
}

// Ids 0..10 are the top genera by rank, 11 is "Other"; categorical, so one palette for both themes.
import { hexToRgb, type Rgb } from "../theme/palette";

export const OTHER_GENUS_ID = 11;

// Softened and spread in lightness as well as hue, so neighbors stay apart under deuteranopia.
export const GENUS_HEX: readonly string[] = [
  "#a95553", // red, dark
  "#c3854d", // orange
  "#d5b455", // yellow, light
  "#637d21", // olive, dark
  "#61a26a", // green
  "#62cdbc", // teal, light
  "#40a0b9", // cyan-blue
  "#89adf2", // periwinkle, light
  "#c09fd7", // lavender, light
  "#945d7f", // plum, dark
  "#c88197", // rose
  "#a3b39c", // Other: a pale gray sage, also the hue of canopy no inventory names
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

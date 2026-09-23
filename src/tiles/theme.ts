import { PALETTES, type Palette, type ThemeName } from "../theme/palette";

// Set by message; messages arrive in order, so a draw posted after a theme change already sees it.

let theme: ThemeName = "light";

export function setWorkerTheme(next: ThemeName): void {
  theme = next;
}

export function palette(): Palette {
  return PALETTES[theme];
}

// For cache keys; the palette's identity is not a usable key.
export function themeName(): ThemeName {
  return theme;
}

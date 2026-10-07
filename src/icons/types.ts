import type { ThemeName } from "../theme/palette";

// One glyph: the root <svg>'s own attributes, and its children as markup.
export interface IconData {
  attr: Readonly<Record<string, string>>;
  body: string;
}

// A glyph with what its owner dresses it in; `color` is per map theme, and wins over the class's.
export interface IconSpec {
  glyph: IconData;
  class?: string;
  color?: Readonly<Record<ThemeName, string>>;
}

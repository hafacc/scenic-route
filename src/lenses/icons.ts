import {
  MdMapsHomeWork,
  MdStorefront,
  MdUmbrella,
  PiTreeFill,
} from "../icons/glyphs";
import type { IconSpec } from "../icons/types";
import type { LensId } from "./lenses";

// Apart from ./lenses.ts so the routing worker can read the lenses without pulling the glyphs in.
export const LENS_ICONS: Readonly<Record<LensId, IconSpec>> = {
  naturalist: { glyph: PiTreeFill },
  rain: { glyph: MdUmbrella },
  historic: { glyph: MdMapsHomeWork },
  streetlife: { glyph: MdStorefront },
};

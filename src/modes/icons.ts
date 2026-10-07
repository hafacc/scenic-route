import {
  MdMapsHomeWork,
  MdStorefront,
  MdUmbrella,
  PiTreeFill,
} from "../icons/glyphs";
import type { IconSpec } from "../icons/types";
import type { ModeId } from "./modes";

// Apart from ./modes.ts so the routing worker can read the modes without pulling the glyphs in.
export const MODE_ICONS: Readonly<Record<ModeId, IconSpec>> = {
  naturalist: { glyph: PiTreeFill },
  rain: { glyph: MdUmbrella },
  historic: { glyph: MdMapsHomeWork },
  streetlife: { glyph: MdStorefront },
};

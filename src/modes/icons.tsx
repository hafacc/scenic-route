import type { IconType } from "react-icons";
import { MdMapsHomeWork, MdStorefront, MdUmbrella } from "react-icons/md";
import { PiTreeFill } from "react-icons/pi";
import type { ModeId } from "./modes";

// Apart from ./modes.ts so the routing worker can read the modes without pulling React in.
export const MODE_ICONS: Readonly<Record<ModeId, IconType>> = {
  naturalist: PiTreeFill,
  rain: MdUmbrella,
  historic: MdMapsHomeWork,
  streetlife: MdStorefront,
};

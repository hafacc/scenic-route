"use client";

import { MdOutlineHome, MdOutlinePlace, MdSignpost } from "react-icons/md";
import { PiTrainSimpleFill } from "react-icons/pi";
import {
  ADDRESS_RESULT_TYPE,
  INDEX_RESULT_TYPE,
  STREET_RESULT_TYPE,
  SUBWAY_RESULT_TYPE,
} from "../src/geocode";
import { SUBWAY_COLOR } from "../src/overlays/colors";
import { useMapTheme } from "./use-map-theme";

const GLYPH = "h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500";

export default function ResultGlyph({ type }: { type: string }) {
  const theme = useMapTheme();
  if (type === ADDRESS_RESULT_TYPE) {
    return <MdOutlineHome className={GLYPH} aria-hidden="true" />;
  } else if (type === SUBWAY_RESULT_TYPE) {
    // The layer menu's subway color in the map's theme, so list and map show the same blue.
    return (
      <PiTrainSimpleFill
        className="h-4 w-4 shrink-0"
        style={{ color: SUBWAY_COLOR[theme] }}
        aria-hidden="true"
      />
    );
  } else if (type === STREET_RESULT_TYPE) {
    return <MdSignpost className={GLYPH} aria-hidden="true" />;
  } else if (type === INDEX_RESULT_TYPE) {
    // One pin for every place; a glyph per category would be 1,639 of them.
    return <MdOutlinePlace className={GLYPH} aria-hidden="true" />;
  } else {
    return null;
  }
}

// What the route cards share that is not a component.
import type { CardSummary, ChipView } from "../../src/lenses/cards";

export interface CardView {
  summary: CardSummary;
  color: string;
  chips: ChipView[];
}

// Inline rather than a flex item, so a summary too long for its row ellipses like a sentence.
const PILL_SHAPE =
  "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 align-middle text-[11px] font-bold leading-none";
export const PILL = `ml-1 ${PILL_SHAPE}`;
export const FERRY_PILL = `mr-1 ${PILL_SHAPE}`;

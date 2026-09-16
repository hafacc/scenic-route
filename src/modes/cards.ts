// The line of text and the colour a card wears, worked out apart from the card that says it. A card
// says what a route IS — never how the planner found it, and never what it avoided.

import { SCENIC_KEYS, type ScenicKey } from "../routing/cost";
import { formatDistance, formatDuration } from "../routing/directions";
import { FACTORS, type FactorKey } from "../routing/factors";
import type { FerryLeg } from "../routing/search";
import type { FactorAvailability, Mode } from "./modes";

// The colour a single route has always been drawn in, worn here by the least scenic card.
export const DIRECT_COLOR = "#334155";

// A boat ridden, as the card says it: the minutes it costs, the wait on the pier included, because
// waiting on the pier is time spent taking the boat. A boat has no line bullet to wear, so the pill
// is drawn from the glyph and colour the ferry layer already uses and the name is not said.
export interface FerrySummary {
  seconds: number;
}

export function ferrySummaries(ferries: readonly FerryLeg[]): FerrySummary[] {
  return ferries.map((ferry) => ({
    seconds: ferry.waitSeconds + ferry.crossingSeconds,
  }));
}

export interface CardSummary {
  travelSeconds: number;
  walkMeters: number; // walking-only, so a ferry crossing is timed rather than counted as mileage
  ferries: readonly FerrySummary[];
}

// One boat, which the rich row draws as a boat pill and its minutes.
export interface FerrySegment {
  kind: "ferry";
  minutes: string;
}

export type LinePart = string | FerrySegment;

// Which of the two numbers leads. Modes says the time first, because a card is chosen on it;
// Explorer has always led with the distance, and a gate on its screenshots says it still does.
export type SummaryOrder = "time" | "distance";

// The legs in the order they are taken, each boat its own segment.
function legParts(card: CardSummary): LinePart[] {
  return card.ferries.map((ferry) => ({
    kind: "ferry" as const,
    minutes: formatDuration(ferry.seconds),
  }));
}

// "58 min · 1.2 mi walk · 14 min by ferry", in segments, so the plain string and the rich row cannot
// drift. The mileage earns the word "walk" only beside a leg nobody walks: on a card that is all
// walking the mileage IS the trip, and saying so would be saying it twice.
export function summaryParts(
  card: CardSummary,
  order: SummaryOrder = "time",
): LinePart[] {
  return [...summaryNumbers(card, order), ...summaryLegs(card)];
}

// The two numbers alone, and the legs alone. A header narrow enough that the two together ellipse —
// a phone, with a boat pill and a line bullet on the row — says the numbers and carries the legs
// down to the row below, where the chips already scroll.
export function summaryNumbers(
  card: CardSummary,
  order: SummaryOrder = "time",
): LinePart[] {
  const time = formatDuration(card.travelSeconds);
  const distance = `${formatDistance(card.walkMeters)}${legParts(card).length > 0 ? " walk" : ""}`;
  return order === "time" ? [time, distance] : [distance, time];
}

export function summaryLegs(card: CardSummary): LinePart[] {
  return legParts(card);
}

// The plain string: the peek bar's fallback, a card button's label, and the summary Explorer prints.
// Both numbers are spelled as the maneuvers spell them, so a card and its own directions agree — a
// short walk reads "300 ft" in both rather than "0.0 mi" here.
export function cardLine(
  card: CardSummary,
  order: SummaryOrder = "time",
): string {
  return summaryParts(card, order)
    .map((part) =>
      typeof part === "string" ? part : `${part.minutes} by ferry`,
    )
    .join(" · ");
}

// A penalty is what a route avoided, which no card reports on; nor a factor this city cannot answer.
export function chipFactors(
  mode: Mode,
  available: FactorAvailability,
): ScenicKey[] {
  return SCENIC_KEYS.filter(
    (key) => (mode.weights[key] ?? 0) > 0 && available[key],
  );
}

export interface CardRank {
  scenicScore: number;
  colorFactor: FactorKey | null; // the feature this route has markedly more of
}

function factorColor(key: FactorKey): string | null {
  return FACTORS.find((factor) => factor.key === key)?.color ?? null;
}

// One colour per card, every one of them a colour the mode's own layers already draw with, so the
// lines and the map read as the same palette. The ends are fixed: the most scenic card wears the
// mode's colour and the least scenic the slate a lone route has always been. Between them, a card
// that stands out on one factor wears that factor's colour, and the rest take the mode's palette in
// order, skipping anything already spoken for.
export function cardColors(mode: Mode, cards: readonly CardRank[]): string[] {
  const byScore = [...cards.keys()].sort(
    (left, right) => cards[right].scenicScore - cards[left].scenicScore,
  );
  const standouts = cards.map((card) =>
    card.colorFactor === null ? null : factorColor(card.colorFactor),
  );
  const used = new Set<string>([mode.color]);
  for (const standout of standouts) {
    if (standout !== null) {
      used.add(standout);
    }
  }
  let next = 0;
  return [...cards.keys()].map((index) => {
    const standout = standouts[index];
    if (index === byScore[0]) {
      return mode.color;
    } else if (index === byScore[byScore.length - 1]) {
      return DIRECT_COLOR;
    } else if (standout !== null) {
      return standout;
    } else {
      while (next < mode.palette.length && used.has(mode.palette[next])) {
        next++;
      }
      const picked = mode.palette[next] ?? mode.color;
      used.add(picked);
      return picked;
    }
  });
}

// One card's chips, as the card holds them: the RAW factor share, rounded to the number drawn.
export interface ChipView {
  key: FactorKey;
  percent: number;
  best: boolean;
}

// A chip says what a route HAS, so a factor whose share rounds to nothing is left off the card
// altogether. The bold one is then the best of the cards still saying it.
export function visibleChips(
  keys: readonly FactorKey[],
  shares: readonly Partial<Record<FactorKey, number>>[],
): ChipView[][] {
  const percents = shares.map((factors) =>
    keys.map((key) => Math.round((factors[key] ?? 0) * 100)),
  );
  // Nothing drawn is at 0, so starting there both skips the hidden chips and keeps the earliest of
  // two equal cards, which is the most scenic of them.
  const bestCards = keys.map((_, column) => {
    let bestCard: number | null = null;
    let bestPercent = 0;
    for (const [card, row] of percents.entries()) {
      if (row[column] > bestPercent) {
        bestPercent = row[column];
        bestCard = card;
      }
    }
    return bestCard;
  });
  return percents.map((row, card) =>
    keys.flatMap((key, column) =>
      row[column] === 0
        ? []
        : [{ key, percent: row[column], best: bestCards[column] === card }],
    ),
  );
}

// The line of text and the colour a card wears, worked out apart from the card that says it. A card
// says what a route IS — never how the planner found it, and never what it avoided.

import { SCENIC_KEYS, type ScenicKey } from "../routing/cost";
import { formatDistance, formatDuration } from "../routing/directions";
import { FACTORS, type FactorKey } from "../routing/factors";
import type { FerryLeg, TransitLeg } from "../routing/search";
import type { FactorAvailability, Mode } from "./modes";

// The colour a single route has always been drawn in, worn here by the least scenic card.
export const DIRECT_COLOR = "#334155";

// A line the reader rides, as the card says it: what the sign calls it, the livery the agency
// publishes, and the minutes it costs — the platform wait included, because waiting for the A is
// time spent taking the A.
export interface RideSummary {
  shortName: string;
  color: string;
  textColor: string;
  seconds: number;
}

// A line no route names, which is what a ride with no timetable route on it falls back to.
const UNNAMED_RIDE = { color: "#334155", textColor: "#ffffff", name: "train" };

export function rideSummaries(rides: readonly TransitLeg[]): RideSummary[] {
  return rides.map((ride) => ({
    shortName: ride.route?.shortName ?? "",
    color: ride.route?.color ?? UNNAMED_RIDE.color,
    textColor: ride.route?.textColor ?? UNNAMED_RIDE.textColor,
    seconds: ride.waitSeconds + ride.rideSeconds,
  }));
}

// A boat ridden, as the card says it: the minutes it costs, the wait on the pier included for the
// reason a train's is. A boat has no line bullet to wear, so the pill is drawn from the glyph and
// colour the ferry layer already uses and the name is not said.
export interface FerrySummary {
  seconds: number;
  // Trains ridden before this boat, which is all it takes to put the two kinds of leg in trip order.
  ridesBefore: number;
}

export function ferrySummaries(ferries: readonly FerryLeg[]): FerrySummary[] {
  return ferries.map((ferry) => ({
    seconds: ferry.waitSeconds + ferry.crossingSeconds,
    ridesBefore: ferry.ridesBefore,
  }));
}

export interface CardSummary {
  travelSeconds: number;
  walkMeters: number; // walking-only, so a ferry crossing is timed rather than counted as mileage
  ferries: readonly FerrySummary[];
  rides: readonly RideSummary[];
}

// The rides of a summary as one segment: "12 min on the A", "14 min on the A then L". Rendered rich
// (./route-cards) the names become the lines' own bullets, so the segment is kept whole rather than
// spelled into the string here.
export interface RideSegment {
  kind: "rides";
  minutes: string;
  rides: readonly RideSummary[];
}

// One boat, which the rich row draws as a boat pill and its minutes.
export interface FerrySegment {
  kind: "ferry";
  minutes: string;
}

export type LinePart = string | RideSegment | FerrySegment;

// Which of the two numbers leads. Modes says the time first, because a card is chosen on it;
// Explorer has always led with the distance, and a gate on its screenshots says it still does.
export type SummaryOrder = "time" | "distance";

function rideSegment(rides: readonly RideSummary[]): RideSegment | null {
  if (rides.length === 0) {
    return null;
  } else {
    const seconds = rides.reduce((total, ride) => total + ride.seconds, 0);
    return { kind: "rides", minutes: formatDuration(seconds), rides };
  }
}

// The legs in the order they are taken: a run of trains is one segment, each boat its own, and a
// boat caught between two trains splits them — which is what the trip was.
function legParts(card: CardSummary): LinePart[] {
  const parts: LinePart[] = [];
  let spelled = 0;
  for (const ferry of card.ferries) {
    const before = rideSegment(card.rides.slice(spelled, ferry.ridesBefore));
    if (before) {
      parts.push(before);
    }
    spelled = ferry.ridesBefore;
    parts.push({ kind: "ferry", minutes: formatDuration(ferry.seconds) });
  }
  const after = rideSegment(card.rides.slice(spelled));
  if (after) {
    parts.push(after);
  }
  return parts;
}

// "58 min · 1.2 mi walk · 14 min by ferry · 12 min on the A", in segments, so the plain string and
// the rich row cannot drift. The mileage earns the word "walk" only beside a leg nobody walks: on a
// card that is all walking the mileage IS the trip, and saying so would be saying it twice.
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

// The names of the lines ridden, as a sentence says them: "A", "A then L", "A, C then L".
export function rideNames(rides: readonly RideSummary[]): string {
  const names = rides.map((ride) => ride.shortName || UNNAMED_RIDE.name);
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  return `${names.slice(0, -1).join(", ")} then ${names[names.length - 1]}`;
}

// The plain string: the peek bar's fallback, a card button's label, and the summary Explorer prints.
// Both numbers are spelled as the maneuvers spell them, so a card and its own directions agree — a
// short walk reads "300 ft" in both rather than "0.0 mi" here.
export function cardLine(
  card: CardSummary,
  order: SummaryOrder = "time",
): string {
  return summaryParts(card, order)
    .map((part) => {
      if (typeof part === "string") {
        return part;
      } else if (part.kind === "ferry") {
        return `${part.minutes} by ferry`;
      } else {
        return `${part.minutes} on the ${rideNames(part.rides)}`;
      }
    })
    .join(" · ");
}

// What a chip's number says. Shelter is the one factor a card reads backwards: in the rain the
// question is how long you are out in it, so the chip counts EXPOSURE — 100 less the shelter the
// route was scored on — and the lowest of them is the bold one, which is the same card the shelter
// mean already bolds. The score, the colours and the order of the cards are the mean throughout;
// only this number is turned over.
export interface ChipReading {
  percent: number;
  exposure: boolean;
}

export function chipReading(key: FactorKey, percent: number): ChipReading {
  return key === "shelter"
    ? { percent: 100 - percent, exposure: true }
    : { percent, exposure: false };
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

// One card's chips, as the card holds them: the RAW factor share, which `chipReading` turns over for
// the rain when it is drawn.
export interface ChipView {
  key: FactorKey;
  percent: number;
  best: boolean;
}

// A chip says what a route HAS, so a factor whose share rounds to nothing is left off the card
// altogether — the rain's included, where a route with no shelter at all would otherwise wear a 100.
// The bold one is then the best of the cards still saying it.
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

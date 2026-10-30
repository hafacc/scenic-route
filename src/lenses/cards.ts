// A card says what a route is, never how the planner found it or what it avoided.

import { PENALTY_KEYS, type RouteWeights } from "../routing/cost";
import {
  durationMinutes,
  formatDistance,
  formatDuration,
} from "../routing/directions";
import {
  chipPercent,
  FACTORS,
  type FactorKey,
  UNCHIPPED,
} from "../routing/factors";
import type { FerryLeg, RouteResult, TransitLeg } from "../routing/search";
import type { Lens } from "./lenses";

// The single-route color, worn by the least scenic card.
export const DIRECT_COLOR = "#334155";

export interface LineBullet {
  shortName: string;
  color: string;
  textColor: string;
}

// `seconds` is the ride alone, as its step in the directions shows it; the wait is only in the total.
export interface RideSummary extends LineBullet {
  seconds: number;
}

// For a ride with no timetable route.
const UNNAMED_RIDE = { color: "#334155", textColor: "#ffffff", name: "train" };

export function rideSummaries(rides: readonly TransitLeg[]): RideSummary[] {
  return rides.map((ride) => ({
    shortName: ride.route?.shortName ?? "",
    color: ride.route?.color ?? UNNAMED_RIDE.color,
    textColor: ride.route?.textColor ?? UNNAMED_RIDE.textColor,
    seconds: ride.rideSeconds,
  }));
}

// `seconds` is what the boat's step shows: its crossing, or with no timetable the baked figure.
export interface FerrySummary {
  seconds: number;
  // Trains ridden before this boat, which orders the two kinds of leg.
  ridesBefore: number;
}

export function ferrySummaries(ferries: readonly FerryLeg[]): FerrySummary[] {
  return ferries.map((ferry) => ({
    seconds: ferry.crossingSeconds,
    ridesBefore: ferry.ridesBefore,
  }));
}

export interface CardSummary {
  travelSeconds: number;
  walkMeters: number; // walking-only, so a ferry crossing is timed rather than counted as mileage
  ferries: readonly FerrySummary[];
  rides: readonly RideSummary[];
}

// Kept whole rather than spelled out, since the rich row renders the names as line bullets.
export interface RideSegment {
  kind: "rides";
  minutes: string;
  rides: readonly RideSummary[];
}

export interface FerrySegment {
  kind: "ferry";
  minutes: string;
}

export type LinePart = string | RideSegment | FerrySegment;

// Explorer leads with distance, and a gate on its screenshots checks that it still does.
export type SummaryOrder = "time" | "distance";

function rideSegment(rides: readonly RideSummary[]): RideSegment | null {
  if (rides.length === 0) {
    return null;
  } else {
    // Each ride rounded as its own step is, so the segment is exactly the sum of those steps.
    const minutes = rides.reduce(
      (total, ride) => total + durationMinutes(ride.seconds),
      0,
    );
    return { kind: "rides", minutes: `${minutes} min`, rides };
  }
}

// A run of trains is one segment, and a boat between two trains splits them.
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

// Segments keep the plain string and rich row in step; "walk" appears only beside a non-walking leg.
export function summaryParts(
  card: CardSummary,
  order: SummaryOrder = "time",
): LinePart[] {
  return [...summaryNumbers(card, order), ...summaryLegs(card)];
}

// Split so a narrow header can carry the legs down to the chip row.
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

// "A", "A then L", "A, C then L".
export function rideNames(rides: readonly RideSummary[]): string {
  const names = rides.map((ride) => ride.shortName || UNNAMED_RIDE.name);
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  return `${names.slice(0, -1).join(", ")} then ${names[names.length - 1]}`;
}

// Spelled as the maneuvers spell distances, so a short walk reads "300 ft" in both.
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

export interface CardRank {
  scenicScore: number;
  colorFactor: FactorKey | null; // the feature this route has markedly more of
}

function factorColor(key: FactorKey): string | null {
  return FACTORS.find((factor) => factor.key === key)?.color ?? null;
}

// Ends wear the lens's color and the lone-route slate; standouts their factor's color, else palette.
export function cardColors(lens: Lens, cards: readonly CardRank[]): string[] {
  const byScore = [...cards.keys()].sort(
    (left, right) => cards[right].scenicScore - cards[left].scenicScore,
  );
  // A standout in the accent's own color would pass for the top card, so it falls back to the palette.
  const standouts = cards.map((card) => {
    const color =
      card.colorFactor === null ? null : factorColor(card.colorFactor);
    return color === lens.color ? null : color;
  });
  const used = new Set<string>([lens.color]);
  for (const standout of standouts) {
    if (standout !== null) {
      used.add(standout);
    }
  }
  let next = 0;
  return [...cards.keys()].map((index) => {
    const standout = standouts[index];
    if (index === byScore[0]) {
      return lens.color;
    } else if (index === byScore[byScore.length - 1]) {
      return DIRECT_COLOR;
    } else if (standout !== null) {
      return standout;
    } else {
      while (next < lens.palette.length && used.has(lens.palette[next])) {
        next++;
      }
      const picked = lens.palette[next] ?? lens.color;
      used.add(picked);
      return picked;
    }
  });
}

// The key a card chip is drawn by; `unwalked` is the new-streets side of `familiar`.
export type ChipKey = FactorKey | "sheds" | "unwalked";

// `percent` is the number drawn, shelter already read as exposure.
export interface CardChip {
  key: ChipKey;
  percent: number;
  best: boolean;
}

// What a card reads its chips from: the factor shares plus the two a route carries outside them.
export type CardShares = Partial<Record<FactorKey | "sheds", number>>;

export function cardShares(
  result: Pick<RouteResult, "factors" | "familiar" | "sheds">,
): CardShares {
  return { ...result.factors, familiar: result.familiar, sheds: result.sheds };
}

interface ChipRule {
  key: ChipKey;
  share: FactorKey | "sheds";
  // Whether a bigger drawn number is the better route.
  more: boolean;
  shown: (percent: number) => number;
  // Hidden rather than drawn, so a route with none of a thing doesn't wear a zero.
  hidden: (percent: number) => boolean;
}

const asIs = (percent: number): number => percent;
const isZero = (percent: number): boolean => percent === 0;
const PENALTIES: ReadonlySet<FactorKey> = new Set<FactorKey>(PENALTY_KEYS);

// Every factor the router priced, in the factors' own order, then scaffolding when it was avoided.
function chipRules(weights: RouteWeights): ChipRule[] {
  const rules: ChipRule[] = [];
  for (const { key } of FACTORS) {
    const weight = weights[key];
    if (weight === 0) {
    } else if (key === "shelter") {
      // Exposure, since in rain the question is time spent out in it; no shelter at all isn't drawn.
      rules.push({
        key,
        share: key,
        more: false,
        shown: (percent) => 100 - percent,
        hidden: isZero,
      });
    } else if (key === "familiar") {
      const walked = weight > 0;
      rules.push({
        key: walked ? key : "unwalked",
        share: key,
        more: true,
        shown: walked ? asIs : (percent) => 100 - percent,
        hidden: walked ? isZero : (percent) => percent === 100,
      });
    } else if (!UNCHIPPED.has(key)) {
      // A penalty, or the shade side of sun, is better the less of it the route has.
      const more = !PENALTIES.has(key) && weight > 0;
      rules.push({ key, share: key, more, shown: asIs, hidden: isZero });
    }
  }
  if (!weights.allowSheds) {
    rules.push({
      key: "sheds",
      share: "sheds",
      more: false,
      shown: asIs,
      hidden: isZero,
    });
  }
  return rules;
}

// Bold goes to every best card, unless the best draws nothing or every card ties.
export function cardChips(
  weights: RouteWeights,
  shares: readonly CardShares[],
): CardChip[][] {
  const rules = chipRules(weights);
  const percents = shares.map((card) =>
    rules.map((rule) => chipPercent(card[rule.share] ?? 0)),
  );
  const bestCards = rules.map((rule, column): ReadonlySet<number> => {
    const shown = percents.map((row) => rule.shown(row[column]));
    const target = rule.more ? Math.max(...shown) : Math.min(...shown);
    const hidden = percents.map((row) => rule.hidden(row[column]));
    const best = [...shown.keys()].filter((card) => shown[card] === target);
    const drawn = hidden.filter((isHidden) => !isHidden).length;
    // Cards that all read the same have no best among them.
    const level = drawn > 1 && best.length === drawn;
    return level || best.some((card) => hidden[card])
      ? new Set()
      : new Set(best);
  });
  return percents.map((row, card) =>
    rules.flatMap((rule, column) =>
      rule.hidden(row[column])
        ? []
        : [
            {
              key: rule.key,
              percent: rule.shown(row[column]),
              best: bestCards[column].has(card),
            },
          ],
    ),
  );
}

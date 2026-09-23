// A card says what a route is, never how the planner found it or what it avoided.

import { SCENIC_KEYS, type ScenicKey } from "../routing/cost";
import { formatDistance, formatDuration } from "../routing/directions";
import { FACTORS, type FactorKey } from "../routing/factors";
import type { FerryLeg, TransitLeg } from "../routing/search";
import type { FactorAvailability, Mode } from "./modes";

// The single-route color, worn by the least scenic card.
export const DIRECT_COLOR = "#334155";

// `seconds` includes the platform wait.
export interface RideSummary {
  shortName: string;
  color: string;
  textColor: string;
  seconds: number;
}

// For a ride with no timetable route.
const UNNAMED_RIDE = { color: "#334155", textColor: "#ffffff", name: "train" };

export function rideSummaries(rides: readonly TransitLeg[]): RideSummary[] {
  return rides.map((ride) => ({
    shortName: ride.route?.shortName ?? "",
    color: ride.route?.color ?? UNNAMED_RIDE.color,
    textColor: ride.route?.textColor ?? UNNAMED_RIDE.textColor,
    seconds: ride.waitSeconds + ride.rideSeconds,
  }));
}

// `seconds` includes the pier wait; a boat has no line bullet, so its pill reuses the ferry glyph.
export interface FerrySummary {
  seconds: number;
  // Trains ridden before this boat, which orders the two kinds of leg.
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
    const seconds = rides.reduce((total, ride) => total + ride.seconds, 0);
    return { kind: "rides", minutes: formatDuration(seconds), rides };
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

// Shelter chips show exposure (100 less shelter), since in rain the question is time spent out in it.
export interface ChipReading {
  percent: number;
  exposure: boolean;
}

export function chipReading(key: FactorKey, percent: number): ChipReading {
  return key === "shelter"
    ? { percent: 100 - percent, exposure: true }
    : { percent, exposure: false };
}

// Penalties aren't reported, nor factors this city can't answer.
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

// Ends wear the mode's color and the lone-route slate; standouts their factor's color, else palette.
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

// The raw share; `chipReading` inverts shelter when drawn.
export interface ChipView {
  key: FactorKey;
  percent: number;
  best: boolean;
}

// A share that rounds to zero is dropped, so a route with no shelter doesn't wear a 100 exposure.
export function visibleChips(
  keys: readonly FactorKey[],
  shares: readonly Partial<Record<FactorKey, number>>[],
): ChipView[][] {
  const percents = shares.map((factors) =>
    keys.map((key) => Math.round((factors[key] ?? 0) * 100)),
  );
  // Starting at 0 skips hidden chips and keeps the earlier, more scenic, of two equal cards.
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

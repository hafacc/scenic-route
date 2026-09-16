"use client";

import { Fragment, type ReactElement } from "react";
import { FiLoader } from "react-icons/fi";
import { MdWaterDrop } from "react-icons/md";
import { PiBoatFill } from "react-icons/pi";
import {
  type CardSummary,
  type ChipView,
  cardLine,
  chipReading,
  type LinePart,
  type RideSummary,
  type SummaryOrder,
  summaryLegs,
  summaryNumbers,
  summaryParts,
} from "../../src/modes/cards";
import { FERRY_COLOR } from "../../src/overlays/colors";
import { FACTORS } from "../../src/routing/factors";
import { useMapTheme } from "../use-map-theme";

export interface CardView {
  summary: CardSummary;
  color: string;
  chips: ChipView[];
}

// A line's own bullet, in the livery the agency publishes: the map's colour, said on the card. Set
// inline rather than as a flex item, so a summary too long for its row ellipses like any sentence.
const PILL_SHAPE =
  "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 align-middle text-[11px] font-bold leading-none";
// A ride's bullet follows its minutes ("12 min on the A"); a boat's leads them, having no name to be
// read as part of the sentence.
const PILL = `ml-1 ${PILL_SHAPE}`;
const FERRY_PILL = `mr-1 ${PILL_SHAPE}`;

export function LinePill({
  ride,
  className,
}: {
  ride: RideSummary;
  className?: string;
}) {
  return (
    <span
      className={className ?? PILL}
      style={{ backgroundColor: ride.color, color: ride.textColor }}
    >
      {ride.shortName || "Train"}
    </span>
  );
}

// The summary, with the lines ridden drawn as their bullets rather than named. Same segments as
// `cardLine`, which is what the button's label and the peek bar still say in plain words.
function LegParts({ parts, lead }: { parts: LinePart[]; lead: boolean }) {
  return (
    <>
      {parts.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a summary's segments are fixed and ordered
        <Fragment key={index}>
          {lead || index > 0 ? (
            <span className="px-1 text-slate-400">·</span>
          ) : null}
          {typeof part === "string" ? (
            part
          ) : part.kind === "ferry" ? (
            <>
              <FerryPill />
              {part.minutes}
            </>
          ) : (
            <>
              {part.minutes} on
              {part.rides.map((ride, seat) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the trip's order IS a ride's identity
                <LinePill key={seat} ride={ride} />
              ))}
            </>
          )}
        </Fragment>
      ))}
    </>
  );
}

// `legs` says where a trip's boats and trains go. Inline they finish the sentence, which is what a
// list card wants; "row" leaves them off, for a header narrow enough that a pill and its minutes
// would ellipse the line away — `CardLegs` then puts them at the head of the chips row, which
// scrolls instead of truncating.
export function CardLine({
  summary,
  order,
  legs = "inline",
}: {
  summary: CardSummary;
  order?: SummaryOrder;
  legs?: "inline" | "row";
}) {
  const parts =
    legs === "inline"
      ? summaryParts(summary, order)
      : summaryNumbers(summary, order);
  return (
    <span className="block truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
      <LegParts parts={parts} lead={false} />
    </span>
  );
}

// The same segments, for the chips row. Null where the trip walks the whole way.
export function CardLegs({
  summary,
}: {
  summary: CardSummary;
}): ReactElement | null {
  const parts = summaryLegs(summary);
  if (parts.length === 0) {
    return null;
  }
  return (
    <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">
      <LegParts parts={parts} lead={false} />
    </span>
  );
}

// No agency numbers a boat the way a line is numbered, so the bullet is the glyph the ferry layer
// and the drawn ferry leg already wear, in the same blue.
function FerryPill() {
  const theme = useMapTheme();
  return (
    <span
      className={FERRY_PILL}
      style={{ backgroundColor: FERRY_COLOR[theme], color: "#ffffff" }}
    >
      <PiBoatFill className="h-3 w-3" aria-hidden={true} />
    </span>
  );
}

export function CardNumber({ index, color }: { index: number; color: string }) {
  return (
    <span
      className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white"
      style={{ backgroundColor: color }}
    >
      {index + 1}
    </span>
  );
}

// The drop an exposure reading wears (`chipReading`) instead of the shelter icon: the number counts
// the rain you are out in, so a bigger one has to read as wetter.
const EXPOSURE = { Icon: MdWaterDrop, label: "Rain exposure" };

export function CardChips({
  chips,
  lead,
}: {
  chips: CardView["chips"];
  lead?: ReactElement | null;
}) {
  return (
    <span className="chip-row gap-x-2.5">
      {lead}
      {chips.map((chip) => {
        const factor = FACTORS.find((entry) => entry.key === chip.key);
        if (!factor) {
          return null;
        }
        const { percent, exposure } = chipReading(chip.key, chip.percent);
        const Icon = exposure ? EXPOSURE.Icon : factor.Icon;
        return (
          <span
            key={chip.key}
            title={exposure ? EXPOSURE.label : factor.label}
            className={`inline-flex items-center gap-1 text-xs tabular-nums ${factor.tint} ${
              chip.best ? "font-bold" : "font-medium"
            }`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden={true} />
            {percent}
          </span>
        );
      })}
    </span>
  );
}

// The first sweep of all, with no cards to hold: the route already on the map, in the place its
// card will take, so the list does not jump when the rest of them arrive.
export function GhostCard({
  line,
  color,
}: {
  line: string | null;
  color: string;
}) {
  return (
    <div className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2 py-1.5">
      <CardNumber index={0} color={color} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
          {line ?? "Finding routes…"}
        </span>
        <FiLoader
          className="mt-0.5 h-3.5 w-3.5 animate-spin text-slate-400"
          aria-hidden={true}
        />
      </span>
    </div>
  );
}

// In the plan's own order. Tapping one is the same act as tapping its line on the map; hovering one
// draws its line the way the chosen one is drawn, which is the answer to "which of these is that".
export default function RouteCards({
  cards,
  selected,
  dimmed,
  onSelect,
  onHover,
}: {
  cards: readonly CardView[];
  selected: number | null;
  // These cards are the last plan's and a new one is on its way, so they are held but not offered.
  dimmed: boolean;
  onSelect: (index: number) => void;
  onHover: (index: number | null) => void;
}) {
  return (
    <div
      className={`min-h-0 shrink space-y-0.5 overflow-y-auto overscroll-contain ${
        dimmed ? "pointer-events-none opacity-50" : ""
      }`}
      onPointerLeave={() => onHover(null)}
    >
      {cards.map((card, index) => (
        <button
          // Two cards can round to the same line, and a mode's colour is one of its factors' too.
          // biome-ignore lint/suspicious/noArrayIndexKey: the plan's order IS a card's identity
          key={index}
          type="button"
          onClick={() => onSelect(index)}
          // A touch fires this too, and on a touch the pointer never leaves — but the tap that
          // sends it is choosing the card anyway, so the highlight it lights is the right one.
          onPointerEnter={(event) => {
            if (event.pointerType !== "touch") {
              onHover(index);
            }
          }}
          aria-pressed={index === selected}
          // The rich line is bullets and numbers; a reader who hears the card rather than sees it
          // gets the same sentence in words.
          aria-label={`${index + 1} ${cardLine(card.summary)}`}
          className={`flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition hover:bg-slate-100 dark:hover:bg-slate-700/60 ${
            index === selected ? "bg-slate-100 dark:bg-slate-700/60" : ""
          }`}
        >
          <CardNumber index={index} color={card.color} />
          <span className="min-w-0 flex-1">
            <CardLine summary={card.summary} />
            {card.chips.length > 0 ? <CardChips chips={card.chips} /> : null}
          </span>
        </button>
      ))}
    </div>
  );
}

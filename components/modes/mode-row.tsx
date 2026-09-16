"use client";

import { type KeyboardEvent, useEffect, useRef } from "react";
import { MODE_ICONS } from "../../src/modes/icons";
import type { Mode, ModeId } from "../../src/modes/modes";

// One component in two placements: it heads the card on a phone and floats above the map on a wide
// screen. The active chip is filled in the mode's own colour, which its routes are drawn in.
//
// On a phone only that chip carries its name — four modes and the switches beside them do not fit a
// 375 px row otherwise, and the icon is what the reader is picking by anyway.
export default function ModeRow({
  modes,
  active,
  className,
  onSelect,
}: {
  modes: readonly Mode[];
  active: ModeId;
  className?: string;
  onSelect: (id: ModeId) => void;
}) {
  const row = useRef<HTMLDivElement | null>(null);
  const chosen = useRef<HTMLButtonElement | null>(null);

  // The row is wider than a phone, and the chip that says which mode you are in is the one that
  // must not be the one scrolled off. Written rather than `scrollIntoView` so nothing but this row
  // can move. A wide screen has no overflow to scroll, and the write is a no-op there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dep is the trigger, not a read
  useEffect(() => {
    const container = row.current;
    const chip = chosen.current;
    if (container && chip) {
      container.scrollLeft = Math.max(
        0,
        chip.offsetLeft - (container.clientWidth - chip.clientWidth) / 2,
      );
    }
  }, [active]);

  // Arrows move through the modes and choose as they go, which is what a radio group does.
  const handleKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const at = modes.findIndex((mode) => mode.id === active);
    const next = modes[(at + step + modes.length) % modes.length];
    if (next) {
      onSelect(next.id);
    }
  };

  return (
    <div
      ref={row}
      role="radiogroup"
      aria-label="Mode"
      onKeyDown={handleKey}
      className={`chip-row gap-1 ${className ?? ""}`}
    >
      {modes.map((mode) => {
        const Icon = MODE_ICONS[mode.id];
        const on = mode.id === active;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a radio input cannot be a filled chip
          <button
            key={mode.id}
            ref={on ? chosen : null}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onSelect(mode.id)}
            aria-label={mode.name}
            title={mode.name}
            className={`flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full text-xs font-semibold transition ${
              on
                ? "px-2.5 text-white shadow-sm"
                : "w-8 bg-slate-100 text-slate-600 hover:bg-slate-200 md:w-auto md:px-2.5 dark:bg-slate-700/60 dark:text-slate-300 dark:hover:bg-slate-700"
            }`}
            style={on ? { backgroundColor: mode.color } : undefined}
          >
            <Icon className="h-4 w-4" aria-hidden={true} />
            <span className={on ? "" : "hidden md:inline"}>{mode.name}</span>
          </button>
        );
      })}
    </div>
  );
}

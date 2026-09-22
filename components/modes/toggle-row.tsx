"use client";

import type { IconType } from "react-icons";
import {
  MdDirectionsBoat,
  MdHorizontalRule,
  MdLandscape,
  MdTerrain,
  MdWbShade,
  MdWbSunny,
  MdWbTwilight,
} from "react-icons/md";
import type { FactorAvailability } from "../../src/modes/modes";
import { HILLS_VALUES, SUN_VALUES, type Toggles } from "../../src/modes/modes";

// Icons with no words: the glyph says which state a switch is in, color says it is doing
// something, and the label is left to the screen reader. One tap moves to the next state.
//
// One component in two placements, as the mode row is: on a phone it is pinned at the end of that
// row, which the chips scroll under, and on a wide screen it is its own pill beside it.

const GRAY = "text-slate-400 dark:text-slate-500";

interface ToggleFace {
  Icon: IconType;
  tint: string;
  label: string;
}

const SUN_FACES: Readonly<Record<Toggles["sun"], ToggleFace>> = {
  sun: {
    Icon: MdWbSunny,
    tint: "text-amber-500 dark:text-amber-400",
    label: "Walk in the sun",
  },
  shade: {
    Icon: MdWbShade,
    tint: "text-sky-600 dark:text-sky-400",
    label: "Walk in the shade",
  },
  neutral: { Icon: MdWbTwilight, tint: GRAY, label: "Sun and shade ignored" },
};

const HILL_FACES: Readonly<Record<Toggles["hills"], ToggleFace>> = {
  any: {
    Icon: MdTerrain,
    tint: "text-amber-700 dark:text-amber-500",
    label: "Hills are fine",
  },
  some: {
    Icon: MdLandscape,
    tint: "text-amber-700 dark:text-amber-500",
    label: "Fewer hills",
  },
  none: { Icon: MdHorizontalRule, tint: GRAY, label: "Avoid hills" },
};

const FERRY_FACES: Readonly<Record<"on" | "off", ToggleFace>> = {
  on: {
    Icon: MdDirectionsBoat,
    tint: "text-blue-600 dark:text-blue-400",
    label: "Ferries allowed",
  },
  off: { Icon: MdDirectionsBoat, tint: GRAY, label: "Ferries barred" },
};

function next<Value extends string>(
  values: readonly Value[],
  current: Value,
): Value {
  return values[(values.indexOf(current) + 1) % values.length];
}

function ToggleButton({
  face,
  pressed,
  onClick,
}: {
  face: ToggleFace;
  // Only the two-state switches: a tri-state is not pressed or unpressed, and its label is the
  // whole of what it says.
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={face.label}
      title={face.label}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-700 ${face.tint}`}
    >
      <face.Icon className="h-[18px] w-[18px]" aria-hidden={true} />
    </button>
  );
}

export default function ToggleRow({
  toggles,
  available,
  onChange,
}: {
  toggles: Toggles;
  // A switch with no data behind it is hidden, not grayed: grayed reads as a state the reader chose.
  available: FactorAvailability;
  onChange: (toggles: Toggles) => void;
}) {
  return (
    <div className="flex shrink-0 items-center">
      {available.shade ? (
        <ToggleButton
          face={SUN_FACES[toggles.sun]}
          onClick={() =>
            onChange({ ...toggles, sun: next(SUN_VALUES, toggles.sun) })
          }
        />
      ) : null}
      {available.hill ? (
        <ToggleButton
          face={HILL_FACES[toggles.hills]}
          onClick={() =>
            onChange({ ...toggles, hills: next(HILLS_VALUES, toggles.hills) })
          }
        />
      ) : null}
      {available.ferry ? (
        <ToggleButton
          face={FERRY_FACES[toggles.ferries ? "on" : "off"]}
          pressed={toggles.ferries}
          onClick={() => onChange({ ...toggles, ferries: !toggles.ferries })}
        />
      ) : null}
    </div>
  );
}

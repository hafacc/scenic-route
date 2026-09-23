"use client";

import type {
  FactorAvailability,
  Mode,
  ModeId,
  Toggles,
} from "../../src/modes/modes";
import ModeRow from "./mode-row";
import ToggleRow from "./toggle-row";

export default function ModeBar({
  modes,
  mode,
  toggles,
  available,
  onMode,
  onToggles,
}: {
  modes: readonly Mode[];
  mode: ModeId;
  toggles: Toggles;
  available: FactorAvailability;
  onMode: (id: ModeId) => void;
  onToggles: (toggles: Toggles) => void;
}) {
  return (
    <>
      <ModeRow
        modes={modes}
        active={mode}
        className="min-w-0 flex-1"
        onSelect={onMode}
      />
      <span
        className="mx-2 h-6 w-px shrink-0 bg-slate-200 dark:bg-slate-600"
        aria-hidden={true}
      />
      <ToggleRow toggles={toggles} available={available} onChange={onToggles} />
    </>
  );
}

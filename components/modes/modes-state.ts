// The deck's state, typed here so the page and its two slots share it.
import type { ModeId, Toggles } from "../../src/modes/modes";
import type { EndpointsKey } from "../../src/modes/selection";
import type { ShellDeck } from "../shell-types";
import type { CardView } from "./route-cards";

export interface ModesState {
  // What the reader picked; a city that doesn't offer it substitutes its own first mode.
  modeId: ModeId;
  toggles: Toggles;
  alt: number | null;
  cards: readonly CardView[];
  // A sweep is running; a dragged pin holds the plan the same way, which the slots add from the shell.
  planning: boolean;
  planningLine: string | null;
  // A destination field just emptied on the directions screen; a question, not a way back.
  directionsOpen: boolean;
  onMode: (id: ModeId) => void;
  onToggles: (toggles: Toggles) => void;
  onSelect: (index: number) => void;
  onHover: (index: number | null) => void;
  onBack: () => void;
  onClose: () => void;
  // True when an endpoint moved, which replans.
  onEndpoints: (key: EndpointsKey | null) => boolean;
}

// Replanning leaves no chosen route to peek at, so the shrunk card comes back.
export function expand(shell: ShellDeck): void {
  if (shell.minimized) {
    shell.onToggleMinimize();
  }
}

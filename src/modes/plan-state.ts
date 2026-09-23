// What the cards and the lines are, and what is on its way to replacing them.

import type { Plan } from "../routing/alternatives";
import type { RouteClock } from "../routing/contexts";
import type { RoutingGraph } from "../routing/graph";
import type { RouteResult } from "../routing/search";
import type { FactorAvailability, Mode } from "./modes";

// The plan on screen, held until another one is DONE: a mode, a switch or a moved endpoint starts a
// sweep that takes a second or more, and clearing the list to wait for it is the one thing the
// reader is certain to be looking at.
export interface LandedPlan {
  id: number;
  graph: RoutingGraph;
  // What the sweep was run under, which is what its cards are colored and chipped from — the
  // reader can already be in another mode by the time it lands.
  mode: Mode;
  available: FactorAvailability;
  plan: Plan;
}

// The sweep in flight. Its streamed max-scenic candidate is the map's only route while there is no
// landed plan at all; with one to hold, that route would replace the drawn one mid-answer.
export interface PendingPlan {
  id: number;
  graph: RoutingGraph;
  preview: RouteResult | null;
}

export interface PlanState {
  landed: LandedPlan | null;
  pending: PendingPlan | null;
  // The instant these routes depart at, captured when the reader asked for them and held until they
  // ask something else. Modes routes at "now", and a "now" that follows the wall clock re-plans the
  // cards under the reader mid-read. Null until the first ask, which leaves the shell's live clock.
  capturedAt: RouteClock | null;
}

export const NO_PLAN: PlanState = {
  landed: null,
  pending: null,
  capturedAt: null,
};

// The departure instant as the router's clock. The minute it falls in is what keys the sun and
// timetable fields a search is costed against, so two asks in the same minute reuse them.
export function planClock(dateMs: number): RouteClock {
  return { tick: Math.floor(dateMs / 60_000), dateMs };
}

export type PlanAction =
  // The reader changed the question, so the departure time becomes now again.
  | { kind: "captured"; clock: RouteClock }
  | { kind: "started"; id: number; graph: RoutingGraph }
  | { kind: "preview"; id: number; result: RouteResult }
  | { kind: "landed"; landed: LandedPlan }
  // The sweep answered with nothing, or threw. Either way it is over.
  | { kind: "failed"; id: number }
  | { kind: "cleared" };

// Every transition is guarded on the sweep's own id: a sweep that ends after a newer one started
// says nothing about the newer one, and a sweep left holding the flag it never cleared is what
// leaves the cards dimmed under "Recomputing…" for good.
export function planReducer(state: PlanState, action: PlanAction): PlanState {
  switch (action.kind) {
    case "captured":
      return { ...state, capturedAt: action.clock };
    case "started":
      return {
        ...state,
        pending: { id: action.id, graph: action.graph, preview: null },
      };
    case "preview":
      return state.pending?.id === action.id
        ? {
            ...state,
            pending: { ...state.pending, preview: action.result },
          }
        : state;
    case "landed":
      // A sweep whose flag is no longer flying was closed or overtaken while it ran: its routes
      // answer a question nobody is asking any more, and one landed after the card closed would draw
      // a route to a destination that is gone.
      return state.pending?.id === action.landed.id
        ? { ...state, landed: action.landed, pending: null }
        : state;
    case "failed":
      return state.pending?.id === action.id
        ? { ...state, pending: null }
        : state;
    case "cleared":
      return NO_PLAN;
  }
}

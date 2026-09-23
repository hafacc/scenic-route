import type { Plan } from "../routing/alternatives";
import type { RouteClock } from "../routing/contexts";
import type { RoutingGraph } from "../routing/graph";
import type { RouteResult } from "../routing/search";
import type { FactorAvailability, Mode } from "./modes";

// Held until the next sweep lands, since clearing the list to wait is what the reader would see.
export interface LandedPlan {
  id: number;
  graph: RoutingGraph;
  // The sweep's own mode, since the reader may have switched by the time it lands.
  mode: Mode;
  available: FactorAvailability;
  plan: Plan;
}

// The streamed preview is drawn only when no plan has landed, or it would replace a drawn route.
export interface PendingPlan {
  id: number;
  graph: RoutingGraph;
  preview: RouteResult | null;
}

export interface PlanState {
  landed: LandedPlan | null;
  pending: PendingPlan | null;
  // Captured per ask, since a "now" that follows the wall clock would re-plan cards mid-read.
  capturedAt: RouteClock | null;
}

export const NO_PLAN: PlanState = {
  landed: null,
  pending: null,
  capturedAt: null,
};

// The minute keys the sun and timetable fields, so asks in the same minute reuse them.
export function planClock(dateMs: number): RouteClock {
  return { tick: Math.floor(dateMs / 60_000), dateMs };
}

export type PlanAction =
  | { kind: "captured"; clock: RouteClock }
  | { kind: "started"; id: number; graph: RoutingGraph }
  | { kind: "preview"; id: number; result: RouteResult }
  | { kind: "landed"; landed: LandedPlan }
  | { kind: "failed"; id: number }
  | { kind: "cleared" };

// Guarded on the sweep's id, or a stale sweep could leave the cards dimmed under "Recomputing…".
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
      // A sweep no longer pending was closed or overtaken, so its routes answer nothing.
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

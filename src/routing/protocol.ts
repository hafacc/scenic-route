// The messages the page and the routing worker exchange. Types only, so the page can talk to the
// worker without pulling the engine — and with it the whole cost model — into the main bundle.

import type { Plan } from "./alternatives";
import type { RouteClock } from "./contexts";
import type { RouteWeights } from "./cost";
import type { GraphIdentity } from "./graph";
import type { RouteResult } from "./search";
import type { Snap } from "./snap";

export interface PlanRequest {
  cityId: string;
  clock: RouteClock;
  start: Snap;
  dest: Snap;
  weights: RouteWeights; // the mode's effective weights, toggles folded in, backed off from here
}

export type RouterRequest =
  // The graph's own bytes, cloned rather than refetched: the page has already downloaded them.
  | {
      type: "load";
      cityId: string;
      buffer: ArrayBuffer;
      identity: GraphIdentity;
      base: string; // the page's base, which a worker cannot derive — see artifact-base.ts
    }
  | {
      type: "route";
      id: number;
      cityId: string;
      clock: RouteClock;
      weights: RouteWeights;
      start: Snap;
      dest: Snap;
    }
  | { type: "drag:start"; which: "start" | "dest" }
  | {
      type: "drag:move";
      id: number;
      cityId: string;
      clock: RouteClock;
      weights: RouteWeights;
      anchor: Snap; // the endpoint being held, which the gesture's solver is rooted at
      moving: Snap; // the endpoint under the cursor
      // 0 for a dest drag; for a start drag, which solves backward, the drawn route's trip time
      anchorSeconds: number;
    }
  | { type: "drag:end" }
  // Drop the weight brackets, whose stale baseline would read an endpoint drop's route as unchanged.
  | { type: "reset" }
  // Every route a mode offers, from one set of endpoints (src/routing/alternatives.ts).
  | { type: "plan"; id: number; request: PlanRequest };

export type RouterResponse =
  | {
      type: "result";
      id: number;
      result: RouteResult | null;
      changed: boolean; // false when the path matches the previous search's route
      shadeRebuilt: boolean;
      shadeLost: boolean;
    }
  // Superseded before it ran; this only settles the promise the page is waiting on.
  | { type: "stale"; id: number }
  | { type: "error"; id: number; message: string }
  // A plan streams each distinct route as it is found, max-scenic first, then closes with the set.
  | { type: "candidate"; id: number; index: number; result: RouteResult }
  | { type: "done"; id: number; plan: Plan };

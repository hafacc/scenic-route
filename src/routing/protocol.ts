// The messages the page and the routing worker exchange. Types only, so the page can talk to the
// worker without pulling the engine — and with it the whole cost model — into the main bundle.
//
// Every search runs in the worker, so a request carries the whole context one needs: which city's
// graph, the clock the fields are built for, the weights, and the snapped endpoints. Snapping stays
// on the page, which already holds a snap index for the endpoint markers and is where the "too far"
// and "disconnected" messages are worded.

import type { RouteClock } from "./contexts";
import type { RouteWeights } from "./cost";
import type { GraphIdentity } from "./graph";
import type { RouteResult } from "./search";
import type { Snap } from "./snap";

// Phase 4's planner holds these fixed across a plan's searches, so they ride the request rather than
// each weight vector. Their shape belongs to the modes UI; the worker only carries them through.
export type PlanToggles = Readonly<Record<string, string | boolean>>;

// What a plan is asked for, apart from the weight vectors it sweeps.
export interface PlanRequest {
  cityId: string;
  clock: RouteClock;
  start: Snap;
  dest: Snap;
}

export type RouterRequest =
  // The graph's own bytes, cloned rather than refetched: the page has already downloaded them and the
  // worker decodes its own copy. Room for a per-graph table (the subway timetable) goes here.
  | {
      type: "load";
      cityId: string;
      buffer: ArrayBuffer;
      identity: GraphIdentity;
      // The page's own base. Artifact paths are written relative to it, and a worker resolves a
      // relative path against the chunk it was served from instead — see artifact-base.ts.
      base: string;
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
      // Forward seconds since departure at the anchor: 0 for a dest drag, the drawn route's trip time
      // for a start drag, which solves backward from the destination.
      anchorSeconds: number;
    }
  | { type: "drag:end" }
  // Drop the weight brackets. An endpoint drop needs it: the drag bypassed them, so their stale
  // baseline would read the exact drop route as unchanged.
  | { type: "reset" }
  // Reserved for phase 4 (src/routing/alternatives.ts); the worker answers it with an error today.
  | {
      type: "plan";
      id: number;
      request: PlanRequest;
      weights: readonly RouteWeights[];
      toggles: PlanToggles;
    };

export type RouterResponse =
  | {
      type: "result";
      id: number;
      result: RouteResult | null;
      // false when the path is identical to the one the previous search returned, so the page can
      // leave the drawn route untouched.
      changed: boolean;
      shadeRebuilt: boolean;
      shadeLost: boolean;
    }
  // A newer request has already superseded this one, so it was never run. The page has moved on too;
  // this only settles the promise it is waiting on.
  | { type: "stale"; id: number }
  | { type: "error"; id: number; message: string }
  // Reserved for phase 4: a plan streams its candidates as they are found, then closes.
  | { type: "candidate"; id: number; index: number; result: RouteResult }
  | { type: "done"; id: number };

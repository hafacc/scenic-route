// The messages the page and the routing worker exchange. Types only, so the page can talk to the
// worker without pulling the engine — and with it the whole cost model — into the main bundle.

import type { Plan } from "./alternatives";
import type { RouteClock } from "./contexts";
import type { RouteWeights } from "./cost";
import type { GraphIdentity } from "./graph";
import type { RouteResult, RouteStep } from "./search";
import type { Snap } from "./snap";
import type { WaypointPlan } from "./waypoints";

// One search, or the whole set of them a mode offers: the same question either way, answered with
// one route or with a plan. The weights are the mode's own, toggles folded in, which a plan then
// backs off from.
export interface RouteRequest {
  cityId: string;
  clock: RouteClock;
  weights: RouteWeights;
  start: Snap;
  dest: Snap;
}

export interface DragRequest {
  cityId: string;
  clock: RouteClock;
  weights: RouteWeights;
  anchor: Snap; // the endpoint being held, which the gesture's solver is rooted at
  moving: Snap; // the endpoint under the cursor
  // 0 for a dest drag; for a start drag, which solves backward, the drawn route's trip time
  anchorSeconds: number;
}

// The chosen route, to be squeezed into the pins the Google Maps export hands over. Its steps and
// nothing else: that is all the planner reads, and a result's stitched path would dwarf them on the
// wire. What the pins are priced against — the shade and shed fields — only the worker builds.
export interface WaypointRequest {
  cityId: string;
  clock: RouteClock;
  weights: RouteWeights;
  steps: RouteStep[];
}

export type RouterRequest =
  // The graph's own bytes, cloned rather than refetched: the page has already downloaded them.
  | {
      type: "load";
      id: number;
      cityId: string;
      buffer: ArrayBuffer;
      identity: GraphIdentity;
      base: string; // the page's base, which a worker cannot derive — see artifact-base.ts
    }
  | ({ type: "route"; id: number } & RouteRequest)
  | { type: "drag:start"; which: "start" | "dest" }
  | ({ type: "drag:move"; id: number } & DragRequest)
  | { type: "drag:end" }
  // Drop the weight brackets, whose stale baseline would read an endpoint drop's route as unchanged.
  | { type: "reset" }
  // Every route a mode offers, from one set of endpoints (src/routing/alternatives.ts).
  | { type: "plan"; id: number; request: RouteRequest }
  | ({ type: "waypoints"; id: number } & WaypointRequest);

export type RouterResponse =
  // The city's graph is decoded and ready to be searched. Answered because a decode can fail — on a
  // phone, for want of memory — and the page has to know rather than wait.
  | { type: "loaded"; id: number }
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
  // The max-scenic route, sent the moment it is found so the map can draw something while the rest
  // of the sweep runs. The alternatives ride back with `done`: the page has nothing to say about a
  // route until the plan settles which of them are cards, and cloning each one twice is not free.
  | { type: "preview"; id: number; result: RouteResult }
  | { type: "done"; id: number; plan: Plan }
  | { type: "waypoints"; id: number; plan: WaypointPlan };

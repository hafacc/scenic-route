// Types only, so talking to the worker doesn't pull the cost model into the main bundle.

import type { Plan } from "./alternatives";
import type { RouteClock } from "./contexts";
import type { RouteWeights } from "./cost";
import type { GraphIdentity } from "./graph";
import type { RouteResult, RouteStep } from "./search";
import type { Snap } from "./snap";
import type { WaypointPlan } from "./waypoints";

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

// Steps only: a result's stitched path would dwarf them on the wire.
export interface WaypointRequest {
  cityId: string;
  clock: RouteClock;
  weights: RouteWeights;
  steps: RouteStep[];
}

export type RouterRequest =
  // Cloned rather than refetched: the page has already downloaded them.
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
  | { type: "plan"; id: number; request: RouteRequest }
  | ({ type: "waypoints"; id: number } & WaypointRequest);

export type RouterResponse =
  // Answered because a decode can fail for want of memory on a phone.
  | { type: "loaded"; id: number }
  | {
      type: "result";
      id: number;
      result: RouteResult | null;
      changed: boolean; // false when the path matches the previous search's route
      shadeRebuilt: boolean;
      shadeLost: boolean;
    }
  | { type: "stale"; id: number }
  | { type: "error"; id: number; message: string }
  // Sent early so the map can draw while the sweep runs; alternatives ride back with `done`.
  | { type: "preview"; id: number; result: RouteResult }
  | { type: "done"; id: number; plan: Plan }
  | { type: "waypoints"; id: number; plan: WaypointPlan };

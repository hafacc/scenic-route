// The page's end of the routing worker. Every search the app runs goes through here; the page keeps
// its graph for the maneuver list, the deck overlays and the endpoint snapping, and never searches.
//
// A request that a newer one overtakes is answered `stale`, which resolves to null: the caller has
// already been superseded — its effect is cancelled — and simply drops the frame.

import type { RouteClock } from "./contexts";
import type { RouteWeights } from "./cost";
import { graphBuffer, type RoutingGraph } from "./graph";
import type { RouterRequest, RouterResponse } from "./protocol";
import type { RouteResult } from "./search";
import type { Snap } from "./snap";

export interface RouteReply {
  result: RouteResult | null;
  changed: boolean;
  shadeRebuilt: boolean;
  shadeLost: boolean;
}

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
  // Forward seconds since departure at the anchor: 0 for a dest drag, the drawn route's trip time
  // for a start drag, which solves backward from the destination.
  anchorSeconds: number;
}

interface Settle {
  resolve: (reply: RouteReply | null) => void;
  reject: (error: Error) => void;
}

export class RouterClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Settle>();
  private readonly loaded = new Set<string>();
  private nextId = 1;

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<RouterResponse>): void => {
      const response = event.data;
      if (response.type === "candidate" || response.type === "done") {
        return; // phase 4's planner; nothing asks for a plan yet
      }
      const settle = this.pending.get(response.id);
      this.pending.delete(response.id);
      if (!settle) {
        return;
      }
      if (response.type === "error") {
        settle.reject(new Error(response.message));
      } else if (response.type === "stale") {
        settle.resolve(null);
      } else {
        settle.resolve({
          result: response.result,
          changed: response.changed,
          shadeRebuilt: response.shadeRebuilt,
          shadeLost: response.shadeLost,
        });
      }
    };
  }

  // Hand the worker its own copy of a city's graph, once. The bytes are cloned rather than fetched
  // again: the page has already downloaded them, and both decoders view their own copy in place.
  load(cityId: string, graph: RoutingGraph): void {
    if (this.loaded.has(cityId)) {
      return;
    }
    const buffer = graphBuffer(cityId);
    if (!buffer) {
      throw new Error(`no downloaded graph bytes for ${cityId}`);
    }
    this.loaded.add(cityId);
    this.post({
      type: "load",
      cityId,
      buffer,
      identity: { hash: graph.hash, keyHash: graph.keyHash },
      base: document.baseURI,
    });
  }

  route(request: RouteRequest): Promise<RouteReply | null> {
    return this.ask((id) => ({ type: "route", id, ...request }));
  }

  dragStart(which: "start" | "dest"): void {
    this.post({ type: "drag:start", which });
  }

  dragMove(request: DragRequest): Promise<RouteReply | null> {
    return this.ask((id) => ({ type: "drag:move", id, ...request }));
  }

  dragEnd(): void {
    this.post({ type: "drag:end" });
  }

  reset(): void {
    this.post({ type: "reset" });
  }

  private ask(
    build: (id: number) => RouterRequest,
  ): Promise<RouteReply | null> {
    const id = this.nextId++;
    return new Promise<RouteReply | null>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post(build(id));
    });
  }

  private post(request: RouterRequest): void {
    this.worker.postMessage(request);
  }
}

let client: RouterClient | null = null;

// Built on first use rather than at import: the export prerenders these modules in node, where there
// is no Worker to construct.
export function routerClient(): RouterClient {
  client ??= new RouterClient();
  return client;
}

// The page's end of the routing worker. A request a newer one overtakes is answered `stale`, which
// resolves to null: the caller has already been superseded and drops the frame.

import type { Plan } from "./alternatives";
import type { RouteClock } from "./contexts";
import type { RouteWeights } from "./cost";
import { graphBuffer, type RoutingGraph } from "./graph";
import type { PlanRequest, RouterRequest, RouterResponse } from "./protocol";
import type { RouteResult } from "./search";
import type { Snap } from "./snap";

export type { PlanRequest };

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
  // 0 for a dest drag; for a start drag, which solves backward, the drawn route's trip time
  anchorSeconds: number;
}

// A route as the plan found it, before the plan says which are cards; the first is the max-scenic
// one, which the map draws while the sweep is still running.
export interface PlanCandidate {
  index: number;
  result: RouteResult;
}

interface RouteSettle {
  kind: "route";
  resolve: (reply: RouteReply | null) => void;
  reject: (error: Error) => void;
}

interface PlanSettle {
  kind: "plan";
  resolve: (plan: Plan | null) => void;
  reject: (error: Error) => void;
  onCandidate: (candidate: PlanCandidate) => void;
}

type Settle = RouteSettle | PlanSettle;

// The worker as this client uses it, so a test can drive the same code over a fake one.
export interface RouterPort {
  postMessage(request: RouterRequest): void;
  onmessage: ((event: MessageEvent<RouterResponse>) => void) | null;
}

export class RouterClient {
  private readonly port: RouterPort;
  private readonly pending = new Map<number, Settle>();
  private readonly loaded = new Set<string>();
  private nextId = 1;

  constructor(port?: RouterPort) {
    this.port =
      port ??
      (new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
      }) as RouterPort);
    this.port.onmessage = (event: MessageEvent<RouterResponse>): void => {
      const response = event.data;
      const settle = this.pending.get(response.id);
      if (!settle) {
        return;
      }
      // A candidate is one of many, so the plan stays pending until its `done` closes it.
      if (response.type === "candidate") {
        if (settle.kind === "plan") {
          settle.onCandidate({
            index: response.index,
            result: response.result,
          });
        }
        return;
      }
      this.pending.delete(response.id);
      if (response.type === "error") {
        settle.reject(new Error(response.message));
      } else if (response.type === "stale") {
        settle.resolve(null);
      } else if (response.type === "done") {
        if (settle.kind === "plan") {
          settle.resolve(response.plan);
        }
      } else if (settle.kind === "route") {
        settle.resolve({
          result: response.result,
          changed: response.changed,
          shadeRebuilt: response.shadeRebuilt,
          shadeLost: response.shadeLost,
        });
      }
    };
  }

  // The bytes are cloned rather than fetched again; both decoders view their own copy in place.
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

  // Resolves null where a newer plan overtook this one, as `route` does.
  plan(
    request: PlanRequest,
    onCandidate: (candidate: PlanCandidate) => void,
  ): Promise<Plan | null> {
    const id = this.nextId++;
    return new Promise<Plan | null>((resolve, reject) => {
      this.pending.set(id, { kind: "plan", resolve, reject, onCandidate });
      this.post({ type: "plan", id, request });
    });
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
      this.pending.set(id, { kind: "route", resolve, reject });
      this.post(build(id));
    });
  }

  private post(request: RouterRequest): void {
    this.port.postMessage(request);
  }
}

let client: RouterClient | null = null;

// Built on first use: the export prerenders these modules in node, where there is no Worker.
export function routerClient(): RouterClient {
  client ??= new RouterClient();
  return client;
}

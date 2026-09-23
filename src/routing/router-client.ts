// An overtaken request is answered `stale`, which resolves to null.

import type { Plan } from "./alternatives";
import { graphBuffer, type RoutingGraph } from "./graph";
import type {
  DragRequest,
  RouteRequest,
  RouterRequest,
  RouterResponse,
  WaypointRequest,
} from "./protocol";
import type { RouteResult } from "./search";
import type { WaypointPlan } from "./waypoints";

export interface RouteReply {
  result: RouteResult | null;
  changed: boolean;
  shadeRebuilt: boolean;
  shadeLost: boolean;
}

interface RouteSettle {
  kind: "route";
  resolve: (reply: RouteReply | null) => void;
  reject: (error: Error) => void;
}

interface LoadSettle {
  kind: "load";
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PlanSettle {
  kind: "plan";
  resolve: (plan: Plan | null) => void;
  reject: (error: Error) => void;
  onPreview: (result: RouteResult) => void;
}

interface WaypointsSettle {
  kind: "waypoints";
  resolve: (plan: WaypointPlan | null) => void;
  reject: (error: Error) => void;
}

type Settle = RouteSettle | LoadSettle | PlanSettle | WaypointsSettle;

// So a test can drive the same code over a fake worker.
export interface RouterPort {
  postMessage(request: RouterRequest): void;
  onmessage: ((event: MessageEvent<RouterResponse>) => void) | null;
  // A worker whose chunk 404s, or an uncloneable reply, lands only here; otherwise requests hang forever.
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
}

export class RouterClient {
  private readonly port: RouterPort;
  private readonly pending = new Map<number, Settle>();
  // Dropped when a load fails, so an out-of-memory decode is retried rather than remembered.
  private readonly loads = new Map<string, Promise<void>>();
  private nextId = 1;
  // Once set, every later request is refused with the same error rather than left hanging.
  private dead: Error | null = null;

  constructor(port?: RouterPort) {
    this.port =
      port ??
      (new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
      }) as RouterPort);
    this.port.onerror = (): void => {
      this.die(new Error("the routing worker failed"));
    };
    this.port.onmessageerror = (): void => {
      this.die(
        new Error("the routing worker sent a reply that could not be read"),
      );
    };
    this.port.onmessage = (event: MessageEvent<RouterResponse>): void => {
      const response = event.data;
      const settle = this.pending.get(response.id);
      if (!settle) {
        return;
      }
      // The preview is the first of several answers, so the plan stays pending until `done`.
      if (response.type === "preview") {
        if (settle.kind === "plan") {
          settle.onPreview(response.result);
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
      } else if (response.type === "waypoints") {
        if (settle.kind === "waypoints") {
          settle.resolve(response.plan);
        }
      } else if (response.type === "loaded") {
        if (settle.kind === "load") {
          settle.resolve();
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

  // Resolves once decoded, so a caller can wait rather than search a city that never loaded.
  load(cityId: string, graph: RoutingGraph): Promise<void> {
    const loading = this.loads.get(cityId);
    if (loading) {
      return loading;
    }
    if (this.dead) {
      return Promise.reject(this.dead);
    }
    const buffer = graphBuffer(cityId);
    if (!buffer) {
      return Promise.reject(
        new Error(`no downloaded graph bytes for ${cityId}`),
      );
    }
    const id = this.nextId++;
    const loaded = new Promise<void>((resolve, reject) => {
      this.pending.set(id, { kind: "load", resolve, reject });
      this.post({
        type: "load",
        id,
        cityId,
        buffer,
        identity: { hash: graph.hash, keyHash: graph.keyHash },
        base: document.baseURI,
      });
    }).catch((error: unknown) => {
      this.loads.delete(cityId);
      throw error;
    });
    this.loads.set(cityId, loaded);
    return loaded;
  }

  // Field by field, since a caller's request may hang the whole decoded graph off itself.
  route(request: RouteRequest): Promise<RouteReply | null> {
    const { cityId, clock, weights, start, dest } = request;
    return this.ask((id) => ({
      type: "route",
      id,
      cityId,
      clock,
      weights,
      start,
      dest,
    }));
  }

  // `onPreview` gets the max-scenic route as soon as it's found, for the map to draw early.
  plan(
    request: RouteRequest,
    onPreview: (result: RouteResult) => void,
  ): Promise<Plan | null> {
    if (this.dead) {
      return Promise.reject(this.dead);
    }
    const id = this.nextId++;
    return new Promise<Plan | null>((resolve, reject) => {
      this.pending.set(id, { kind: "plan", resolve, reject, onPreview });
      this.post({ type: "plan", id, request });
    });
  }

  // Resolves null where a newer route's pins overtook these, as `route` does.
  waypoints(request: WaypointRequest): Promise<WaypointPlan | null> {
    const { cityId, clock, weights, steps } = request;
    if (this.dead) {
      return Promise.reject(this.dead);
    }
    const id = this.nextId++;
    return new Promise<WaypointPlan | null>((resolve, reject) => {
      this.pending.set(id, { kind: "waypoints", resolve, reject });
      this.post({ type: "waypoints", id, cityId, clock, weights, steps });
    });
  }

  dragStart(which: "start" | "dest"): void {
    this.post({ type: "drag:start", which });
  }

  dragMove(request: DragRequest): Promise<RouteReply | null> {
    const { cityId, clock, weights, anchor, moving, anchorSeconds } = request;
    return this.ask((id) => ({
      type: "drag:move",
      id,
      cityId,
      clock,
      weights,
      anchor,
      moving,
      anchorSeconds,
    }));
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
    if (this.dead) {
      return Promise.reject(this.dead);
    }
    const id = this.nextId++;
    return new Promise<RouteReply | null>((resolve, reject) => {
      this.pending.set(id, { kind: "route", resolve, reject });
      this.post(build(id));
    });
  }

  private die(error: Error): void {
    this.dead = error;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    this.loads.clear();
    for (const settle of waiting) {
      settle.reject(error);
    }
  }

  private post(request: RouterRequest): void {
    if (!this.dead) {
      this.port.postMessage(request);
    }
  }
}

let client: RouterClient | null = null;

// Built on first use: the export prerenders these modules in node, where there is no Worker.
export function routerClient(): RouterClient {
  client ??= new RouterClient();
  return client;
}

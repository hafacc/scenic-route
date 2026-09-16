// The page's end of the routing worker. A request a newer one overtakes is answered `stale`, which
// resolves to null: the caller has already been superseded and drops the frame.

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

// The worker as this client uses it, so a test can drive the same code over a fake one.
export interface RouterPort {
  postMessage(request: RouterRequest): void;
  onmessage: ((event: MessageEvent<RouterResponse>) => void) | null;
  // A worker that never started (its chunk 404s after a deploy) and a reply that cannot be cloned
  // both arrive here and nowhere else. Without them every request made after one stays pending for
  // the life of the page, and the panel spins with nothing to say.
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
}

export class RouterClient {
  private readonly port: RouterPort;
  private readonly pending = new Map<number, Settle>();
  // Per city, and dropped again when its load fails, so a decode that ran out of memory is asked
  // for again rather than remembered as done.
  private readonly loads = new Map<string, Promise<void>>();
  private nextId = 1;
  // Set once the worker has failed. Nothing it is asked afterwards can be answered, so every later
  // request is refused with the same error rather than left hanging.
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

  // The bytes are cloned rather than fetched again; both decoders view their own copy in place.
  // Resolves once the worker has decoded them, so a caller can wait rather than post a search at a
  // city the worker never managed to load.
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

  // Field by field rather than spread: a caller's request object may hang the whole decoded graph
  // off itself, and every own property of it would be cloned across the thread boundary.
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

  // Resolves null where a newer plan overtook this one, as `route` does. `onPreview` is handed the
  // max-scenic route as soon as it is found, which is what the map draws while the sweep runs.
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

  // The pins for the route on screen, priced against the fields only the worker has. Resolves null
  // where a newer route's pins overtook these, as `route` does.
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

  // Every promise still waiting is rejected together: they were all waiting on the same worker.
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

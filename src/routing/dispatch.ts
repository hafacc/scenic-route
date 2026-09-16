// One request at a time in arrival order, because a search reads fields a context rebuild replaces.
//
// A route or drag frame that a newer one has already superseded is answered `stale` without being
// run. That is what keeps a drag solving only the position the cursor is at now: the page posts a
// frame per animation frame, and searching the ones already overtaken would just push the live one
// further behind. A plan is coalesced the same way, against other plans; it is also one synchronous
// unit, so a drag frame never interleaves with the searches it is made of. A waypoint plan
// coalesces against other waypoint plans, which is what keeps card-flipping from queueing one per
// card.

import { planRoutes } from "./alternatives";
import { setArtifactBase } from "./artifact-base";
import { minMultiplier } from "./cost";
import { graphFactorMax, type RoutingEngine } from "./engine";
import { MAX_WAYPOINTS } from "./google-maps";
import { decodeCityGraph } from "./graph";
import type { RouterRequest, RouterResponse } from "./protocol";
import { planWaypoints } from "./waypoints";

export interface Dispatch {
  receive(request: RouterRequest): Promise<void>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Coalesced = "route" | "plan" | "waypoints";
type Coalescing = Extract<
  RouterRequest,
  { type: "route" | "drag:move" | "plan" | "waypoints" }
>;

// Which answer a request competes for, or null where it competes for none: two requests of the same
// kind draw the same thing, so a newer one makes an older one pointless.
function coalesced(request: RouterRequest): Coalesced | null {
  if (request.type === "route" || request.type === "drag:move") {
    return "route";
  } else if (request.type === "plan") {
    return "plan";
  } else if (request.type === "waypoints") {
    return "waypoints";
  } else {
    return null;
  }
}

function coalescing(request: RouterRequest): request is Coalescing {
  return coalesced(request) !== null;
}

export function createDispatch(
  engine: RoutingEngine,
  post: (response: RouterResponse) => void,
): Dispatch {
  const queue: RouterRequest[] = [];
  let running = false;

  async function handle(request: RouterRequest): Promise<void> {
    switch (request.type) {
      case "load":
        // The one request whose failure has nowhere else to surface: a decode that runs out of
        // memory would otherwise leave the page believing this city was loaded, and everything
        // queued behind it stranded.
        try {
          const graph = decodeCityGraph(
            request.cityId,
            request.buffer,
            request.identity,
          );
          setArtifactBase(request.base);
          engine.load(request.cityId, graph);
          post({ type: "loaded", id: request.id });
        } catch (error) {
          post({ type: "error", id: request.id, message: describe(error) });
        }
        return;
      case "reset":
        engine.resetCache();
        return;
      case "drag:start":
        engine.dragStart(request.which);
        return;
      case "drag:end":
        engine.dragEnd();
        return;
      case "plan": {
        const { cityId, clock, start, dest, weights } = request.request;
        try {
          await engine.prepare(cityId, clock, weights);
          // The context fetches above are the one place a newer plan can overtake this one.
          if (queue.some((queued) => coalesced(queued) === "plan")) {
            post({ type: "stale", id: request.id });
            return;
          }
          let previewed = false;
          const plan = planRoutes({
            weights,
            search: (candidate) => engine.search(start, dest, candidate),
            minMultiplier: (candidate) =>
              minMultiplier(engine.graph, candidate),
            factorMax: graphFactorMax(engine.graph),
            onCandidate: (result) => {
              if (!previewed) {
                previewed = true;
                post({ type: "preview", id: request.id, result });
              }
            },
          });
          post({ type: "done", id: request.id, plan });
        } catch (error) {
          post({ type: "error", id: request.id, message: describe(error) });
        }
        return;
      }
      case "waypoints": {
        const { cityId, clock, weights, steps } = request;
        try {
          await engine.prepare(cityId, clock, weights);
          // The context fetches above are the one place a newer set of pins can overtake this one.
          if (queue.some((queued) => coalesced(queued) === "waypoints")) {
            post({ type: "stale", id: request.id });
            return;
          }
          post({
            type: "waypoints",
            id: request.id,
            plan: planWaypoints(
              engine.graph,
              { steps },
              weights,
              MAX_WAYPOINTS,
            ),
          });
        } catch (error) {
          post({ type: "error", id: request.id, message: describe(error) });
        }
        return;
      }
      default: {
        try {
          const sync = await engine.prepare(
            request.cityId,
            request.clock,
            request.weights,
          );
          // The context fetches above are the one place a newer frame can overtake this one.
          if (queue.some((queued) => coalesced(queued) === "route")) {
            post({ type: "stale", id: request.id });
            return;
          }
          const { result, changed } =
            request.type === "route"
              ? engine.route(request.start, request.dest, request.weights)
              : {
                  result: engine.dragMove(
                    request.anchor,
                    request.moving,
                    request.weights,
                    request.anchorSeconds,
                  ),
                  // A drag frame answers a moved endpoint, so it is never the drawn route.
                  changed: true,
                };
          post({
            type: "result",
            id: request.id,
            result,
            changed,
            shadeRebuilt: sync.shadeRebuilt,
            shadeLost: sync.shadeLost,
          });
        } catch (error) {
          post({ type: "error", id: request.id, message: describe(error) });
        }
        return;
      }
    }
  }

  async function pump(): Promise<void> {
    if (running) {
      return; // the running pump drains everything queued behind it, including this
    }
    running = true;
    try {
      while (queue.length > 0) {
        const request = queue.shift();
        if (!request) {
          break;
        }
        if (
          coalescing(request) &&
          queue.some((queued) => coalesced(queued) === coalesced(request))
        ) {
          post({ type: "stale", id: request.id });
        } else {
          await handle(request);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    receive(request: RouterRequest): Promise<void> {
      queue.push(request);
      return pump();
    },
  };
}

// The worker's message loop, kept apart from the worker file so it can be driven in a test with a
// fake `post`. Requests are handled one at a time in arrival order, because a search reads fields a
// context rebuild replaces.
//
// A route or drag frame that a newer one has already superseded is answered `stale` without being
// run. That is what keeps a drag solving only the position the cursor is at now: the page posts a
// frame per animation frame, and searching the ones already overtaken would just push the live one
// further behind.

import { setArtifactBase } from "./artifact-base";
import type { RoutingEngine } from "./engine";
import { decodeCityGraph } from "./graph";
import type { RouterRequest, RouterResponse } from "./protocol";

export interface Dispatch {
  receive(request: RouterRequest): Promise<void>;
}

// Whether a newer request of this kind makes an older one pointless: both draw the one live route.
function drawsTheRoute(
  request: RouterRequest,
): request is Extract<RouterRequest, { type: "route" | "drag:move" }> {
  return request.type === "route" || request.type === "drag:move";
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
        setArtifactBase(request.base);
        engine.load(
          request.cityId,
          decodeCityGraph(request.cityId, request.buffer, request.identity),
        );
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
      case "plan":
        post({
          type: "error",
          id: request.id,
          message: "the route planner is not built yet",
        });
        return;
      default: {
        try {
          const sync = await engine.prepare(
            request.cityId,
            request.clock,
            request.weights,
          );
          // The context fetches above are the one place a newer frame can overtake this one.
          if (queue.some(drawsTheRoute)) {
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
          post({
            type: "error",
            id: request.id,
            message: error instanceof Error ? error.message : String(error),
          });
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
        if (drawsTheRoute(request) && queue.some(drawsTheRoute)) {
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

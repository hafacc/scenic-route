// The router itself, with everything one search needs held together: the decoded graphs, their
// route-time fields, the weight-bracket cache and the live drag solver. It runs inside the routing
// worker and knows nothing about messages, so a caller there — the drag protocol today, phase 4's
// planner next — can prepare a city once and then search it synchronously as many times as it likes.

import { cityById } from "../cities";
import { type ContextSync, type RouteClock, RouteContexts } from "./contexts";
import type { RouteWeights } from "./cost";
import type { RoutingGraph } from "./graph";
import { type CachedRoute, RouteCache } from "./route-cache";
import {
  findRoute,
  type RouteResult,
  RouteSolver,
  reverseResult,
} from "./search";
import type { Snap } from "./snap";

export class RoutingEngine {
  // Kept per city, as the page keeps its own: switching and coming back must not re-decode 600k edges.
  private readonly graphs = new Map<
    string,
    { graph: RoutingGraph; contexts: RouteContexts }
  >();
  private prepared: RoutingGraph | null = null;
  private cache = new RouteCache();
  private dragWhich: "start" | "dest" = "dest";
  private dragSolver: RouteSolver | null = null;

  loaded(cityId: string): boolean {
    return this.graphs.has(cityId);
  }

  load(cityId: string, graph: RoutingGraph): void {
    if (!this.graphs.has(cityId)) {
      this.graphs.set(cityId, { graph, contexts: new RouteContexts() });
    }
  }

  // Point the engine at a city and bring its route-time fields up to the clock. Everything cached
  // against a field this rebuilds is dropped, so every search after it sees one settled context.
  async prepare(
    cityId: string,
    clock: RouteClock,
    weights: RouteWeights,
  ): Promise<ContextSync> {
    const entry = this.graphs.get(cityId);
    const city = cityById(cityId);
    if (!entry || !city) {
      throw new Error(`no routing graph loaded for ${cityId}`);
    }
    const sync = await entry.contexts.sync(entry.graph, city, clock, weights);
    if (sync.rebuilt) {
      this.cache = new RouteCache();
      this.dragSolver = null;
    }
    this.prepared = entry.graph;
    return sync;
  }

  get graph(): RoutingGraph {
    if (!this.prepared) {
      throw new Error("no graph prepared");
    }
    return this.prepared;
  }

  // One search over the prepared graph and its fields, straight through the cost model. Synchronous
  // and uncached: this is what a plan calls once per weight vector.
  search(start: Snap, dest: Snap, weights: RouteWeights): RouteResult | null {
    return findRoute(this.graph, start, dest, weights);
  }

  // The same search behind the weight brackets, for a single route being re-costed as a slider moves.
  route(start: Snap, dest: Snap, weights: RouteWeights): CachedRoute {
    return this.cache.route(this.graph, start, dest, weights);
  }

  resetCache(): void {
    this.cache = new RouteCache();
  }

  dragStart(which: "start" | "dest"): void {
    this.dragWhich = which;
    this.dragSolver = null;
  }

  dragEnd(): void {
    this.dragSolver = null;
  }

  // One frame of an endpoint drag: an incremental solver rooted at the held endpoint answers the
  // moving one approximately, reusing its settled search across the gesture's frames. A start drag
  // solves backward from the destination, so its answer is reversed before it is drawn.
  dragMove(
    anchor: Snap,
    moving: Snap,
    weights: RouteWeights,
    anchorSeconds: number,
  ): RouteResult | null {
    const graph = this.graph;
    const solver = (this.dragSolver ??=
      this.dragWhich === "dest"
        ? new RouteSolver(graph, anchor, weights)
        : new RouteSolver(graph, anchor, weights, anchorSeconds, -1));
    const solved = solver.solveApprox(moving);
    return this.dragWhich === "start" && solved
      ? reverseResult(graph, solved)
      : solved;
  }
}

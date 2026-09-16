// The router itself, with everything one search needs held together: the decoded graphs, their
// route-time fields, the weight-bracket cache and the live drag solver. It runs inside the routing
// worker and knows nothing about messages, so a caller there — the drag protocol, the planner — can
// prepare a city once and then search it synchronously as many times as it likes.

import { cityById } from "../cities";
import { type ContextSync, type RouteClock, RouteContexts } from "./contexts";
import { maxShelter, type RouteWeights } from "./cost";
import type { FactorKey } from "./factors";
import type { RoutingGraph } from "./graph";
import { type CachedRoute, RouteCache } from "./route-cache";
import {
  findRoute,
  type RouteResult,
  RouteSolver,
  reverseResult,
} from "./search";
import type { Snap } from "./snap";

// The greatest each scored factor reaches anywhere on this graph, which is what a card's lead over
// the others is measured against. Only the discounts are scored, so the penalties are left out and
// read as 1. Shade and shelter come off the route-time fields, so `prepare` has to have run.
export function graphFactorMax(
  graph: RoutingGraph,
): Partial<Record<FactorKey, number>> {
  return {
    tree: graph.maxCover,
    landmark: graph.maxLandmark,
    art: graph.maxArt,
    commercial: graph.maxCommercial,
    historic: graph.maxHistoric,
    shade: graph.shade ? graph.shade.maxAbs : 0,
    shelter: maxShelter(graph),
  };
}

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

  load(cityId: string, graph: RoutingGraph): void {
    if (!this.graphs.has(cityId)) {
      this.graphs.set(cityId, { graph, contexts: new RouteContexts() });
    }
  }

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

  // Uncached, unlike route(): a plan calls this once per weight vector.
  search(start: Snap, dest: Snap, weights: RouteWeights): RouteResult | null {
    return findRoute(this.graph, start, dest, weights);
  }

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

  // The solver is rooted at the held endpoint and reused across the gesture's frames.
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

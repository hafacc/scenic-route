// The router itself, with everything one search needs held together: the decoded graphs, their
// route-time fields, the weight-bracket cache and the live drag solver. It runs inside the routing
// worker and knows nothing about messages, so a caller there — the drag protocol, the planner — can
// prepare a city once and then search it synchronously as many times as it likes.

import { cityById } from "../cities";
import { type ContextSync, type RouteClock, RouteContexts } from "./contexts";
import { DISCOUNT_KEYS, discountMax, type RouteWeights } from "./cost";
import type { FactorKey } from "./factors";
import type { RoutingGraph } from "./graph";
import { type CachedRoute, RouteCache } from "./route-cache";
import {
  findRoute,
  networkMetersTo,
  type RouteResult,
  RouteSolver,
  reverseResult,
  SearchLabels,
  type SearchReuse,
} from "./search";
import { haversineMeters, type Snap } from "./snap";
import { bakeWalkSeconds } from "./walk-speed";

// The greatest each scored factor reaches anywhere on this graph, which is what a card's lead over
// the others is measured against. Only the discounts are scored, so the penalties are left out and
// read as 1. Shade and shelter come off the route-time fields, so `prepare` has to have run.
export function graphFactorMax(
  graph: RoutingGraph,
): Partial<Record<FactorKey, number>> {
  const maxima: Partial<Record<FactorKey, number>> = {};
  for (const key of DISCOUNT_KEYS) {
    maxima[key] = discountMax(graph, key);
  }
  return maxima;
}

// How far past the straight line the network estimate is measured. See `reuseFor`.
const NETWORK_RADIUS_MULTIPLE = 3;

export class RoutingEngine {
  // Kept per city, as the page keeps its own: switching and coming back must not re-decode 600k edges.
  private readonly graphs = new Map<
    string,
    { graph: RoutingGraph; contexts: RouteContexts }
  >();
  private prepared: RoutingGraph | null = null;
  // The label arrays and the built routes one prepared graph's searches hand each other. A plan is
  // sixteen searches over one graph at one departure, which is exactly the run these span.
  private labels: SearchLabels | null = null;
  private readonly built = new Map<string, RouteResult>();
  // The destination the network estimate below was measured to, how far out it was measured, and the
  // estimate itself. One backward Dijkstra serves every search to that destination: a plan's
  // sixteen, and every slider move the reader makes afterwards.
  private networkKey = "";
  private networkRadius = 0;
  private networkMeters: Float32Array | null = null;
  private cache = this.newCache();
  private dragWhich: "start" | "dest" = "dest";
  private dragSolver: RouteSolver | null = null;

  load(cityId: string, graph: RoutingGraph): void {
    if (!this.graphs.has(cityId)) {
      // The bake belongs to the thread that searches: the relax loop reads these doubles millions of
      // times a plan, and the page — which decodes the same bytes — walks a handful of edges a route
      // and would spend 10 MB a city on them for nothing.
      graph.walkSeconds = bakeWalkSeconds(graph);
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
    // A built route is only good for the fields it was costed against, and only for the endpoints it
    // was asked about: both are settled for the run of searches this call opens, and neither
    // survives into the next one.
    this.built.clear();
    if (sync.rebuilt) {
      this.cache = this.newCache();
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
    return this.searchWith(this.graph, start, dest, weights);
  }

  private searchWith(
    graph: RoutingGraph,
    start: Snap,
    dest: Snap,
    weights: RouteWeights,
  ): RouteResult | null {
    return findRoute(
      graph,
      start,
      dest,
      weights,
      this.reuseFor(graph, start, dest),
    );
  }

  private reuseFor(graph: RoutingGraph, start: Snap, dest: Snap): SearchReuse {
    if (this.labels?.nodeCount !== graph.nodeCount) {
      this.labels = new SearchLabels(graph.nodeCount);
    }
    // Measured only as far out as a route could plausibly wander, because the backward search is a
    // flat cost and a short trip cannot earn it back: settling the whole of New York took longer
    // than the searches it saved on a two-kilometer walk. Three times the straight line is well
    // past the most roundabout route anything here produces, and past it the estimate falls back to
    // the straight line, which is a lower bound in its own right.
    const radius =
      NETWORK_RADIUS_MULTIPLE *
      haversineMeters(
        start.point.lat,
        start.point.lng,
        dest.point.lat,
        dest.point.lng,
      );
    const key = `${graph.hash}|${dest.edge}@${dest.metersFromA}`;
    if (this.networkKey !== key || radius > this.networkRadius) {
      this.networkKey = key;
      this.networkRadius = radius;
      this.networkMeters = networkMetersTo(graph, dest, radius);
    }
    return {
      labels: this.labels,
      results: this.built,
      networkMeters: this.networkMeters ?? undefined,
    };
  }

  route(start: Snap, dest: Snap, weights: RouteWeights): CachedRoute {
    return this.cache.route(this.graph, start, dest, weights);
  }

  resetCache(): void {
    this.cache = this.newCache();
  }

  // Always through the engine's own search: a cache built around the bare `findRoute` still answers,
  // but silently without the label reuse, the network estimate or the memo of what it already built.
  private newCache(): RouteCache {
    return new RouteCache(this.searchWith.bind(this));
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
    // A start drag solves backwards from the held dest, and a route found that way rides its trains
    // in reverse: the board it reports is the alight, and flipping the steps cannot flip that. So the
    // live preview of a start drag walks. The drop re-solves forward and may ride.
    const solver = (this.dragSolver ??=
      this.dragWhich === "dest"
        ? new RouteSolver(graph, anchor, weights)
        : new RouteSolver(
            graph,
            anchor,
            { ...weights, allowTransit: false },
            anchorSeconds,
            -1,
          ));
    const solved = solver.solveApprox(moving);
    return this.dragWhich === "start" && solved
      ? reverseResult(graph, solved)
      : solved;
  }
}

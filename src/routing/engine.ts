// Knows nothing about messages, so a worker caller can prepare a city once and search synchronously.

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

// Penalties read as 1; shade and shelter come off the route-time fields, so `prepare` must have run.
export function graphFactorMax(
  graph: RoutingGraph,
): Partial<Record<FactorKey, number>> {
  const maxima: Partial<Record<FactorKey, number>> = {};
  for (const key of DISCOUNT_KEYS) {
    maxima[key] = discountMax(graph, key);
  }
  return maxima;
}

// See `reuseFor`.
const NETWORK_RADIUS_MULTIPLE = 3;

export class RoutingEngine {
  // Kept per city: switching back must not re-decode 600k edges.
  private readonly graphs = new Map<
    string,
    { graph: RoutingGraph; contexts: RouteContexts }
  >();
  private prepared: RoutingGraph | null = null;
  private labels: SearchLabels | null = null;
  private readonly built = new Map<string, RouteResult>();
  // One backward Dijkstra serves every search to that destination.
  private networkKey = "";
  private networkRadius = 0;
  private networkMeters: Float32Array | null = null;
  private cache = this.newCache();
  private dragWhich: "start" | "dest" = "dest";
  private dragSolver: RouteSolver | null = null;

  load(cityId: string, graph: RoutingGraph): void {
    if (!this.graphs.has(cityId)) {
      // Only the searching thread bakes these; the page would spend 10 MB a city for a handful of reads.
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
    // Built routes are only good for the fields and endpoints they were costed against.
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
    // Bounded, since settling all of New York took longer than the searches it saved on a 2 km walk.
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

  // A cache around bare `findRoute` silently loses label reuse, the network estimate and the memo.
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

  dragMove(
    anchor: Snap,
    moving: Snap,
    weights: RouteWeights,
    anchorSeconds: number,
  ): RouteResult | null {
    const graph = this.graph;
    // A backward solve rides trains in reverse, so a start drag's preview walks; the drop may ride.
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

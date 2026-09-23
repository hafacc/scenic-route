// The keys record what was built onto one graph, so the worker's and the page's each need an instance.

import type { City } from "../cities";
import type { RouteWeights } from "./cost";
import { computeFerrySchedule } from "./ferry-schedule";
import type { RoutingGraph } from "./graph";
import { computeEdgeShade } from "./shade";
import { computeEdgeSheds, setShedSun, shedDay } from "./sheds";
import { loadTimetable } from "./transit-schedule";

export interface RouteClock {
  tick: number; // bumped once a minute, which is what the shade and ferry fields are keyed on
  dateMs: number; // the instant a search departs at
}

export interface ContextSync {
  rebuilt: boolean; // a field was rebuilt, so the weight brackets and any drag solver are stale
  shadeRebuilt: boolean; // the shade field was (re)built on this call
  shadeLost: boolean; // ... and its artifact failed, so this departure carries no sun/shade bias
}

// The page passes the five values alone, so a fresh weights object doesn't resubscribe the clock.
export interface RouteTimeInputs {
  shade: number;
  shelter: number;
  allowSheds: boolean;
  allowFerries: boolean;
  allowTransit: boolean;
}

// Sun, sheds, sailings and trains move with the clock, so such a route is re-costed every tick.
export function followsRouteTime(weights: RouteTimeInputs): boolean {
  return (
    weights.shade !== 0 ||
    weights.shelter !== 0 ||
    !weights.allowSheds ||
    weights.allowFerries ||
    weights.allowTransit
  );
}

export class RouteContexts {
  private shadeKey = "";
  private shedKey = "";
  private ferryKey = "";
  private transitKey = "";

  // Keys carry the city, or a switch with the clock stopped would claim the new graph was built.
  async sync(
    graph: RoutingGraph,
    city: City,
    clock: RouteClock,
    weights: RouteWeights,
  ): Promise<ContextSync> {
    const date = new Date(clock.dateMs);
    let shadeRebuilt = false;
    let shadeLost = false;

    // Four independent fetches run together, so the walk pays for the slowest rather than the sum.
    const shade = (async (): Promise<boolean> => {
      if (weights.shade === 0) {
        graph.shade = null;
        this.shadeKey = "";
        return false;
      }
      const key = `${city.id}:${clock.tick}`;
      if (this.shadeKey === key) {
        return false;
      }
      this.shadeKey = key;
      shadeRebuilt = true;
      try {
        await computeEdgeShade(graph, date, city);
      } catch (error) {
        console.error("shade routing disabled:", error);
        graph.shade = null;
        shadeLost = true;
      }
      return true;
    })();

    const sheds = (async (): Promise<boolean> => {
      if (weights.shade === 0 && weights.shelter === 0 && weights.allowSheds) {
        graph.sheds = null;
        this.shedKey = "";
        return false;
      }
      const key = `${city.id}:${shedDay(date)}`;
      let built = false;
      if (this.shedKey !== key) {
        this.shedKey = key;
        built = true;
        try {
          await computeEdgeSheds(graph, date, city);
        } catch (error) {
          console.error("scaffolding routing disabled:", error);
        }
      }
      // The set moves with the day but the sun with the clock, so re-aim rather than rebuild.
      if (graph.sheds) {
        setShedSun(graph.sheds, date, city);
      }
      return built;
    })();

    const rebuilt = await Promise.all([
      shade,
      sheds,
      this.syncFerries(graph, city, clock, weights),
      this.syncTransit(graph, city, clock, weights),
    ]);

    return {
      rebuilt: rebuilt.some((field) => field),
      shadeRebuilt,
      shadeLost,
    };
  }

  // Worker only; no baked fallback, since a board edge bakes no departure: no schedule, no train.
  async syncTransit(
    graph: RoutingGraph,
    city: City,
    clock: RouteClock,
    weights: RouteWeights,
  ): Promise<boolean> {
    if (weights.allowTransit && graph.boardEdges.length > 0) {
      const key = `${city.id}:${clock.tick}`;
      if (this.transitKey !== key) {
        this.transitKey = key;
        try {
          graph.transit = await loadTimetable(city.id, new Date(clock.dateMs));
        } catch (error) {
          console.error("transit timetable unavailable:", error);
          graph.transit = null;
        }
        return true;
      } else {
        return false;
      }
    } else {
      graph.transit = null;
      this.transitKey = "";
      return false;
    }
  }

  // The page needs only the timetable, to name sailings; search fields are built in the worker.
  async syncFerries(
    graph: RoutingGraph,
    city: City,
    clock: RouteClock,
    weights: RouteWeights,
  ): Promise<boolean> {
    if (weights.allowFerries && graph.ferryEdges.length > 0) {
      const key = `${city.id}:${clock.tick}`;
      if (this.ferryKey !== key) {
        this.ferryKey = key;
        try {
          await computeFerrySchedule(graph, city.id, new Date(clock.dateMs));
        } catch (error) {
          console.error("ferry timetable unavailable:", error);
          graph.ferries = null;
        }
        return true;
      } else {
        return false;
      }
    } else {
      graph.ferries = null;
      this.ferryKey = "";
      return false;
    }
  }
}

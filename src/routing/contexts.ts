// The route-time fields a search costs against, kept current on one graph. The worker's graph and the
// page's each need their own instance: the keys below record what was built onto ONE graph.

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

// What a field a search is costed against needs of the weights. RouteWeights satisfies it; the page
// hands in the five values on their own, so following the clock does not resubscribe every time the
// deck builds a fresh weights object.
export interface RouteTimeInputs {
  shade: number;
  shelter: number;
  allowSheds: boolean;
  allowFerries: boolean;
  allowTransit: boolean;
}

// Whether anything this route is costed against moves with the clock: the sun over it, the standing
// scaffolding, the sailing a terminal is next offering, and the train a platform is. A page that
// follows the clock re-costs the route on every tick, and one that does not would go on quoting the
// 6:20 boat — or the 6:20 train — long after it had gone.
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

  // Every key carries the city: a field is built onto ONE city's graph, so a switch with the clock
  // stopped would otherwise leave the key claiming the new graph was already built.
  async sync(
    graph: RoutingGraph,
    city: City,
    clock: RouteClock,
    weights: RouteWeights,
  ): Promise<ContextSync> {
    const date = new Date(clock.dateMs);
    let shadeRebuilt = false;
    let shadeLost = false;

    // The four fields are four independent fetches, and a plan waits on all of them before its first
    // search: run together, the walk pays for the slowest rather than the sum. Nothing here reads
    // what another writes — the shed set feeds the shade COMPOSITE, which is asked for per edge at
    // search time, not while the field is built.
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

    // The standing shed set moves only with the picked day, and feeds the shade composite as well as
    // the shelter factor and the scaffolding gate.
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

  // The rail timetable, keyed like the ferry one: a different day is a different artifact, and the
  // clock tick is what re-resolves it. Only the worker needs it — the page's directions name a line
  // and a terminus, both of which the graph itself carries.
  //
  // A day no record covers, or a fetch that failed, leaves it null and every board edge then costs
  // Infinity (src/routing/cost.ts): no schedule, no train. There is deliberately no baked fallback
  // the way a ferry has one — a board edge bakes no departure, and an invented headway would be
  // putting a walker on a train nobody has said runs.
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

  // The timetable on its own, which is the one field the PAGE reads: `buildDirections` names the
  // sailing a ferry leg catches. Everything a search costs against is built in the worker, on its
  // own copy — building it here too would run the same fetch and the same pass over every edge a
  // second time, on the thread that draws.
  //
  // Barred, every ferry edge is skipped before its cost is asked for. A failed fetch falls back to
  // the graph's baked crossing-plus-average-wait figure.
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

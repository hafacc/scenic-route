// The route-time fields a search costs against, kept current on one graph. The worker's graph and the
// page's each need their own instance: the keys below record what was built onto ONE graph.

import type { City } from "../cities";
import type { RouteWeights } from "./cost";
import { computeFerrySchedule } from "./ferry-schedule";
import type { RoutingGraph } from "./graph";
import { computeEdgeShade } from "./shade";
import { computeEdgeSheds, setShedSun, shedDay } from "./sheds";

export interface RouteClock {
  tick: number; // bumped once a minute, which is what the shade and ferry fields are keyed on
  dateMs: number; // the instant a search departs at
}

export interface ContextSync {
  rebuilt: boolean; // a field was rebuilt, so the weight brackets and any drag solver are stale
  shadeRebuilt: boolean; // the shade field was (re)built on this call
  shadeLost: boolean; // ... and its artifact failed, so this departure carries no sun/shade bias
}

export class RouteContexts {
  private shadeKey = "";
  private shedKey = "";
  private ferryKey = "";

  // Every key carries the city: a field is built onto ONE city's graph, so a switch with the clock
  // stopped would otherwise leave the key claiming the new graph was already built.
  async sync(
    graph: RoutingGraph,
    city: City,
    clock: RouteClock,
    weights: RouteWeights,
  ): Promise<ContextSync> {
    const date = new Date(clock.dateMs);
    let rebuilt = false;
    let shadeRebuilt = false;
    let shadeLost = false;

    if (weights.shade !== 0) {
      const key = `${city.id}:${clock.tick}`;
      if (this.shadeKey !== key) {
        this.shadeKey = key;
        rebuilt = true;
        shadeRebuilt = true;
        try {
          await computeEdgeShade(graph, date, city);
        } catch (error) {
          console.error("shade routing disabled:", error);
          graph.shade = null;
          shadeLost = true;
        }
      }
    } else {
      graph.shade = null;
      this.shadeKey = "";
    }

    // The standing shed set moves only with the picked day, and feeds the shade composite as well as
    // the shelter factor and the scaffolding gate.
    if (weights.shade !== 0 || weights.shelter !== 0 || !weights.allowSheds) {
      const key = `${city.id}:${shedDay(date)}`;
      if (this.shedKey !== key) {
        this.shedKey = key;
        rebuilt = true;
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
    } else {
      graph.sheds = null;
      this.shedKey = "";
    }

    const ferryRebuilt = await this.syncFerries(graph, city, clock, weights);

    return { rebuilt: rebuilt || ferryRebuilt, shadeRebuilt, shadeLost };
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

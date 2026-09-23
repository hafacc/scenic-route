// Pure geometry, so it's testable away from Leaflet; components/route-layer.tsx paints it.

import { SUBWAY_COLOR } from "../overlays/colors";
import type { Subway } from "../subway/format";
import { sliceTrack, trackShapes } from "../subway/tracks";
import { currentTheme } from "../theme/current";
import {
  edgeKind,
  isStayAboard,
  type RoutingGraph,
  routeOf,
  subEdgePath,
} from "./graph";
import type { RouteResult, RouteStep } from "./search";
import { haversineMeters, type Snap } from "./snap";

// Walked kinds draw stored geometry as-is; a ride borrows the agency's drawn track in the line's color.
export interface DrawStep {
  lngs: Float64Array;
  lats: Float64Array;
  mode: "walk" | "ferry" | { color: string };
}

export interface StationDot {
  lat: number;
  lng: number;
  color: string;
}

export interface RouteDrawing {
  steps: DrawStep[];
  stations: StationDot[];
  badge: { lat: number; lng: number } | null;
}

// A transfer's platforms are meters apart, so the alight and board dots merge; the board's wins.
const TRANSFER_METERS = 150;

// The end edges are trimmed at the snap projections.
function stepBounds(
  graph: RoutingGraph,
  step: RouteStep,
  index: number,
  stepCount: number,
  start: Snap,
  dest: Snap,
): [number, number] {
  const edgeLength = graph.edgeLength[step.edge];
  if (stepCount === 1 && start.edge === dest.edge) {
    return [
      Math.min(start.metersFromA, dest.metersFromA),
      Math.max(start.metersFromA, dest.metersFromA),
    ];
  }
  if (index === 0) {
    // the start edge, departed through node b (forward) or node a (reverse)
    return step.forward
      ? [start.metersFromA, edgeLength]
      : [0, start.metersFromA];
  }
  if (index === stepCount - 1) {
    // the dest edge, reached through node a (forward) or node b (reverse)
    return step.forward
      ? [0, dest.metersFromA]
      : [dest.metersFromA, edgeLength];
  }
  return [0, edgeLength];
}

// Gathered so the whole leg lies on one drawn track rather than per-hop projections.
interface RideLeg {
  route: { shortName: string; color: string } | null;
  lngs: number[];
  lats: number[];
}

export function buildDrawing(
  graph: RoutingGraph,
  result: RouteResult,
  tracks: Subway | null,
): RouteDrawing {
  const draw: DrawStep[] = [];
  const stations: StationDot[] = [];
  const stepCount = result.steps.length;
  let leg: RideLeg | null = null;

  // Dots go where the drawing ends, not where the platform node sits.
  const closeLeg = (): void => {
    if (leg === null) {
      return;
    }
    const color = leg.route?.color ?? SUBWAY_COLOR[currentTheme()];
    const chord = {
      lngs: Float64Array.from(leg.lngs),
      lats: Float64Array.from(leg.lats),
    };
    const board = { lat: leg.lats[0], lng: leg.lngs[0] };
    const alight = {
      lat: leg.lats[leg.lats.length - 1],
      lng: leg.lngs[leg.lngs.length - 1],
    };
    const track =
      tracks && leg.route
        ? sliceTrack(trackShapes(tracks, leg.route), board, alight)
        : null;
    const drawn = track ?? chord;
    draw.push({ lngs: drawn.lngs, lats: drawn.lats, mode: { color } });
    const last = drawn.lats.length - 1;
    const boardDot = { lat: drawn.lats[0], lng: drawn.lngs[0], color };
    const previous = stations[stations.length - 1];
    if (
      previous &&
      haversineMeters(previous.lat, previous.lng, boardDot.lat, boardDot.lng) <
        TRANSFER_METERS
    ) {
      stations.pop();
    }
    stations.push(boardDot);
    stations.push({ lat: drawn.lats[last], lng: drawn.lngs[last], color });
    leg = null;
  };

  for (let index = 0; index < stepCount; index++) {
    const step = result.steps[index];
    const [fromMeters, toMeters] = stepBounds(
      graph,
      step,
      index,
      stepCount,
      result.start,
      result.dest,
    );
    const clipped = subEdgePath(graph, step.edge, fromMeters, toMeters);
    const lngs = step.forward ? clipped.lngs : [...clipped.lngs].reverse();
    const lats = step.forward ? clipped.lats : [...clipped.lats].reverse();
    if (lngs.length < 2) {
      continue;
    }
    if (edgeKind(graph, step.edge) === "ride") {
      if (isStayAboard(graph, step.edge)) {
        // Closing the leg on a stay-aboard step would split the ride per hop and dot every stop.
        continue;
      }
      const route = routeOf(graph, step.edge);
      if (leg === null || leg.route?.shortName !== route?.shortName) {
        closeLeg();
        leg = { route, lngs: [], lats: [] };
      }
      // The hops share their junction vertex, which is the platform they both call at.
      const from = leg.lngs.length === 0 ? 0 : 1;
      for (let vertex = from; vertex < lngs.length; vertex++) {
        leg.lngs.push(lngs[vertex]);
        leg.lats.push(lats[vertex]);
      }
      continue;
    }
    closeLeg();
    draw.push({
      lngs: Float64Array.from(lngs),
      lats: Float64Array.from(lats),
      mode: edgeKind(graph, step.edge) === "ferry" ? "ferry" : "walk",
    });
  }
  closeLeg();
  return { steps: draw, stations, badge: midpointOf(draw) };
}

// By length, not vertex count, so a mostly-ridden route's badge doesn't land near an end.
function midpointOf(
  steps: readonly DrawStep[],
): { lat: number; lng: number } | null {
  const spans: number[] = [];
  let total = 0;
  for (const step of steps) {
    let length = 0;
    for (let vertex = 1; vertex < step.lats.length; vertex++) {
      length += haversineMeters(
        step.lats[vertex - 1],
        step.lngs[vertex - 1],
        step.lats[vertex],
        step.lngs[vertex],
      );
    }
    spans.push(length);
    total += length;
  }
  let running = 0;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (running + spans[index] < total / 2) {
      running += spans[index];
      continue;
    }
    for (let vertex = 1; vertex < step.lats.length; vertex++) {
      const segment = haversineMeters(
        step.lats[vertex - 1],
        step.lngs[vertex - 1],
        step.lats[vertex],
        step.lngs[vertex],
      );
      if (running + segment >= total / 2) {
        return { lat: step.lats[vertex], lng: step.lngs[vertex] };
      }
      running += segment;
    }
  }
  const last = steps[steps.length - 1];
  return last ? { lat: last.lats[0], lng: last.lngs[0] } : null;
}

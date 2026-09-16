// What a route looks like on the map: the polyline of every step in travel order, a disc at each
// station it is carried from, and the point its badge sits on. Pure geometry over the graph and the
// drawn track, so it is testable away from Leaflet; components/route-layer.tsx paints the result.

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

// A per-step polyline in travel order. Every walked kind draws its stored geometry as-is: a
// sidewalk's baked offset already runs corner-to-corner on its own side, and a crossing or link is
// the straight corner-to-corner line edgePath synthesizes, so there is no draw-time offset to apply.
// A ride is the exception, and the reason `mode` is not a boolean: it has no geometry of its own and
// borrows the agency's drawn track (../subway/tracks), which it wears in the line's own colour.
export interface DrawStep {
  lngs: Float64Array;
  lats: Float64Array;
  mode: "walk" | "ferry" | { color: string };
}

// A white disc at each station the route stops being carried at: where it gets on, where it changes
// and where it gets off, in the colour of the line boarded there.
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

// A transfer's two platforms are metres apart, so the alight dot and the board dot that follows it
// are one station: the second wins, in the colour of the line the reader is getting onto.
const TRANSFER_METERS = 150;

// The a -> b along-distance bounds this step actually walked, so the end edges are trimmed at the
// snap projections rather than drawn all the way to the intersection.
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

// One boarding's worth of ride steps, gathered so the whole leg can be laid on one drawn track
// rather than each hop between two stops projected on its own.
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

  // The leg's own chords give way to the stretch of published track between its two stations, where
  // the artifact has one. The dots go where the drawing ends, not where the platform node sits.
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
    // The clip runs a -> b; reverse it into travel order so the ribbon flows the way it is walked.
    const lngs = step.forward ? clipped.lngs : [...clipped.lngs].reverse();
    const lats = step.forward ? clipped.lats : [...clipped.lats].reverse();
    if (lngs.length < 2) {
      continue;
    }
    if (edgeKind(graph, step.edge) === "ride") {
      if (isStayAboard(graph, step.edge)) {
        // A rider holding their seat through a stop: no length, no route of its own, and closing the
        // leg on it would cut the ride into one drawing per hop and dot every stop it passes.
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

// Halfway along the DRAWN route by length, rather than at its middle vertex. By vertex count a
// route that spends most of its distance on a train would put its badge on whichever walk had the
// more corners, which is near one of its ends; by length it lands where the trip's middle is, ride
// included.
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

// Turns location fixes into street sightings; pure, so the page owns the watcher and the storage.

import { edgeDurableKey, type RoutingGraph } from "../routing/graph";
import {
  haversineMeters,
  nearestEdge,
  projectToEdge,
  type SnapIndex,
} from "../routing/snap";

// Wider than a street's two pavements are apart, so a vaguer fix can't say which side.
export const MAX_ACCURACY_METERS = 30;
// Outside this the fix is in a building, a park lawn or a car park, not on a street.
export const MATCH_METERS = 20;
// A brisk walk or a jog; past it the fix is a bike, a bus or a car, which is not walking a street.
export const MAX_WALK_METERS_PER_SECOND = 3;
// A street seen again inside this is the same pass, however the fixes jitter between edges.
export const PASS_MS = 10 * 60 * 1000;
// Share of a street one pass must cover to count, so passing its end or crossing it doesn't.
export const COVER_SHARE = 0.5;
// About how far a still fix wanders along a street; a street shorter than this must be walked end to end.
export const MIN_COVER_METERS = 15;

export interface Fix {
  lat: number;
  lng: number;
  accuracy: number; // meters, as GeolocationCoordinates reports it
  speed: number | null; // meters per second, where the device reports it
  at: number; // epoch ms
}

interface Pass {
  from: number; // meters from A, the least projection so far
  to: number;
  at: number; // epoch ms of the latest fix on it
  counted: boolean;
}

export class WalkTracker {
  private last: Fix | null = null;
  private previous: { fix: Fix; edge: number } | null = null; // the last fix, if it matched a street
  private readonly passes = new Map<number, Pass>(); // durable key -> the stretch covered this pass

  // Durable keys this fix finishes covering; none for a fix that says nothing about walking a street.
  observe(fix: Fix, graph: RoutingGraph, index: SnapIndex): number[] {
    const previous = this.previous;
    this.previous = null;
    if (!(fix.accuracy <= MAX_ACCURACY_METERS)) {
      return [];
    }
    const last = this.last;
    this.last = fix;
    if (this.tooFast(fix, last)) {
      return [];
    }
    const match = nearestEdge(graph, index, fix, MATCH_METERS);
    if (match === null || edgeDurableKey(graph, match.edge) === -1) {
      return [];
    }
    this.previous = { fix, edge: match.edge };
    for (const [stale, pass] of this.passes) {
      if (fix.at - pass.at >= PASS_MS) {
        this.passes.delete(stale);
      }
    }
    const bridge =
      previous !== null && fix.at - previous.fix.at < PASS_MS ? previous : null;
    // The step from the last fix runs along whichever of the two streets both fixes sit on.
    const edges =
      bridge === null || bridge.edge === match.edge
        ? [match.edge]
        : [bridge.edge, match.edge];
    const counted: number[] = [];
    for (const edge of edges) {
      const here = projectToEdge(graph, edge, fix.lat, fix.lng);
      if (here.distanceMeters > MATCH_METERS) {
        continue;
      }
      let from = here.metersFromA;
      let to = here.metersFromA;
      if (bridge !== null) {
        const before = projectToEdge(
          graph,
          edge,
          bridge.fix.lat,
          bridge.fix.lng,
        );
        if (before.distanceMeters <= MATCH_METERS) {
          from = Math.min(from, before.metersFromA);
          to = Math.max(to, before.metersFromA);
        }
      }
      const key = edgeDurableKey(graph, edge);
      const pass = this.passes.get(key);
      const covered =
        pass === undefined
          ? { from, to, at: fix.at, counted: false }
          : {
              ...pass,
              from: Math.min(pass.from, from),
              to: Math.max(pass.to, to),
              at: fix.at,
            };
      this.passes.set(key, covered);
      const length = graph.edgeLength[edge];
      const needed = Math.min(
        length,
        Math.max(COVER_SHARE * length, MIN_COVER_METERS),
      );
      // Lengths are float32, so a walk end to end rounds back to the whole length.
      if (
        !covered.counted &&
        Math.fround(covered.to - covered.from) >= needed
      ) {
        covered.counted = true;
        counted.push(key);
      }
    }
    return counted;
  }

  // The device's own speed where it has one; else the pace since the last fix.
  private tooFast(fix: Fix, previous: Fix | null): boolean {
    if (fix.speed !== null && Number.isFinite(fix.speed)) {
      return fix.speed > MAX_WALK_METERS_PER_SECOND;
    } else if (previous === null || fix.at <= previous.at) {
      return false;
    } else {
      const meters = haversineMeters(
        previous.lat,
        previous.lng,
        fix.lat,
        fix.lng,
      );
      return (
        meters / ((fix.at - previous.at) / 1000) > MAX_WALK_METERS_PER_SECOND
      );
    }
  }
}

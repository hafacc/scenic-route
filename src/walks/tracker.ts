// Turns location fixes into street sightings; pure, so the page owns the watcher and the storage.

import { edgeDurableKey, type RoutingGraph } from "../routing/graph";
import { haversineMeters, nearestEdge, type SnapIndex } from "../routing/snap";

// Wider than a street's two pavements are apart, so a vaguer fix can't say which side.
export const MAX_ACCURACY_METERS = 30;
// Outside this the fix is in a building, a park lawn or a car park, not on a street.
export const MATCH_METERS = 20;
// A brisk walk or a jog; past it the fix is a bike, a bus or a car, which is not walking a street.
export const MAX_WALK_METERS_PER_SECOND = 3;
// A street seen again inside this is the same pass, however the fixes jitter between edges.
export const PASS_MS = 10 * 60 * 1000;

export interface Fix {
  lat: number;
  lng: number;
  accuracy: number; // meters, as GeolocationCoordinates reports it
  speed: number | null; // meters per second, where the device reports it
  at: number; // epoch ms
}

export class WalkTracker {
  private last: Fix | null = null;
  private readonly seen = new Map<number, number>(); // durable key -> when last counted

  // The durable key to count, or null for a fix that says nothing about walking a street.
  observe(fix: Fix, graph: RoutingGraph, index: SnapIndex): number | null {
    if (!(fix.accuracy <= MAX_ACCURACY_METERS)) {
      return null;
    }
    const previous = this.last;
    this.last = fix;
    if (this.tooFast(fix, previous)) {
      return null;
    }
    const match = nearestEdge(graph, index, fix, MATCH_METERS);
    const key = match === null ? -1 : edgeDurableKey(graph, match.edge);
    if (key === -1) {
      return null;
    }
    for (const [stale, at] of this.seen) {
      if (fix.at - at >= PASS_MS) {
        this.seen.delete(stale);
      }
    }
    if (this.seen.has(key)) {
      return null;
    }
    this.seen.set(key, fix.at);
    return key;
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

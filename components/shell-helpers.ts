// The constants and pure functions map-shell.svelte uses.
import { type City, cityInSentence, containsPoint } from "../src/cities";
import { loadGraph, type RoutingGraph } from "../src/routing/graph";
import { routerClient } from "../src/routing/router-client";
import { buildSnapIndex, type SnapIndex } from "../src/routing/snap";
import type { LatLng } from "../src/url-state";

export const RESNAP_METERS = 25;
// Matches the zoom the map's own follow camera uses.
export const LOCATED_ZOOM = 16;
// Only ever zoomed in to: someone looking at one block shouldn't be pulled back out.
export const SEARCH_PIN_ZOOM = 16;
export const LANDMARK_PASS_METERS = 40;
export const ART_PASS_METERS = 40;

// Built once per city and shared, so switching back doesn't rebuild an index over 600k edges.
const routingPromises = new Map<
  string,
  Promise<{ graph: RoutingGraph; index: SnapIndex }>
>();
export function loadRouting(
  cityId: string,
): Promise<{ graph: RoutingGraph; index: SnapIndex }> {
  const pending = routingPromises.get(cityId);
  if (pending) {
    return pending;
  }
  const request = loadGraph(cityId)
    .then((graph) => {
      // Handed over now, so the worker decodes its copy while this thread builds the snap index.
      void routerClient()
        .load(cityId, graph)
        .catch(() => {}); // the route effect reports it
      return { graph, index: buildSnapIndex(graph) };
    })
    .catch((error: unknown) => {
      routingPromises.delete(cityId);
      throw error;
    });
  routingPromises.set(cityId, request);
  return request;
}

export function metersBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = Math.PI / 180;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const deltaLat = (b.lat - a.lat) * toRad;
  const deltaLng = (b.lng - a.lng) * toRad;
  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);
  const inner =
    sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(inner)));
}

// Outside the city is its own failure; "300 m from a walkable street" there reads as a map gap.
export function messageFor(
  reason: "startTooFar" | "destTooFar" | "disconnected",
  city: City,
  point: LatLng | null,
): string {
  if (reason === "disconnected") {
    return "No walkable connection in the street data — likely separated by water.";
  } else if (point && !containsPoint(city, point)) {
    return `That point is outside ${cityInSentence(city)}, and a route cannot leave it.`;
  } else {
    return "That point is more than 300 m from a walkable street.";
  }
}

// One hex, mixed in oklab to keep lightness; the percentages are emerald's stops against 600.
export function accentVars(hex: string): string {
  return [
    `--color-brand-50:color-mix(in oklab, ${hex} 8%, white)`,
    `--color-brand-100:color-mix(in oklab, ${hex} 18%, white)`,
    `--color-brand-400:color-mix(in oklab, ${hex} 62%, white)`,
    `--color-brand-500:color-mix(in oklab, ${hex} 82%, white)`,
    `--color-brand-600:${hex}`,
    `--color-brand-700:color-mix(in oklab, ${hex} 82%, black)`,
  ].join(";");
}

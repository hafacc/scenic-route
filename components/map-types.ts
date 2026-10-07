// The types map.svelte and route-layer.svelte share, kept apart so importing them never loads Leaflet.
import type { RouteResult } from "../src/routing/search";

export interface MapTarget {
  lat: number;
  lng: number;
  zoom?: number;
}

export interface SearchPin {
  lat: number;
  lng: number;
  label: string;
}

export interface RouteLine {
  result: RouteResult;
  color: string;
  label: string;
  selected: boolean;
  // Stays drawn, unselected, until the new plan lands.
  dimmed?: boolean;
}

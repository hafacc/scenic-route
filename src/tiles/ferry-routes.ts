// Each feed's GTFS `route_color` by `route_long_name`; kept here so a recolor needs no re-ingest.
const ROUTE_COLORS: Record<string, string> = {
  Astoria: "#ff6b00",
  "East River": "#00839c",
  "Governors Island Shuttle": "#9795a0",
  "Rockaway Rocket": "#ff8672",
  "Rockaway-Soundview": "#4e008e",
  "South Brooklyn": "#ffd100",
  "St. George": "#d0006f",
  "Staten Island Ferry": "#ff8330",
  "Alameda Seaplane": "#df7a1c",
  "Harbor Bay": "#c74a5d",
  "Oakland & Alameda": "#4fab47",
  "Oakland Alameda Water Shuttle": "#ffd400",
};

export interface RouteStyle {
  color: string | null; // null falls back to the layer's color
  route: number; // index in sorted name order
}

// Indexed by sorted name so a route is stable across tiles; unnamed segments share the last index.
export function routeStyles(routes: readonly (string | null)[]): RouteStyle[] {
  const named = [...new Set(routes.filter((route) => route !== null))].sort();
  const indices = new Map(named.map((route, index) => [route, index]));
  return routes.map((route) => ({
    color: route === null ? null : (ROUTE_COLORS[route] ?? null),
    route: route === null ? named.length : (indices.get(route) ?? named.length),
  }));
}

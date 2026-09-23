import { activeCity, cityById } from "./cities";
import {
  reverseNameIndex,
  searchCenter,
  searchNameIndex,
} from "./search/name-search";
import type { IndexHit, ReverseHit } from "./search/protocol";
import { sharedQueries } from "./share-target";

// Only searches are cached; naming a point is cheaper to redo than to keep.
const MAX_CACHE_ENTRIES = 200;

export const SUBWAY_RESULT_TYPE = "subway-station";
// Routes listed before an ellipsis; Times Sq serves ten.
const MAX_ROUTE_BULLETS = 4;

export interface GeocodeResult {
  placeId: string;
  lat: number;
  lng: number;
  displayName: string;
  type: string;
  // The house number typed, not the nearest door the city could offer.
  exact: boolean;
}

const searchCache = new Map<string, GeocodeResult[]>();

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (!map.has(key) && map.size >= MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
  map.set(key, value);
}

// One point stands for the whole street.
export const STREET_RESULT_TYPE = "scenic:street";

export const INDEX_RESULT_TYPE = "scenic:index";

export const ADDRESS_RESULT_TYPE = "scenic:address";

function reverseResultType(kind: ReverseHit["kind"]): string {
  if (kind === "address") {
    return ADDRESS_RESULT_TYPE;
  } else if (kind === "station") {
    return SUBWAY_RESULT_TYPE;
  } else if (kind === "street") {
    return STREET_RESULT_TYPE;
  } else {
    return INDEX_RESULT_TYPE;
  }
}

// Label only (routes use the coordinate); null when nothing is near enough, and never invented.
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<GeocodeResult | null> {
  const cityId = activeCity().id;
  const hit = await reverseNameIndex(cityId, { lat, lng });
  if (hit === null) {
    return null;
  }
  const name = hit.at ? hit.name : `near ${hit.name}`;
  return {
    placeId: `local:${cityId}:${hit.kind}:${hit.lat.toFixed(5)},${hit.lng.toFixed(5)}`,
    lat: hit.lat,
    lng: hit.lng,
    displayName: [name, hit.label].filter(Boolean).join(", "),
    type: reverseResultType(hit.kind),
    exact: hit.at,
  };
}

const MAX_LOCAL_RESULTS = 8;

// A station lists its routes, since "Bedford Av" is both a street and a station.
function localDisplayName(hit: IndexHit): string {
  if (hit.kind === "station") {
    const routes = hit.category === null ? [] : hit.category.split("/");
    const bullets = routes.slice(0, MAX_ROUTE_BULLETS).join("/");
    const shown = routes.length > MAX_ROUTE_BULLETS ? `${bullets}…` : bullets;
    return shown
      ? `${hit.name} (${shown}) — subway station`
      : `${hit.name} — subway station`;
  } else if (hit.label.startsWith(hit.name)) {
    return hit.label;
  } else {
    return [hit.name, hit.label].filter(Boolean).join(", ");
  }
}

function localResultType(hit: IndexHit): string {
  if (hit.exact !== null) {
    return ADDRESS_RESULT_TYPE;
  } else if (hit.kind === "station") {
    return SUBWAY_RESULT_TYPE;
  } else if (hit.kind === "street") {
    return STREET_RESULT_TYPE;
  } else {
    return INDEX_RESULT_TYPE;
  }
}

// Only the exact typed door at the top is routed to without asking; anything else gets a list.
export function exactAddressMatch(
  results: readonly GeocodeResult[],
): GeocodeResult | null {
  const [top] = results;
  if (top?.exact === true && top.type === ADDRESS_RESULT_TYPE) {
    return top;
  } else {
    return null;
  }
}

// Null means the index hasn't arrived yet, not "no such place".
export async function searchPlaces(
  query: string,
  cityId: string = activeCity().id,
): Promise<GeocodeResult[] | null> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  // Ranking depends on the center, so it's in the key, rounded to ~1 km so panning keeps the cache.
  const center =
    searchCenter(cityId) ?? (cityById(cityId) ?? activeCity()).center;
  const near = `${center.lat.toFixed(2)},${center.lng.toFixed(2)}`;
  const cacheKey = `${cityId}|${trimmed}@${near}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const indexHits = await searchNameIndex({
    cityId,
    text: trimmed,
    center,
    limit: MAX_LOCAL_RESULTS,
  });
  const results: GeocodeResult[] = [];
  // Identical rows collapse to the best-ranked, and a bare street name to one of its namesakes.
  const listed = new Set<string>();
  const streets = new Set<string>();
  for (const hit of indexHits ?? []) {
    const displayName = localDisplayName(hit);
    const bare = hit.exact === null && hit.kind === "street";
    if (listed.has(displayName) || (bare && streets.has(hit.name))) {
      continue;
    }
    listed.add(displayName);
    if (bare) {
      streets.add(hit.name);
    }
    results.push({
      placeId: `local:${cityId}:${hit.kind}:${hit.lat.toFixed(5)},${hit.lng.toFixed(5)}:${displayName}`,
      lat: hit.lat,
      lng: hit.lng,
      displayName,
      type: localResultType(hit),
      exact: hit.exact === true,
    });
  }
  if (indexHits === null) {
    return null;
  } else {
    // Caching a not-yet-fetched index's empty answer would outlive its arrival.
    setBounded(searchCache, cacheKey, results);
    return results;
  }
}

// For shared links, resolved after `awaitNameIndex` has already waited, so null means a failed fetch.
export async function searchAddress(
  query: string,
  cityId: string = activeCity().id,
): Promise<GeocodeResult[]> {
  return (await searchPlaces(query, cityId)) ?? [];
}

export interface SharedDestination {
  query: string;
  results: GeocodeResult[];
  exact: GeocodeResult | null;
}

// Searches every reading so a door wins wherever it sits ("Katz's Delicatessen, 205 E Houston St").
// `canceled` is checked between searches, since each one warms the worker for its city.
export async function resolveSharedQuery(
  text: string,
  cityId: string,
  search: (
    query: string,
    cityId: string,
  ) => Promise<GeocodeResult[]> = searchAddress,
  canceled: () => boolean = () => false,
): Promise<SharedDestination | null> {
  let named: SharedDestination | null = null;
  for (const query of sharedQueries(text)) {
    if (canceled()) {
      return null;
    }
    const results = await search(query, cityId);
    const exact = exactAddressMatch(results);
    if (exact !== null) {
      return { query, results, exact };
    }
    if (named === null && results.length > 0) {
      named = { query, results, exact: null };
    }
  }
  return canceled() ? null : named;
}

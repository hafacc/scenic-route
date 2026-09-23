// "City" is the code's word, but `sf` is a region ("Bay Area"), so reader-facing text says "region".
import type { OverlayId } from "./overlays/registry";
import manifest from "./tree-cover/manifest.json";
import type { LatLng } from "./url-state";

export interface CityBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface City {
  id: string;
  name: string;
  bounds: CityBounds;
  center: LatLng;
  // Timetables are written in this zone, so hours and service days never use the browser's offset.
  timeZone: string;
  // In switcher order; a shared link naming an overlay the city lacks drops it rather than breaking.
  overlays: readonly OverlayId[];
  // Curb to the baked sidewalk line.
  sidewalkInsetMeters: number;
  // Longest pier wait before the ferry stops counting; absent means src/routing/cost.ts's default.
  maxFerryWaitSeconds?: number;
  // The same cap for a platform; absent means the default.
  maxTransitWaitSeconds?: number;
}

// Authored, not derived: a city may have a layer's data and still not want it in the switcher.
const OVERLAYS_BY_CITY: Record<string, readonly OverlayId[]> = {
  nyc: [
    "canopy",
    "genus",
    "landmarks",
    "art",
    "ferries",
    "subway",
    "highways",
    "industrial",
    "historic",
    "legacy",
    "commercial",
    "shade",
    "scaffolding",
  ],
  // Its Muni and BART rail rides under the "subway" id: same artifact, same layer.
  sf: [
    "canopy",
    "genus",
    "elevation",
    "landmarks",
    "art",
    "ferries",
    "subway",
    "highways",
    "industrial",
    "historic",
    "legacy",
    "shade",
  ],
};

// Ids whose name takes "the" mid-sentence: "outside the Bay Area"; the name itself can't say.
const ARTICLED_NAMES: ReadonlySet<string> = new Set(["sf"]);

export function cityInSentence(city: City): string {
  return ARTICLED_NAMES.has(city.id) ? `the ${city.name}` : city.name;
}

const METERS_PER_DEGREE_LAT = 111_320;

// The zoom a city opens at when there is no camera to restore.
export const CITY_ZOOM = 13;

// Past this the camera cuts rather than flies, so viewport consumers never render the ocean between.
export const CROSS_CITY_METERS = 120_000;

// The Bay's ferry is the only way across on foot with a 140-minute midday gap, so a short cap refuses.
const MAX_FERRY_WAIT_BY_CITY: Record<string, number> = {
  sf: 150 * 60,
};

// A coordinate carries no zone, and a wrong guess shows up as the wrong trains rather than an error.
const TIME_ZONE_BY_CITY: Record<string, string> = {
  nyc: "America/New_York",
  sf: "America/Los_Angeles",
};

export const CITIES: readonly City[] = manifest.cities.map((city) => ({
  id: city.id,
  name: city.name,
  bounds: city.bounds,
  center: {
    lat: (city.bounds.north + city.bounds.south) / 2,
    lng: (city.bounds.east + city.bounds.west) / 2,
  },
  timeZone: TIME_ZONE_BY_CITY[city.id] ?? "America/New_York",
  overlays: OVERLAYS_BY_CITY[city.id] ?? [],
  sidewalkInsetMeters: city.streets.sidewalkInsetMeters,
  maxFerryWaitSeconds: MAX_FERRY_WAIT_BY_CITY[city.id],
}));

export const DEFAULT_CITY: City = CITIES[0];

// 0 inside; longitude is scaled by latitude so the gap is in ground meters.
export function metersFromCity(city: City, point: LatLng): number {
  const { bounds } = city;
  const north = Math.max(0, bounds.south - point.lat, point.lat - bounds.north);
  const east = Math.max(0, bounds.west - point.lng, point.lng - bounds.east);
  const northMeters = north * METERS_PER_DEGREE_LAT;
  const eastMeters =
    east * METERS_PER_DEGREE_LAT * Math.cos((point.lat * Math.PI) / 180);
  return Math.hypot(northMeters, eastMeters);
}

export function cityById(id: string | null): City | null {
  return CITIES.find((city) => city.id === id) ?? null;
}

// For non-React modules; exactly one city is live at a time, so a global beats threading a parameter.
let active: City = DEFAULT_CITY;

export function setActiveCity(city: City): void {
  active = city;
}

export function activeCity(): City {
  return active;
}

export function containsPoint(city: City, point: LatLng): boolean {
  return metersFromCity(city, point) === 0;
}

// Overlap, not containment: a city half off the edge is still in view.
export function citiesInView(view: CityBounds): City[] {
  return CITIES.filter(
    ({ bounds }) =>
      bounds.south <= view.north &&
      bounds.north >= view.south &&
      bounds.west <= view.east &&
      bounds.east >= view.west,
  );
}

// Never null: an out-of-coverage visitor goes to the nearest city rather than an empty map.
export function nearestCity(point: LatLng): City {
  return CITIES.reduce((best, city) =>
    metersFromCity(city, point) < metersFromCity(best, point) ? city : best,
  );
}

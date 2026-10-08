// Pure URL rules for the service worker; it caches what the page asks for and never fetches itself.

import { APP_PAGES, MODES_PAGE, SHELL_EXTRAS } from "../pages";

// Routing is its own store so a long clock scrub filling the overlay store can't evict the graph.
export type Store = "shell" | "routing" | "overlay";

// Rewritten daily on the default branch, so read from raw rather than the deploy.
const FEED_HOST = "raw.githubusercontent.com";
const FEED_PREFIX = "/hafacc/scenic-route/main/public/";
const FEED_DIRS = ["sheds/", "ferry-schedule/", "transit-schedule/"];

// Protomaps' terms allow keeping tiles; only those over a city are kept, not ocean pans.
const BASEMAP_HOST = "api.protomaps.com";
const BASEMAP_TILE = /^\/tiles\/v\d+\/(\d+)\/(\d+)\/(\d+)\.[a-z]+$/;

export interface CityBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

// Compared as boxes, so a low-zoom tile covering a city is kept for zooming in from.
export function coversACity(
  path: string,
  cities: readonly CityBounds[],
): boolean {
  const match = BASEMAP_TILE.exec(`/${path}`);
  if (!match) {
    return false;
  }
  const [zoom, x, y] = match.slice(1).map(Number);
  const span = 2 ** zoom;
  if (x < 0 || y < 0 || x >= span || y >= span) {
    return false;
  }
  const west = (x / span) * 360 - 180;
  const east = ((x + 1) / span) * 360 - 180;
  // Web Mercator: latitude is the inverse Gudermannian of the row, and y counts down from the north.
  const latitude = (row: number): number =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / span))) * 180) / Math.PI;
  const north = latitude(y);
  const south = latitude(y + 1);
  return cities.some(
    (city) =>
      west < city.east &&
      east > city.west &&
      south < city.north &&
      north > city.south,
  );
}

// Read once into memory, so their read times never move and LRU would evict them first.
const KEPT_DIRS = ["routing/", "addresses/", "search/"];

// Every page's path and file, plus src/pages.ts extras, which the precache is built from too.
const SHELL_FILES = [
  ...APP_PAGES.flatMap((page) => [page.path, page.file]),
  ...SHELL_EXTRAS,
];
const SHELL_DIRS = ["_app/", "icons/"];

// Everything unknown, 404 included, gets the root document, which is the app's not-found page.
export function pageFor(path: string): string {
  const page = APP_PAGES.find(
    (entry) => entry.path === path || entry.file === path,
  );
  return page ? page.file : MODES_PAGE.file;
}

// Null leaves the request alone, with no `respondWith`.
export interface Filed {
  path: string;
  store: Store;
  // Network first; only the daily feeds change without a deploy.
  fresh: boolean;
  // The basemap key rides in the query string, so keying by full URL would orphan tiles on rotation.
  cacheKey?: string;
}

export function fileRequest(
  url: string,
  scope: string,
  cities: readonly CityBounds[] = [],
): Filed | null {
  const target = new URL(url);
  if (target.host === BASEMAP_HOST) {
    const path = target.pathname.replace(/^\//, "");
    return coversACity(path, cities)
      ? {
          path,
          store: "overlay",
          fresh: false,
          cacheKey: `${target.origin}/${path}`,
        }
      : null;
  }
  if (target.host === FEED_HOST) {
    const dir = target.pathname.startsWith(FEED_PREFIX)
      ? target.pathname.slice(FEED_PREFIX.length)
      : null;
    if (dir !== null && FEED_DIRS.some((feed) => dir.startsWith(feed))) {
      return { path: dir, store: "routing", fresh: true };
    }
    return null;
  }
  const root = new URL(scope);
  if (
    target.origin !== root.origin ||
    !target.pathname.startsWith(root.pathname)
  ) {
    return null;
  }
  // Not the href, or every share link's `#at=` would get its own cache entry.
  const path = target.pathname.slice(root.pathname.length);
  if (path === "sw.js") {
    return null; // or a deploy could never replace the worker
  }
  if (
    SHELL_FILES.includes(path) ||
    SHELL_DIRS.some((dir) => path.startsWith(dir))
  ) {
    return { path, store: "shell", fresh: false };
  }
  // The default rather than a list, so a new layer can't be silently left out of offline.
  return {
    path,
    store: KEPT_DIRS.some((dir) => path.startsWith(dir))
      ? "routing"
      : "overlay",
    fresh: false,
  };
}

// The (city, bin) of a display pyramid tile or routing shade fraction, else null.
export interface ShadeKey {
  city: string;
  bin: number;
}

export function shadeKey(path: string): ShadeKey | null {
  const parts = path.split("/");
  const [head, kind, city, fourth] = parts;
  if (head === "tiles" && (kind === "shade" || kind === "tree-shade")) {
    // Excludes `buckets.json`, which sits where a bin directory would.
    const bin = binNumber(fourth);
    return bin === null || parts.length < 5 ? null : { city, bin };
  }
  if (head === "routing" && kind === "shade" && parts.length === 4) {
    const bin = fourth?.endsWith(".bin")
      ? binNumber(fourth.slice(0, -".bin".length))
      : null;
    return bin === null ? null : { city, bin };
  }
  return null;
}

// Read once into memory, so its read time never moves and LRU would evict it first.
export function isGraph(path: string): boolean {
  return /^routing\/[^/]+\.bin$/.test(path);
}

function binNumber(text: string | undefined): number | null {
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : null;
}

// A deploy's content hash per unit of what it serves, baked into the worker by scripts/build-sw.ts.
export type Stamps = Readonly<Record<string, string>>;

// Fine enough that one city's rebuild keeps the other's, coarse enough to bake into the worker.
export function contentUnit(path: string): string {
  const parts = path.split("/");
  const depth = shadeKey(path) ? 4 : parts[0] === "tiles" ? 3 : 2;
  return parts.slice(0, depth).join("/");
}

// A unit that changed, appeared or went away; another host's (unstamped, mutable) files always are.
export function outdated(
  url: string,
  scope: string,
  before: Stamps,
  after: Stamps,
): boolean {
  const target = new URL(url);
  const root = new URL(scope);
  if (
    target.origin !== root.origin ||
    !target.pathname.startsWith(root.pathname)
  ) {
    return true;
  }
  const unit = contentUnit(target.pathname.slice(root.pathname.length));
  return stampOf(before, unit) !== stampOf(after, unit);
}

function stampOf(stamps: Stamps, unit: string): string | undefined {
  return Object.hasOwn(stamps, unit) ? stamps[unit] : undefined;
}

// Whether a stored marker vouches for exactly these stamps, whatever order its keys came back in.
export function sameStamps(stored: Stamps | null, current: Stamps): boolean {
  if (stored === null) {
    return false;
  }
  const units = Object.keys(current);
  return (
    Object.keys(stored).length === units.length &&
    units.every((unit) => stampOf(stored, unit) === current[unit])
  );
}

// Revalidated on a miss, so a stale HTTP or CDN copy isn't pinned under a stamp that now matches.
export function missRequest(request: Request, scope: string): Request {
  return new URL(request.url).origin === new URL(scope).origin
    ? new Request(request, { cache: "no-cache" })
    : request;
}

// Past half the cache, deleting it whole beats a delete per entry.
export function dropsMost(doomed: number, total: number): boolean {
  return doomed > 0 && doomed * 2 > total;
}

export function chunked<Item>(items: readonly Item[], size: number): Item[][] {
  const chunks: Item[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

interface ScriptCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

// Network first, keeping a copy; the copy answers offline or once a deploy has taken the hashed file away.
export async function freshThenStored(
  request: Request,
  load: (request: Request) => Promise<Response>,
  cache: ScriptCache,
  keep: (stored: Promise<void>) => void,
): Promise<Response> {
  let response: Response | null = null;
  let failure: unknown;
  try {
    response = await load(request);
  } catch (error) {
    failure = error;
  }
  if (response?.ok) {
    keep(cache.put(request, response.clone()));
    return response;
  }
  const stored = await cache.match(request);
  if (stored) {
    return stored;
  } else if (response) {
    return response;
  } else {
    throw failure;
  }
}

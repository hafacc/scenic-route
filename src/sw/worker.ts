import {
  forget,
  overflowing,
  readConfig,
  record,
  touch,
  wipe,
  writeConfig,
} from "./ledger";
import {
  type Filed,
  fileRequest,
  isGraph,
  pageFor,
  type Store,
  shadeKey,
} from "./policy";
import type { ReleaseReply } from "./update";

// Owns storage policy only; an offline cache miss rejects rather than answering 404.
// Built by scripts/build-sw.ts into out/sw.js; the committed public/sw.js is a no-cache dev stub.

// Replaced at build time; the version is the deploy's git sha, so every deploy gets new cache names.
declare const SW_VERSION: string;
declare const SW_PRECACHE: readonly string[];
// The owner's deploy marker, from src/sw/update.ts.
declare const SW_RELEASE: number;
declare const SW_CITIES: readonly {
  west: number;
  south: number;
  east: number;
  north: number;
}[];

interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike extends ExtendableEventLike {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

interface MessageEventLike extends ExtendableEventLike {
  data: unknown;
  ports: readonly MessagePort[];
}

// `self` types as a Window under the dom lib, and the webworker lib conflicts with it.
const scope = globalThis as unknown as {
  addEventListener(
    type: "install" | "activate",
    handler: (event: ExtendableEventLike) => void,
  ): void;
  addEventListener(
    type: "fetch",
    handler: (event: FetchEventLike) => void,
  ): void;
  addEventListener(
    type: "message",
    handler: (event: MessageEventLike) => void,
  ): void;
  registration: { scope: string };
  clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
};

// Sized so one city fits (NYC at every zoom is ~400 MB of overlay; routing for both is ~71 MB).
// The shell is uncapped since losing any of it stops the app opening; OVERLAY_CAP overrides overlay.
const CAPS: Partial<Record<Store, number>> = {
  routing: 128 * 1024 * 1024,
  overlay: 1024 * 1024 * 1024,
};

// `undefined` is not read yet (use the built-in cap); `null` is the reader's choice of no cap.
const OVERLAY_CAP = "overlay-cap";
let overlayCap: number | null | undefined;
// The page's message starts a stopped worker, so it can beat this read, which is then stale.
let capFromPage = false;
const capLoaded = readConfig(OVERLAY_CAP)
  .then((stored) => {
    if (!capFromPage && stored !== undefined) {
      overlayCap = typeof stored === "number" ? stored : null;
    }
  })
  .catch(() => undefined);

function capFor(which: Store): number {
  if (which === "overlay" && overlayCap !== undefined) {
    return overlayCap ?? Number.POSITIVE_INFINITY;
  } else {
    return CAPS[which] ?? Number.POSITIVE_INFINITY;
  }
}

// A pan hits dozens of tiles at once, so a hit's read time is recorded only when this stale.
const TOUCH_AFTER_MS = 10 * 60 * 1000;

const STORES: Record<Store, string> = {
  shell: `shell-${SW_VERSION}`,
  routing: `routing-${SW_VERSION}`,
  overlay: `overlay-${SW_VERSION}`,
};
const CURRENT = new Set(Object.values(STORES));

// Kept in a real cache so it survives worker restarts and a deploy's purge destroys it.
const seasonMarker = (city: string): string =>
  `${scope.registration.scope}__sw/shade-season/${city}`;

scope.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STORES.shell);
      await cache.addAll(
        SW_PRECACHE.map((file) => new URL(file, scope.registration.scope).href),
      );
    })(),
  );
});

// No skipWaiting on install: activating would purge chunks a still-open page may lazily import.
scope.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (!CURRENT.has(name)) {
          await caches.delete(name);
        }
      }
      await wipe().catch(() => {});
      // Only takes clients an older worker let go of; on a first visit it avoids needing a reload.
      await scope.clients.claim();
    })(),
  );
});

// Settings are pushed rather than queried, since waking a stopped worker costs the page a round trip.
scope.addEventListener("message", (event) => {
  const message = event.data as
    | { type: "overlay-cap"; bytes: number | null }
    | { type: "clear-overlays" }
    | { type: "release" }
    | { type: "skip-waiting" }
    | undefined;
  if (message?.type === "overlay-cap") {
    event.waitUntil(setOverlayCap(message.bytes));
  } else if (message?.type === "clear-overlays") {
    event.waitUntil(clearOverlays());
  } else if (message?.type === "release") {
    const reply: ReleaseReply = { release: SW_RELEASE };
    event.ports[0]?.postMessage(reply);
  } else if (message?.type === "skip-waiting") {
    // Every open page must reload on the hand-over, since activation deletes the shell they import.
    event.waitUntil(scope.skipWaiting());
  }
});

// Evicts now, since a lowered cap is usually meant to get the space back.
async function setOverlayCap(bytes: number | null): Promise<void> {
  capFromPage = true;
  overlayCap = bytes;
  await writeConfig(OVERLAY_CAP, bytes).catch(() => {});
  await evict("overlay", capFor("overlay"));
}

// Only the worker can do this, since the cache name carries the deploy's sha.
async function clearOverlays(): Promise<void> {
  const cache = await caches.open(STORES.overlay);
  const keys = await cache.keys();
  for (const request of keys) {
    await cache.delete(request);
  }
  await forget(
    "overlay",
    keys.map(({ url }) => url),
  ).catch(() => {});
}

scope.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }
  if (request.destination === "worker") {
    event.respondWith(serveWorkerScript(event));
    return;
  }
  const filed = fileRequest(request.url, scope.registration.scope, SW_CITIES);
  if (filed) {
    event.respondWith(serve(event, filed));
  }
});

// Turbopack passes worker config in the URL fragment, which a stored Response's URL drops; rewrap it.
async function serveWorkerScript(event: FetchEventLike): Promise<Response> {
  const { request } = event;
  const cache = await caches.open(STORES.shell);
  try {
    const response = await fetch(request);
    if (response.ok) {
      event.waitUntil(cache.put(request, response.clone()));
    }
    return response;
  } catch (error) {
    const stored = await cache.match(request);
    if (!stored) {
      throw error;
    }
    return new Response(await stored.blob(), {
      headers: stored.headers,
    });
  }
}

async function serve(event: FetchEventLike, filed: Filed): Promise<Response> {
  const { request } = event;
  if (filed.store === "shell" && request.mode === "navigate") {
    return await servePage(request, filed.path);
  }
  const cache = await caches.open(STORES[filed.store]);
  if (filed.fresh) {
    // Daily feeds: network first, since a stale permit or timetable is worse than a slow one.
    try {
      const response = await fetch(request);
      if (response.ok) {
        event.waitUntil(store(filed.store, request.url, response.clone()));
      }
      return response;
    } catch (error) {
      const stale = await cache.match(request);
      if (stale) {
        return stale;
      }
      throw error;
    }
  }
  const key = filed.cacheKey ?? request.url;
  const hit = await cache.match(key);
  if (hit) {
    event.waitUntil(read(filed.store, key));
    return hit;
  }
  const response = await fetch(request);
  // Not 404s: the pyramids are sparse on purpose, and a cached one would outlive the next deploy.
  if (response.ok) {
    event.waitUntil(store(filed.store, key, response.clone()));
    event.waitUntil(keepOneSeason(filed.path));
  }
  return response;
}

// Every cache write goes through here so the ledger that bounds it stays in step.
async function store(
  which: Store,
  key: string,
  response: Response,
): Promise<void> {
  const cache = await caches.open(STORES[which]);
  // A Response whose body a failed `put` touched can't be cloned, so buffer it for the retry.
  const body = await response.blob();
  await capLoaded;
  const cap = capFor(which);
  const copy = (): Response =>
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  let stored = await put(cache, key, copy());
  if (!stored) {
    // Out of the origin-wide quota, which something else may have filled; free half and retry once.
    await evict(which, cap === Number.POSITIVE_INFINITY ? 0 : cap / 2);
    stored = await put(cache, key, copy());
  }
  if (stored) {
    await record(which, key, body.size, Date.now()).catch(() => {});
    await evict(which, cap);
  }
}

async function put(
  cache: Cache,
  key: string,
  response: Response,
): Promise<boolean> {
  try {
    await cache.put(key, response);
    return true;
  } catch {
    return false;
  }
}

const lastRead = new Map<string, number>();

async function read(which: Store, url: string): Promise<void> {
  const now = Date.now();
  if (now - (lastRead.get(url) ?? 0) < TOUCH_AFTER_MS) {
    return;
  }
  lastRead.set(url, now);
  await touch(which, url, now).catch(() => {});
}

async function evict(which: Store, cap: number): Promise<void> {
  if (cap === Number.POSITIVE_INFINITY) {
    return;
  }
  const over = await overflowing(which, cap).catch(() => [] as string[]);
  const doomed = over.filter((url) => {
    const filed = fileRequest(url, scope.registration.scope, SW_CITIES);
    return !filed || !isGraph(filed.path);
  });
  if (doomed.length === 0) {
    return;
  }
  const cache = await caches.open(STORES[which]);
  for (const url of doomed) {
    await cache.delete(url);
  }
  await forget(which, doomed).catch(() => {});
}

// Not written back, since caching navigations would file one copy of the page per share link.
async function servePage(request: Request, path: string): Promise<Response> {
  const cache = await caches.open(STORES.shell);
  const page = await cache.match(
    new URL(pageFor(path), scope.registration.scope).href,
  );
  return page ?? (await fetch(request));
}

// Keeps one shade season (a day's bins); the page only asks for the picked day, so keep the latest.
const kept = new Map<string, number>();
const purging = new Set<string>();

async function keepOneSeason(path: string): Promise<void> {
  const key = shadeKey(path);
  if (!key) {
    return;
  }
  const table = await seasonsFor(key.city);
  const season = table?.get(key.bin);
  if (!table || season === undefined) {
    return;
  }
  const marked = kept.get(key.city) ?? (await markedSeason(key.city));
  if (marked === season || purging.has(key.city)) {
    return;
  }
  // Set before the sweep so the next request doesn't start a second one.
  kept.set(key.city, season);
  purging.add(key.city);
  try {
    const cache = await caches.open(STORES.overlay);
    await cache.put(seasonMarker(key.city), new Response(String(season)));
    await purgeOtherSeasons(key.city, season, table);
  } finally {
    purging.delete(key.city);
  }
}

async function markedSeason(city: string): Promise<number | null> {
  const cache = await caches.open(STORES.overlay);
  const marker = await cache.match(seasonMarker(city));
  if (!marker) {
    return null;
  }
  const season = Number(await marker.text());
  kept.set(city, season);
  return season;
}

async function purgeOtherSeasons(
  city: string,
  season: number,
  table: ReadonlyMap<number, number>,
): Promise<void> {
  for (const which of ["overlay", "routing"] as const) {
    const cache = await caches.open(STORES[which]);
    const doomed: string[] = [];
    for (const request of await cache.keys()) {
      const filed = fileRequest(
        request.url,
        scope.registration.scope,
        SW_CITIES,
      );
      const key = filed && shadeKey(filed.path);
      if (key && key.city === city && table.get(key.bin) !== season) {
        doomed.push(request.url);
      }
    }
    for (const url of doomed) {
      await cache.delete(url);
    }
    await forget(which, doomed).catch(() => {});
  }
}

// Bin index to season, read through the cache so it works offline.
const tables = new Map<string, Promise<ReadonlyMap<number, number> | null>>();

function seasonsFor(city: string): Promise<ReadonlyMap<number, number> | null> {
  const pending = tables.get(city);
  if (pending) {
    return pending;
  }
  const url = new URL(
    `tiles/shade/${city}/buckets.json`,
    scope.registration.scope,
  ).href;
  const request = (async () => {
    const cache = await caches.open(STORES.overlay);
    const response = (await cache.match(url)) ?? (await fetch(url));
    if (!response.ok) {
      throw new Error(`${url}: ${response.status}`);
    }
    const buckets = (await response.json()) as {
      index: number;
      season: number;
    }[];
    return new Map(buckets.map(({ index, season }) => [index, season]));
  })().catch(() => {
    tables.delete(city); // retry an unreachable lookup rather than remember it as absent
    return null;
  });
  tables.set(city, request);
  return request;
}

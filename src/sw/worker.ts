import {
  drop,
  forget,
  overflowing,
  readConfig,
  record,
  touch,
  writeConfig,
} from "./ledger";
import {
  chunked,
  dropsMost,
  type Filed,
  fileRequest,
  freshThenStored,
  isGraph,
  missRequest,
  outdated,
  pageFor,
  type Stamps,
  type Store,
  sameStamps,
  shadeKey,
} from "./policy";

// Storage policy only: an offline miss rejects rather than answering 404; public/sw.js is the no-cache dev stub.

// Replaced by scripts/build-sw.ts as it builds out/sw.js; the version is the deploy's git sha, so every deploy gets a new shell.
declare const SW_VERSION: string;
declare const SW_PRECACHE: readonly string[];
declare const SW_STAMPS: Stamps;
declare const SW_CITIES: readonly {
  west: number;
  south: number;
  east: number;
  north: number;
}[];

// Named once, since a define is pasted in at every use.
const STAMPS = SW_STAMPS;

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
  registration: { scope: string; installing: unknown; waiting: unknown };
  clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
};

// One city fits (NYC's overlay is ~400 MB, both graphs ~71 MB); the shell is uncapped, and OVERLAY_CAP overrides overlay.
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

// Data outlives a deploy, which evicts only the units whose stamp it changed; the shell never does.
const STORES: Record<Store, string> = {
  shell: `shell-${SW_VERSION}`,
  routing: "routing",
  overlay: "overlay",
};
const CURRENT = new Set(Object.values(STORES));

// Kept in a real cache so it survives worker restarts.
const seasonMarker = (city: string): string =>
  `${scope.registration.scope}__sw/shade-season/${city}`;

// The stamps the data caches hold content of, kept beside it in the routing cache.
const stampsMarker = (): string => `${scope.registration.scope}__sw/stamps`;

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
      // The last shell's rows went with its cache; the precache was never counted.
      await drop("shell").catch(() => {});
      // A sweep that fails may leave data it can't vouch for, so it costs everything instead.
      stampsSettled = keepUnchanged()
        .catch(async () => {
          await clearData();
          await writeStamps();
        })
        .catch(() => {});
      await stampsSettled;
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
    // Pages from before #272 offer a reload only when a parked worker answers above their 1.
    event.ports[0]?.postMessage({ release: 2 });
  } else if (message?.type === "skip-waiting") {
    // Every open page must reload on the hand-over, since activation deletes the shell they import.
    event.waitUntil(scope.skipWaiting());
  }
});

// Set on activate; otherwise checked once per worker start, since a sweep cut short leaves no marker.
let stampsSettled: Promise<void> | null = null;

function stampsVouched(): Promise<void> {
  stampsSettled ??= (async () => {
    if (!sameStamps(await storedStamps(), STAMPS)) {
      await clearData();
      await writeStamps();
    }
  })().catch(() => {});
  return stampsSettled;
}

// Keeps what this deploy didn't change, so a deploy doesn't cost both graphs and every tile.
async function keepUnchanged(): Promise<void> {
  const before = await storedStamps();
  if (before === null) {
    // A first install, the sha-named era, or a sweep cut short: nothing says what is held.
    await clearData();
  } else {
    // Dropped first, so a sweep cut short leaves no claim and the next activate clears everything.
    const routing = await caches.open(STORES.routing);
    await routing.delete(stampsMarker());
    for (const which of ["routing", "overlay"] as const) {
      await sweep(which, before);
    }
  }
  await writeStamps();
}

async function writeStamps(): Promise<void> {
  const routing = await caches.open(STORES.routing);
  await routing.put(stampsMarker(), new Response(JSON.stringify(STAMPS)));
}

async function storedStamps(): Promise<Stamps | null> {
  const routing = await caches.open(STORES.routing);
  const marker = await routing.match(stampsMarker());
  return marker
    ? ((await marker.json().catch(() => null)) as Stamps | null)
    : null;
}

async function sweep(which: Store, before: Stamps): Promise<void> {
  const cache = await caches.open(STORES[which]);
  const keys = await cache.keys();
  const doomed = keys
    .map(({ url }) => url)
    .filter((url) => outdated(url, scope.registration.scope, before, STAMPS));
  if (dropsMost(doomed.length, keys.length)) {
    await caches.delete(STORES[which]);
    await drop(which).catch(() => {});
  } else {
    await discard(which, doomed);
  }
}

const DELETE_BATCH = 64;

// Every cache delete goes through here so the ledger forgets in step; batched, as a sweep can drop thousands.
async function discard(which: Store, urls: string[]): Promise<void> {
  if (urls.length === 0) {
    return;
  }
  const cache = await caches.open(STORES[which]);
  for (const batch of chunked(urls, DELETE_BATCH)) {
    await Promise.all(batch.map((url) => cache.delete(url)));
  }
  await forget(which, urls).catch(() => {});
}

async function clearData(): Promise<void> {
  for (const which of ["routing", "overlay"] as const) {
    await caches.delete(STORES[which]);
    await drop(which).catch(() => {});
  }
}

// Evicts now, since a lowered cap is usually meant to get the space back.
async function setOverlayCap(bytes: number | null): Promise<void> {
  capFromPage = true;
  overlayCap = bytes;
  await writeConfig(OVERLAY_CAP, bytes).catch(() => {});
  await evict("overlay", capFor("overlay"));
}

// Through the worker, so the ledger forgets what the cache drops.
async function clearOverlays(): Promise<void> {
  const cache = await caches.open(STORES.overlay);
  const keys = await cache.keys();
  await discard(
    "overlay",
    keys.map(({ url }) => url),
  );
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

async function serveWorkerScript(event: FetchEventLike): Promise<Response> {
  const cache = await caches.open(STORES.shell);
  return await freshThenStored(event.request, fetch, cache, (stored) =>
    event.waitUntil(stored),
  );
}

async function serve(event: FetchEventLike, filed: Filed): Promise<Response> {
  const { request } = event;
  if (filed.store === "shell" && request.mode === "navigate") {
    return await servePage(request, filed.path);
  }
  if (filed.store !== "shell") {
    await stampsVouched();
  }
  const cache = await caches.open(STORES[filed.store]);
  if (filed.fresh) {
    // Daily feeds: network first, since a stale permit or timetable is worse than a slow one.
    return await freshThenStored(
      request,
      fetch,
      {
        match: (asked) => cache.match(asked),
        put: (asked, response) => store(filed.store, asked.url, response),
      },
      (stored) => event.waitUntil(stored),
      { notOkStands: true },
    );
  }
  const key = filed.cacheKey ?? request.url;
  const hit = await cache.match(key);
  if (hit) {
    event.waitUntil(read(filed.store, key));
    return hit;
  }
  const response = await fetch(
    filed.store === "shell"
      ? request
      : missRequest(request, scope.registration.scope),
  );
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
  // A successor installing or waiting may already be live upstream, and these stamps can't vouch for it.
  if (
    which !== "shell" &&
    (scope.registration.installing || scope.registration.waiting)
  ) {
    return;
  }
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
  await discard(which, doomed);
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
    await discard(which, doomed);
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

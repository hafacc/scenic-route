import { afterControl } from "../sw/control";
import type {
  FromSearchWorker,
  IndexHit,
  InitMessage,
  QueryMessage,
  ReverseHit,
  ReverseMessage,
} from "./protocol";

// Queries before the ~7 MB index loads get null rather than waiting; only pin naming waits.

let worker: Worker | undefined;
// They differ while a load is in flight; after a failure `requested` resets so the next ask retries.
let requested: string | null = null;
let ready: string | null = null;

let nextQuery = 1;
// A newer query supersedes this one, whose promise gets null rather than hanging.
let asked: {
  id: number;
  resolve: (hits: IndexHit[] | null) => void;
} | null = null;

// Each lookup answers its own caller, so two pins named together both get theirs.
const named = new Map<number, (hit: ReverseHit | null) => void>();

let waiting: (() => void)[] = [];

// Pins pull the index in only while naming, then drop its ~20 MB of tables unless the panel holds it.
let naming = 0;
let heldForNaming = false;

function settle(hits: IndexHit[] | null): void {
  asked?.resolve(hits);
  asked = null;
}

// Null for every lookup still out, since the index they asked is gone.
function dropNames(): void {
  const dropped = [...named.values()];
  named.clear();
  for (const resolve of dropped) {
    resolve(null);
  }
}

function stopWaiting(): void {
  const waited = waiting;
  waiting = [];
  for (const resume of waited) {
    resume();
  }
}

function searchWorker(): Worker {
  if (!worker) {
    const created = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    worker = created;
    // A script that fails to load answers nothing, so whatever waits on it is let go.
    created.addEventListener("error", () => {
      if (worker === created) {
        console.error("search worker failed");
        releaseNameIndex();
      }
    });
    created.addEventListener(
      "message",
      ({ data }: MessageEvent<FromSearchWorker>) => {
        if (data.type === "ready") {
          ready = data.city;
          stopWaiting();
        } else if (data.type === "error") {
          if (requested === data.city) {
            requested = null; // a file this device could not fetch is retried, not remembered
          }
          console.error(`search index for ${data.city}:`, data.message);
          stopWaiting();
        } else if (data.type === "reverse") {
          const resolve = named.get(data.id);
          named.delete(data.id);
          resolve?.(data.hit);
        } else if (asked?.id === data.id) {
          settle(data.hits);
        }
      },
    );
  }
  return worker;
}

function indexUrls(cityId: string): { searchUrl: string; addressUrl: string } {
  // Against the document; inside the worker it would resolve to its chunk.
  return {
    searchUrl: new URL(`search/${cityId}.bin.gz`, document.baseURI).href,
    addressUrl: new URL(`addresses/${cityId}.bin.gz`, document.baseURI).href,
  };
}

// Fills the service worker's cache for every visitor: both files read in chunks and dropped, never decoded or held.
export async function prefetchNameIndex(cityId: string): Promise<void> {
  await new Promise<void>(afterControl);
  if (requested === cityId) {
    return; // the worker is already reading them; a second fetch would only race its own cache
  }
  const { searchUrl, addressUrl } = indexUrls(cityId);
  await Promise.all(
    [searchUrl, addressUrl].map(async (url) => {
      try {
        const response = await fetch(url);
        const reader = response.body?.getReader();
        while (reader) {
          const { done } = await reader.read();
          if (done) {
            break;
          }
        }
      } catch {
        // The worker refetches and reports failures when someone searches.
      }
    }),
  );
}

function warm(cityId: string, forNaming: boolean): void {
  if (!forNaming) {
    heldForNaming = false; // the panel is open, and it keeps the index for as long as it is
  }
  if (requested === cityId) {
    return;
  }
  heldForNaming = forNaming;
  requested = cityId;
  ready = null;
  settle(null); // whatever was outstanding belonged to the city being left
  dropNames();
  const message: InitMessage = {
    type: "init",
    city: cityId,
    ...indexUrls(cityId),
  };
  // Started once the service worker can store what it fetches.
  afterControl(() => {
    if (requested === cityId) {
      searchWorker().postMessage(message);
    }
  });
}

export function warmNameIndex(cityId: string): void {
  warm(cityId, false);
}

// Decoded tables are ~40 MB; the files stay cached, so rewarming reads from disk.
export function releaseNameIndex(): void {
  if (!worker && requested === null) {
    return;
  }
  worker?.terminate();
  worker = undefined;
  requested = null;
  ready = null;
  heldForNaming = false;
  settle(null);
  dropNames();
  stopWaiting();
}

// Kept with its city, since a center in another city says nothing about this one.
let mapCenter: { cityId: string; at: { lat: number; lng: number } } | null =
  null;

export function setSearchCenter(
  cityId: string,
  at: { lat: number; lng: number },
): void {
  mapCenter = { cityId, at };
}

// Null until the map settles over this city.
export function searchCenter(
  cityId: string,
): { lat: number; lng: number } | null {
  return mapCenter !== null && mapCenter.cityId === cityId
    ? mapCenter.at
    : null;
}

export interface NameSearch {
  cityId: string;
  text: string;
  center: { lat: number; lng: number };
  limit: number;
}

// Null while the city loads or when its file couldn't be fetched.
export function searchNameIndex({
  cityId,
  text,
  center,
  limit,
}: NameSearch): Promise<IndexHit[] | null> {
  warmNameIndex(cityId);
  if (ready !== cityId) {
    return Promise.resolve(null);
  }
  settle(null);
  const id = nextQuery;
  nextQuery += 1;
  const message: QueryMessage = {
    type: "query",
    id,
    text,
    center,
    limit,
  };
  searchWorker().postMessage(message);
  return new Promise((resolve) => {
    asked = { id, resolve };
  });
}

// A link's destination waits: the index is never ready at load, and null would show an empty list.
export async function awaitNameIndex(cityId: string): Promise<boolean> {
  warmNameIndex(cityId);
  if (ready !== cityId) {
    await new Promise<void>((resume) => waiting.push(resume));
  }
  return ready === cityId;
}

// Null where nothing is near enough, e.g. the middle of the harbor.
export async function reverseNameIndex(
  cityId: string,
  at: { lat: number; lng: number },
): Promise<ReverseHit | null> {
  naming += 1;
  try {
    warm(cityId, true);
    if (ready !== cityId) {
      await new Promise<void>((resume) => waiting.push(resume));
    }
    if (ready !== cityId) {
      return null; // the files never arrived, or the reader left for another city
    }
    const id = nextQuery;
    nextQuery += 1;
    const message: ReverseMessage = { type: "reverse", id, at };
    searchWorker().postMessage(message);
    return await new Promise<ReverseHit | null>((resolve) => {
      named.set(id, resolve);
    });
  } finally {
    naming -= 1;
    if (naming === 0 && heldForNaming) {
      releaseNameIndex();
    }
  }
}

"use client";

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

// Superseded the same way: a dragged endpoint asks several times a second.
let named: {
  id: number;
  resolve: (hit: ReverseHit | null) => void;
} | null = null;

let waiting: (() => void)[] = [];

// Pins pull the index in only while naming, then drop its ~20 MB of tables unless the panel holds it.
let naming = 0;
let heldForNaming = false;

function settle(hits: IndexHit[] | null): void {
  asked?.resolve(hits);
  asked = null;
}

function settleName(hit: ReverseHit | null): void {
  named?.resolve(hit);
  named = null;
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
    worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    worker.addEventListener(
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
          if (named?.id === data.id) {
            settleName(data.hit);
          }
        } else if (asked?.id === data.id) {
          settle(data.hits);
        }
      },
    );
  }
  return worker;
}

function indexUrls(cityId: string): { searchUrl: string; addressUrl: string } {
  // Against the document, for the deploy's basePath; inside the worker it would resolve to its chunk.
  return {
    searchUrl: new URL(`search/${cityId}.bin.gz`, document.baseURI).href,
    addressUrl: new URL(`addresses/${cityId}.bin.gz`, document.baseURI).href,
  };
}

// Fetches both files for the service worker's cache for every visitor, without decoding them.
// Read in chunks and dropped, as holding the whole body would cost most of what this avoids.
export async function prefetchNameIndex(cityId: string): Promise<void> {
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
  settleName(null);
  const message: InitMessage = {
    type: "init",
    city: cityId,
    ...indexUrls(cityId),
  };
  searchWorker().postMessage(message);
}

export function warmNameIndex(cityId: string): void {
  warm(cityId, false);
}

// Decoded tables are ~40 MB; the files stay cached, so rewarming reads from disk.
export function releaseNameIndex(): void {
  if (!worker) {
    return;
  }
  worker.terminate();
  worker = undefined;
  requested = null;
  ready = null;
  heldForNaming = false;
  settle(null);
  settleName(null);
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
    settleName(null); // an older pin has been superseded by this one
    const id = nextQuery;
    nextQuery += 1;
    const message: ReverseMessage = { type: "reverse", id, at };
    searchWorker().postMessage(message);
    return await new Promise<ReverseHit | null>((resolve) => {
      named = { id, resolve };
    });
  } finally {
    naming -= 1;
    if (naming === 0 && heldForNaming) {
      releaseNameIndex();
    }
  }
}

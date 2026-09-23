import { type AddressIndex, fetchAddresses } from "./addresses";
import type {
  FromSearchWorker,
  IndexHit,
  InitMessage,
  ReverseHit,
  ToSearchWorker,
} from "./protocol";
import { reverseCity } from "./reverse";
import {
  type CityRequest,
  decodeSearchIndex,
  type SearchIndex,
  searchCity,
} from "./search-query";

// Off the main thread: loading NYC's 12 MB index would freeze the app for half a second.

// `self` types as Window under the dom lib, so the worker scope goes through globalThis instead.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ToSearchWorker>) => void) | null;
  postMessage(message: FromSearchWorker): void;
};

interface Loaded {
  city: string;
  index: SearchIndex;
  addresses: AddressIndex;
}

let loaded: Loaded | null = null;
// So a repeat init doesn't refetch, and a switch away makes the in-flight answer stale.
let wanted: string | null = null;

async function load({
  city,
  searchUrl,
  addressUrl,
}: InitMessage): Promise<void> {
  if (wanted === city) {
    return;
  }
  wanted = city;
  loaded = null;
  try {
    // Neither is useful alone: without labels, chain branches are indistinguishable.
    const [index, addresses] = await Promise.all([
      fetchIndex(searchUrl),
      fetchAddresses(addressUrl),
    ]);
    if (wanted !== city) {
      return; // the reader moved to another city while this was in flight
    }
    loaded = { city, index, addresses };
    scope.postMessage({ type: "ready", city });
  } catch (error) {
    if (wanted === city) {
      wanted = null; // a failed load is retried, not remembered
      scope.postMessage({ type: "error", city, message: String(error) });
    }
  }
}

async function fetchIndex(url: string): Promise<SearchIndex> {
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`${url}: ${response.status} ${response.statusText}`);
  }
  // Gzipped because Pages serves .bin uncompressed.
  const unpacked = response.body.pipeThrough(new DecompressionStream("gzip"));
  const bytes = await new Response(unpacked).arrayBuffer();
  return decodeSearchIndex(new Uint8Array(bytes));
}

// Answer empty rather than stay silent, or the asking side would wait forever.
function look(city: Loaded | null, request: CityRequest): IndexHit[] {
  if (city === null) {
    return [];
  } else {
    return searchCity(city.index, city.addresses, request);
  }
}

// Likewise answers null rather than silence before the files land.
function name(
  city: Loaded | null,
  at: { lat: number; lng: number },
): ReverseHit | null {
  if (city === null) {
    return null;
  } else {
    return reverseCity(city.index, city.addresses, at);
  }
}

scope.onmessage = ({ data }: MessageEvent<ToSearchWorker>) => {
  if (data.type === "init") {
    void load(data);
  } else if (data.type === "reverse") {
    scope.postMessage({
      type: "reverse",
      id: data.id,
      hit: name(loaded, data.at),
    });
  } else {
    const { id, text, center, limit } = data;
    scope.postMessage({
      type: "results",
      id,
      hits: look(loaded, { text, center, limit }),
    });
  }
};

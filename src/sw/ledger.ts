// The Cache API won't report sizes, so the worker keeps per-entry sizes and read times itself.
// Chain requests in `onsuccess`, not `await`: an IndexedDB transaction commits when idle.

const DB_NAME = "scenic-route-sw";
const DB_VERSION = 2;
const ENTRIES = "entries";
const TOTALS = "totals";
// Survives a deploy, since `wipe()` clears only the accounting stores.
const CONFIG = "config";
const BY_AGE = "by-age";

interface Row {
  store: string;
  url: string;
  bytes: number;
  at: number;
}

interface Total {
  store: string;
  bytes: number;
}

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    // Additive, since dropping stores would leave surviving caches unaccounted and so unevictable.
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ENTRIES)) {
        db.createObjectStore(ENTRIES, {
          keyPath: ["store", "url"],
        }).createIndex(BY_AGE, ["store", "at"]);
      }
      if (!db.objectStoreNames.contains(TOTALS)) {
        db.createObjectStore(TOTALS, { keyPath: "store" });
      }
      if (!db.objectStoreNames.contains(CONFIG)) {
        db.createObjectStore(CONFIG, { keyPath: "key" });
      }
    };
    // The page opens this too, and an open connection blocks an upgrade without these handlers.
    request.onblocked = () => {
      reject(new Error("the ledger is open elsewhere at an older version"));
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      reject(request.error);
    };
  }).catch((error: unknown) => {
    // Storage off or refused in a private window; retried next time, and callers skip accounting.
    opening = null;
    throw error;
  });
  return opening;
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error);
    };
    transaction.onabort = () => {
      reject(transaction.error);
    };
  });
}

function addTotal(totals: IDBObjectStore, store: string, delta: number): void {
  const current = totals.get(store);
  current.onsuccess = () => {
    const total = current.result as Total | undefined;
    totals.put({
      store,
      bytes: Math.max(0, (total?.bytes ?? 0) + delta),
    } satisfies Total);
  };
}

// Replaces an existing entry, so a re-fetch isn't counted twice in the total.
export async function record(
  store: string,
  url: string,
  bytes: number,
  now: number,
): Promise<void> {
  const db = await open();
  const transaction = db.transaction([ENTRIES, TOTALS], "readwrite");
  const entries = transaction.objectStore(ENTRIES);
  const totals = transaction.objectStore(TOTALS);
  const previous = entries.get([store, url]);
  previous.onsuccess = () => {
    const row = previous.result as Row | undefined;
    entries.put({ store, url, bytes, at: now } satisfies Row);
    addTotal(totals, store, bytes - (row?.bytes ?? 0));
  };
  await finished(transaction);
}

export async function touch(
  store: string,
  url: string,
  now: number,
): Promise<void> {
  const db = await open();
  const transaction = db.transaction(ENTRIES, "readwrite");
  const entries = transaction.objectStore(ENTRIES);
  const existing = entries.get([store, url]);
  existing.onsuccess = () => {
    const row = existing.result as Row | undefined;
    if (row) {
      entries.put({ ...row, at: now } satisfies Row);
    }
  };
  await finished(transaction);
}

export async function forget(store: string, urls: string[]): Promise<void> {
  if (urls.length === 0) {
    return;
  }
  const db = await open();
  const transaction = db.transaction([ENTRIES, TOTALS], "readwrite");
  const entries = transaction.objectStore(ENTRIES);
  const totals = transaction.objectStore(TOTALS);
  let freed = 0;
  let outstanding = urls.length;
  for (const url of urls) {
    const existing = entries.get([store, url]);
    existing.onsuccess = () => {
      const row = existing.result as Row | undefined;
      if (row) {
        freed += row.bytes;
        entries.delete([store, url]);
      }
      outstanding -= 1;
      if (outstanding === 0) {
        addTotal(totals, store, -freed);
      }
    };
  }
  await finished(transaction);
}

// Returned rather than deleted, since only the caller holds the cache that must change with it.
export async function overflowing(
  store: string,
  cap: number,
): Promise<string[]> {
  const db = await open();
  const transaction = db.transaction([ENTRIES, TOTALS], "readonly");
  const doomed: string[] = [];
  const total = transaction.objectStore(TOTALS).get(store);
  total.onsuccess = () => {
    let over = ((total.result as Total | undefined)?.bytes ?? 0) - cap;
    if (over <= 0) {
      return;
    }
    const walk = transaction
      .objectStore(ENTRIES)
      .index(BY_AGE)
      .openCursor(
        IDBKeyRange.bound(
          [store, Number.NEGATIVE_INFINITY],
          [store, Number.POSITIVE_INFINITY],
        ),
      );
    walk.onsuccess = () => {
      const cursor = walk.result;
      if (!cursor || over <= 0) {
        return;
      }
      const row = cursor.value as Row;
      doomed.push(row.url);
      over -= row.bytes;
      cursor.continue();
    };
  };
  await finished(transaction);
  return doomed;
}

// Read by the page directly, so a stopped worker needn't be woken to answer.
export async function totals(): Promise<Record<string, number>> {
  const db = await open();
  const transaction = db.transaction(TOTALS, "readonly");
  const all = transaction.objectStore(TOTALS).getAll();
  const held: Record<string, number> = {};
  all.onsuccess = () => {
    for (const { store, bytes } of all.result as Total[]) {
      held[store] = bytes;
    }
  };
  await finished(transaction);
  return held;
}

export async function readConfig(key: string): Promise<unknown> {
  const db = await open();
  const transaction = db.transaction(CONFIG, "readonly");
  const request = transaction.objectStore(CONFIG).get(key);
  let value: unknown;
  request.onsuccess = () => {
    value = (request.result as { value?: unknown } | undefined)?.value;
  };
  await finished(transaction);
  return value;
}

export async function writeConfig(key: string, value: unknown): Promise<void> {
  const db = await open();
  const transaction = db.transaction(CONFIG, "readwrite");
  transaction.objectStore(CONFIG).put({ key, value });
  await finished(transaction);
}

export async function wipe(): Promise<void> {
  const db = await open();
  const transaction = db.transaction([ENTRIES, TOTALS], "readwrite");
  transaction.objectStore(ENTRIES).clear();
  transaction.objectStore(TOTALS).clear();
  await finished(transaction);
}

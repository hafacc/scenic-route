// This device only: nothing here is synced, uploaded or put in a link (see src/settings/sync.ts).

import {
  decayedWeight,
  FORGOTTEN_WEIGHT,
  sighted,
  type WalkRecord,
} from "../routing/familiar";

const KEY = "scenic-route:walks.v1";

export type WalkStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// Per city, then per durable edge key; a record is [weight, at] to keep the document small.
type WalkDocument = Record<string, Record<string, [number, number]>>;

function parsed(raw: string | null): WalkDocument {
  try {
    const value: unknown = raw === null ? {} : JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as WalkDocument)
      : {};
  } catch {
    return {};
  }
}

function validRecord(entry: unknown): entry is [number, number] {
  return (
    Array.isArray(entry) &&
    entry.length === 2 &&
    Number.isFinite(entry[0]) &&
    Number.isFinite(entry[1])
  );
}

export class WalkHistory {
  private cached: WalkDocument | null = null;
  private readonly listeners = new Set<() => void>();

  // A function, since a window can exist with storage that throws on access.
  constructor(private readonly storage: () => WalkStorage | null) {}

  private document(): WalkDocument {
    if (this.cached === null) {
      try {
        this.cached = parsed(this.storage()?.getItem(KEY) ?? null);
      } catch {
        this.cached = {};
      }
    }
    return this.cached;
  }

  private write(next: WalkDocument): void {
    this.cached = next;
    try {
      this.storage()?.setItem(KEY, JSON.stringify(next));
    } catch {
      // A full or blocked store costs the memory of this walk, not the session.
    }
    this.announce();
  }

  private announce(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  records(cityId: string): Map<number, WalkRecord> {
    const records = new Map<number, WalkRecord>();
    for (const [key, entry] of Object.entries(this.document()[cityId] ?? {})) {
      if (validRecord(entry)) {
        records.set(Number(key), { weight: entry[0], at: entry[1] });
      }
    }
    return records;
  }

  // Faded records are dropped here, so the document stays the size of what is still remembered.
  record(cityId: string, key: number, now: number): void {
    const city: Record<string, [number, number]> = {};
    for (const [stored, record] of this.records(cityId)) {
      if (decayedWeight(record, now) >= FORGOTTEN_WEIGHT) {
        city[stored] = [record.weight, record.at];
      }
    }
    const before = city[key];
    const next = sighted(
      before ? { weight: before[0], at: before[1] } : undefined,
      now,
    );
    city[key] = [next.weight, next.at];
    this.write({ ...this.document(), [cityId]: city });
  }

  // Every city's streets, across all keys this build could have written.
  count(): number {
    let total = 0;
    for (const city of Object.values(this.document())) {
      total += Object.keys(city ?? {}).length;
    }
    return total;
  }

  forget(): void {
    this.cached = {};
    try {
      this.storage()?.removeItem(KEY);
    } catch {
      // Blocked storage held nothing to forget.
    }
    this.announce();
  }

  // Another tab's walk or forget lands here.
  reload(): void {
    this.cached = null;
    this.announce();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function localStore(): WalkStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export const walks = new WalkHistory(localStore);

if (typeof addEventListener === "function") {
  addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === null) {
      walks.reload();
    }
  });
}

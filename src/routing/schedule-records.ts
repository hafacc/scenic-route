// `<id>.bin` is the record in effect and `<id>-past.bin` every superseded one (scripts/schedule-record.ts).

import { artifactUrl } from "./artifact-base";

// `lastDay` is 0 while the record is still in effect.
export interface DatedRecord {
  firstDay: number;
  lastDay: number;
}

export interface DecodedRecord<Record extends DatedRecord> {
  record: Record;
  nextOffset: number;
}

// Fetched once per city and kept, since the route re-resolves every minute and the artifact doesn't change.
export function scheduleReader<Record extends DatedRecord>(
  base: string,
  decode: (bytes: Uint8Array, offset?: number) => DecodedRecord<Record>,
): (cityId: string, day: number) => Promise<Record | null> {
  const currentRecords = new Map<string, Promise<Record | null>>();
  const pastFiles = new Map<string, Promise<Uint8Array | null>>();

  const cached = <Value>(
    store: Map<string, Promise<Value>>,
    key: string,
    load: () => Promise<Value>,
  ): Promise<Value> => {
    const existing = store.get(key);
    if (existing) {
      return existing;
    }
    // Not memoized, so a network blip doesn't disable the timetable for the session.
    const request = load().catch((error: unknown) => {
      store.delete(key);
      throw error;
    });
    store.set(key, request);
    return request;
  };

  const fetchRecord = async (path: string): Promise<Record | null> => {
    const response = await fetch(artifactUrl(path));
    if (!response.ok) {
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return decode(bytes).record;
  };

  return async (cityId: string, day: number): Promise<Record | null> => {
    const current = await cached(currentRecords, cityId, () =>
      fetchRecord(`${base}/${cityId}.bin`),
    );
    if (!current) {
      return null;
    } else if (day >= current.firstDay) {
      return current;
    }
    // Only a day before the standing timetable took effect pays for the history file.
    const bytes = await cached(pastFiles, cityId, async () => {
      const response = await fetch(artifactUrl(`${base}/${cityId}-past.bin`));
      return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
    });
    if (!bytes) {
      return null;
    }
    let offset = 0;
    while (offset < bytes.length) {
      const { record, nextOffset } = decode(bytes, offset);
      if (record.firstDay <= day && day <= record.lastDay) {
        return record;
      }
      offset = nextOffset;
    }
    return null;
  };
}

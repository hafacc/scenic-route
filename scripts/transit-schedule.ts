// Keyed by TRNS lane ids, since the daily job can't rebuild the graph; headway bands, not departures.

import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { toSeconds } from "./ferries";
import { writeVarint } from "./geometry";
import type { GtfsFeed } from "./gtfs";
import {
  CURRENT_LAST_DAY,
  collectServices,
  dayNumber,
  dayString,
  type Exception,
  encodeExceptions,
  encodeServices,
  localDay,
  publishRecord,
  type Service,
} from "./schedule-record";
import {
  buildTopology,
  decodeTopology,
  type LoadedFeed,
  loadFeeds,
  TRANSIT_CITIES,
  TRANSIT_DIR,
  type TransitTopology,
} from "./transit";

const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
export const SCHEDULE_DIR = join(PUBLIC_DIR, "transit-schedule");

export const SCHEDULE_MAGIC = "TSCH";
export const SCHEDULE_FORMAT = 1;
const HEADER_BYTES = 44;
const PATTERN_BYTES = 12;
const LANE_BYTES = 12;

// Measured on 2026 feeds: modeled departures average 20 s off the real ones, 89% within a minute.
const BAND_TOLERANCE_SECONDS = 60;
const BAND_TOLERANCE_FRACTION = 0.1;
const SINGLE_DEPARTURE_HEADWAY = 0;

// First-stop departures `start + k·headway` up to `end`, plus `end` itself.
export interface Band {
  start: number; // seconds from midnight of the service day; GTFS allows past 86400
  end: number;
  headway: number;
}

export interface ScheduleLane {
  patternIndex: number;
  serviceIndex: number;
  bands: Band[];
}

// `offsets`: seconds from the first stop's departure to each stop.
export interface SchedulePattern {
  laneId: number;
  offsets: readonly number[];
}

export interface Timetable {
  patterns: SchedulePattern[];
  lanes: ScheduleLane[];
  services: Service[];
  exceptions: Exception[];
}

// GTFS frequencies run strictly before `end_time`, so the band end is pulled back to a departure.
function frequencyBands(
  feeds: readonly { feedId: string; feed: GtfsFeed }[],
): Map<string, Band[]> {
  const bands = new Map<string, Band[]>();
  for (const { feedId, feed } of feeds) {
    for (const row of feed.frequencies) {
      const start = toSeconds(row.start_time ?? "");
      const until = toSeconds(row.end_time ?? "");
      const headway = Number(row.headway_secs);
      if (
        start === null ||
        until === null ||
        !Number.isFinite(headway) ||
        headway <= 0 ||
        until < start
      ) {
        continue;
      }
      const trips = Math.max(0, Math.ceil((until - start) / headway) - 1);
      const key = `${feedId}:${row.trip_id}`;
      const band = { start, end: start + trips * headway, headway };
      const existing = bands.get(key);
      if (existing) {
        existing.push(band);
      } else {
        bands.set(key, [band]);
      }
    }
  }
  return bands;
}

// Headway is the band's mean, so its last modeled departure lands on the last real one.
export function deriveBands(departures: readonly number[]): Band[] {
  const sorted = [...new Set(departures)].sort((left, right) => left - right);
  const bands: Band[] = [];
  let first = 0;
  while (first < sorted.length) {
    if (first + 1 >= sorted.length) {
      bands.push({
        start: sorted[first],
        end: sorted[first],
        headway: SINGLE_DEPARTURE_HEADWAY,
      });
      first += 1;
      continue;
    }
    let last = first + 1;
    while (last + 1 < sorted.length) {
      const mean = (sorted[last] - sorted[first]) / (last - first);
      const gap = sorted[last + 1] - sorted[last];
      const tolerance = Math.max(
        BAND_TOLERANCE_SECONDS,
        mean * BAND_TOLERANCE_FRACTION,
      );
      if (Math.abs(gap - mean) > tolerance) {
        break;
      }
      last += 1;
    }
    bands.push({
      start: sorted[first],
      end: sorted[last],
      headway: Math.round((sorted[last] - sorted[first]) / (last - first)),
    });
    first = last + 1;
  }
  return bands;
}

// Patterns come from `committed`, which the graph indexes into; the share rule is off since a
// pattern this run would drop is still boardable. Sorted, so an unchanged feed writes identical bytes.
export function buildTimetable(
  loaded: readonly LoadedFeed[],
  committed: TransitTopology,
): Timetable {
  const { topology } = buildTopology(loaded, 0);
  const feeds = loaded.map(({ source, feed }) => ({ feedId: source.id, feed }));
  const frequencies = frequencyBands(feeds);

  const patterns: SchedulePattern[] = committed.patterns.map((pattern) => ({
    laneId: pattern.laneId,
    offsets: pattern.offsets,
  }));
  const running = new Map(
    topology.patterns.map((pattern) => [pattern.laneId, pattern]),
  );

  const usedServices = new Set<string>();
  const draft: { patternIndex: number; serviceKey: string; bands: Band[] }[] =
    [];
  committed.patterns.forEach((committedPattern, patternIndex) => {
    const pattern = running.get(committedPattern.laneId);
    if (!pattern) {
      const route = committed.routes[committedPattern.routeIndex];
      const ends = [
        committedPattern.stops[0],
        committedPattern.stops[committedPattern.stops.length - 1],
      ].map((stop) => committed.stations[stop]?.name ?? "?");
      console.error(
        `transit-schedule: WARNING lane ${committedPattern.laneId} ` +
          `(${route?.shortName ?? "?"}: ${ends[0]} to ${ends[1]}) runs no trips in the feed; ` +
          "the deployed graph can board it and no train will ever come. Rebuild the graph.",
      );
      return;
    }
    const departuresOf = new Map<string, number[]>();
    const bandsOf = new Map<string, Band[]>();
    for (const trip of pattern.trips) {
      usedServices.add(trip.serviceKey);
      const published = frequencies.get(`${trip.feedId}:${trip.tripId}`);
      if (published) {
        // A frequency trip's stop_times are only a template.
        const existing = bandsOf.get(trip.serviceKey);
        if (existing) {
          existing.push(...published);
        } else {
          bandsOf.set(trip.serviceKey, [...published]);
        }
      } else {
        const existing = departuresOf.get(trip.serviceKey);
        if (existing) {
          existing.push(trip.departure);
        } else {
          departuresOf.set(trip.serviceKey, [trip.departure]);
        }
      }
    }

    for (const serviceKey of [
      ...new Set([...bandsOf.keys(), ...departuresOf.keys()]),
    ].sort()) {
      draft.push({
        patternIndex,
        serviceKey,
        bands: [
          ...(bandsOf.get(serviceKey) ?? []),
          ...deriveBands(departuresOf.get(serviceKey) ?? []),
        ].sort(
          (left, right) =>
            left.start - right.start ||
            left.end - right.end ||
            left.headway - right.headway,
        ),
      });
    }
  });

  const { services, exceptions } = collectServices(feeds, usedServices);
  const indexOfService = new Map(
    services.map((service, index) => [service.key, index]),
  );
  const lanes: ScheduleLane[] = draft.map(
    ({ patternIndex, serviceKey, bands }) => ({
      patternIndex,
      serviceIndex: indexOfService.get(serviceKey) ?? 0,
      bands,
    }),
  );
  lanes.sort(
    (left, right) =>
      left.patternIndex - right.patternIndex ||
      left.serviceIndex - right.serviceIndex,
  );

  return { patterns, lanes, services, exceptions };
}

function push(bytes: number[], value: number): void {
  const scratch = new Uint8Array(10);
  const end = writeVarint(scratch, 0, value);
  for (let byte = 0; byte < end; byte++) {
    bytes.push(scratch[byte]);
  }
}

// Sections are padded to 4 bytes so records concatenated into the history file stay aligned.
export function encodeTimetable(
  timetable: Timetable,
  firstDay: number,
  lastDay: number,
): Uint8Array {
  const { patterns, lanes, services, exceptions } = timetable;
  const serviceIndex = new Map(
    services.map((service, index) => [service.key, index]),
  );

  const offsetBytes: number[] = [];
  const patternOffsets: number[] = [];
  for (const pattern of patterns) {
    patternOffsets.push(offsetBytes.length);
    let previous = 0;
    for (const offset of pattern.offsets) {
      push(offsetBytes, offset - previous);
      previous = offset;
    }
  }
  while (offsetBytes.length % 4 !== 0) {
    offsetBytes.push(0);
  }
  const offsetBlob = Uint8Array.from(offsetBytes);

  const serviceTable = encodeServices(services);
  const exceptionTable = encodeExceptions(exceptions, serviceIndex);

  const patternTable = new Uint8Array(patterns.length * PATTERN_BYTES);
  const patternView = new DataView(patternTable.buffer);
  patterns.forEach((pattern, index) => {
    const record = index * PATTERN_BYTES;
    patternView.setUint32(record, pattern.laneId, true);
    patternView.setUint16(record + 4, pattern.offsets.length, true);
    patternView.setUint32(record + 8, patternOffsets[index], true);
  });

  const bandBytes: number[] = [];
  const laneOffsets: number[] = [];
  for (const lane of lanes) {
    laneOffsets.push(bandBytes.length);
    let previous = 0;
    for (const band of lane.bands) {
      push(bandBytes, band.start - previous);
      push(bandBytes, band.end - band.start);
      push(bandBytes, band.headway);
      previous = band.start;
    }
  }
  while (bandBytes.length % 4 !== 0) {
    bandBytes.push(0);
  }
  const bandBlob = Uint8Array.from(bandBytes);

  const laneTable = new Uint8Array(lanes.length * LANE_BYTES);
  const laneView = new DataView(laneTable.buffer);
  lanes.forEach((lane, index) => {
    const record = index * LANE_BYTES;
    laneView.setUint16(record, lane.patternIndex, true);
    laneView.setUint16(record + 2, lane.serviceIndex, true);
    laneView.setUint16(record + 4, lane.bands.length, true);
    laneView.setUint32(record + 8, laneOffsets[index], true);
  });

  const serviceOffset = HEADER_BYTES;
  const exceptionOffset = serviceOffset + serviceTable.length;
  const patternOffset = exceptionOffset + exceptionTable.length;
  const laneOffset = patternOffset + patternTable.length;
  const bandOffset = laneOffset + laneTable.length;
  const blobOffset = bandOffset + bandBlob.length;
  const total = blobOffset + offsetBlob.length;

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 4; index++) {
    bytes[index] = SCHEDULE_MAGIC.charCodeAt(index);
  }
  view.setUint16(4, SCHEDULE_FORMAT, true);
  view.setUint16(6, HEADER_BYTES, true);
  view.setUint32(8, firstDay, true);
  view.setUint32(12, lastDay, true);
  view.setUint32(16, services.length, true);
  view.setUint32(20, exceptions.length, true);
  view.setUint32(24, patterns.length, true);
  view.setUint32(28, lanes.length, true);
  view.setUint32(32, bandBlob.length, true);
  view.setUint32(36, offsetBlob.length, true);
  view.setUint32(40, total, true);
  bytes.set(serviceTable, serviceOffset);
  bytes.set(exceptionTable, exceptionOffset);
  bytes.set(patternTable, patternOffset);
  bytes.set(laneTable, laneOffset);
  bytes.set(bandBlob, bandOffset);
  bytes.set(offsetBlob, blobOffset);
  return bytes;
}

export interface ScheduleUpdate {
  changed: boolean;
  firstDay: number;
  patterns: number;
  lanes: number;
  bands: number;
  services: number;
  bytes: number;
  sha256: string;
}

export async function updateTransitSchedule(
  cityId: string,
  today: string,
): Promise<ScheduleUpdate> {
  await mkdir(SCHEDULE_DIR, { recursive: true });
  // Not rebuilt from today's feeds: the deployed graph boards the committed lane ids and offsets.
  const topologyPath = join(TRANSIT_DIR, `${cityId}.bin`);
  const committed = decodeTopology(
    new Uint8Array(await readFile(topologyPath)),
  );
  const timetable = buildTimetable(await loadFeeds(cityId), committed);
  const day = dayNumber(today);
  const { changed, firstDay, record } = await publishRecord({
    directory: SCHEDULE_DIR,
    cityId,
    candidate: encodeTimetable(timetable, day, CURRENT_LAST_DAY),
    headerBytes: HEADER_BYTES,
    today: day,
    label: "transit-schedule",
  });

  const bands = timetable.lanes.reduce(
    (sum, lane) => sum + lane.bands.length,
    0,
  );
  console.error(
    `transit-schedule: ${cityId} ${timetable.patterns.length} patterns, ` +
      `${timetable.lanes.length} lanes, ${bands} bands, ` +
      `${timetable.services.length} services, in effect from ${dayString(firstDay)} ` +
      `(${changed ? "changed" : "unchanged"}, ${record.length} bytes)`,
  );

  return {
    changed,
    firstDay,
    patterns: timetable.patterns.length,
    lanes: timetable.lanes.length,
    bands,
    services: timetable.services.length,
    bytes: record.length,
    sha256: createHash("sha256").update(record).digest("hex"),
  };
}

// One `today` for the run, so cities open new records on the same day even across midnight.
if (import.meta.main) {
  // Declared so parseArgs accepts them; scripts/cache.ts reads argv itself.
  const { values } = parseArgs({
    options: {
      city: { type: "string" },
      offline: { type: "boolean" },
      refresh: { type: "boolean" },
    },
  });
  const cities = values.city === undefined ? TRANSIT_CITIES : [values.city];
  const today = localDay(new Date());
  for (const cityId of cities) {
    await updateTransitSchedule(cityId, today);
  }
}

// `bun run update-transit-schedule`: the rail timetable the router departs against, refreshed daily
// beside the ferry one and committed, as public/transit-schedule/<city>.bin (magic TSCH).
//
// data/transit/<city>.bin (TRNS) carries the topology — stations, routes, patterns — and the graph
// pass bakes it into the 37 MB routing graph. Nothing in the daily path can rebuild that graph, so
// the timetable lives on its own, keyed by the LANE IDS the two artifacts share.
//
// It holds HEADWAY BANDS, not departures: per lane and service, a window with a start, an end and
// the seconds between trains inside it. A subway timetable listed departure by departure is about
// ten times the size for an answer nobody can tell apart — what a walker needs from a five-minute
// service is that a train comes in about five minutes, and where the service is sparse enough for
// the exact minute to matter the bands are short and say so.
//
// Two files per city, exactly as the ferry timetable does it: `<city>.bin` is the timetable in
// effect now and `<city>-past.bin` every superseded one, each carrying the day range it ran for.
// The publishing itself is scripts/schedule-record.ts. Layout: scripts/README.md.

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

// How far one gap between departures may fall from a band's mean headway and still belong to it.
// Both terms matter: a minute is the slack a published timetable rounds to at any headway, and a
// tenth lets a twenty-minute evening service vary by two minutes without splitting into a band per
// train. The pair is measured, not guessed: over the 2026 feeds it folds New York's 20,353
// departures into 3,036 bands and San Francisco's 14,261 into 1,605, and the departure it models for
// a real train is a mean of 20 seconds out, 89% of them inside a minute and none more than 4:16.
// Loosening it trades that fidelity away fast — at two minutes and a quarter the mean error is 75
// seconds and only 57% land inside a minute, for 1,200 bands saved.
const BAND_TOLERANCE_SECONDS = 60;
const BAND_TOLERANCE_FRACTION = 0.1;
// A band of one departure: the train leaves at `start`, and `end` is the same second.
const SINGLE_DEPARTURE_HEADWAY = 0;

// One window of even service at a pattern's first stop. The departures it stands for are `start`,
// `start + headway`, `start + 2·headway` … up to `end`, and `end` itself, which is the last train of
// the window whether or not the grid lands on it.
export interface Band {
  start: number; // seconds from midnight of the service day; GTFS allows past 86400
  end: number;
  headway: number;
}

// One pattern's departures on one service.
export interface ScheduleLane {
  patternIndex: number;
  serviceIndex: number;
  bands: Band[];
}

// One pattern the graph can board: the lane id it shares with TRNS, and the seconds from the first
// stop's departure to each of its stops — which is what turns a first-stop departure into a
// departure at the stop the walker is actually standing at.
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

// The frequency windows a feed publishes for a trip, keyed `${feedId}:${tripId}`. GTFS runs a
// frequency trip at `start_time`, `+headway`, … strictly BEFORE `end_time`, so the band's end is
// pulled back to the last of those: a band's end is always a departure.
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

// A sorted departure list cut into bands of even service. A band grows while the next gap sits
// within the tolerance of the mean headway so far, so a run of five-minute trains stays one band
// through the rounding a published timetable does, and the evening's first twelve-minute gap starts
// a new one. The headway written is the mean over the band, which puts its last modeled departure
// on its last real one rather than letting rounding drift across a long window.
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

// The city's timetable, for exactly the lanes the COMMITTED topology carries.
//
// `committed` is data/transit/<city>.bin as the graph was cut from it, and it decides both the
// pattern table and its offsets: the graph's board edges carry a lane id and a stop index into these
// offsets, and a timetable that indexed anything else would put a rider on the wrong departure. The
// feeds supply only the trips, matched by lane id, and the share rule is off while they are read —
// a pattern this run would drop is still a lane the deployed graph can board, and dropping it here
// is how a lane goes silently Infinity for everyone.
//
// A lane the feeds no longer run gets no bands, and says so loudly: the pattern changed under the
// graph, and the answer is to rebuild the graph, not to guess.
//
// Every table is sorted before it is written, so an unchanged feed writes identical bytes.
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
        // A frequency trip's own stop_times are a template nobody departs on; its rows are the
        // service.
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

// One LEB128 varint appended to a byte list.
function push(bytes: number[], value: number): void {
  const scratch = new Uint8Array(10);
  const end = writeVarint(scratch, 0, value);
  for (let byte = 0; byte < end; byte++) {
    bytes.push(scratch[byte]);
  }
}

// Writes one TSCH record: the header, then the service, exception, pattern, lane and band tables and
// the varint offset blob, back to back. Little-endian throughout, and every section a multiple of 4
// so that records concatenated into the history file stay aligned.
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

// Reads the city's feeds, builds its timetable and — only if it differs from the one in effect —
// retires the standing record into `<city>-past.bin` and opens a new one from `today`.
export async function updateTransitSchedule(
  cityId: string,
  today: string,
): Promise<ScheduleUpdate> {
  await mkdir(SCHEDULE_DIR, { recursive: true });
  // The graph's own topology, not one rebuilt from today's feeds: the lane ids and stop offsets the
  // deployed graph carries are what a rider boards against.
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

// One city with `--city`, otherwise every city that has rail — which is what the daily job runs, so
// adding a city needs no change to the workflow. One `today` for the whole run, so two cities whose
// feeds both moved open their new records on the same day even across midnight.
if (import.meta.main) {
  // The cache flags are declared so parseArgs does not reject them; scripts/cache.ts reads argv itself.
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

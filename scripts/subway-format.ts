import { COORD_SCALE, haversineMeters, writeVarint, zigzag } from "./geometry";
import type { GtfsFeed } from "./gtfs";
import type { Coord } from "./socrata";

export const SUBWAY_MAGIC = "SBWY";
export const SUBWAY_FORMAT = 3;
const SUBWAY_HEADER_BYTES = 60;
const SUBWAY_ROUTE_BYTES = 16;
const SUBWAY_LINE_BYTES = 8;
const SUBWAY_STATION_BYTES = 20;
// The station route mask is a u32.
const MAX_ROUTES = 32;

// ~150 m of new track a non-primary must add; SF's one-way detours measure 7-10, the rest 0-4.
const NEW_TRACK_CELLS = 5;
// ~39 m by ~30 m: coarser than rails are apart, so the opposite rail reads as covered.
const COVERAGE_CELL_DEGREES = 0.00035;
// Columns run to about -3.5e5 here.
const CELL_STRIDE = 10_000_000;

export interface Rgb {
  red: number;
  green: number;
  blue: number;
}

// `shortName` is what a rider says ("N", "Yellow"), `longName` the corridor ("JUDAH").
export interface TransitRoute {
  id: string;
  shortName: string;
  longName: string;
  color: Rgb;
  textColor: Rgb;
  sortOrder: number;
  lines: Coord[][];
}

export interface TransitStation extends Coord {
  name: string;
  routeMask: number; // bit per route index
  // transfers.txt component from 1; 0 = unknown, and the client falls back to distance.
  complex: number;
}

// Several lines because clipping to the city can cut a shape; accepted or rejected whole.
export interface ShapeVariant {
  shapeId: string;
  primary: boolean; // forward direction: kept unless a duplicate
  trips: number;
  lines: Coord[][];
}

// GTFS transfer_type 3: no transfer possible between the pair.
const NO_TRANSFER = "3";

// One station a complex can hold; `key` is unique across a city's feeds.
export interface ComplexStation extends Coord {
  key: string;
  name: string;
}

// Directed, as transfers.txt is; `seconds` is null where no agency publishes the time.
export interface TransferPair {
  from: string;
  to: string;
  seconds: number | null;
}

// Stations one source calls a single complex, with that source's name for the whole when it has one.
export interface ComplexGroup {
  keys: readonly string[];
  name?: string;
}

export interface ComplexModel {
  // 0 = in no complex; set on every station of a city whose agency publishes transfers.
  complexOf: Map<string, number>;
  // Only complexes of two or more stations.
  names: Map<number, string>;
  transfers: TransferPair[];
}

// A feed's own pairs between distinct stations, mapped onto the city's station keys.
export function publishedTransfers(
  feed: GtfsFeed,
  keyOfStop: (stopId: string) => string,
): { pairs: TransferPair[]; blocked: TransferPair[] } {
  const pairs: TransferPair[] = [];
  const blocked: TransferPair[] = [];
  for (const row of feed.transfers) {
    const from = keyOfStop(row.from_stop_id);
    const to = keyOfStop(row.to_stop_id);
    const seconds = Number.parseInt(row.min_transfer_time ?? "", 10);
    if (from === to) {
    } else if (row.transfer_type === NO_TRANSFER) {
      blocked.push({ from, to, seconds: null });
    } else {
      pairs.push({
        from,
        to,
        seconds: Number.isFinite(seconds) ? seconds : null,
      });
    }
  }
  return { pairs, blocked };
}

const NAME_NOISE: ReadonlySet<string> = new Set([
  "station",
  "bart",
  "muni",
  "metro",
  "mezzanine",
  "level",
  "platform",
  "st",
  "street",
]);

// Stripped only from the end: BART has a Downtown Berkeley.
const DIRECTION_WORDS: ReadonlySet<string> = new Set([
  "inbound",
  "outbound",
  "outbd",
  "downtown",
  "downtn",
  "northbound",
  "southbound",
]);

export function stationNameTokens(name: string): string[] {
  const tokens = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token !== "" && !NAME_NOISE.has(token));
  while (tokens.length > 1 && DIRECTION_WORDS.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens;
}

// True when one name's tokens run contiguously inside the other's.
export function stationNamesAgree(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const [inner, outer] =
    left.length <= right.length ? [left, right] : [right, left];
  if (inner.length === 0) {
    return false;
  }
  for (let start = 0; start + inner.length <= outer.length; start++) {
    if (inner.every((token, index) => token === outer[start + index])) {
      return true;
    }
  }
  return false;
}

// "14 St/8 Av" -> "14 St / 8 Av".
function spacedSlashes(name: string): string {
  return name.replace(/\s*\/\s*/g, " / ");
}

// Agreeing names ("Powell", "Powell Street") keep the shortest; the rest join as "A / B".
function joinedName(names: readonly string[]): string {
  const kept: string[] = [];
  const ordered = [...new Set(names)].sort(
    (left, right) => left.length - right.length || (left < right ? -1 : 1),
  );
  for (const name of ordered) {
    const tokens = stationNameTokens(name);
    if (
      !kept.some((one) => stationNamesAgree(stationNameTokens(one), tokens))
    ) {
      kept.push(name);
    }
  }
  return kept.sort().join(" / ");
}

// Published pairs join their stations; a group joins all of its own and pairs those left unpaired.
export function buildComplexes(
  stations: readonly ComplexStation[],
  published: readonly TransferPair[],
  groups: readonly ComplexGroup[],
  // transfer_type 3: an agency saying no transfer between the pair, which no group may add.
  blocked: readonly TransferPair[] = [],
): ComplexModel {
  const byKey = new Map(stations.map((station) => [station.key, station]));
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    const seen = parent.get(key);
    if (seen === undefined || seen === key) {
      return key;
    }
    const root = find(seen);
    parent.set(key, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    // Lower key wins the root, so numbering is independent of row order.
    const roots = [find(left), find(right)].sort();
    parent.set(roots[1], roots[0]);
  };

  const transfers: TransferPair[] = [];
  const paired = new Set<string>();
  const pairKey = (from: string, to: string): string => `${from}\u0000${to}`;
  const refused = new Set(blocked.map(({ from, to }) => pairKey(from, to)));
  for (const pair of published) {
    const key = pairKey(pair.from, pair.to);
    if (!byKey.has(pair.from) || !byKey.has(pair.to) || paired.has(key)) {
      continue;
    }
    paired.add(key);
    transfers.push(pair);
    union(pair.from, pair.to);
  }
  const named: { members: string[]; name: string }[] = [];
  for (const group of groups) {
    const members = [...new Set(group.keys)].filter((key) => byKey.has(key));
    if (members.length < 2) {
      continue;
    }
    for (const from of members) {
      union(members[0], from);
      for (const to of members) {
        const key = pairKey(from, to);
        if (from !== to && !paired.has(key) && !refused.has(key)) {
          paired.add(key);
          transfers.push({ from, to, seconds: null });
        }
      }
    }
    if (group.name !== undefined) {
      named.push({ members, name: group.name });
    }
  }

  const everyStation = published.length > 0;
  const members = new Map<string, string[]>();
  for (const key of [...byKey.keys()].sort()) {
    const root = find(key);
    const group = members.get(root);
    if (group) {
      group.push(key);
    } else {
      members.set(root, [key]);
    }
  }
  const complexOf = new Map<string, number>();
  const names = new Map<number, string>();
  let nextId = 1;
  for (const [root, keys] of members) {
    if (keys.length < 2 && !everyStation) {
      for (const key of keys) {
        complexOf.set(key, 0);
      }
      continue;
    }
    const id = nextId++;
    for (const key of keys) {
      complexOf.set(key, id);
    }
    if (keys.length < 2) {
      continue;
    }
    // The agency's name for the most of it, else the members' own.
    let best: { covered: number; name: string } | null = null;
    for (const group of named) {
      const covered = group.members.filter((key) => find(key) === root).length;
      if (
        covered > 1 &&
        (best === null ||
          covered > best.covered ||
          (covered === best.covered && group.name < best.name))
      ) {
        best = { covered, name: group.name };
      }
    }
    names.set(
      id,
      best === null
        ? joinedName(keys.map((key) => byKey.get(key)?.name ?? ""))
        : spacedSlashes(best.name),
    );
  }
  transfers.sort(
    (left, right) =>
      (left.from < right.from ? -1 : left.from > right.from ? 1 : 0) ||
      (left.to < right.to ? -1 : left.to > right.to ? 1 : 0),
  );
  return { complexOf, names, transfers };
}

// A terminal's several curbs arrive as separate stops in every feed here.
export const STATION_MERGE_METERS = 100;

// Single-link, so a row of curbs strung along a block joins up.
export function clusterByName<Point extends Coord & { name: string }>(
  points: readonly Point[],
): Point[][] {
  const byName = new Map<string, Point[]>();
  for (const point of points) {
    const group = byName.get(point.name);
    if (group) {
      group.push(point);
    } else {
      byName.set(point.name, [point]);
    }
  }

  const clusters: Point[][] = [];
  for (const group of byName.values()) {
    const taken = new Array<boolean>(group.length).fill(false);
    for (let seed = 0; seed < group.length; seed++) {
      if (taken[seed]) {
        continue;
      }
      taken[seed] = true;
      const cluster = [group[seed]];
      for (let member = 0; member < cluster.length; member++) {
        for (let other = 0; other < group.length; other++) {
          if (
            !taken[other] &&
            haversineMeters(cluster[member], group[other]) <=
              STATION_MERGE_METERS
          ) {
            taken[other] = true;
            cluster.push(group[other]);
          }
        }
      }
      clusters.push(cluster);
    }
  }
  return clusters;
}

export function centroid(points: readonly Coord[]): Coord {
  return {
    lat: points.reduce((sum, one) => sum + one.lat, 0) / points.length,
    lng: points.reduce((sum, one) => sum + one.lng, 0) / points.length,
  };
}

export function parseColor(hex: string, fallback: string): Rgb {
  const clean = /^[0-9a-fA-F]{6}$/.test(hex.trim()) ? hex.trim() : fallback;
  return {
    red: Number.parseInt(clean.slice(0, 2), 16),
    green: Number.parseInt(clean.slice(2, 4), 16),
    blue: Number.parseInt(clean.slice(4, 6), 16),
  };
}

function cellKey(row: number, column: number): number {
  return row * CELL_STRIDE + column;
}

function addTrack(points: readonly Coord[], covered: Set<number>): void {
  for (const { lat, lng } of points) {
    covered.add(
      cellKey(
        Math.round(lat / COVERAGE_CELL_DEGREES),
        Math.round(lng / COVERAGE_CELL_DEGREES),
      ),
    );
  }
}

// A cell counts as covered if any of its eight neighbors is.
function newTrackCells(
  lines: readonly Coord[][],
  covered: Set<number>,
): number {
  const seen = new Set<number>();
  let fresh = 0;
  for (const line of lines) {
    for (const { lat, lng } of line) {
      const row = Math.round(lat / COVERAGE_CELL_DEGREES);
      const column = Math.round(lng / COVERAGE_CELL_DEGREES);
      const key = cellKey(row, column);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      let touches = false;
      for (let deltaRow = -1; deltaRow <= 1 && !touches; deltaRow++) {
        for (let deltaColumn = -1; deltaColumn <= 1; deltaColumn++) {
          if (covered.has(cellKey(row + deltaRow, column + deltaColumn))) {
            touches = true;
            break;
          }
        }
      }
      if (!touches) {
        fresh += 1;
      }
    }
  }
  return fresh;
}

// Drops only duplicates and retracing non-primaries: thinning is the renderer's job.
export function chooseLines(variants: readonly ShapeVariant[]): Coord[][] {
  const ordered = [...variants].sort(
    (left, right) =>
      Number(right.primary) - Number(left.primary) ||
      right.trips - left.trips ||
      (left.shapeId < right.shapeId ? -1 : 1),
  );

  const lines: Coord[][] = [];
  const drawn = new Set<string>();
  const covered = new Set<number>();
  for (const variant of ordered) {
    if (variant.lines.length === 0) {
      continue;
    }
    const signature = variant.lines
      .map((line) => line.map(({ lat, lng }) => `${lat},${lng}`).join(" "))
      .join("|");
    const retraces =
      !variant.primary &&
      newTrackCells(variant.lines, covered) < NEW_TRACK_CELLS;
    if (drawn.has(signature) || retraces) {
      continue;
    }
    drawn.add(signature);
    for (const line of variant.lines) {
      lines.push(line);
      addTrack(line, covered);
    }
  }
  return lines;
}

// SBWY layout: scripts/README.md.
export function encodeSubway(
  routes: readonly TransitRoute[],
  stations: readonly TransitStation[],
): Uint8Array {
  if (routes.length > MAX_ROUTES) {
    throw new Error(
      `${routes.length} routes will not fit the u32 station route mask: widen the mask (and the` +
        " format) rather than dropping the routes past the 32nd",
    );
  }

  let originLng = Number.POSITIVE_INFINITY;
  let originLat = Number.POSITIVE_INFINITY;
  const swallow = ({ lat, lng }: Coord): void => {
    originLng = Math.min(originLng, lng);
    originLat = Math.min(originLat, lat);
  };
  for (const route of routes) {
    for (const line of route.lines) {
      for (const point of line) {
        swallow(point);
      }
    }
  }
  for (const station of stations) {
    swallow(station);
  }

  const names = [
    ...new Set([
      ...routes.flatMap((route) => [route.shortName, route.longName]),
      ...stations.map((station) => station.name),
    ]),
  ].sort();
  const nameIndex = new Map(names.map((name, index) => [name, index]));

  const geometryBytes: number[] = [];
  const lineTable = new Uint8Array(
    routes.reduce((total, route) => total + route.lines.length, 0) *
      SUBWAY_LINE_BYTES,
  );
  const lineView = new DataView(lineTable.buffer);
  const scratch = new Uint8Array(10);
  let lineCursor = 0;
  const routeSpans: { first: number; count: number }[] = [];
  for (let index = 0; index < routes.length; index++) {
    const first = lineCursor / SUBWAY_LINE_BYTES;
    for (const line of routes[index].lines) {
      lineView.setUint32(lineCursor, geometryBytes.length, true);
      lineView.setUint16(lineCursor + 4, line.length, true);
      lineView.setUint16(lineCursor + 6, index, true);
      lineCursor += SUBWAY_LINE_BYTES;
      let previousX = 0;
      let previousY = 0;
      for (const { lat, lng } of line) {
        const x = Math.round((lng - originLng) / COORD_SCALE);
        const y = Math.round((lat - originLat) / COORD_SCALE);
        for (const delta of [x - previousX, y - previousY]) {
          const end = writeVarint(scratch, 0, zigzag(delta));
          for (let byte = 0; byte < end; byte++) {
            geometryBytes.push(scratch[byte]);
          }
        }
        previousX = x;
        previousY = y;
      }
    }
    routeSpans.push({ first, count: routes[index].lines.length });
  }
  while (geometryBytes.length % 4 !== 0) {
    geometryBytes.push(0); // pad so the name blob starts 4-byte aligned
  }
  const geometryBlob = Uint8Array.from(geometryBytes);

  const routeTable = new Uint8Array(routes.length * SUBWAY_ROUTE_BYTES);
  const routeView = new DataView(routeTable.buffer);
  for (let index = 0; index < routes.length; index++) {
    const route = routes[index];
    const record = index * SUBWAY_ROUTE_BYTES;
    routeTable[record] = route.color.red;
    routeTable[record + 1] = route.color.green;
    routeTable[record + 2] = route.color.blue;
    routeTable[record + 3] = route.textColor.red;
    routeTable[record + 4] = route.textColor.green;
    routeTable[record + 5] = route.textColor.blue;
    routeView.setUint16(record + 6, nameIndex.get(route.shortName) ?? 0, true);
    routeView.setUint16(record + 8, nameIndex.get(route.longName) ?? 0, true);
    routeView.setUint16(record + 10, routeSpans[index].first, true);
    routeView.setUint16(record + 12, routeSpans[index].count, true);
    routeView.setUint16(record + 14, route.sortOrder, true);
  }

  const stationTable = new Uint8Array(stations.length * SUBWAY_STATION_BYTES);
  const stationView = new DataView(stationTable.buffer);
  for (let index = 0; index < stations.length; index++) {
    const station = stations[index];
    const record = index * SUBWAY_STATION_BYTES;
    stationView.setInt32(
      record,
      Math.round((station.lng - originLng) / COORD_SCALE),
      true,
    );
    stationView.setInt32(
      record + 4,
      Math.round((station.lat - originLat) / COORD_SCALE),
      true,
    );
    stationView.setUint32(record + 8, nameIndex.get(station.name) ?? 0, true);
    stationView.setUint32(record + 12, station.routeMask, true);
    stationView.setUint32(record + 16, station.complex, true);
  }

  const encoder = new TextEncoder();
  const nameBytes = names.map((name) => encoder.encode(name));
  const nameBlob = new Uint8Array(
    nameBytes.reduce((total, bytes) => total + 2 + bytes.length, 4),
  );
  const nameView = new DataView(nameBlob.buffer);
  nameView.setUint32(0, names.length, true);
  let nameCursor = 4;
  for (const bytes of nameBytes) {
    nameView.setUint16(nameCursor, bytes.length, true);
    nameCursor += 2;
    nameBlob.set(bytes, nameCursor);
    nameCursor += bytes.length;
  }

  const geometryOffset =
    SUBWAY_HEADER_BYTES +
    routeTable.length +
    lineTable.length +
    stationTable.length;
  const nameBlobOffset = geometryOffset + geometryBlob.length;
  const bytes = new Uint8Array(nameBlobOffset + nameBlob.length);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 4; index++) {
    bytes[index] = SUBWAY_MAGIC.charCodeAt(index);
  }
  view.setUint16(4, SUBWAY_FORMAT, true);
  view.setUint16(6, SUBWAY_HEADER_BYTES, true);
  view.setUint32(8, routes.length, true);
  view.setUint32(12, lineTable.length / SUBWAY_LINE_BYTES, true);
  view.setFloat64(16, originLng, true);
  view.setFloat64(24, originLat, true);
  view.setFloat64(32, COORD_SCALE, true);
  view.setUint32(40, stations.length, true);
  view.setUint32(44, geometryOffset, true);
  view.setUint32(48, geometryBlob.length, true);
  view.setUint32(52, nameBlobOffset, true);
  view.setUint32(56, nameBlob.length, true);
  bytes.set(routeTable, SUBWAY_HEADER_BYTES);
  bytes.set(lineTable, SUBWAY_HEADER_BYTES + routeTable.length);
  bytes.set(
    stationTable,
    SUBWAY_HEADER_BYTES + routeTable.length + lineTable.length,
  );
  bytes.set(geometryBlob, geometryOffset);
  bytes.set(nameBlob, nameBlobOffset);
  return bytes;
}

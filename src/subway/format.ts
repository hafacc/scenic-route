import { decodeNames, type Polyline, readPolyline } from "../tiles/polylines";
import type { Cursor } from "../tiles/varint";

// SBWY layout: scripts/README.md. Not in the tile worker, since the search build reads it too.
const MAGIC = "SBWY";
const FORMAT = 3;
const ROUTE_BYTES = 16;
const LINE_BYTES = 8;
const STATION_BYTES = 20;

export interface SubwayRoute {
  color: string; // route_color, the hex the MTA publishes for the line
  textColor: string; // route_text_color, the letter inside the bullet
  shortName: string; // the "1", "A", "SIR" a rider says
  longName: string; // the corridor; the only thing telling the three `S` shuttles apart
}

export interface SubwayLine extends Polyline {
  route: number; // index into `routes`
}

export interface SubwayStation {
  lng: number;
  lat: number;
  name: string;
  routes: number; // bitmask: bit i set means route i of `routes` calls here
  // The station's complex in the agency's transfers.txt; 0 where the feed publishes no transfers.
  complex: number;
}

export interface Subway {
  routes: SubwayRoute[];
  lines: SubwayLine[];
  stations: SubwayStation[];
}

function hex(bytes: Uint8Array, offset: number): string {
  const channel = (at: number) => bytes[at].toString(16).padStart(2, "0");
  return `#${channel(offset)}${channel(offset + 1)}${channel(offset + 2)}`;
}

export function decodeSubway(buffer: ArrayBuffer): Subway {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const found = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (found !== MAGIC) {
    throw new Error(`not a ${MAGIC} blob`);
  }
  const format = view.getUint16(4, true);
  if (format !== FORMAT) {
    throw new Error(`${MAGIC} v${format}, expected v${FORMAT}`);
  }
  const headerBytes = view.getUint16(6, true);
  const routeCount = view.getUint32(8, true);
  const lineCount = view.getUint32(12, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const stationCount = view.getUint32(40, true);
  const geometryOffset = view.getUint32(44, true);
  const names = decodeNames(view, bytes, view.getUint32(52, true));

  const routes: SubwayRoute[] = [];
  for (let route = 0; route < routeCount; route++) {
    const record = headerBytes + route * ROUTE_BYTES;
    routes.push({
      color: hex(bytes, record),
      textColor: hex(bytes, record + 3),
      shortName: names[view.getUint16(record + 6, true)] ?? "",
      longName: names[view.getUint16(record + 8, true)] ?? "",
    });
  }

  const lineTable = headerBytes + routeCount * ROUTE_BYTES;
  const lines: SubwayLine[] = [];
  for (let line = 0; line < lineCount; line++) {
    const record = lineTable + line * LINE_BYTES;
    const cursor: Cursor = {
      offset: geometryOffset + view.getUint32(record, true),
    };
    lines.push({
      ...readPolyline(
        bytes,
        cursor,
        view.getUint16(record + 4, true),
        originLng,
        originLat,
        scale,
      ),
      route: view.getUint16(record + 6, true),
    });
  }

  const stationTable = lineTable + lineCount * LINE_BYTES;
  const stations: SubwayStation[] = [];
  for (let station = 0; station < stationCount; station++) {
    const record = stationTable + station * STATION_BYTES;
    stations.push({
      lng: originLng + view.getInt32(record, true) * scale,
      lat: originLat + view.getInt32(record + 4, true) * scale,
      name: names[view.getUint32(record + 8, true)] ?? "",
      routes: view.getUint32(record + 12, true),
      complex: view.getUint32(record + 16, true),
    });
  }

  return { routes, lines, stations };
}

// File order is each agency's `route_sort_order`, so a station reads "A, C, E" like its signs.
export function stationRouteIndices(station: SubwayStation): number[] {
  const indices: number[] = [];
  for (let route = 0; route < 32; route++) {
    if ((station.routes & (1 << route)) !== 0) {
      indices.push(route);
    }
  }
  return indices;
}

export function stationRoutes(
  station: SubwayStation,
  routes: readonly SubwayRoute[],
): string[] {
  return stationRouteIndices(station).map(
    (index) => routes[index]?.shortName ?? "",
  );
}

const METERS_PER_DEGREE_LAT = 111_320;

// Muni files one corner per direction and per side of the street, never separate stops this close;
// 60 m closes all 63 near pairs in the file.
const SAME_PLACE_METERS = 60;
// Muni's Metro platform pairs are 76-93 m apart; the next same-named pair is distinct stops at 220 m.
const SAME_NAME_METERS = 160;

// Only trailing, so "Downtown Berkeley" keeps its name.
const DIRECTION_SUFFIX =
  /[\s/]+(?:downtown|downtn|outbound|outbd|inbound|inbd|northbound|southbound|eastbound|westbound)$/i;

// The artifact really holds both "Market St & 5th St" and "Market St & 5th  St".
function canonicalName(name: string): string {
  return name.replace(DIRECTION_SUFFIX, "").replace(/\s+/g, " ").trim();
}

function metersApart(
  from: SubwayStation,
  to: SubwayStation,
  lngMeters: number,
) {
  return Math.hypot(
    (from.lng - to.lng) * lngMeters,
    (from.lat - to.lat) * METERS_PER_DEGREE_LAT,
  );
}

// The name comes from the record serving the most routes (the station, not the curb), then shorter.
export function mergeStations(
  stations: readonly SubwayStation[],
): SubwayStation[] {
  const midLat = stations.length
    ? stations[Math.floor(stations.length / 2)].lat
    : 0;
  const lngMeters = METERS_PER_DEGREE_LAT * Math.cos((midLat * Math.PI) / 180);
  const canonical = stations.map(({ name }) => canonicalName(name));

  const parent = stations.map((_, index) => index);
  const find = (index: number): number =>
    parent[index] === index ? index : (parent[index] = find(parent[index]));
  for (let left = 0; left < stations.length; left++) {
    for (let right = left + 1; right < stations.length; right++) {
      const apart = metersApart(stations[left], stations[right], lngMeters);
      // Transfers only veto a geometric match, which splits Rector St's unlinked pair 49.5 m apart;
      // as a trigger they would merge Times Sq with 42 St-Port Authority, 386 m away.
      const sameName =
        apart < SAME_PLACE_METERS ||
        (apart < SAME_NAME_METERS && canonical[left] === canonical[right]);
      const answered =
        stations[left].complex !== 0 && stations[right].complex !== 0;
      const together =
        sameName &&
        (!answered || stations[left].complex === stations[right].complex);
      if (together) {
        // The lower index wins the root, so a group's root is its earliest member.
        const roots = [find(left), find(right)];
        parent[Math.max(...roots)] = Math.min(...roots);
      }
    }
  }

  // Keyed on the earliest member, so markers keep file order and indices into them are stable.
  const groups = new Map<number, number[]>();
  for (let station = 0; station < stations.length; station++) {
    const root = find(station);
    const members = groups.get(root);
    if (members) {
      members.push(station);
    } else {
      groups.set(root, [station]);
    }
  }

  return [...groups.values()].map((members) => {
    let routes = 0;
    let lng = 0;
    let lat = 0;
    for (const member of members) {
      routes |= stations[member].routes;
      lng += stations[member].lng;
      lat += stations[member].lat;
    }
    const best = members.reduce((chosen, member) => {
      const gained =
        stationRouteIndices(stations[member]).length -
        stationRouteIndices(stations[chosen]).length;
      const shorter = canonical[member].length - canonical[chosen].length;
      return gained > 0 || (gained === 0 && shorter < 0) ? member : chosen;
    });
    return {
      lng: lng / members.length,
      lat: lat / members.length,
      name: canonical[best],
      routes,
      complex: stations[members[0]].complex,
    };
  });
}

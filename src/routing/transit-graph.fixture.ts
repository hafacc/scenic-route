// The synthetic routing graph the transit tests are run over: one straight kilometre of pavement
// with a two-station line beside it, and a hand-written timetable for that line.
//
// Written as GRPH v11 BYTES and decoded, rather than assembled as an object the way the ferry
// fixture is. The transit cost model reads things the tiler puts in the side tables — which lane a
// board edge departs against, which stop of it this platform is, which route a ride runs — so a
// fixture that hand-set those fields would be asking the cost model about a graph no tiler writes.
//
// The line is quicker than the walk and dearer than it: at no transit penalty the ride wins, at the
// top of the slider the walk does. That is the whole point of the geometry, so the numbers below are
// chosen and not incidental — see the assertions in transit-cost.test.ts.

import type { RouteWeights } from "./cost";
import {
  decodeGraph,
  EDGE_RECORD_BYTES,
  FORMAT_VERSION,
  HEADER_BYTES,
  NO_GEOMETRY,
  NO_SOURCE_ID,
  type RoutingGraph,
} from "./graph";
import { haversineMeters, type Snap } from "./snap";
import {
  resolveTimetable,
  type ScheduleRecord,
  type TransitTimetable,
} from "./transit-schedule";

export const SCALE = 1e-6;
export const ORIGIN_LNG = -74;
export const ORIGIN_LAT = 40.7;
const NAME_NONE = 0xffff;

const KIND_SIDEWALK = 0;
const KIND_ACCESS = 5;
const KIND_BOARD = 6;
const KIND_RIDE = 7;

// The lane the board edges depart against, as TRNS hashes one. Any u32 will do; this is not one of
// the graph's own numbers, it is the join key the timetable is keyed by.
export const LANE_ID = 0x1234_5678;
// A lane the graph names and the timetable does not, for the "no schedule, no train" case.
export const UNSCHEDULED_LANE = 0x0bad_0bad;

// The two ends are deliberately different kinds of stop: the west is a station with a way in, the
// east a kerbside stop the tiler bakes the shorter walk for, which is the only mark of the feed's
// surface flag the graph keeps.
export const ACCESS_SECONDS = 90; // the walk down into the west station and back up
export const EAST_ACCESS_SECONDS = 30; // and across the pavement to the east stop
export const ALIGHT_SECONDS = 30; // and back up from the platform
export const RIDE_SECONDS = 180;
export const WEST_STATION = "West Street";
export const EAST_STATION = "East Street";
export const ROUTE_SHORT_NAME = "Q";
export const ROUTE_LONG_NAME = "Cross-town Local";

// About a kilometre of pavement, so the walk is ~780 s: long enough that a 180 s ride plus its
// station walks beats it outright, short enough that the same ride at the top of the transit slider
// does not.
const EAST_X = 12_000;
// The line runs a hundred metres off the pavement, which is far enough that the two routes cover
// different ground: the planner tells its cards apart by the cells they cross, and a line drawn on
// top of the street it parallels would read as the same walk.
const STATION_Y = 900;
export const SIDEWALK_COVER = 0.5;

const NODES: readonly [number, number][] = [
  [0, 0], // 0 the pavement's west end
  [EAST_X / 2, 0], // 1 the middle of it, where the two sidewalk edges meet
  [EAST_X, 0], // 2 its east end
  [0, STATION_Y], // 3 the west station
  [EAST_X, STATION_Y], // 4 the east station
  [0, STATION_Y], // 5 the west platform, standing where its station does
  [EAST_X, STATION_Y], // 6 the east platform
];

interface EdgeSpec {
  a: number;
  b: number;
  kind: number;
  seconds: number;
  name: number; // index into NAMES, or NAME_NONE
  cover?: number; // 0..1, a sidewalk's own tree cover; the transit kinds carry none
}

const NAMES = [
  "Main Street",
  WEST_STATION,
  EAST_STATION,
  ROUTE_SHORT_NAME,
  ROUTE_LONG_NAME,
  "q",
];
const [MAIN, WEST_NAME, EAST_NAME, SHORT_NAME, LONG_NAME, ROUTE_ID] = [
  0, 1, 2, 3, 4, 5,
];

// Two sidewalks, the two station walks, and one westbound pattern: board, alight and ride at each of
// its two stops. The eastbound half of the line is deliberately absent — one direction is enough to
// ask every question here, and its absence is what makes a backwards ride visible if one is taken.
const EDGES: readonly EdgeSpec[] = [
  // The pavement is half-shaded, so a factor mean over a route that rides has something to be wrong
  // about: the ride carries no cover at all, and averaging it in would halve the number.
  {
    a: 0,
    b: 1,
    kind: KIND_SIDEWALK,
    seconds: 0,
    name: MAIN,
    cover: SIDEWALK_COVER,
  },
  {
    a: 1,
    b: 2,
    kind: KIND_SIDEWALK,
    seconds: 0,
    name: MAIN,
    cover: SIDEWALK_COVER,
  },
  { a: 3, b: 0, kind: KIND_ACCESS, seconds: ACCESS_SECONDS, name: WEST_NAME },
  {
    a: 4,
    b: 2,
    kind: KIND_ACCESS,
    seconds: EAST_ACCESS_SECONDS,
    name: EAST_NAME,
  },
  { a: 3, b: 5, kind: KIND_BOARD, seconds: 0, name: SHORT_NAME },
  { a: 5, b: 3, kind: KIND_ACCESS, seconds: ALIGHT_SECONDS, name: NAME_NONE },
  { a: 5, b: 6, kind: KIND_RIDE, seconds: RIDE_SECONDS, name: SHORT_NAME },
  { a: 4, b: 6, kind: KIND_BOARD, seconds: 0, name: SHORT_NAME },
  { a: 6, b: 4, kind: KIND_ACCESS, seconds: ALIGHT_SECONDS, name: NAME_NONE },
];

// Two more ways east, for the planner: a dogleg with more cover than Main Street and a longer one
// with more still, so a mode that wants trees has three walks to tell apart and the greenest of them
// is not the quickest. Appended after the rail, so every node and edge id below is where it was.
const DETOUR_Y = 2_000; // ~220 m off the pavement, well past the 50 m two routes must differ by
const DETOUR_NODES: readonly [number, number][] = [
  [EAST_X / 2, -DETOUR_Y],
  [EAST_X / 2, -2 * DETOUR_Y],
];
const DETOUR_COVER = [0.8, 0.95];
const DETOUR_EDGES: readonly EdgeSpec[] = DETOUR_NODES.flatMap(
  (_point, detour) => [
    {
      a: 0,
      b: NODES.length + detour,
      kind: KIND_SIDEWALK,
      seconds: 0,
      name: MAIN,
      cover: DETOUR_COVER[detour],
    },
    {
      a: NODES.length + detour,
      b: 2,
      kind: KIND_SIDEWALK,
      seconds: 0,
      name: MAIN,
      cover: DETOUR_COVER[detour],
    },
  ],
);

export const WEST_SIDEWALK = 0;
export const EAST_SIDEWALK = 1;
export const WEST_ACCESS = 2;
export const EAST_ACCESS = 3;
export const WEST_BOARD = 4;
export const WEST_ALIGHT = 5;
export const RIDE_EDGE = 6;
export const EAST_BOARD = 7;

// The stop each board edge is at, along the pattern: the west station is its first and the east one
// its second, which is what the timetable's offsets are indexed by.
const BOARD_TABLE: readonly [number, number, number, number][] = [
  [WEST_BOARD, LANE_ID, 0, 0],
  [EAST_BOARD, LANE_ID, 0, 1],
];
const RIDE_TABLE: readonly [number, number][] = [[RIDE_EDGE, 0]];

function align4(offset: number): number {
  return (offset + 3) & ~3;
}

// The GRPH blob, laid out as crates/tiler/src/graph.rs writes one: the fixed sections back to back
// from the header, then the names, the (empty) geometry and ferry table, and the transit tables.
function graphBytes(
  lanes: readonly number[],
  nodes: readonly (readonly [number, number])[],
  edges: readonly EdgeSpec[],
): ArrayBuffer {
  const nodeCount = nodes.length;
  const edgeCount = edges.length;
  const nameBlob = new TextEncoder().encode(NAMES.join(""));
  const nameTableBytes = 4 + 4 * (NAMES.length + 1) + nameBlob.length;

  const nodeLngAt = HEADER_BYTES;
  const nodeLatAt = nodeLngAt + 4 * nodeCount;
  const componentAt = nodeLatAt + 4 * nodeCount;
  const csrAt = align4(componentAt + 2 * nodeCount);
  const adjacencyAt = csrAt + 4 * (nodeCount + 1);
  const edgesAt = adjacencyAt + 8 * edgeCount;
  const nameAt = align4(edgesAt + EDGE_RECORD_BYTES * edgeCount);
  const ferryAt = align4(nameAt + nameTableBytes);
  const transitAt = ferryAt + 4;
  const total =
    transitAt +
    4 +
    12 +
    4 +
    12 * BOARD_TABLE.length +
    4 +
    8 * RIDE_TABLE.length;

  const lat = (node: number): number => ORIGIN_LAT + nodes[node][1] * SCALE;
  const lng = (node: number): number => ORIGIN_LNG + nodes[node][0] * SCALE;

  const buffer = new ArrayBuffer(total);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(new TextEncoder().encode("GRPH"));
  view.setUint16(4, FORMAT_VERSION, true);
  view.setUint16(6, HEADER_BYTES, true);
  view.setUint32(8, nodeCount, true);
  view.setUint32(12, edgeCount, true);
  view.setFloat64(16, ORIGIN_LNG, true);
  view.setFloat64(24, ORIGIN_LAT, true);
  view.setFloat64(32, SCALE, true);
  view.setUint32(40, 1, true);
  view.setUint32(44, nameAt, true);
  view.setUint32(48, nameTableBytes, true);
  view.setUint32(52, ferryAt, true); // an empty geometry blob: every edge here is a straight line
  view.setUint32(56, 0, true);
  view.setUint32(60, ferryAt, true);
  view.setUint32(64, transitAt, true);

  for (const [node, [x, y]] of nodes.entries()) {
    view.setInt32(nodeLngAt + 4 * node, x, true);
    view.setInt32(nodeLatAt + 4 * node, y, true);
  }

  const incident: number[][] = nodes.map(() => []);
  for (const [edge, spec] of edges.entries()) {
    incident[spec.a].push(edge);
    incident[spec.b].push(edge);
  }
  let cursor = 0;
  for (const [node, edges] of incident.entries()) {
    view.setUint32(csrAt + 4 * node, cursor, true);
    for (const edge of edges) {
      view.setUint32(adjacencyAt + 4 * cursor, edge, true);
      cursor += 1;
    }
  }
  view.setUint32(csrAt + 4 * nodeCount, cursor, true);

  for (const [edge, spec] of edges.entries()) {
    const record = edgesAt + EDGE_RECORD_BYTES * edge;
    view.setUint32(record, spec.a, true);
    view.setUint32(record + 4, spec.b, true);
    // The true geodesic span between the two nodes, which is what keeps the A* walking floor a
    // lower bound: the heuristic measures the same coordinates.
    view.setFloat32(
      record + 8,
      haversineMeters(lat(spec.a), lng(spec.a), lat(spec.b), lng(spec.b)),
      true,
    );
    view.setUint32(record + 12, NO_GEOMETRY, true);
    view.setUint16(record + 16, 0, true);
    view.setUint16(record + 18, spec.name, true);
    view.setUint16(record + 20, spec.seconds, true);
    if (spec.cover !== undefined) {
      bytes[record + 20] = Math.round(spec.cover * 255);
      bytes[record + 21] = 0;
    }
    bytes[record + 22] = spec.kind;
    view.setUint32(record + 29, NO_SOURCE_ID, true);
  }

  view.setUint32(nameAt, NAMES.length, true);
  let nameCursor = 0;
  for (const [index, name] of NAMES.entries()) {
    view.setUint32(nameAt + 4 + 4 * index, nameCursor, true);
    nameCursor += name.length;
  }
  view.setUint32(nameAt + 4 + 4 * NAMES.length, nameCursor, true);
  bytes.set(nameBlob, nameAt + 4 + 4 * (NAMES.length + 1));
  view.setUint32(ferryAt, 0, true); // no ferries in this fixture

  let at = transitAt;
  view.setUint32(at, 1, true); // one route
  at += 4;
  bytes.set([0x00, 0x39, 0xa6, 0xff, 0xff, 0xff], at);
  view.setUint16(at + 6, SHORT_NAME, true);
  view.setUint16(at + 8, LONG_NAME, true);
  view.setUint16(at + 10, ROUTE_ID, true);
  at += 12;
  view.setUint32(at, BOARD_TABLE.length, true);
  at += 4;
  for (const [index, [edge, , route, stop]] of BOARD_TABLE.entries()) {
    view.setUint32(at, edge, true);
    view.setUint32(at + 4, lanes[index], true);
    view.setUint16(at + 8, route, true);
    view.setUint16(at + 10, stop, true);
    at += 12;
  }
  view.setUint32(at, RIDE_TABLE.length, true);
  at += 4;
  for (const [edge, route] of RIDE_TABLE) {
    view.setUint32(at, edge, true);
    view.setUint16(at + 4, route, true);
    at += 8;
  }
  return buffer;
}

// The fixture graph, with no timetable on it: hang one with `transitGraph().transit = ...`.
// `lanes` overrides which lane each board edge departs against, for the unscheduled-lane case.
export function transitGraph(
  lanes: readonly number[] = BOARD_TABLE.map(([, lane]) => lane),
  { detours = false }: { detours?: boolean } = {},
): RoutingGraph {
  const nodes = detours ? [...NODES, ...DETOUR_NODES] : NODES;
  const edges = detours ? [...EDGES, ...DETOUR_EDGES] : EDGES;
  return decodeGraph(graphBytes(lanes, nodes, edges), {
    hash: "0",
    keyHash: "0",
  });
}

// Weights with every scenic factor off, so a test's own numbers are the only thing pricing a route.
export function transitWeights(
  overrides: Partial<RouteWeights> = {},
): RouteWeights {
  return {
    tree: 0,
    ferry: 0,
    landmark: 0,
    art: 0,
    highway: 0,
    hill: 0,
    commercial: 0,
    industrial: 0,
    historic: 0,
    shade: 0,
    shelter: 0,
    transit: 0,
    allowFerries: true,
    allowTransit: true,
    allowSheds: true,
    // The fixture draws no crossing, so this is free either way; stated because omitting it reads as
    // "avoid crossings", which is not what any of these tests means.
    allowCrossings: true,
    ...overrides,
  };
}

export const FIRST_DEPARTURE = 8 * 3600; // 08:00
export const HEADWAY = 600;
export const LAST_DEPARTURE = 10 * 3600; // 10:00, after which the line has stopped for the day

// A timetable for the fixture's one lane: trains every ten minutes from 08:00 to 10:00, every day.
// Hand-written as the record the reader decodes rather than as TSCH bytes — the format itself is
// transit-schedule.test.ts's question, and this one is about what the router does with the answer.
export function fixtureTimetable(date: Date): TransitTimetable {
  const record: ScheduleRecord = {
    firstDay: 20200101,
    lastDay: 0,
    services: [{ mask: 0x7f, startDay: 20200101, endDay: 20301231 }],
    exceptions: [],
    patterns: [{ laneId: LANE_ID, offsets: [0, RIDE_SECONDS] }],
    lanes: [
      {
        pattern: 0,
        service: 0,
        bands: [
          { start: FIRST_DEPARTURE, end: LAST_DEPARTURE, headway: HEADWAY },
        ],
      },
    ],
  };
  return resolveTimetable(record, date, FIXTURE_TIME_ZONE);
}

// The fixture's instants are built with the local Date constructor, so its timetable is read in the
// runner's own zone: the tests are about waits and transfers, not about where the reader is.
export const FIXTURE_TIME_ZONE =
  Intl.DateTimeFormat().resolvedOptions().timeZone;

// A departure instant on the fixture's day, given the seconds from midnight. A Wednesday, so the
// everyday service runs.
export function departureAt(secondsOfDay: number): Date {
  return new Date(2026, 8, 2, 0, 0, secondsOfDay);
}

// The instant to leave at so the walker reaches the platform exactly as a train does: the band's
// first departure, less however long the approach takes. Leaving a minute later than this is a
// minute late for that train, and the test that wants a wait says so that way.
export function departureReaching(approachSeconds: number): Date {
  return departureAt(FIRST_DEPARTURE - approachSeconds);
}

// A snap sitting exactly on a node, entered through one of its incident sidewalks — the only edges
// a real snap index offers, since it never indexes a platform.
export function snapAtNode(
  graph: RoutingGraph,
  node: number,
  walkEdge: number,
): Snap {
  const atA = graph.edgeNodeA[walkEdge] === node;
  return {
    edge: walkEdge,
    metersFromA: atA ? 0 : graph.edgeLength[walkEdge],
    point: {
      lat: graph.originLat + graph.nodeQy[node] * graph.scale,
      lng: graph.originLng + graph.nodeQx[node] * graph.scale,
    },
    distanceMeters: 0,
    component: 0,
  };
}

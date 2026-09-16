// The synthetic routing graph the transit tests are run over: one straight kilometre of pavement
// with a two-station line beside it, and a hand-written timetable for that line.
//
// Written as GRPH BYTES and decoded, rather than assembled as an object the way the ferry
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
  ELEVATOR_FLAG,
  ENTRY_ONLY_FLAG,
  EXIT_ONLY_FLAG,
  type RoutingGraph,
  STAY_ABOARD_FLAG,
} from "./graph";
import { encodeGraph } from "./graph-bytes.fixture";
import { haversineMeters, type Snap } from "./snap";
import {
  resolveTimetable,
  type ScheduleRecord,
  type TransitTimetable,
} from "./transit-schedule";
import { WALK_METERS_PER_SECOND } from "./walk-speed";

export const SCALE = 1e-6;
export const ORIGIN_LNG = -74;
export const ORIGIN_LAT = 40.7;
const NAME_NONE = 0xffff;

const KIND_SIDEWALK = 0;
const KIND_CROSSING = 1;
const KIND_ACCESS = 5;
const KIND_BOARD = 6;
const KIND_RIDE = 7;

// The lane the board edges depart against, as TRNS hashes one. Any u32 will do; this is not one of
// the graph's own numbers, it is the join key the timetable is keyed by.
export const LANE_ID = 0x1234_5678;
// A lane the graph names and the timetable does not, for the "no schedule, no train" case.
export const UNSCHEDULED_LANE = 0x0bad_0bad;

export const ALIGHT_SECONDS = 30; // the step back up from the platform
export const RIDE_SECONDS = 180;
export const WEST_STATION = "West Street";
export const EAST_STATION = "East Street";
export const ROUTE_SHORT_NAME = "Q";
export const ROUTE_LONG_NAME = "Cross-town Local";

// A kilometre and a bit of pavement, so the walk is ~900 s: long enough that a 180 s ride plus the
// walks into and out of its two stations beats it outright — with room to spare for a trip that
// starts part way along and has to come back — and short enough that the same ride at the top of the
// transit slider does not.
const EAST_X = 14_000;
// The line runs a hundred metres off the pavement, which is far enough that the two routes cover
// different ground: the planner tells its cards apart by the cells they cross, and a line drawn on
// top of the street it parallels would read as the same walk.
const STATION_Y = 900;
export const SIDEWALK_COVER = 0.5;

// The two ends are deliberately different kinds of stop: the west is a station with a way in, the
// east a kerbside stop the tiler bakes the shorter walk for, which is the only mark of the feed's
// surface flag the graph keeps. Each carries its own base plus the walk out to the pavement, as the
// tiler bakes it (crates/tiler/src/graph.rs), and it is taking that walk back off that tells the two
// bases apart.
const ACCESS_WALK_SECONDS = Math.round(
  haversineMeters(
    ORIGIN_LAT,
    ORIGIN_LNG,
    ORIGIN_LAT + STATION_Y * SCALE,
    ORIGIN_LNG,
  ) / WALK_METERS_PER_SECOND,
);
export const ACCESS_SECONDS = 90 + ACCESS_WALK_SECONDS; // down into the west station and back up
export const EAST_ACCESS_SECONDS = 30 + ACCESS_WALK_SECONDS; // across the pavement to the east stop

const NODES: readonly [number, number][] = [
  [0, 0], // 0 the pavement's west end
  [EAST_X / 2, 0], // 1 the middle of it, where the two sidewalk edges meet
  [EAST_X, 0], // 2 its east end
  [0, STATION_Y], // 3 the west station
  [EAST_X, STATION_Y], // 4 the east station
  [0, STATION_Y], // 5 the west platform's boarding node, standing where its station does
  [EAST_X, STATION_Y], // 6 the east platform's
  [0, STATION_Y], // 7 the west platform's arrival node, at the same point
  [EAST_X, STATION_Y], // 8 the east platform's
];

// The longest board edge New York has: inside a transfer complex the station node is the members'
// centroid and the platform stands on its own stop, a passage away. Opt-in, since every other test
// here wants the platforms where their stations are.
export const PLATFORM_SETBACK_METERS = 251;
const PLATFORM_SETBACK_UNITS = Math.round(
  PLATFORM_SETBACK_METERS /
    haversineMeters(ORIGIN_LAT, ORIGIN_LNG, ORIGIN_LAT, ORIGIN_LNG + SCALE),
);

// Both platforms drawn back along the line toward each other, so each board edge spans the setback
// and the ride between them shortens by two of them.
const SETBACK_NODES: readonly (readonly [number, number])[] = NODES.map(
  (point, node): readonly [number, number] => {
    if (node === 5 || node === 7) {
      return [PLATFORM_SETBACK_UNITS, STATION_Y];
    } else if (node === 6 || node === 8) {
      return [EAST_X - PLATFORM_SETBACK_UNITS, STATION_Y];
    } else {
      return point;
    }
  },
);

interface EdgeSpec {
  a: number;
  b: number;
  kind: number;
  seconds: number;
  name: number; // index into NAMES, or NAME_NONE
  cover?: number; // 0..1, a sidewalk's own tree cover; the transit kinds carry none
  side?: number; // which side of its street a sidewalk lies on: 0 none, 1 N, 2 E, 3 S, 4 W
  flags?: number; // an access edge's door bits, or a ride's stay-aboard bit
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

// The free one-way step from a stop's arrival node onto its boarding node, which is what a rider
// staying on the train takes. Every platform has one, and it is what makes a board and an alight at
// the same stop impossible.
function stayAboard(arrival: number, boarding: number): EdgeSpec {
  return {
    a: arrival,
    b: boarding,
    kind: KIND_RIDE,
    seconds: 0,
    name: NAME_NONE,
    flags: STAY_ABOARD_FLAG,
  };
}

// Two sidewalks, the two station walks, and one westbound pattern: board, alight and ride at each of
// its two stops. The eastbound half of the line is deliberately absent — one direction is enough to
// ask every question here, and its absence is what makes a backwards ride visible if one is taken.
//
// Its stations stand on ONE node each, with a two-way door, which is the shape the tiler wrote
// before it split them into a way in and a way out — and the shape every graph deployed before that
// still carries, since the door bits read as 0. The split station below is the shape it writes now;
// this one is what says the decoder still reads the other.
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
  { a: 7, b: 3, kind: KIND_ACCESS, seconds: ALIGHT_SECONDS, name: NAME_NONE },
  { a: 5, b: 8, kind: KIND_RIDE, seconds: RIDE_SECONDS, name: SHORT_NAME },
  { a: 4, b: 6, kind: KIND_BOARD, seconds: 0, name: SHORT_NAME },
  { a: 8, b: 4, kind: KIND_ACCESS, seconds: ALIGHT_SECONDS, name: NAME_NONE },
  // Staying aboard, arrival node onto boarding node, at each of the two stops.
  stayAboard(7, 5),
  stayAboard(8, 6),
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

// The GRPH blob for this fixture, built from the same description the tiler's own writer takes.
function graphBytes(
  lanes: readonly number[],
  nodes: readonly (readonly [number, number])[],
  edges: readonly EdgeSpec[],
): ArrayBuffer {
  const lat = (node: number): number => ORIGIN_LAT + nodes[node][1] * SCALE;
  const lng = (node: number): number => ORIGIN_LNG + nodes[node][0] * SCALE;
  return encodeGraph({
    originLng: ORIGIN_LNG,
    originLat: ORIGIN_LAT,
    scale: SCALE,
    nodes: nodes.map(([qx, qy]) => ({ qx, qy })),
    edges: edges.map((spec) => ({
      a: spec.a,
      b: spec.b,
      kind: spec.kind,
      // The true geodesic span between the two nodes, which is what keeps the A* walking floor a
      // lower bound: the heuristic measures the same coordinates.
      length: haversineMeters(
        lat(spec.a),
        lng(spec.a),
        lat(spec.b),
        lng(spec.b),
      ),
      nameId: spec.name,
      durationSeconds: spec.seconds,
      flags: spec.flags,
      cover: spec.cover === undefined ? 0 : Math.round(spec.cover * 255),
    })),
    names: NAMES,
    transitRoutes: [
      {
        color: [0x00, 0x39, 0xa6],
        textColor: [0xff, 0xff, 0xff],
        shortName: SHORT_NAME,
        longName: LONG_NAME,
        id: ROUTE_ID,
      },
    ],
    board: BOARD_TABLE.map(([edge, , route, stop], index) => ({
      edge,
      lane: lanes[index],
      route,
      stop,
    })),
    ride: RIDE_TABLE.map(([edge, route]) => ({ edge, route })),
    doors: [
      { edge: WEST_ACCESS, street: MAIN, side: 0 },
      { edge: EAST_ACCESS, street: MAIN, side: 0 },
    ],
  });
}

// The fixture graph, with no timetable on it: hang one with `transitGraph().transit = ...`.
// `lanes` overrides which lane each board edge departs against, for the unscheduled-lane case.
export function transitGraph(
  lanes: readonly number[] = BOARD_TABLE.map(([, lane]) => lane),
  {
    detours = false,
    setback = false,
  }: { detours?: boolean; setback?: boolean } = {},
): RoutingGraph {
  const placed = setback ? SETBACK_NODES : NODES;
  const nodes = detours ? [...placed, ...DETOUR_NODES] : placed;
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
    bridge: 0,
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

// A SPLIT station — one with no free crossover — and the avenue it stands under, as its own little
// network rather than a switch on the graph above, so every node and edge id in that one stays
// where it is. The avenue runs north-south with a pavement each side and a crossing at its southern
// corner; the station has one node per direction, and the doors are what tell them apart: the two
// on the east pavement reach the uptown platform, the lift on the west pavement the downtown one.
// A rider who wants a train has to be on the right pavement, which is the whole point of the split.
const AVENUE_HALF = 400; // ~34 m off the centre line: one pavement each side
const SPLIT_DOOR_Y = 600; // the doors, ~67 m north of the crossing
const SPLIT_EXIT_Y = 200; // the exit-only door, nearer the crossing than the two-way one
const SPLIT_NORTH_Y = 18_000; // ~2 km up the line, where the next station is
const SPLIT_SOUTH_Y = -18_000;

export const SPLIT_STATION = "Bridge St";
export const SPLIT_NORTH_STATION = "Vine St";
export const SPLIT_SOUTH_STATION = "Harbor St";
export const SPLIT_AVENUE = "FLATBUSH AVE";
export const SPLIT_CROSS_STREET = "FULTON ST";
export const SPLIT_ROUTE_SHORT_NAME = "B";
export const SPLIT_UPTOWN_LANE = 0x0101_0101;
export const SPLIT_DOWNTOWN_LANE = 0x0202_0202;
// Trains every two minutes, so the worst wait cannot make the ride dearer than walking the avenue.
export const SPLIT_HEADWAY = 120;

const SPLIT_NAMES = [
  SPLIT_AVENUE,
  SPLIT_CROSS_STREET,
  SPLIT_STATION,
  SPLIT_NORTH_STATION,
  SPLIT_SOUTH_STATION,
  SPLIT_ROUTE_SHORT_NAME,
  "Crosstown Express",
  "b",
];
const [
  AVENUE_NAME,
  CROSS_NAME,
  SPLIT_NAME,
  NORTH_NAME,
  SOUTH_NAME,
  SPLIT_SHORT_NAME,
  SPLIT_LONG_NAME,
  SPLIT_ROUTE_ID,
] = [0, 1, 2, 3, 4, 5, 6, 7];

// The corners and the doors. A station side stands on TWO nodes at the one point — the one its
// doors lead in to and the one they lead out of — as the tiler places them.
export const SPLIT_WEST_CORNER = 0;
export const SPLIT_EAST_CORNER = 1;
export const SPLIT_WEST_DOOR_NODE = 2;
export const SPLIT_EAST_DOOR_NODE = 3;
export const SPLIT_EXIT_DOOR_NODE = 4;
export const SPLIT_NORTH_PAVEMENT = 5;
export const SPLIT_SOUTH_PAVEMENT = 6;
const UPTOWN_ENTRY = 7;
const UPTOWN_EXIT = 8;
const DOWNTOWN_ENTRY = 9;
const DOWNTOWN_EXIT = 10;
const NORTH_ENTRY = 11;
const NORTH_EXIT = 12;
const SOUTH_ENTRY = 13;
const SOUTH_EXIT = 14;
const UPTOWN_PLATFORM = 15;
const DOWNTOWN_PLATFORM = 16;
const NORTH_PLATFORM = 17;
const SOUTH_PLATFORM = 18;
// Each platform's arrival node, standing where its boarding node does: the ride lands here and the
// alight leaves here, with the stay-aboard edge between the two.
const UPTOWN_ARRIVAL = 19;
const DOWNTOWN_ARRIVAL = 20;
const NORTH_ARRIVAL = 21;
const SOUTH_ARRIVAL = 22;

const SPLIT_NODES: readonly [number, number][] = [
  [-AVENUE_HALF, 0],
  [AVENUE_HALF, 0],
  [-AVENUE_HALF, SPLIT_DOOR_Y],
  [AVENUE_HALF, SPLIT_DOOR_Y],
  [AVENUE_HALF, SPLIT_EXIT_Y],
  [AVENUE_HALF, SPLIT_NORTH_Y],
  [-AVENUE_HALF, SPLIT_SOUTH_Y],
  [0, SPLIT_DOOR_Y],
  [0, SPLIT_DOOR_Y],
  [0, SPLIT_DOOR_Y],
  [0, SPLIT_DOOR_Y],
  [0, SPLIT_NORTH_Y],
  [0, SPLIT_NORTH_Y],
  [0, SPLIT_SOUTH_Y],
  [0, SPLIT_SOUTH_Y],
  [0, SPLIT_DOOR_Y],
  [0, SPLIT_DOOR_Y],
  [0, SPLIT_NORTH_Y],
  [0, SPLIT_SOUTH_Y],
  [0, SPLIT_DOOR_Y],
  [0, SPLIT_DOOR_Y],
  [0, SPLIT_NORTH_Y],
  [0, SPLIT_SOUTH_Y],
];

const SIDE_EAST = 2;
const SIDE_WEST = 4;

// The walk down to the platform as the tiler bakes it: a base for the way in, plus the walk from
// the station's own point out to the door at walking pace. A lift is the dearer base of the two.
function doorSeconds(station: number, door: number, elevator = false): number {
  const meters = haversineMeters(
    ORIGIN_LAT + SPLIT_NODES[station][1] * SCALE,
    ORIGIN_LNG + SPLIT_NODES[station][0] * SCALE,
    ORIGIN_LAT + SPLIT_NODES[door][1] * SCALE,
    ORIGIN_LNG + SPLIT_NODES[door][0] * SCALE,
  );
  return Math.round((elevator ? 150 : 90) + meters / WALK_METERS_PER_SECOND);
}

export const SPLIT_WEST_SIDEWALK = 0;
export const SPLIT_SOUTH_SIDEWALK = 1;
export const SPLIT_EAST_SIDEWALK = 2;
export const SPLIT_NORTH_SIDEWALK = 4;
export const SPLIT_CROSSING = 5;
// The uptown side's two-way stair, as the two one-way edges the tiler writes it as.
export const SPLIT_EAST_DOOR = 6;
export const SPLIT_EAST_DOOR_OUT = 7;
export const SPLIT_EXIT_DOOR = 8;
export const SPLIT_UPTOWN_TRANSFER = 9;
export const SPLIT_ELEVATOR_DOOR = 10;
export const SPLIT_ELEVATOR_DOOR_OUT = 11;
export const SPLIT_UPTOWN_BOARD = 19;
export const SPLIT_DOWNTOWN_BOARD = 24;

// A door as the tiler writes it: one edge in, one edge out, unless the agency says a stair only
// opens outwards. Both carry the station's name, the same seconds and the same kind.
function splitDoors(
  entry: number,
  exit: number,
  door: number,
  name: number,
  { elevator = false, exitOnly = false } = {},
): EdgeSpec[] {
  const seconds = doorSeconds(entry, door, elevator);
  const kind = elevator ? ELEVATOR_FLAG : 0;
  const inward: EdgeSpec[] = exitOnly
    ? []
    : [
        {
          a: entry,
          b: door,
          kind: KIND_ACCESS,
          seconds,
          name,
          flags: kind | ENTRY_ONLY_FLAG,
        },
      ];
  return [
    ...inward,
    {
      a: exit,
      b: door,
      kind: KIND_ACCESS,
      seconds,
      name,
      flags: kind | EXIT_ONLY_FLAG,
    },
  ];
}

// The change of train: a station side's exit round to its own entry, free and one-way. It is what
// keeps a door-in, door-out walk through the station impossible while a change stays possible.
function splitTransfer(entry: number, exit: number, name: number): EdgeSpec {
  return {
    a: exit,
    b: entry,
    kind: KIND_ACCESS,
    seconds: 0,
    name,
    flags: EXIT_ONLY_FLAG,
  };
}

const SPLIT_EDGES: readonly EdgeSpec[] = [
  {
    a: SPLIT_WEST_CORNER,
    b: SPLIT_WEST_DOOR_NODE,
    kind: KIND_SIDEWALK,
    seconds: 0,
    name: AVENUE_NAME,
    side: SIDE_WEST,
  },
  {
    a: SPLIT_WEST_CORNER,
    b: SPLIT_SOUTH_PAVEMENT,
    kind: KIND_SIDEWALK,
    seconds: 0,
    name: AVENUE_NAME,
    side: SIDE_WEST,
  },
  {
    a: SPLIT_EAST_CORNER,
    b: SPLIT_EXIT_DOOR_NODE,
    kind: KIND_SIDEWALK,
    seconds: 0,
    name: AVENUE_NAME,
    side: SIDE_EAST,
  },
  {
    a: SPLIT_EXIT_DOOR_NODE,
    b: SPLIT_EAST_DOOR_NODE,
    kind: KIND_SIDEWALK,
    seconds: 0,
    name: AVENUE_NAME,
    side: SIDE_EAST,
  },
  {
    a: SPLIT_EAST_DOOR_NODE,
    b: SPLIT_NORTH_PAVEMENT,
    kind: KIND_SIDEWALK,
    seconds: 0,
    name: AVENUE_NAME,
    side: SIDE_EAST,
  },
  {
    a: SPLIT_WEST_CORNER,
    b: SPLIT_EAST_CORNER,
    kind: KIND_CROSSING,
    seconds: 0,
    name: CROSS_NAME,
  },
  // The uptown side's two doors, both on the east pavement: a stair a rider may use either way, and
  // one that only opens outwards.
  ...splitDoors(UPTOWN_ENTRY, UPTOWN_EXIT, SPLIT_EAST_DOOR_NODE, SPLIT_NAME),
  ...splitDoors(UPTOWN_ENTRY, UPTOWN_EXIT, SPLIT_EXIT_DOOR_NODE, SPLIT_NAME, {
    exitOnly: true,
  }),
  splitTransfer(UPTOWN_ENTRY, UPTOWN_EXIT, SPLIT_NAME),
  // The downtown side's one door, a lift on the west pavement.
  ...splitDoors(
    DOWNTOWN_ENTRY,
    DOWNTOWN_EXIT,
    SPLIT_WEST_DOOR_NODE,
    SPLIT_NAME,
    { elevator: true },
  ),
  splitTransfer(DOWNTOWN_ENTRY, DOWNTOWN_EXIT, SPLIT_NAME),
  ...splitDoors(NORTH_ENTRY, NORTH_EXIT, SPLIT_NORTH_PAVEMENT, NORTH_NAME),
  splitTransfer(NORTH_ENTRY, NORTH_EXIT, NORTH_NAME),
  ...splitDoors(SOUTH_ENTRY, SOUTH_EXIT, SPLIT_SOUTH_PAVEMENT, SOUTH_NAME),
  splitTransfer(SOUTH_ENTRY, SOUTH_EXIT, SOUTH_NAME),
  // Direction 0 boards from side 0's entry and runs north; direction 1 from side 1's. No edge joins
  // the two sides: changing your mind means walking out and across.
  {
    a: UPTOWN_ENTRY,
    b: UPTOWN_PLATFORM,
    kind: KIND_BOARD,
    seconds: 0,
    name: SPLIT_SHORT_NAME,
  },
  {
    a: UPTOWN_ARRIVAL,
    b: UPTOWN_EXIT,
    kind: KIND_ACCESS,
    seconds: ALIGHT_SECONDS,
    name: NAME_NONE,
  },
  {
    a: UPTOWN_PLATFORM,
    b: NORTH_ARRIVAL,
    kind: KIND_RIDE,
    seconds: RIDE_SECONDS,
    name: SPLIT_SHORT_NAME,
  },
  {
    a: NORTH_ENTRY,
    b: NORTH_PLATFORM,
    kind: KIND_BOARD,
    seconds: 0,
    name: SPLIT_SHORT_NAME,
  },
  {
    a: NORTH_ARRIVAL,
    b: NORTH_EXIT,
    kind: KIND_ACCESS,
    seconds: ALIGHT_SECONDS,
    name: NAME_NONE,
  },
  {
    a: DOWNTOWN_ENTRY,
    b: DOWNTOWN_PLATFORM,
    kind: KIND_BOARD,
    seconds: 0,
    name: SPLIT_SHORT_NAME,
  },
  {
    a: DOWNTOWN_ARRIVAL,
    b: DOWNTOWN_EXIT,
    kind: KIND_ACCESS,
    seconds: ALIGHT_SECONDS,
    name: NAME_NONE,
  },
  {
    a: DOWNTOWN_PLATFORM,
    b: SOUTH_ARRIVAL,
    kind: KIND_RIDE,
    seconds: RIDE_SECONDS,
    name: SPLIT_SHORT_NAME,
  },
  {
    a: SOUTH_ENTRY,
    b: SOUTH_PLATFORM,
    kind: KIND_BOARD,
    seconds: 0,
    name: SPLIT_SHORT_NAME,
  },
  {
    a: SOUTH_ARRIVAL,
    b: SOUTH_EXIT,
    kind: KIND_ACCESS,
    seconds: ALIGHT_SECONDS,
    name: NAME_NONE,
  },
  stayAboard(UPTOWN_ARRIVAL, UPTOWN_PLATFORM),
  stayAboard(NORTH_ARRIVAL, NORTH_PLATFORM),
  stayAboard(DOWNTOWN_ARRIVAL, DOWNTOWN_PLATFORM),
  stayAboard(SOUTH_ARRIVAL, SOUTH_PLATFORM),
];

// Every door of the fixture with the street it opens onto, as the tiler reads it off the pavement it
// cut the door into: the uptown side's stairs onto the east pavement, the downtown lift onto the
// west, and the two stations up and down the line.
const SPLIT_DOOR_STREETS: readonly {
  edge: number;
  street: number;
  side: number;
}[] = SPLIT_EDGES.flatMap((spec, edge) => {
  const pavement = SPLIT_EDGES.find(
    (walk) =>
      walk.kind === KIND_SIDEWALK && (walk.a === spec.b || walk.b === spec.b),
  );
  return spec.kind === KIND_ACCESS && pavement !== undefined
    ? [{ edge, street: pavement.name, side: pavement.side ?? 0 }]
    : [];
});

// The split station's graph, with no timetable on it: hang one with `splitTimetable`.
export function splitStationGraph(): RoutingGraph {
  const lat = (node: number): number =>
    ORIGIN_LAT + SPLIT_NODES[node][1] * SCALE;
  const lng = (node: number): number =>
    ORIGIN_LNG + SPLIT_NODES[node][0] * SCALE;
  return decodeGraph(
    encodeGraph({
      originLng: ORIGIN_LNG,
      originLat: ORIGIN_LAT,
      scale: SCALE,
      nodes: SPLIT_NODES.map(([qx, qy]) => ({ qx, qy })),
      edges: SPLIT_EDGES.map((spec) => ({
        a: spec.a,
        b: spec.b,
        kind: spec.kind,
        side: spec.side,
        flags: spec.flags,
        length: haversineMeters(
          lat(spec.a),
          lng(spec.a),
          lat(spec.b),
          lng(spec.b),
        ),
        nameId: spec.name,
        durationSeconds: spec.seconds,
      })),
      names: SPLIT_NAMES,
      transitRoutes: [
        {
          color: [0xff, 0x63, 0x19],
          textColor: [0xff, 0xff, 0xff],
          shortName: SPLIT_SHORT_NAME,
          longName: SPLIT_LONG_NAME,
          id: SPLIT_ROUTE_ID,
        },
      ],
      board: [
        {
          edge: SPLIT_UPTOWN_BOARD,
          lane: SPLIT_UPTOWN_LANE,
          route: 0,
          stop: 0,
        },
        { edge: 22, lane: SPLIT_UPTOWN_LANE, route: 0, stop: 1 },
        {
          edge: SPLIT_DOWNTOWN_BOARD,
          lane: SPLIT_DOWNTOWN_LANE,
          route: 0,
          stop: 0,
        },
        { edge: 27, lane: SPLIT_DOWNTOWN_LANE, route: 0, stop: 1 },
      ],
      ride: [
        { edge: 21, route: 0 },
        { edge: 26, route: 0 },
      ],
      doors: SPLIT_DOOR_STREETS,
    }),
    { hash: "0", keyHash: "0" },
  );
}

// A timetable for the split station's two directions, both running all day at a short headway.
export function splitTimetable(date: Date): TransitTimetable {
  const record: ScheduleRecord = {
    firstDay: 20200101,
    lastDay: 0,
    services: [{ mask: 0x7f, startDay: 20200101, endDay: 20301231 }],
    exceptions: [],
    patterns: [
      { laneId: SPLIT_UPTOWN_LANE, offsets: [0, RIDE_SECONDS] },
      { laneId: SPLIT_DOWNTOWN_LANE, offsets: [0, RIDE_SECONDS] },
    ],
    lanes: [0, 1].map((pattern) => ({
      pattern,
      service: 0,
      bands: [
        { start: FIRST_DEPARTURE, end: LAST_DEPARTURE, headway: SPLIT_HEADWAY },
      ],
    })),
  };
  return resolveTimetable(record, date, FIXTURE_TIME_ZONE);
}

// A station with a two-way door on each pavement of an avenue, and the only crossing two kilometres
// south of it: walking round is an hour and walking down one stair and up the other is four minutes.
// On one station node that is what a router does — the station becomes a free underpass — so this is
// the fixture that says the way in and the way out are different nodes. Two lines meet here as well,
// which is the other half of the same question: a change of train still has to be possible.
const UNDERPASS_HALF = 400; // ~34 m off the centre line: one pavement each side
const UNDERPASS_SOUTH = -20_000; // the crossing, ~2.2 km down the avenue
const UNDERPASS_NORTH = 20_000; // and the next station, as far the other way

export const UNDERPASS_STATION = "Mid St";
export const UNDERPASS_SOUTH_STATION = "South St";
export const UNDERPASS_NORTH_STATION = "North St";
export const UNDERPASS_AVENUE = "FLATBUSH AVE";
export const UNDERPASS_CROSS_STREET = "FULTON ST";
export const UNDERPASS_SOUTH_LANE = 0x0303_0303;
export const UNDERPASS_NORTH_LANE = 0x0404_0404;

const UNDERPASS_NAMES = [
  UNDERPASS_AVENUE,
  UNDERPASS_CROSS_STREET,
  UNDERPASS_STATION,
  UNDERPASS_SOUTH_STATION,
  UNDERPASS_NORTH_STATION,
  "A",
  "A line",
  "a",
  "B",
  "B line",
  "b",
];
const [
  UP_AVENUE_NAME,
  UP_CROSS_NAME,
  UP_MID_NAME,
  UP_SOUTH_NAME,
  UP_NORTH_NAME,
  UP_A_SHORT,
  UP_A_LONG,
  UP_A_ID,
  UP_B_SHORT,
  UP_B_LONG,
  UP_B_ID,
] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export const UNDERPASS_WEST_DOOR_NODE = 0;
export const UNDERPASS_EAST_DOOR_NODE = 1;
export const UNDERPASS_WEST_CORNER = 2;
export const UNDERPASS_EAST_CORNER = 3;
export const UNDERPASS_NORTH_END = 4;
const MID_ENTRY = 5;
const MID_EXIT = 6;
const UP_SOUTH_ENTRY = 7;
const UP_SOUTH_EXIT = 8;
const UP_NORTH_ENTRY = 9;
const UP_NORTH_EXIT = 10;
const A_MID_PLATFORM = 11;
const A_SOUTH_PLATFORM = 12;
const B_MID_PLATFORM = 13;
const B_NORTH_PLATFORM = 14;
// Each platform's arrival node, at the same point as its boarding node.
const A_MID_ARRIVAL = 15;
const A_SOUTH_ARRIVAL = 16;
const B_MID_ARRIVAL = 17;
const B_NORTH_ARRIVAL = 18;

const UNDERPASS_NODES: readonly [number, number][] = [
  [-UNDERPASS_HALF, 0],
  [UNDERPASS_HALF, 0],
  [-UNDERPASS_HALF, UNDERPASS_SOUTH],
  [UNDERPASS_HALF, UNDERPASS_SOUTH],
  [UNDERPASS_HALF, UNDERPASS_NORTH],
  [0, 0],
  [0, 0],
  [0, UNDERPASS_SOUTH],
  [0, UNDERPASS_SOUTH],
  [0, UNDERPASS_NORTH],
  [0, UNDERPASS_NORTH],
  [0, 0],
  [0, UNDERPASS_SOUTH],
  [0, 0],
  [0, UNDERPASS_NORTH],
  [0, 0],
  [0, UNDERPASS_SOUTH],
  [0, 0],
  [0, UNDERPASS_NORTH],
];

function underpassDoorSeconds(station: number, door: number): number {
  const meters = haversineMeters(
    ORIGIN_LAT + UNDERPASS_NODES[station][1] * SCALE,
    ORIGIN_LNG + UNDERPASS_NODES[station][0] * SCALE,
    ORIGIN_LAT + UNDERPASS_NODES[door][1] * SCALE,
    ORIGIN_LNG + UNDERPASS_NODES[door][0] * SCALE,
  );
  return Math.round(90 + meters / WALK_METERS_PER_SECOND);
}

// A two-way door and the change of train behind it, as the tiler writes them.
function underpassDoors(
  entry: number,
  exit: number,
  door: number,
  name: number,
): EdgeSpec[] {
  const seconds = underpassDoorSeconds(entry, door);
  return [
    {
      a: entry,
      b: door,
      kind: KIND_ACCESS,
      seconds,
      name,
      flags: ENTRY_ONLY_FLAG,
    },
    {
      a: exit,
      b: door,
      kind: KIND_ACCESS,
      seconds,
      name,
      flags: EXIT_ONLY_FLAG,
    },
  ];
}

export const UNDERPASS_WEST_SIDEWALK = 0;
export const UNDERPASS_EAST_SIDEWALK = 1;
export const UNDERPASS_EAST_NORTH_SIDEWALK = 2;
export const UNDERPASS_CROSSING = 3;
export const UNDERPASS_WEST_DOOR = 4;
export const UNDERPASS_EAST_DOOR = 6;
export const UNDERPASS_TRANSFER = 8;
export const UNDERPASS_SOUTH_DOOR = 9;

const UNDERPASS_EDGES: readonly EdgeSpec[] = [
  {
    a: UNDERPASS_WEST_CORNER,
    b: UNDERPASS_WEST_DOOR_NODE,
    kind: KIND_SIDEWALK,
    seconds: 0,
    name: UP_AVENUE_NAME,
    side: SIDE_WEST,
  },
  {
    a: UNDERPASS_EAST_CORNER,
    b: UNDERPASS_EAST_DOOR_NODE,
    kind: KIND_SIDEWALK,
    seconds: 0,
    name: UP_AVENUE_NAME,
    side: SIDE_EAST,
  },
  {
    a: UNDERPASS_EAST_DOOR_NODE,
    b: UNDERPASS_NORTH_END,
    kind: KIND_SIDEWALK,
    seconds: 0,
    name: UP_AVENUE_NAME,
    side: SIDE_EAST,
  },
  {
    a: UNDERPASS_WEST_CORNER,
    b: UNDERPASS_EAST_CORNER,
    kind: KIND_CROSSING,
    seconds: 0,
    name: UP_CROSS_NAME,
  },
  ...underpassDoors(MID_ENTRY, MID_EXIT, UNDERPASS_WEST_DOOR_NODE, UP_MID_NAME),
  ...underpassDoors(MID_ENTRY, MID_EXIT, UNDERPASS_EAST_DOOR_NODE, UP_MID_NAME),
  splitTransfer(MID_ENTRY, MID_EXIT, UP_MID_NAME),
  // The station down the line opens onto the crossing's own corner, which is the case the door
  // table is for: the step a route arrives along is the crossing, and it names no street at all.
  ...underpassDoors(
    UP_SOUTH_ENTRY,
    UP_SOUTH_EXIT,
    UNDERPASS_EAST_CORNER,
    UP_SOUTH_NAME,
  ),
  splitTransfer(UP_SOUTH_ENTRY, UP_SOUTH_EXIT, UP_SOUTH_NAME),
  ...underpassDoors(
    UP_NORTH_ENTRY,
    UP_NORTH_EXIT,
    UNDERPASS_NORTH_END,
    UP_NORTH_NAME,
  ),
  splitTransfer(UP_NORTH_ENTRY, UP_NORTH_EXIT, UP_NORTH_NAME),
  // Line A comes up from the south and ends here; line B carries on north.
  {
    a: UP_SOUTH_ENTRY,
    b: A_SOUTH_PLATFORM,
    kind: KIND_BOARD,
    seconds: 0,
    name: UP_A_SHORT,
  },
  {
    a: A_SOUTH_ARRIVAL,
    b: UP_SOUTH_EXIT,
    kind: KIND_ACCESS,
    seconds: ALIGHT_SECONDS,
    name: NAME_NONE,
  },
  {
    a: A_SOUTH_PLATFORM,
    b: A_MID_ARRIVAL,
    kind: KIND_RIDE,
    seconds: RIDE_SECONDS,
    name: UP_A_SHORT,
  },
  {
    a: MID_ENTRY,
    b: A_MID_PLATFORM,
    kind: KIND_BOARD,
    seconds: 0,
    name: UP_A_SHORT,
  },
  {
    a: A_MID_ARRIVAL,
    b: MID_EXIT,
    kind: KIND_ACCESS,
    seconds: ALIGHT_SECONDS,
    name: NAME_NONE,
  },
  {
    a: MID_ENTRY,
    b: B_MID_PLATFORM,
    kind: KIND_BOARD,
    seconds: 0,
    name: UP_B_SHORT,
  },
  {
    a: B_MID_ARRIVAL,
    b: MID_EXIT,
    kind: KIND_ACCESS,
    seconds: ALIGHT_SECONDS,
    name: NAME_NONE,
  },
  {
    a: B_MID_PLATFORM,
    b: B_NORTH_ARRIVAL,
    kind: KIND_RIDE,
    seconds: RIDE_SECONDS,
    name: UP_B_SHORT,
  },
  {
    a: UP_NORTH_ENTRY,
    b: B_NORTH_PLATFORM,
    kind: KIND_BOARD,
    seconds: 0,
    name: UP_B_SHORT,
  },
  {
    a: B_NORTH_ARRIVAL,
    b: UP_NORTH_EXIT,
    kind: KIND_ACCESS,
    seconds: ALIGHT_SECONDS,
    name: NAME_NONE,
  },
  stayAboard(A_SOUTH_ARRIVAL, A_SOUTH_PLATFORM),
  stayAboard(A_MID_ARRIVAL, A_MID_PLATFORM),
  stayAboard(B_MID_ARRIVAL, B_MID_PLATFORM),
  stayAboard(B_NORTH_ARRIVAL, B_NORTH_PLATFORM),
];

// Each door with the street it opens onto, as the tiler reads it off the pavement it cut it into.
const UNDERPASS_DOOR_STREETS: readonly {
  edge: number;
  street: number;
  side: number;
}[] = UNDERPASS_EDGES.flatMap((spec, edge) => {
  const pavement = UNDERPASS_EDGES.find(
    (walk) =>
      walk.kind === KIND_SIDEWALK && (walk.a === spec.b || walk.b === spec.b),
  );
  return spec.kind === KIND_ACCESS && pavement !== undefined
    ? [{ edge, street: pavement.name, side: pavement.side ?? 0 }]
    : [];
});

export function underpassGraph(): RoutingGraph {
  const lat = (node: number): number =>
    ORIGIN_LAT + UNDERPASS_NODES[node][1] * SCALE;
  const lng = (node: number): number =>
    ORIGIN_LNG + UNDERPASS_NODES[node][0] * SCALE;
  const graph = decodeGraph(
    encodeGraph({
      originLng: ORIGIN_LNG,
      originLat: ORIGIN_LAT,
      scale: SCALE,
      nodes: UNDERPASS_NODES.map(([qx, qy]) => ({ qx, qy })),
      edges: UNDERPASS_EDGES.map((spec) => ({
        a: spec.a,
        b: spec.b,
        kind: spec.kind,
        side: spec.side,
        flags: spec.flags,
        length: haversineMeters(
          lat(spec.a),
          lng(spec.a),
          lat(spec.b),
          lng(spec.b),
        ),
        nameId: spec.name,
        durationSeconds: spec.seconds,
      })),
      names: UNDERPASS_NAMES,
      transitRoutes: [
        {
          color: [0x00, 0x93, 0x3c],
          textColor: [0xff, 0xff, 0xff],
          shortName: UP_A_SHORT,
          longName: UP_A_LONG,
          id: UP_A_ID,
        },
        {
          color: [0xff, 0x63, 0x19],
          textColor: [0xff, 0xff, 0xff],
          shortName: UP_B_SHORT,
          longName: UP_B_LONG,
          id: UP_B_ID,
        },
      ],
      board: [
        { edge: 15, lane: UNDERPASS_SOUTH_LANE, route: 0, stop: 0 },
        { edge: 18, lane: UNDERPASS_SOUTH_LANE, route: 0, stop: 1 },
        { edge: 20, lane: UNDERPASS_NORTH_LANE, route: 1, stop: 0 },
        { edge: 23, lane: UNDERPASS_NORTH_LANE, route: 1, stop: 1 },
      ],
      ride: [
        { edge: 17, route: 0 },
        { edge: 22, route: 1 },
      ],
      doors: UNDERPASS_DOOR_STREETS,
    }),
    { hash: "0", keyHash: "0" },
  );
  graph.transit = underpassTimetable(departureAt(FIRST_DEPARTURE));
  return graph;
}

// Both of the underpass fixture's lines, running all day at the split station's headway.
export function underpassTimetable(date: Date): TransitTimetable {
  const record: ScheduleRecord = {
    firstDay: 20200101,
    lastDay: 0,
    services: [{ mask: 0x7f, startDay: 20200101, endDay: 20301231 }],
    exceptions: [],
    patterns: [
      { laneId: UNDERPASS_SOUTH_LANE, offsets: [0, RIDE_SECONDS] },
      { laneId: UNDERPASS_NORTH_LANE, offsets: [0, RIDE_SECONDS] },
    ],
    lanes: [0, 1].map((pattern) => ({
      pattern,
      service: 0,
      bands: [
        { start: FIRST_DEPARTURE, end: LAST_DEPARTURE, headway: SPLIT_HEADWAY },
      ],
    })),
  };
  return resolveTimetable(record, date, FIXTURE_TIME_ZONE);
}

// A line calling at THREE stops along one pavement, which is what riding PAST a station looks like:
// board at the west end, stay aboard through the middle stop, get off at the east one. The walk is
// half as long again as the ride, so the train wins outright. Its own little network, so every node
// and edge id above stays where it is.
export const THREE_STOP_WEST = "West End";
export const THREE_STOP_MIDDLE = "Middle";
export const THREE_STOP_EAST = "East End";
export const THREE_STOP_ROUTE_SHORT_NAME = "C";
export const THREE_STOP_LANE = 0x0505_0505;
const THREE_STOP_SPACING = 10_500; // ~890 m of pavement between one stop and the next

const THREE_STOP_NAMES = [
  "Main Street",
  THREE_STOP_WEST,
  THREE_STOP_MIDDLE,
  THREE_STOP_EAST,
  THREE_STOP_ROUTE_SHORT_NAME,
  "Crosstown Local",
  "c",
];
const [
  THREE_STOP_STREET,
  THREE_STOP_WEST_NAME,
  THREE_STOP_MIDDLE_NAME,
  THREE_STOP_EAST_NAME,
  THREE_STOP_SHORT_NAME,
  THREE_STOP_LONG_NAME,
  THREE_STOP_ROUTE_ID,
] = [0, 1, 2, 3, 4, 5, 6];

// Three pavement nodes, then each station's entry and exit, then each platform's boarding and
// arrival node. The stations stand where the main fixture's do, so a door costs what one costs there.
export const THREE_STOP_PAVEMENT = [0, 1, 2];
const threeStopEntry = (stop: number): number => 3 + stop * 2;
const threeStopExit = (stop: number): number => 4 + stop * 2;
const threeStopBoarding = (stop: number): number => 9 + stop * 2;
const threeStopArrival = (stop: number): number => 10 + stop * 2;

const THREE_STOP_NODES: readonly [number, number][] = [
  ...[0, 1, 2].map((stop): [number, number] => [stop * THREE_STOP_SPACING, 0]),
  ...[0, 1, 2].flatMap((stop): [number, number][] => [
    [stop * THREE_STOP_SPACING, STATION_Y],
    [stop * THREE_STOP_SPACING, STATION_Y],
  ]),
  ...[0, 1, 2].flatMap((stop): [number, number][] => [
    [stop * THREE_STOP_SPACING, STATION_Y],
    [stop * THREE_STOP_SPACING, STATION_Y],
  ]),
];

export const THREE_STOP_WEST_SIDEWALK = 0;
export const THREE_STOP_EAST_SIDEWALK = 1;
// The board edge at each stop, which is what says a leg boarded once and rode two stops.
export const THREE_STOP_BOARDS = [11, 14, 17];

const THREE_STOP_EDGES: readonly EdgeSpec[] = [
  {
    a: 0,
    b: 1,
    kind: KIND_SIDEWALK,
    seconds: 0,
    name: THREE_STOP_STREET,
  },
  {
    a: 1,
    b: 2,
    kind: KIND_SIDEWALK,
    seconds: 0,
    name: THREE_STOP_STREET,
  },
  // Each station's way in, way out and change of train, in that order.
  ...[0, 1, 2].flatMap((stop): EdgeSpec[] => {
    const name = [
      THREE_STOP_WEST_NAME,
      THREE_STOP_MIDDLE_NAME,
      THREE_STOP_EAST_NAME,
    ][stop];
    return [
      {
        a: threeStopEntry(stop),
        b: stop,
        kind: KIND_ACCESS,
        seconds: ACCESS_SECONDS,
        name,
        flags: ENTRY_ONLY_FLAG,
      },
      {
        a: threeStopExit(stop),
        b: stop,
        kind: KIND_ACCESS,
        seconds: ACCESS_SECONDS,
        name,
        flags: EXIT_ONLY_FLAG,
      },
      splitTransfer(threeStopEntry(stop), threeStopExit(stop), name),
    ];
  }),
  // And each platform's board, alight and stay-aboard.
  ...[0, 1, 2].flatMap((stop): EdgeSpec[] => [
    {
      a: threeStopEntry(stop),
      b: threeStopBoarding(stop),
      kind: KIND_BOARD,
      seconds: 0,
      name: THREE_STOP_SHORT_NAME,
    },
    {
      a: threeStopArrival(stop),
      b: threeStopExit(stop),
      kind: KIND_ACCESS,
      seconds: ALIGHT_SECONDS,
      name: NAME_NONE,
    },
    stayAboard(threeStopArrival(stop), threeStopBoarding(stop)),
  ]),
  ...[0, 1].map(
    (stop): EdgeSpec => ({
      a: threeStopBoarding(stop),
      b: threeStopArrival(stop + 1),
      kind: KIND_RIDE,
      seconds: RIDE_SECONDS,
      name: THREE_STOP_SHORT_NAME,
    }),
  ),
];

export function threeStopGraph(): RoutingGraph {
  const lat = (node: number): number =>
    ORIGIN_LAT + THREE_STOP_NODES[node][1] * SCALE;
  const lng = (node: number): number =>
    ORIGIN_LNG + THREE_STOP_NODES[node][0] * SCALE;
  const graph = decodeGraph(
    encodeGraph({
      originLng: ORIGIN_LNG,
      originLat: ORIGIN_LAT,
      scale: SCALE,
      nodes: THREE_STOP_NODES.map(([qx, qy]) => ({ qx, qy })),
      edges: THREE_STOP_EDGES.map((spec) => ({
        a: spec.a,
        b: spec.b,
        kind: spec.kind,
        flags: spec.flags,
        length: haversineMeters(
          lat(spec.a),
          lng(spec.a),
          lat(spec.b),
          lng(spec.b),
        ),
        nameId: spec.name,
        durationSeconds: spec.seconds,
      })),
      names: THREE_STOP_NAMES,
      transitRoutes: [
        {
          color: [0x00, 0x93, 0x3c],
          textColor: [0xff, 0xff, 0xff],
          shortName: THREE_STOP_SHORT_NAME,
          longName: THREE_STOP_LONG_NAME,
          id: THREE_STOP_ROUTE_ID,
        },
      ],
      board: THREE_STOP_BOARDS.map((edge, stop) => ({
        edge,
        lane: THREE_STOP_LANE,
        route: 0,
        stop,
      })),
      ride: [
        { edge: 20, route: 0 },
        { edge: 21, route: 0 },
      ],
      doors: THREE_STOP_EDGES.flatMap((spec, edge) =>
        spec.kind === KIND_ACCESS && spec.b <= 2
          ? [{ edge, street: THREE_STOP_STREET, side: 0 }]
          : [],
      ),
    }),
    { hash: "0", keyHash: "0" },
  );
  graph.transit = threeStopTimetable(departureAt(FIRST_DEPARTURE));
  return graph;
}

// The three-stop line's timetable: the same short headway the split station runs, so the worst wait
// cannot make the ride dearer than the walk.
export function threeStopTimetable(date: Date): TransitTimetable {
  const record: ScheduleRecord = {
    firstDay: 20200101,
    lastDay: 0,
    services: [{ mask: 0x7f, startDay: 20200101, endDay: 20301231 }],
    exceptions: [],
    patterns: [
      {
        laneId: THREE_STOP_LANE,
        offsets: [0, RIDE_SECONDS, 2 * RIDE_SECONDS],
      },
    ],
    lanes: [
      {
        pattern: 0,
        service: 0,
        bands: [
          {
            start: FIRST_DEPARTURE,
            end: LAST_DEPARTURE,
            headway: SPLIT_HEADWAY,
          },
        ],
      },
    ],
  };
  return resolveTimetable(record, date, FIXTURE_TIME_ZONE);
}

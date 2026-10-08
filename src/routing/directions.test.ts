import { beforeEach, expect, test } from "bun:test";
import { cardLine, ferrySummaries, rideSummaries } from "../lenses/cards";
import { BOARDING_SECONDS } from "./cost";
import {
  buildDirections,
  durationMinutes,
  formatDuration,
  type Maneuver,
} from "./directions";
import type { FerryTimetable } from "./ferry-schedule";
import {
  clearEdgePathCache,
  type EdgeKind,
  NO_GEOMETRY,
  type RoutingGraph,
  type SideLabel,
} from "./graph";
import type { PassedPoi } from "./pois";
import {
  type FerryLeg,
  ferryLegs,
  findRoute,
  type RouteResult,
  type RouteStep,
} from "./search";
import {
  ACCESS_SECONDS,
  COMPLEX_NORTH_DOOR_NODE,
  COMPLEX_NORTH_SIDEWALK,
  COMPLEX_SOUTH_DOOR_NODE,
  COMPLEX_SOUTH_SIDEWALK,
  complexGraph,
  departureReaching,
  EAST_SIDEWALK,
  fixtureTimetable,
  HEADWAY,
  snapAtNode,
  transitGraph,
  transitWeights,
  WEST_SIDEWALK,
} from "./transit-graph.fixture";

const SCALE = 1e-6;

// The path cache is keyed by edge id only, and other test files' graphs reuse the same ids.
beforeEach(clearEdgePathCache);

// Straight edges between node coordinates are all buildDirections needs for bearings.
function makeGraph(nodes: ReadonlyArray<[number, number]>): RoutingGraph {
  const count = nodes.length;
  const nodeQx = new Int32Array(count);
  const nodeQy = new Int32Array(count);
  for (let index = 0; index < count; index++) {
    const [lat, lng] = nodes[index];
    nodeQx[index] = Math.round(lng / SCALE);
    nodeQy[index] = Math.round(lat / SCALE);
  }
  return {
    originLng: 0,
    originLat: 0,
    scale: SCALE,
    nodeQx,
    nodeQy,
    edgeGeomOffset: new Uint32Array(0),
    edgeGeomCount: new Uint16Array(0),
    edgeNodeA: new Uint32Array(0),
    edgeNodeB: new Uint32Array(0),
    geometry: new Uint8Array(0),
  } as unknown as RoutingGraph;
}

interface EdgeSpec {
  a: number;
  b: number;
  kind: EdgeKind;
  side: SideLabel;
  name: string | null; // the edge name; for a ferry this is its route display name
  lengthMeters: number;
  durationSeconds?: number; // a ferry leg's crossing seconds
  aStop?: string; // a ferry edge's terminal name at node a
  bStop?: string; // a ferry edge's terminal name at node b
}

function makeResult(
  graph: RoutingGraph,
  specs: ReadonlyArray<EdgeSpec>,
  timetable: FerryTimetable | null = null,
) {
  const edgeCount = specs.length;
  const edgeNodeA = new Uint32Array(edgeCount);
  const edgeNodeB = new Uint32Array(edgeCount);
  const edgeGeomOffset = new Uint32Array(edgeCount).fill(NO_GEOMETRY);
  const edgeGeomCount = new Uint16Array(edgeCount);
  const edgeDurationSeconds = new Uint16Array(edgeCount);
  // ferryLegs runs the ETA clock to pick sailings, so it needs what rawSeconds reads.
  const edgeLength = new Float32Array(edgeCount);
  const edgeKindSide = new Uint8Array(edgeCount);
  const kindByte: Record<EdgeKind, number> = {
    sidewalk: 0,
    crossing: 1,
    link: 2,
    path: 3,
    ferry: 4,
    access: 5,
    board: 6,
    ride: 7,
  };
  const NAME_NONE = 0xffff;
  const edgeNameId = new Uint16Array(edgeCount).fill(NAME_NONE);
  const names: string[] = [];
  const nameId = new Map<string, number>();
  const ferryEndpointNames = new Map<number, { a: string; b: string }>();
  const internName = (name: string): number => {
    const existing = nameId.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const id = names.length;
    names.push(name);
    nameId.set(name, id);
    return id;
  };
  const steps: RouteStep[] = [];
  for (let edge = 0; edge < edgeCount; edge++) {
    const spec = specs[edge];
    edgeNodeA[edge] = spec.a;
    edgeNodeB[edge] = spec.b;
    edgeDurationSeconds[edge] = spec.durationSeconds ?? 0;
    edgeLength[edge] = spec.lengthMeters;
    edgeKindSide[edge] = kindByte[spec.kind];
    if (spec.name !== null) {
      edgeNameId[edge] = internName(spec.name);
    }
    if (spec.aStop !== undefined && spec.bStop !== undefined) {
      ferryEndpointNames.set(edge, { a: spec.aStop, b: spec.bStop });
    }
    steps.push({
      edge,
      forward: true,
      kind: spec.kind,
      side: spec.side,
      name: spec.name,
      cover: 0,
      lengthMeters: spec.lengthMeters,
    });
  }
  const wired = graph as unknown as {
    edgeNodeA: Uint32Array;
    edgeNodeB: Uint32Array;
    edgeGeomOffset: Uint32Array;
    edgeGeomCount: Uint16Array;
    edgeDurationSeconds: Uint16Array;
    edgeLength: Float32Array;
    edgeAscent: Uint8Array;
    edgeDescent: Uint8Array;
    edgeKindSide: Uint8Array;
    nodeMidRoadway: Uint8Array;
    edgeNameId: Uint16Array;
    names: string[];
    ferryEndpointNames: Map<number, { a: string; b: string }>;
  };
  wired.edgeNodeA = edgeNodeA;
  wired.edgeNodeB = edgeNodeB;
  wired.edgeGeomOffset = edgeGeomOffset;
  wired.edgeGeomCount = edgeGeomCount;
  wired.edgeDurationSeconds = edgeDurationSeconds;
  wired.edgeLength = edgeLength;
  // flat: these fixtures are about maneuvers, not grades
  wired.edgeAscent = new Uint8Array(edgeCount);
  wired.edgeDescent = new Uint8Array(edgeCount);
  wired.edgeKindSide = edgeKindSide;
  // No islands in these fixtures: every crossing starts from pavement.
  wired.nodeMidRoadway = new Uint8Array(
    specs.reduce((most, spec) => Math.max(most, spec.a, spec.b), 0) + 1,
  );
  wired.edgeNameId = edgeNameId;
  wired.names = names;
  wired.ferryEndpointNames = ferryEndpointNames;
  graph.ferries = timetable;
  // The legs the search itself would record, which is where the boats' rows are read from.
  const ferries = ferryLegs(graph, steps, []);
  return { steps, rides: [], ferries } as unknown as RouteResult;
}

test("start, cross with suppressed continuation, left turn, arrive", () => {
  // North up 5th Ave (west side), cross E 20 St, continue north (suppressed), left onto E 21 St.
  const graph = makeGraph([
    [40.74, -73.99], // 0
    [40.741, -73.99], // 1
    [40.7412, -73.99], // 2
    [40.742, -73.99], // 3
    [40.742, -73.991], // 4 (due west of 3)
  ]);
  const result = makeResult(graph, [
    {
      a: 0,
      b: 1,
      kind: "sidewalk",
      side: "west",
      name: "5 AVE",
      lengthMeters: 111,
    },
    {
      a: 1,
      b: 2,
      kind: "crossing",
      side: null,
      name: "E 20 ST",
      lengthMeters: 18,
    },
    {
      a: 2,
      b: 3,
      kind: "sidewalk",
      side: "west",
      name: "5 AVE",
      lengthMeters: 20,
    },
    {
      a: 3,
      b: 4,
      kind: "sidewalk",
      side: "north",
      name: "E 21 ST",
      lengthMeters: 90,
    },
  ]);
  const maneuvers = buildDirections(graph, result);

  expect(maneuvers.map((m) => m.kind)).toEqual([
    "start",
    "cross",
    "turn",
    "arrive",
  ]);
  expect(maneuvers[0].text).toBe("Walk north on the west side of 5th Avenue");
  expect(maneuvers[1].text).toBe("Cross East 20th Street");
  // The suppressed continuation folds its length into the crossing.
  expect(maneuvers[1].lengthMeters).toBe(38);
  expect(maneuvers[1].stepRange).toEqual([1, 3]);
  expect(maneuvers[2].turn).toBe("left");
  expect(maneuvers[2].text).toBe(
    "Turn left onto the north side of East 21st Street",
  );
  expect(maneuvers[3].text).toBe(
    "Arrive — on the north side of East 21st Street",
  );
});

test("link steps are silent and paths follow", () => {
  const graph = makeGraph([
    [40.57, -73.98], // 0
    [40.571, -73.98], // 1
    [40.5711, -73.9801], // 2 (link hop)
    [40.5711, -73.981], // 3 (boardwalk, heading west)
  ]);
  const result = makeResult(graph, [
    {
      a: 0,
      b: 1,
      kind: "sidewalk",
      side: "east",
      name: "STILLWELL AVE",
      lengthMeters: 120,
    },
    { a: 1, b: 2, kind: "link", side: null, name: null, lengthMeters: 8 },
    {
      a: 2,
      b: 3,
      kind: "path",
      side: null,
      name: "BOARDWALK",
      lengthMeters: 200,
    },
  ]);
  const maneuvers = buildDirections(graph, result);

  expect(maneuvers.map((m) => m.kind)).toEqual(["start", "path", "arrive"]);
  expect(maneuvers[0].text).toBe(
    "Walk north on the east side of Stillwell Avenue",
  );
  // The link's 8 m fold into the run it touches (120 + 8).
  expect(maneuvers[1].text).toBe("Follow Boardwalk");
  expect(maneuvers[1].lengthMeters).toBe(200);
});

test("consecutive same-name crossings merge into one", () => {
  const graph = makeGraph([
    [40.68, -73.977], // 0
    [40.681, -73.977], // 1
    [40.6812, -73.977], // 2
    [40.6814, -73.977], // 3
  ]);
  const result = makeResult(graph, [
    {
      a: 0,
      b: 1,
      kind: "sidewalk",
      side: "west",
      name: "4 AVE",
      lengthMeters: 100,
    },
    {
      a: 1,
      b: 2,
      kind: "crossing",
      side: null,
      name: "ATLANTIC AVE",
      lengthMeters: 15,
    },
    {
      a: 2,
      b: 3,
      kind: "crossing",
      side: null,
      name: "ATLANTIC AVE",
      lengthMeters: 15,
    },
  ]);
  const maneuvers = buildDirections(graph, result);

  const crossings = maneuvers.filter((m) => m.kind === "cross");
  expect(crossings).toHaveLength(1);
  expect(crossings[0].text).toBe("Cross Atlantic Avenue");
  expect(crossings[0].lengthMeters).toBe(30);
});

test("linear crossings collapse into one walk maneuver", () => {
  // North up 5th Ave (west side), crossing E 23 St then E 22 St, staying on the same street+side.
  const graph = makeGraph([
    [40.74, -73.99], // 0
    [40.741, -73.99], // 1
    [40.7412, -73.99], // 2
    [40.742, -73.99], // 3
    [40.7422, -73.99], // 4
    [40.743, -73.99], // 5
  ]);
  const specs: ReadonlyArray<EdgeSpec> = [
    {
      a: 0,
      b: 1,
      kind: "sidewalk",
      side: "west",
      name: "5 AVE",
      lengthMeters: 100,
    },
    {
      a: 1,
      b: 2,
      kind: "crossing",
      side: null,
      name: "E 23 ST",
      lengthMeters: 18,
    },
    {
      a: 2,
      b: 3,
      kind: "sidewalk",
      side: "west",
      name: "5 AVE",
      lengthMeters: 20,
    },
    {
      a: 3,
      b: 4,
      kind: "crossing",
      side: null,
      name: "E 22 ST",
      lengthMeters: 18,
    },
    {
      a: 4,
      b: 5,
      kind: "sidewalk",
      side: "west",
      name: "5 AVE",
      lengthMeters: 30,
    },
  ];

  const expanded = buildDirections(graph, makeResult(graph, specs), {
    collapseLinearCrossings: false,
  });
  expect(expanded.map((m) => m.kind)).toEqual([
    "start",
    "cross",
    "cross",
    "arrive",
  ]);
  expect(expanded.filter((m) => m.kind === "cross")).toHaveLength(2);

  const collapsed = buildDirections(graph, makeResult(graph, specs), {
    collapseLinearCrossings: true,
  });
  expect(collapsed.map((m) => m.kind)).toEqual(["start", "arrive"]);
  expect(collapsed[0].text).toBe("Walk north on the west side of 5th Avenue");
  expect(collapsed[0].lengthMeters).toBe(186);
  expect(collapsed[0].stepRange).toEqual([0, 5]);
});

test("a ferry leg becomes its own maneuver reporting the crossing time", () => {
  const graph = makeGraph([
    [40.7, -74.01], // 0
    [40.7, -74.0], // 1
    [40.72, -73.99], // 2 (across the water)
    [40.72, -73.98], // 3
  ]);
  const result = makeResult(graph, [
    {
      a: 0,
      b: 1,
      kind: "sidewalk",
      side: null,
      name: "SOUTH ST",
      lengthMeters: 120,
    },
    {
      a: 1,
      b: 2,
      kind: "ferry",
      side: null,
      name: "Staten Island Ferry", // the route display name edgeName() returns
      lengthMeters: 2600,
      durationSeconds: 1500, // 25 min
      aStop: "Whitehall Ferry Terminal",
      bStop: "St. George Ferry Terminal",
    },
    {
      a: 2,
      b: 3,
      kind: "sidewalk",
      side: null,
      name: "PIER ST",
      lengthMeters: 90,
    },
  ]);
  const maneuvers = buildDirections(graph, result);

  expect(maneuvers.map((m) => m.kind)).toEqual([
    "start",
    "ferry",
    "start",
    "arrive",
  ]);
  const ferry = maneuvers[1];
  // No doubled "ferry", " Ferry Terminal" stripped; the crossing time rides in durationSeconds.
  expect(ferry.text).toBe("Take the Staten Island Ferry to St. George");
  expect(ferry.durationSeconds).toBe(1500);
  // Kept so nav-progress's along-route accounting stays intact.
  expect(ferry.lengthMeters).toBe(2600);
  expect(ferry.stepRange).toEqual([1, 2]);
  expect(maneuvers[2].text.startsWith("Walk")).toBe(true);
});

test("an action crossing survives collapsing", () => {
  // The final crossing changes street+side, so it's an action and must survive collapsing.
  const graph = makeGraph([
    [40.74, -73.99], // 0
    [40.741, -73.99], // 1
    [40.7412, -73.99], // 2
    [40.742, -73.99], // 3
    [40.7422, -73.99], // 4
    [40.743, -73.99], // 5
    [40.7432, -73.99], // 6
    [40.7432, -73.991], // 7 (due west of 6)
  ]);
  const specs: ReadonlyArray<EdgeSpec> = [
    {
      a: 0,
      b: 1,
      kind: "sidewalk",
      side: "west",
      name: "5 AVE",
      lengthMeters: 100,
    },
    {
      a: 1,
      b: 2,
      kind: "crossing",
      side: null,
      name: "E 23 ST",
      lengthMeters: 18,
    },
    {
      a: 2,
      b: 3,
      kind: "sidewalk",
      side: "west",
      name: "5 AVE",
      lengthMeters: 20,
    },
    {
      a: 3,
      b: 4,
      kind: "crossing",
      side: null,
      name: "E 22 ST",
      lengthMeters: 18,
    },
    {
      a: 4,
      b: 5,
      kind: "sidewalk",
      side: "west",
      name: "5 AVE",
      lengthMeters: 30,
    },
    {
      a: 5,
      b: 6,
      kind: "crossing",
      side: null,
      name: "E 21 ST",
      lengthMeters: 18,
    },
    {
      a: 6,
      b: 7,
      kind: "sidewalk",
      side: "north",
      name: "E 21 ST",
      lengthMeters: 90,
    },
  ];

  const collapsed = buildDirections(graph, makeResult(graph, specs), {
    collapseLinearCrossings: true,
  });
  expect(collapsed.map((m) => m.kind)).toEqual([
    "start",
    "cross",
    "turn",
    "arrive",
  ]);
  expect(collapsed.filter((m) => m.kind === "cross")).toHaveLength(1);
  expect(collapsed[1].text).toBe("Cross East 21st Street");
  expect(collapsed[2].turn).toBe("left");
});

test("starts run forward and hold a passed POI inside its host", () => {
  // The first fixture's route: start(111) / cross(38) / turn(90) / arrive.
  const graph = makeGraph([
    [40.74, -73.99], // 0
    [40.741, -73.99], // 1
    [40.7412, -73.99], // 2
    [40.742, -73.99], // 3
    [40.742, -73.991], // 4 (due west of 3)
  ]);
  const result = makeResult(graph, [
    {
      a: 0,
      b: 1,
      kind: "sidewalk",
      side: "west",
      name: "5 AVE",
      lengthMeters: 111,
    },
    {
      a: 1,
      b: 2,
      kind: "crossing",
      side: null,
      name: "E 20 ST",
      lengthMeters: 18,
    },
    {
      a: 2,
      b: 3,
      kind: "sidewalk",
      side: "west",
      name: "5 AVE",
      lengthMeters: 20,
    },
    {
      a: 3,
      b: 4,
      kind: "sidewalk",
      side: "north",
      name: "E 21 ST",
      lengthMeters: 90,
    },
  ]);
  const passed: PassedPoi[] = [
    {
      name: "Flatiron Building",
      kind: "landmark",
      stepIndex: 0,
      alongMeters: 60,
      at: { lat: 40.7405, lng: -73.99 },
    },
    {
      name: "Metronome",
      kind: "art",
      stepIndex: 3,
      alongMeters: 189,
      at: { lat: 40.742, lng: -73.9905 },
    },
    // Anchored past its host's span, which the splice must pull back in.
    {
      name: "Worth Square",
      kind: "landmark",
      stepIndex: 0,
      alongMeters: 300,
      at: { lat: 40.7408, lng: -73.99 },
    },
  ];
  const maneuvers = buildDirections(graph, result, { passed });

  expect(maneuvers.map((m) => m.kind)).toEqual([
    "start",
    "landmark",
    "landmark",
    "cross",
    "turn",
    "art",
    "arrive",
  ]);
  for (let index = 1; index < maneuvers.length; index++) {
    expect(maneuvers[index].startMeters).toBeGreaterThanOrEqual(
      maneuvers[index - 1].startMeters,
    );
  }
  expect(maneuvers.map((m) => m.startMeters)).toEqual([
    0, 60, 111, 111, 149, 189, 239,
  ]);
  let host = maneuvers[0];
  for (const maneuver of maneuvers) {
    if (maneuver.kind === "landmark" || maneuver.kind === "art") {
      expect(maneuver.startMeters).toBeGreaterThanOrEqual(host.startMeters);
      expect(maneuver.startMeters).toBeLessThanOrEqual(
        host.startMeters + host.lengthMeters,
      );
    } else {
      host = maneuver;
    }
  }
});

// A walk to the pier, the boat, and a walk off it, with the timetable answering one fixed sailing.
function ferryTrip(
  waitSeconds: number,
  crossingSeconds: number,
  passed: readonly PassedPoi[] = [],
) {
  const graph = makeGraph([
    [40.7, -74.01],
    [40.7, -74.0],
    [40.72, -73.99],
    [40.72, -73.98],
  ]);
  const walk = { kind: "sidewalk", side: null, lengthMeters: 120 } as const;
  const timetable: FerryTimetable = {
    covers: () => true,
    board: () => ({
      departure: 12 * 3600 + 15 * 60,
      wait: waitSeconds,
      crossing: crossingSeconds,
      route: "Staten Island Ferry",
    }),
    minRideSeconds: () => crossingSeconds,
  };
  const result = makeResult(
    graph,
    [
      { ...walk, a: 0, b: 1, name: "SOUTH ST" },
      {
        a: 1,
        b: 2,
        kind: "ferry",
        side: null,
        name: "Staten Island Ferry",
        lengthMeters: 2600,
        durationSeconds: crossingSeconds,
        aStop: "Whitehall Ferry Terminal",
        bStop: "St. George Ferry Terminal",
      },
      { ...walk, a: 2, b: 3, name: "PIER ST" },
    ],
    timetable,
  );
  const [leg] = result.ferries;
  // The page's timetable is gone or changed by the time the rows are built, and they must not care.
  graph.ferries = null;
  const maneuvers = buildDirections(graph, result, { passed });
  return { maneuvers, result, leg };
}

// Every boat and train row beside the card's own parts, which must be the same figures in the same order.
function expectRowsMatchCard(
  maneuvers: Maneuver[],
  result: RouteResult,
  parts: string,
): void {
  const line = cardLine({
    travelSeconds: 3600,
    walkMeters: 240,
    ferries: ferrySummaries(result.ferries),
    rides: rideSummaries(result.rides),
  });
  expect(line).toBe(`60 min · 0.1 mi walk · ${parts}`);
  const rows = maneuvers
    .filter((maneuver) => ["ferry", "transit"].includes(maneuver.kind))
    .map((maneuver) =>
      maneuver.kind === "ferry"
        ? `${formatDuration(maneuver.durationSeconds ?? 0)} by ferry`
        : `${formatDuration(maneuver.durationSeconds ?? 0)} on the ${maneuver.name}`,
    );
  expect(rows.join(" · ")).toBe(parts);
}

// What the list prints beside a wait or a ride, as a number.
function shownMinutes(maneuver: Maneuver): number {
  return durationMinutes(maneuver.durationSeconds ?? 0);
}

// Shown from two minutes up and then summing with its ride to the leg; hidden, the ride is at most one short.
function expectWaitRule(
  wait: Maneuver | undefined,
  ride: Maneuver,
  waitSeconds: number,
  rideSeconds: number,
): void {
  const charged = durationMinutes(waitSeconds + rideSeconds);
  const added = charged - shownMinutes(ride);
  expect(wait !== undefined).toBe(added >= 2);
  if (wait === undefined) {
    expect(added).toBeGreaterThanOrEqual(0);
    expect(added).toBeLessThanOrEqual(1);
  } else {
    expect(shownMinutes(wait)).toBeGreaterThanOrEqual(2);
    expect(shownMinutes(wait) + shownMinutes(ride)).toBe(charged);
    expect(Math.abs(shownMinutes(wait) * 60 - waitSeconds)).toBeLessThan(60);
  }
}

test("the pier wait is a step of its own, just ahead of the boat it waits for", () => {
  const { maneuvers, leg } = ferryTrip(14 * 60, 25 * 60);
  expect(maneuvers.map((maneuver) => maneuver.kind)).toEqual([
    "start",
    "wait",
    "ferry",
    "start",
    "arrive",
  ]);
  const [, wait, ferry] = maneuvers;
  expect(wait.text).toBe("Wait for the 12:15 PM Staten Island Ferry");
  expect(formatDuration(wait.durationSeconds ?? 0)).toBe("14 min");
  expect(ferry.text).toBe(
    "Take the 12:15 PM Staten Island Ferry to St. George",
  );
  expect(formatDuration(ferry.durationSeconds ?? 0)).toBe("25 min");
  // Standing still: no length, no steps of the route, and the boat's own place along it.
  expect(wait.lengthMeters).toBe(0);
  expect(wait.stepRange).toEqual([1, 1]);
  expect(wait.startMeters).toBe(ferry.startMeters);
  // The card's part is the crossing the step shows, and its total keeps the wait.
  expect(
    cardLine({
      travelSeconds: 45 * 60,
      walkMeters: 240,
      ferries: ferrySummaries([leg]),
      rides: [],
    }),
  ).toBe("45 min · 0.1 mi walk · 25 min by ferry");
});

// Worked by hand, so the rule is pinned by something other than its own formula.
test("the wait row's minutes are the charged minutes less the ride's, from two up", () => {
  const rows = (waitSeconds: number, crossingSeconds: number) =>
    ferryTrip(waitSeconds, crossingSeconds)
      .maneuvers.filter((maneuver) => ["wait", "ferry"].includes(maneuver.kind))
      .map(
        (maneuver) =>
          `${maneuver.kind} ${formatDuration(maneuver.durationSeconds ?? 0)}`,
      );
  // 26:29 charged is 26 against a 25 minute boat: one minute, so no row.
  expect(rows(89, 1500)).toEqual(["ferry 25 min"]);
  // 26:30 charged rounds to 27: two minutes.
  expect(rows(90, 1500)).toEqual(["wait 2 min", "ferry 25 min"]);
  // A 61 second wait on a 25:29 boat is also 26:30 charged, and the boat still reads 25.
  expect(rows(61, 1529)).toEqual(["wait 2 min", "ferry 25 min"]);
  // The same wait on a 25:30 boat: 26:31 is 27 charged, the boat reads 26, one minute, no row.
  expect(rows(61, 1530)).toEqual(["ferry 26 min"]);
  expect(rows(14 * 60, 1500)).toEqual(["wait 14 min", "ferry 25 min"]);
  expect(rows(0, 1500)).toEqual(["ferry 25 min"]);
});

test("a landmark cannot land between a wait and the boat it waits for", () => {
  const poi = (name: string, stepIndex: number, alongMeters: number) => ({
    name,
    kind: "landmark" as const,
    stepIndex,
    alongMeters,
    at: { lat: 40.7, lng: -74.0 },
  });
  const { maneuvers } = ferryTrip(14 * 60, 25 * 60, [
    // On the walk up, but measured past the pier, which is as near the boat as one can be put.
    poi("Battery Maritime Building", 0, 500),
    poi("Statue of Liberty", 1, 1400),
    // On the boat's own step and at its very start, where the wait also stands.
    poi("Whitehall Terminal", 1, 120),
  ]);
  expect(maneuvers.map((maneuver) => maneuver.text)).toEqual([
    "Walk east on South Street",
    "Pass Battery Maritime Building",
    "Wait for the 12:15 PM Staten Island Ferry",
    "Take the 12:15 PM Staten Island Ferry to St. George",
    "Pass Whitehall Terminal",
    "Pass Statue of Liberty",
    "Walk east on Pier Street",
    "Arrive — on Pier Street",
  ]);
  const starts = maneuvers.map((maneuver) => maneuver.startMeters);
  expect(starts).toEqual([...starts].sort((left, right) => left - right));
});

// Two piers apart on the water, then a third, each hop a ferry edge of its own.
function twoHopTrip(secondRoute: string) {
  const graph = makeGraph([
    [40.7, -74.01],
    [40.7, -74.0],
    [40.71, -73.99],
    [40.72, -73.98],
    [40.72, -73.97],
  ]);
  const walk = { kind: "sidewalk", side: null, lengthMeters: 120 } as const;
  const hop = { kind: "ferry", side: null, lengthMeters: 1500 } as const;
  const result = makeResult(graph, [
    { ...walk, a: 0, b: 1, name: "SOUTH ST" },
    {
      ...hop,
      a: 1,
      b: 2,
      name: "East River",
      durationSeconds: 24 * 60,
      aStop: "Wall St/Pier 11",
      bStop: "Dumbo",
    },
    {
      ...hop,
      a: 2,
      b: 3,
      name: secondRoute,
      durationSeconds: 17 * 60,
      aStop: "Dumbo",
      bStop: "North Williamsburg",
    },
    { ...walk, a: 3, b: 4, name: "PIER ST" },
  ]);
  return { maneuvers: buildDirections(graph, result), result, graph };
}

test("with no timetable a boat has no wait row and reads the baked figure, as the card does", () => {
  const { maneuvers, result } = twoHopTrip("East River");
  // One line all the way, so one boat: the two baked figures are one row and one card part.
  expect(result.ferries).toHaveLength(1);
  expect(maneuvers.map((maneuver) => maneuver.kind)).toEqual([
    "start",
    "ferry",
    "start",
    "arrive",
  ]);
  expect(maneuvers[1].text).toBe(
    "Take the East River ferry to North Williamsburg",
  );
  expect(maneuvers[1].stepRange).toEqual([1, 3]);
  expectRowsMatchCard(maneuvers, result, "41 min by ferry");
});

test("with no timetable two lines are two boats in the rows, as they are two parts on the card", () => {
  const { maneuvers, result } = twoHopTrip("Astoria");
  expect(result.ferries).toHaveLength(2);
  expect(
    maneuvers
      .filter((maneuver) => maneuver.kind !== "start")
      .map((maneuver) => maneuver.text),
  ).toEqual([
    "Take the East River ferry to Dumbo",
    "Take the Astoria ferry to North Williamsburg",
    "Arrive — on Pier Street",
  ]);
  expectRowsMatchCard(maneuvers, result, "24 min by ferry · 17 min by ferry");
});

test("the rows are read from the route's own legs, whatever the page's timetable now says", () => {
  const { graph, maneuvers, result } = twoHopTrip("Astoria");
  expect(maneuvers.some((maneuver) => maneuver.kind === "wait")).toBe(false);
  // Legs as a worker with a timetable recorded them, which this page's graph could not answer.
  const planned: FerryLeg[] = [
    { ...result.ferries[0], waitSeconds: 6 * 60, departureSeconds: 9 * 3600 },
    { ...result.ferries[1], crossingSeconds: 19 * 60 },
  ];
  const rows = buildDirections(graph, { ...result, ferries: planned });
  expect(
    rows
      .filter((maneuver) => ["wait", "ferry"].includes(maneuver.kind))
      .map((maneuver) => [
        maneuver.text,
        formatDuration(maneuver.durationSeconds ?? 0),
      ]),
  ).toEqual([
    ["Wait for the 9:00 AM East River ferry", "6 min"],
    ["Take the 9:00 AM East River ferry to Dumbo", "24 min"],
    ["Take the Astoria ferry to North Williamsburg", "19 min"],
  ]);
});

test("a boat caught with under two minutes to wait has no wait step", () => {
  const kinds = (waitSeconds: number, crossingSeconds: number) =>
    ferryTrip(waitSeconds, crossingSeconds).maneuvers.map(
      (maneuver) => maneuver.kind,
    );
  expect(kinds(0, 25 * 60)).toEqual(["start", "ferry", "start", "arrive"]);
  // A minute's wait is stepping aboard, and the row starts at two.
  expect(kinds(60, 25 * 60)).toEqual(["start", "ferry", "start", "arrive"]);
  expect(kinds(89, 25 * 60)).toEqual(["start", "ferry", "start", "arrive"]);
  expect(kinds(90, 25 * 60)).toEqual([
    "start",
    "wait",
    "ferry",
    "start",
    "arrive",
  ]);
});

test("a wait shown sums with its crossing to the minutes charged, and the card says the crossing", () => {
  for (const crossingSeconds of [45, 1490, 1500, 1510, 1530, 1559]) {
    for (let waitSeconds = 0; waitSeconds <= 20 * 60; waitSeconds += 10) {
      const { maneuvers, leg } = ferryTrip(waitSeconds, crossingSeconds);
      const wait = maneuvers.find((maneuver) => maneuver.kind === "wait");
      const ferry = maneuvers.find((maneuver) => maneuver.kind === "ferry");
      if (ferry === undefined) {
        throw new Error("the trip lost its boat");
      }
      expectWaitRule(wait, ferry, waitSeconds, crossingSeconds);
      expect(
        cardLine({
          travelSeconds: 3600,
          walkMeters: 240,
          ferries: ferrySummaries([leg]),
          rides: [],
        }),
      ).toEndWith(`${shownMinutes(ferry)} min by ferry`);
    }
  }
});

// The export plans from the route's steps, which a wait is not one of.
test("a wait step adds nothing to the steps the Google Maps export plans from", () => {
  const { maneuvers, result } = ferryTrip(14 * 60, 25 * 60);
  expect(result.steps.map((step) => step.kind)).toEqual([
    "sidewalk",
    "ferry",
    "sidewalk",
  ]);
  const covered = maneuvers.flatMap((maneuver) =>
    maneuver.kind === "wait" ? [] : [maneuver.stepRange],
  );
  expect(covered).toEqual([
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 3],
  ]);
});

function railSteps(maneuvers: Maneuver[]): Maneuver[] {
  return maneuvers.filter(
    (maneuver) => maneuver.kind === "wait" || maneuver.kind === "transit",
  );
}

test("the platform wait, boarding minute included, is a step ahead of the train from two minutes up", () => {
  // Up to the wait past which this fixture's walk beats the train.
  for (let waitSeconds = 0; waitSeconds <= 280; waitSeconds += 10) {
    const graph = transitGraph();
    graph.transit = fixtureTimetable(
      departureReaching(ACCESS_SECONDS + waitSeconds - HEADWAY),
    );
    const route = findRoute(
      graph,
      snapAtNode(graph, 0, WEST_SIDEWALK),
      snapAtNode(graph, 2, EAST_SIDEWALK),
      transitWeights({ transit: 0 }),
    ) as RouteResult;
    const [leg] = route.rides;
    expect(leg.waitSeconds).toBeCloseTo(waitSeconds + BOARDING_SECONDS, 6);
    const steps = railSteps(buildDirections(graph, route));
    const ride = steps[steps.length - 1];
    const wait = steps.length === 2 ? steps[0] : undefined;
    expect(ride.kind).toBe("transit");
    expect(wait?.kind ?? "wait").toBe("wait");
    expect(wait?.text ?? "Wait for the Q").toBe("Wait for the Q");
    expect(ride.durationSeconds).toBe(leg.rideSeconds);
    expectWaitRule(wait, ride, leg.waitSeconds, leg.rideSeconds);
    expect(
      cardLine({
        travelSeconds: route.travelSeconds,
        walkMeters: route.walkMeters,
        ferries: [],
        rides: rideSummaries(route.rides),
      }),
    ).toEndWith(`${shownMinutes(ride)} min on the Q`);
  }
});

test("a train stepped straight onto has no wait row, its boarding minute left to the total", () => {
  const graph = transitGraph();
  graph.transit = fixtureTimetable(departureReaching(ACCESS_SECONDS));
  const route = findRoute(
    graph,
    snapAtNode(graph, 0, WEST_SIDEWALK),
    snapAtNode(graph, 2, EAST_SIDEWALK),
    transitWeights({ transit: 0 }),
  ) as RouteResult;
  expect(route.rides[0].waitSeconds).toBe(BOARDING_SECONDS);
  expect(
    railSteps(buildDirections(graph, route)).map((maneuver) => [
      maneuver.text,
      formatDuration(maneuver.durationSeconds ?? 0),
    ]),
  ).toEqual([["Take the Q at 8:00 AM toward East Street (1 stop)", "3 min"]]);
});

test("a train waited for reads as its wait and then its ride", () => {
  const graph = transitGraph();
  graph.transit = fixtureTimetable(departureReaching(ACCESS_SECONDS - 400));
  const route = findRoute(
    graph,
    snapAtNode(graph, 0, WEST_SIDEWALK),
    snapAtNode(graph, 2, EAST_SIDEWALK),
    transitWeights({ transit: 0 }),
  ) as RouteResult;
  expect(
    railSteps(buildDirections(graph, route)).map((maneuver) => [
      maneuver.text,
      formatDuration(maneuver.durationSeconds ?? 0),
    ]),
  ).toEqual([
    ["Wait for the Q", "4 min"],
    ["Take the Q at 8:10 AM toward East Street (1 stop)", "3 min"],
  ]);
});

test("a train with no line name is waited for as the train", () => {
  const graph = transitGraph();
  graph.transit = fixtureTimetable(departureReaching(ACCESS_SECONDS - 400));
  for (const route of graph.transitRoutes) {
    route.shortName = "";
  }
  const route = findRoute(
    graph,
    snapAtNode(graph, 0, WEST_SIDEWALK),
    snapAtNode(graph, 2, EAST_SIDEWALK),
    transitWeights({ transit: 0 }),
  ) as RouteResult;
  expect(
    railSteps(buildDirections(graph, route)).map((maneuver) => maneuver.text),
  ).toEqual(["Wait for the train", "Take the train at 8:10 AM (1 stop)"]);
});

// A boat tacked on after the train, over a pavement edge standing in for the water.
test("a train and then a boat each read in their rows what the card says of them", () => {
  const graph = transitGraph();
  graph.transit = fixtureTimetable(departureReaching(ACCESS_SECONDS - 400));
  const route = findRoute(
    graph,
    snapAtNode(graph, 0, WEST_SIDEWALK),
    snapAtNode(graph, 2, EAST_SIDEWALK),
    transitWeights({ transit: 0 }),
  ) as RouteResult;
  graph.ferryEndpointNames.set(EAST_SIDEWALK, {
    a: "East Street Pier",
    b: "Main Street Ferry Terminal",
  });
  const crossing: RouteStep = {
    edge: EAST_SIDEWALK,
    forward: true,
    kind: "ferry",
    side: null,
    name: null,
    cover: 0,
    lengthMeters: graph.edgeLength[EAST_SIDEWALK],
  };
  const result: RouteResult = {
    ...route,
    steps: [...route.steps, crossing],
    ferries: [
      {
        route: "East River",
        waitSeconds: 5 * 60,
        crossingSeconds: 10 * 60,
        ridesBefore: 1,
        hops: 1,
        departureSeconds: 8 * 3600 + 20 * 60,
      },
    ],
  };
  const maneuvers = buildDirections(graph, result);
  expect(
    maneuvers
      .filter((maneuver) =>
        ["wait", "transit", "ferry"].includes(maneuver.kind),
      )
      .map((maneuver) => [
        maneuver.text,
        formatDuration(maneuver.durationSeconds ?? 0),
      ]),
  ).toEqual([
    ["Wait for the Q", "4 min"],
    ["Take the Q at 8:10 AM toward East Street (1 stop)", "3 min"],
    ["Wait for the 8:20 AM East River ferry", "5 min"],
    ["Take the 8:20 AM East River ferry to Main Street", "10 min"],
  ]);
  expectRowsMatchCard(maneuvers, result, "3 min on the Q · 10 min by ferry");
});

test("each of two trains is waited for on its own, and the change between them is counted once", () => {
  const graph = complexGraph();
  const route = findRoute(
    graph,
    snapAtNode(graph, COMPLEX_SOUTH_DOOR_NODE, COMPLEX_SOUTH_SIDEWALK),
    snapAtNode(graph, COMPLEX_NORTH_DOOR_NODE, COMPLEX_NORTH_SIDEWALK),
    transitWeights(),
  ) as RouteResult;
  const maneuvers = buildDirections(graph, route);
  expect(
    maneuvers
      .filter((maneuver) =>
        ["wait", "transit", "station"].includes(maneuver.kind),
      )
      .map((maneuver) => maneuver.text),
  ).toEqual([
    "Enter Chambers St by the stair on the east side of 8th Avenue",
    "Wait for the A",
    "Take the A at 8:04 AM toward 14 St (1 stop)",
    "Change at 14 St for the L at 8 Av (500 ft, ~1½ min)",
    "Take the L at 8:10 AM toward Bedford Av (1 stop)",
    "Get off at Bedford Av",
    "Exit Bedford Av by the stair on the east side of 8th Avenue",
  ]);
  const steps = railSteps(maneuvers);
  const trains = steps.filter((maneuver) => maneuver.kind === "transit");
  // The L leaves under two minutes after the change, so only the A has a wait row.
  expect(steps.map((maneuver) => maneuver.kind)).toEqual([
    "wait",
    "transit",
    "transit",
  ]);
  route.rides.forEach((leg, index) => {
    const ride = trains[index];
    const before = steps[steps.indexOf(ride) - 1];
    const wait = before?.kind === "wait" ? before : undefined;
    // The leg's wait is the board step's alone, so the change's walk is in neither figure.
    expectWaitRule(wait, ride, leg.waitSeconds, leg.rideSeconds);
  });
  const ridden = steps
    .filter((maneuver) => maneuver.kind === "transit")
    .reduce((total, maneuver) => total + shownMinutes(maneuver), 0);
  expect(
    cardLine({
      travelSeconds: route.travelSeconds,
      walkMeters: route.walkMeters,
      ferries: [],
      rides: rideSummaries(route.rides),
    }),
  ).toEndWith(`${ridden} min on the A then L`);
});

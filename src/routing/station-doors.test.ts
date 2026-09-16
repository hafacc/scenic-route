// The doors of a station, which are not interchangeable: at a station with no free crossover the
// stair you take settles which platform you reach, some doors only open outwards, a lift is neither
// a stair nor the same walk, and none of them is a way THROUGH the station. The fixtures are the
// split station and the underpass in ./transit-graph.fixture.ts.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildDirections } from "./directions";
import {
  doorStreet,
  ELEVATOR_FLAG,
  ENTRY_ONLY_FLAG,
  EXIT_ONLY_FLAG,
  isElevatorDoor,
  isEntryOnlyDoor,
  isExitOnlyDoor,
  type RoutingGraph,
  transitForward,
} from "./graph";
import { findRoute, type RouteResult } from "./search";
import type { Snap } from "./snap";
import {
  departureAt,
  FIRST_DEPARTURE,
  SPLIT_DOWNTOWN_BOARD,
  SPLIT_EAST_CORNER,
  SPLIT_EAST_DOOR,
  SPLIT_EAST_DOOR_OUT,
  SPLIT_EAST_SIDEWALK,
  SPLIT_ELEVATOR_DOOR,
  SPLIT_EXIT_DOOR,
  SPLIT_NORTH_SIDEWALK,
  SPLIT_NORTH_STATION,
  SPLIT_SOUTH_SIDEWALK,
  SPLIT_SOUTH_STATION,
  SPLIT_STATION,
  SPLIT_UPTOWN_BOARD,
  SPLIT_WEST_CORNER,
  SPLIT_WEST_SIDEWALK,
  snapAtNode,
  splitStationGraph,
  splitTimetable,
  transitWeights,
  UNDERPASS_CROSSING,
  UNDERPASS_EAST_DOOR,
  UNDERPASS_EAST_DOOR_NODE,
  UNDERPASS_EAST_NORTH_SIDEWALK,
  UNDERPASS_EAST_SIDEWALK,
  UNDERPASS_NORTH_END,
  UNDERPASS_NORTH_STATION,
  UNDERPASS_SOUTH_DOOR,
  UNDERPASS_SOUTH_STATION,
  UNDERPASS_STATION,
  UNDERPASS_TRANSFER,
  UNDERPASS_WEST_CORNER,
  UNDERPASS_WEST_DOOR,
  UNDERPASS_WEST_DOOR_NODE,
  UNDERPASS_WEST_SIDEWALK,
  underpassGraph,
} from "./transit-graph.fixture";

// The split station's graph with its timetable resolved for a walker setting off at the first train.
function scheduled(): RoutingGraph {
  const graph = splitStationGraph();
  graph.transit = splitTimetable(departureAt(FIRST_DEPARTURE));
  return graph;
}

// A destination part way along an edge, so the walk out of the last station is a step of its own —
// which is what makes the exit maneuver name the street it leaves by.
function snapAlong(graph: RoutingGraph, edge: number, fraction: number): Snap {
  const nodeA = graph.edgeNodeA[edge];
  const nodeB = graph.edgeNodeB[edge];
  const point = (node: number): { lat: number; lng: number } => ({
    lat: graph.originLat + graph.nodeQy[node] * graph.scale,
    lng: graph.originLng + graph.nodeQx[node] * graph.scale,
  });
  const from = point(nodeA);
  const to = point(nodeB);
  return {
    edge,
    metersFromA: graph.edgeLength[edge] * fraction,
    point: {
      lat: from.lat + (to.lat - from.lat) * fraction,
      lng: from.lng + (to.lng - from.lng) * fraction,
    },
    distanceMeters: 0,
    component: 0,
  };
}

// The access edges a route walks, in order.
function doorsUsed(route: RouteResult): number[] {
  return route.steps
    .filter((step) => step.kind === "access")
    .map((step) => step.edge);
}

function stationText(graph: RoutingGraph, route: RouteResult): string[] {
  return buildDirections(graph, route)
    .filter((maneuver) => maneuver.kind === "station")
    .map((maneuver) => maneuver.text);
}

test("the three door bits read off an access edge and nothing else", () => {
  const graph = splitStationGraph();
  expect(isExitOnlyDoor(graph, SPLIT_EXIT_DOOR)).toBe(true);
  expect(isExitOnlyDoor(graph, SPLIT_EAST_DOOR)).toBe(false);
  expect(isElevatorDoor(graph, SPLIT_ELEVATOR_DOOR)).toBe(true);
  expect(isElevatorDoor(graph, SPLIT_EAST_DOOR)).toBe(false);
  // A two-way stair is two edges, one flagged each way.
  expect(isEntryOnlyDoor(graph, SPLIT_EAST_DOOR)).toBe(true);
  expect(isExitOnlyDoor(graph, SPLIT_EAST_DOOR_OUT)).toBe(true);
  expect(isEntryOnlyDoor(graph, SPLIT_EXIT_DOOR)).toBe(false);
  // The bits live in the top of the flags byte, where a walking edge keeps other things entirely.
  expect(isExitOnlyDoor(graph, SPLIT_EAST_SIDEWALK)).toBe(false);
  expect(isElevatorDoor(graph, SPLIT_EAST_SIDEWALK)).toBe(false);
  expect(isEntryOnlyDoor(graph, SPLIT_EAST_SIDEWALK)).toBe(false);
});

test("an exit-only door goes out of the station and not into it", () => {
  const graph = splitStationGraph();
  const station = graph.edgeNodeA[SPLIT_EXIT_DOOR];
  const pavement = graph.edgeNodeB[SPLIT_EXIT_DOOR];
  expect(transitForward(graph, SPLIT_EXIT_DOOR, station)).toBe(true);
  expect(transitForward(graph, SPLIT_EXIT_DOOR, pavement)).toBe(false);
  // An entry-only door is the same fixture the other way round, which is what the way IN to every
  // station is: one edge from the pavement to the entry node, walkable that way alone.
  expect(
    transitForward(graph, SPLIT_EAST_DOOR, graph.edgeNodeA[SPLIT_EAST_DOOR]),
  ).toBe(false);
  expect(
    transitForward(graph, SPLIT_EAST_DOOR, graph.edgeNodeB[SPLIT_EAST_DOOR]),
  ).toBe(true);
});

// The bits themselves, against the tiler's own constants: the graph is written by one and read by
// the other, and nothing but this holds the two spellings together.
test("the door bits are the ones the tiler writes", () => {
  const source = readFileSync("crates/tiler/src/graph.rs", "utf8");
  const bitOf = (name: string): number => {
    const match = source.match(new RegExp(`const ${name}: u8 = 1 << (\\d+);`));
    expect(match, name).not.toBeNull();
    return 1 << Number((match as RegExpMatchArray)[1]);
  };
  expect(bitOf("ACCESS_EXIT_ONLY")).toBe(EXIT_ONLY_FLAG);
  expect(bitOf("ACCESS_ENTRY_ONLY")).toBe(ENTRY_ONLY_FLAG);
  expect(bitOf("ACCESS_ELEVATOR")).toBe(ELEVATOR_FLAG);
});

test("a trip boarding direction 0 crosses to a side-0 door", () => {
  const graph = scheduled();
  // The west pavement's lift is the nearest way in and it reaches the downtown platform only, so a
  // rider bound uptown has to pay the crossing — which is what the split says is the truth.
  const route = findRoute(
    graph,
    snapAtNode(graph, SPLIT_WEST_CORNER, SPLIT_WEST_SIDEWALK),
    snapAlong(graph, SPLIT_NORTH_SIDEWALK, 0.9),
    transitWeights(),
  ) as RouteResult;
  expect(route).not.toBeNull();
  expect(route.steps.some((step) => step.edge === SPLIT_UPTOWN_BOARD)).toBe(
    true,
  );
  expect(doorsUsed(route)[0]).toBe(SPLIT_EAST_DOOR);
  expect(route.steps.some((step) => step.kind === "crossing")).toBe(true);
  expect(stationText(graph, route)[0]).toBe(
    `Enter ${SPLIT_STATION} by the stair on the east side of Flatbush Avenue`,
  );
});

test("an exit-only door is never entered, though it is the nearest way in", () => {
  const graph = scheduled();
  const ends = {
    start: snapAtNode(graph, SPLIT_EAST_CORNER, SPLIT_EAST_SIDEWALK),
    dest: snapAlong(graph, SPLIT_NORTH_SIDEWALK, 0.9),
  };
  const route = findRoute(
    graph,
    ends.start,
    ends.dest,
    transitWeights(),
  ) as RouteResult;
  expect(doorsUsed(route)[0]).toBe(SPLIT_EAST_DOOR);
  // Opened inwards — which is the agency's decision and nothing else — that same stair is the one a
  // router picks: it stands nearer the corner the walk starts from, so the bit is the only thing
  // between the route and it.
  const open = scheduled();
  open.edgeFlags[SPLIT_EXIT_DOOR] = ENTRY_ONLY_FLAG;
  const through = findRoute(
    open,
    ends.start,
    ends.dest,
    transitWeights(),
  ) as RouteResult;
  expect(doorsUsed(through)[0]).toBe(SPLIT_EXIT_DOOR);
});

test("a lift is named as one, going in and coming out", () => {
  const graph = scheduled();
  const route = findRoute(
    graph,
    snapAtNode(graph, SPLIT_WEST_CORNER, SPLIT_WEST_SIDEWALK),
    snapAlong(graph, SPLIT_SOUTH_SIDEWALK, 0.9),
    transitWeights(),
  ) as RouteResult;
  expect(route.steps.some((step) => step.edge === SPLIT_DOWNTOWN_BOARD)).toBe(
    true,
  );
  expect(doorsUsed(route)[0]).toBe(SPLIT_ELEVATOR_DOOR);
  expect(stationText(graph, route)).toEqual([
    `Enter ${SPLIT_STATION} by the elevator on the west side of Flatbush Avenue`,
    `Get off at ${SPLIT_SOUTH_STATION}`,
    `Exit ${SPLIT_SOUTH_STATION} by the stair on the west side of Flatbush Avenue`,
  ]);
  const doors = buildDirections(graph, route)
    .filter((maneuver) => maneuver.kind === "station")
    .map((maneuver) => maneuver.door);
  expect(doors).toEqual(["elevator", undefined, "stair"]);
});

test("a door on a street nothing names leaves the station named alone", () => {
  const graph = scheduled();
  // The way out of a station is sometimes a path the graph has no name for, and then the tiler
  // records no street for the door and there is nothing to say beyond which station it is.
  for (const edge of graph.transitDoorStreet.keys()) {
    graph.transitDoorStreet.delete(edge);
  }
  const route = findRoute(
    graph,
    snapAtNode(graph, SPLIT_EAST_CORNER, SPLIT_EAST_SIDEWALK),
    snapAtNode(
      graph,
      graph.edgeNodeB[SPLIT_NORTH_SIDEWALK],
      SPLIT_NORTH_SIDEWALK,
    ),
    transitWeights(),
  ) as RouteResult;
  expect(stationText(graph, route).at(-1)).toBe(`Exit ${SPLIT_NORTH_STATION}`);
});

// The underpass. Two doors of one station, a walk between them that the street charges an hour for,
// and a station node that used to join the two: a router took the stairs and came up across the
// avenue, which is not a walk anyone can make. Nothing about the doors says so — it is the entry and
// the exit being different nodes that does, every door running into the one or out of the other.
//
// Asked with the trains off, which is the case that was plainly wrong: the doors are walkable at any
// setting, so the station stood open as a free passage between its own two sides.
test("a station is a way in and a way out, and not a way through the block", () => {
  const graph = underpassGraph();
  const route = findRoute(
    graph,
    snapAtNode(graph, UNDERPASS_EAST_DOOR_NODE, UNDERPASS_EAST_SIDEWALK),
    snapAtNode(graph, UNDERPASS_WEST_DOOR_NODE, UNDERPASS_WEST_SIDEWALK),
    transitWeights({ allowTransit: false }),
  ) as RouteResult;

  const throughTheDoors =
    graph.edgeDurationSeconds[UNDERPASS_EAST_DOOR] +
    graph.edgeDurationSeconds[UNDERPASS_WEST_DOOR];
  expect(throughTheDoors).toBeLessThan(route.travelSeconds / 4);
  expect(doorsUsed(route)).toEqual([]);
  expect(route.steps.some((step) => step.edge === UNDERPASS_CROSSING)).toBe(
    true,
  );
});

// The same block with the trains ON, which the station pair alone did not close: a rider could enter
// the middle station, board the A line there and step straight off it, and come up on the far
// pavement for the price of a wait — eight minutes against the hour the avenue charges. The
// platform's own pair is what closes that, the board landing on the boarding node and the alight
// leaving the arrival node, so the shortest way across a platform is a ride of at least one stop.
// What the router is left with here is a real one: two kilometres down the east pavement, the A line
// north one stop, and up the middle station's west stair.
test("boarding a train and stepping straight off it is not a way through either", () => {
  const graph = underpassGraph();
  const route = findRoute(
    graph,
    snapAtNode(graph, UNDERPASS_EAST_DOOR_NODE, UNDERPASS_EAST_SIDEWALK),
    snapAtNode(graph, UNDERPASS_WEST_DOOR_NODE, UNDERPASS_WEST_SIDEWALK),
    transitWeights(),
  ) as RouteResult;

  expect(
    route.rides.map((ride) => [
      ride.boardStation,
      ride.alightStation,
      ride.stops,
    ]),
  ).toEqual([[UNDERPASS_SOUTH_STATION, UNDERPASS_STATION, 1]]);
});

// And the other half of that: an alight onto the exit and a board off the entry is still one act,
// because the change of train runs between them.
test("a change of train crosses from the station's exit back to its entry", () => {
  const graph = underpassGraph();
  const route = findRoute(
    graph,
    snapAtNode(graph, UNDERPASS_WEST_CORNER, UNDERPASS_WEST_SIDEWALK),
    snapAtNode(graph, UNDERPASS_NORTH_END, UNDERPASS_EAST_NORTH_SIDEWALK),
    transitWeights(),
  ) as RouteResult;

  expect(doorsUsed(route)).toContain(UNDERPASS_TRANSFER);
  expect(route.rides).toHaveLength(2);
  // The change is one maneuver, not an exit and an entrance: the transfer walk tells a reader
  // nothing the "Change at" does not.
  expect(stationText(graph, route)).toEqual([
    `Enter ${UNDERPASS_SOUTH_STATION} by the stair on the east side of Flatbush Avenue`,
    `Change at ${UNDERPASS_STATION}`,
    `Get off at ${UNDERPASS_NORTH_STATION}`,
    `Exit ${UNDERPASS_NORTH_STATION} by the stair on the east side of Flatbush Avenue`,
  ]);
});

// What the door table buys. This door stands on the corner the crossing lands on, and the route
// reaches it across that crossing: the approach step is the cross street, or nothing at all, and
// naming the door by it said "Enter South St" and left the rider on the wrong pavement.
test("a door on a corner is named by its own street and not the one walked in on", () => {
  const graph = underpassGraph();
  expect(doorStreet(graph, UNDERPASS_SOUTH_DOOR)).toEqual({
    street: "FLATBUSH AVE",
    side: "east",
  });
  const route = findRoute(
    graph,
    snapAtNode(graph, UNDERPASS_WEST_CORNER, UNDERPASS_WEST_SIDEWALK),
    snapAtNode(graph, UNDERPASS_NORTH_END, UNDERPASS_EAST_NORTH_SIDEWALK),
    transitWeights(),
  ) as RouteResult;
  const steps = route.steps;
  const door = steps.findIndex((step) => step.edge === UNDERPASS_SOUTH_DOOR);
  expect(steps[door - 1].edge).toBe(UNDERPASS_CROSSING);
  expect(stationText(graph, route)[0]).toBe(
    `Enter ${UNDERPASS_SOUTH_STATION} by the stair on the east side of Flatbush Avenue`,
  );
});

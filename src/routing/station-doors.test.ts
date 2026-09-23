// Fixtures are the split station and the underpass in ./transit-graph.fixture.ts.

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

function scheduled(): RoutingGraph {
  const graph = splitStationGraph();
  graph.transit = splitTimetable(departureAt(FIRST_DEPARTURE));
  return graph;
}

// Part way along, so the exit is a step of its own and its maneuver names the street.
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
  // A walking edge uses the top of the flags byte for other things.
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
  expect(
    transitForward(graph, SPLIT_EAST_DOOR, graph.edgeNodeA[SPLIT_EAST_DOOR]),
  ).toBe(false);
  expect(
    transitForward(graph, SPLIT_EAST_DOOR, graph.edgeNodeB[SPLIT_EAST_DOOR]),
  ).toBe(true);
});

// Graph written by the tiler and read here; only this ties the two spellings together.
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
  // The nearest way in only reaches downtown, so an uptown rider must pay the crossing.
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
  // The nearer stair opened inwards is the one picked, so the bit alone was keeping the route off it.
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
  // A door onto an unnamed path gets no street, and only the station is named.
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

// Asked with trains off: separate entry and exit nodes stop the station being a free underpass.
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

// With trains on, boarding and alighting at separate nodes forces a ride of at least one stop.
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
  // The transfer walk tells a reader nothing the "Change at" does not.
  expect(stationText(graph, route)).toEqual([
    `Enter ${UNDERPASS_SOUTH_STATION} by the stair on the east side of Flatbush Avenue`,
    `Change at ${UNDERPASS_STATION}`,
    `Get off at ${UNDERPASS_NORTH_STATION}`,
    `Exit ${UNDERPASS_NORTH_STATION} by the stair on the east side of Flatbush Avenue`,
  ]);
});

// Naming the door by the approach crossing said "Enter South St", the wrong pavement.
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

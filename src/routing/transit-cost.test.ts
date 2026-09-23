// The fixture is the smallest network where riding and walking are both real answers.

import { beforeEach, expect, test } from "bun:test";
import {
  BOARDING_SECONDS,
  boardSeconds,
  effSeconds,
  heuristicFloor,
  MAX_TRANSIT_WEIGHT,
  type RouteWeights,
  rawSeconds,
  transitMultiplier,
  WALK_METERS_PER_SECOND,
} from "./cost";
import { buildDirections } from "./directions";
import {
  clearEdgePathCache,
  otherEnd,
  type RoutingGraph,
  stopIndexOf,
} from "./graph";
import { findRoute, networkMetersTo, type RouteResult } from "./search";
import type { Snap } from "./snap";
import {
  ACCESS_SECONDS,
  ALIGHT_SECONDS,
  departureAt,
  departureReaching,
  EAST_ACCESS_SECONDS,
  EAST_SIDEWALK,
  EAST_STATION,
  FIRST_DEPARTURE,
  fixtureTimetable,
  HEADWAY,
  LAST_DEPARTURE,
  PLATFORM_SETBACK_METERS,
  RIDE_EDGE,
  RIDE_SECONDS,
  ROUTE_SHORT_NAME,
  SIDEWALK_COVER,
  snapAtNode,
  THREE_STOP_EAST,
  THREE_STOP_EAST_SIDEWALK,
  THREE_STOP_MIDDLE,
  THREE_STOP_ROUTE_SHORT_NAME,
  THREE_STOP_WEST,
  THREE_STOP_WEST_SIDEWALK,
  threeStopGraph,
  transitGraph,
  transitWeights,
  UNSCHEDULED_LANE,
  WEST_BOARD,
  WEST_SIDEWALK,
  WEST_STATION,
} from "./transit-graph.fixture";

// Down into the west station, boarding, the ride, back up at the east stop and out; no wait.
const RIDE_TRIP_SECONDS =
  ACCESS_SECONDS +
  BOARDING_SECONDS +
  RIDE_SECONDS +
  ALIGHT_SECONDS +
  EAST_ACCESS_SECONDS;

function ends(graph: RoutingGraph): { start: Snap; dest: Snap } {
  return {
    start: snapAtNode(graph, 0, WEST_SIDEWALK),
    dest: snapAtNode(graph, 2, EAST_SIDEWALK),
  };
}

// Resolved so a walker leaving now catches a train with no wait, making the ride's cost nameable.
function scheduled(lanes?: readonly number[]): RoutingGraph {
  const graph = transitGraph(lanes);
  graph.transit = fixtureTimetable(departureReaching(ACCESS_SECONDS));
  return graph;
}

function rides(result: RouteResult | null): boolean {
  return result?.steps.some((step) => step.kind === "ride") ?? false;
}

// Carries the elapsed clock as findRoute does, since a board edge's cost steps with it.
function dijkstraCost(
  graph: RoutingGraph,
  start: Snap,
  dest: Snap,
  weights: RouteWeights,
): number {
  const distance = new Float64Array(graph.nodeCount).fill(
    Number.POSITIVE_INFINITY,
  );
  const elapsed = new Float64Array(graph.nodeCount);
  const settled = new Uint8Array(graph.nodeCount);

  const startA = graph.edgeNodeA[start.edge];
  const startB = graph.edgeNodeB[start.edge];
  const startLength = graph.edgeLength[start.edge];
  const perMeter =
    (1 - weights.tree * (graph.edgeCover[start.edge] / 255)) /
    WALK_METERS_PER_SECOND;
  distance[startA] = start.metersFromA * perMeter;
  distance[startB] = (startLength - start.metersFromA) * perMeter;
  elapsed[startA] = start.metersFromA / WALK_METERS_PER_SECOND;
  elapsed[startB] = (startLength - start.metersFromA) / WALK_METERS_PER_SECOND;

  for (;;) {
    let node = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate < graph.nodeCount; candidate++) {
      if (!settled[candidate] && distance[candidate] < best) {
        best = distance[candidate];
        node = candidate;
      }
    }
    if (node === -1) {
      break;
    }
    settled[node] = 1;
    for (let slot = graph.csr[node]; slot < graph.csr[node + 1]; slot++) {
      const edge = graph.adjacency[slot];
      const relaxed =
        distance[node] + effSeconds(graph, edge, weights, elapsed[node], node);
      const neighbor = otherEnd(graph, edge, node);
      if (relaxed < distance[neighbor]) {
        distance[neighbor] = relaxed;
        elapsed[neighbor] =
          elapsed[node] + rawSeconds(graph, edge, node, elapsed[node]);
      }
    }
  }

  const destA = graph.edgeNodeA[dest.edge];
  const destB = graph.edgeNodeB[dest.edge];
  const destLength = graph.edgeLength[dest.edge];
  const destPerMeter =
    (1 - weights.tree * (graph.edgeCover[dest.edge] / 255)) /
    WALK_METERS_PER_SECOND;
  return Math.min(
    distance[destA] + dest.metersFromA * destPerMeter,
    distance[destB] + (destLength - dest.metersFromA) * destPerMeter,
  );
}

function costOf(
  graph: RoutingGraph,
  result: RouteResult,
  weights: RouteWeights,
): number {
  let cost = 0;
  let elapsed = 0;
  for (const step of result.steps) {
    const from = step.forward
      ? graph.edgeNodeA[step.edge]
      : graph.edgeNodeB[step.edge];
    if (step.kind === "sidewalk") {
      cost +=
        (step.lengthMeters / WALK_METERS_PER_SECOND) *
        (1 - weights.tree * (graph.edgeCover[step.edge] / 255));
      elapsed += step.lengthMeters / WALK_METERS_PER_SECOND;
    } else {
      cost += effSeconds(graph, step.edge, weights, elapsed, from);
      elapsed += rawSeconds(graph, step.edge, from, elapsed);
    }
  }
  return cost;
}

// The fixtures here and elsewhere reuse edge ids, and the polyline cache is keyed on them alone.
beforeEach(clearEdgePathCache);

test("the line is a way through at no penalty and a detour at the top of the slider", () => {
  const graph = scheduled();
  const { start, dest } = ends(graph);
  const ridden = findRoute(graph, start, dest, transitWeights({ transit: 0 }));
  expect(rides(ridden)).toBe(true);
  expect(ridden?.travelSeconds).toBeCloseTo(RIDE_TRIP_SECONDS, 6);
  const walked = findRoute(
    graph,
    start,
    dest,
    transitWeights({ transit: MAX_TRANSIT_WEIGHT }),
  );
  expect(rides(walked)).toBe(false);
  expect(walked?.steps.every((step) => step.kind === "sidewalk")).toBe(true);
});

test("the wait is the one the band gives, and it is in the reported time", () => {
  const graph = scheduled();
  // The band's own headway less the lateness; past about five minutes the walk wins instead.
  const late = 400;
  expect(boardSeconds(graph, WEST_BOARD, ACCESS_SECONDS + late)).toBeCloseTo(
    HEADWAY - late + BOARDING_SECONDS,
    6,
  );
  expect(stopIndexOf(graph, WEST_BOARD)).toBe(0);

  const waiting = transitGraph();
  waiting.transit = fixtureTimetable(departureReaching(ACCESS_SECONDS - late));
  const { start, dest } = ends(waiting);
  const route = findRoute(waiting, start, dest, transitWeights({ transit: 0 }));
  expect(rides(route)).toBe(true);
  expect(route?.travelSeconds).toBeCloseTo(
    RIDE_TRIP_SECONDS + (HEADWAY - late),
    6,
  );
  // The wait counts as rail time, since the line costs you it.
  expect(route?.transitSeconds).toBeCloseTo(
    HEADWAY - late + BOARDING_SECONDS + RIDE_SECONDS,
    6,
  );
});

test("past the last train the line is not a way anywhere", () => {
  const graph = transitGraph();
  // Tomorrow's first train is not an answer to "how do I get there now".
  graph.transit = fixtureTimetable(departureAt(LAST_DEPARTURE + 3600));
  expect(boardSeconds(graph, WEST_BOARD, 0)).toBe(Number.POSITIVE_INFINITY);
  const { start, dest } = ends(graph);
  const route = findRoute(graph, start, dest, transitWeights({ transit: 0 }));
  expect(rides(route)).toBe(false);
});

test("a lane the timetable does not name is not a train either", () => {
  // No baked fallback: a board edge bakes no departure.
  const graph = scheduled([UNSCHEDULED_LANE, UNSCHEDULED_LANE]);
  expect(boardSeconds(graph, WEST_BOARD, 0)).toBe(Number.POSITIVE_INFINITY);
  const { start, dest } = ends(graph);
  expect(rides(findRoute(graph, start, dest, transitWeights()))).toBe(false);

  const unloaded = transitGraph(); // and the same with no timetable at all
  expect(boardSeconds(unloaded, WEST_BOARD, 0)).toBe(Number.POSITIVE_INFINITY);
});

test("the gate bars the board edge, not the pavement", () => {
  const graph = scheduled();
  const { start, dest } = ends(graph);
  const route = findRoute(
    graph,
    start,
    dest,
    transitWeights({ transit: 0, allowTransit: false }),
  );
  expect(rides(route)).toBe(false);
  expect(route?.walkMeters).toBeCloseTo(graph.edgeLength[WEST_SIDEWALK] * 2, 3);
  expect(
    effSeconds(
      graph,
      WEST_BOARD,
      transitWeights({ allowTransit: false }),
      0,
      graph.edgeNodeA[WEST_BOARD],
    ),
  ).toBe(Number.POSITIVE_INFINITY);
});

test("a train may not be ridden backwards, nor a platform entered by alighting", () => {
  const graph = scheduled();
  const weights = transitWeights();
  const forwards = graph.edgeNodeA[RIDE_EDGE];
  const backwards = graph.edgeNodeB[RIDE_EDGE];
  expect(effSeconds(graph, RIDE_EDGE, weights, 0, forwards)).toBeCloseTo(
    RIDE_SECONDS,
    6,
  );
  expect(effSeconds(graph, RIDE_EDGE, weights, 0, backwards)).toBe(
    Number.POSITIVE_INFINITY,
  );
  // Walked backwards, the alight would board a train with no wait at all.
  const alight = 5;
  expect(effSeconds(graph, alight, weights, 0, graph.edgeNodeB[alight])).toBe(
    Number.POSITIVE_INFINITY,
  );
});

test("shelter discounts the wait and the ride, and shade never touches either", () => {
  const graph = scheduled();
  const dry = transitWeights({ transit: 0, shelter: 1 });
  const plain = transitWeights({ transit: 0 });
  const station = graph.edgeNodeA[WEST_BOARD];
  // Sheltered at attr 1, so both fall to the discount's floor rather than to zero.
  expect(
    effSeconds(graph, RIDE_EDGE, dry, 0, graph.edgeNodeA[RIDE_EDGE]),
  ).toBeLessThan(
    effSeconds(graph, RIDE_EDGE, plain, 0, graph.edgeNodeA[RIDE_EDGE]) / 100,
  );
  expect(
    effSeconds(graph, RIDE_EDGE, dry, 0, graph.edgeNodeA[RIDE_EDGE]),
  ).toBeGreaterThan(0);
  expect(
    effSeconds(graph, WEST_BOARD, dry, ACCESS_SECONDS, station),
  ).toBeLessThan(effSeconds(graph, WEST_BOARD, plain, ACCESS_SECONDS, station));

  // Full shade preference makes a shaded meter a tenth of its price; the ride is priced by neither.
  const before = effSeconds(
    graph,
    RIDE_EDGE,
    plain,
    0,
    graph.edgeNodeA[RIDE_EDGE],
  );
  graph.shade = {
    attrAt: () => -0.9,
    intensityAt: () => 0.9,
    maxAbs: 0.9,
  };
  const shady = transitWeights({ transit: 0, shade: -1 });
  expect(
    effSeconds(graph, RIDE_EDGE, shady, 0, graph.edgeNodeA[RIDE_EDGE]),
  ).toBeCloseTo(before, 6);
  expect(
    effSeconds(graph, WEST_SIDEWALK, shady, 0, graph.edgeNodeA[WEST_SIDEWALK]),
  ).toBeLessThan(
    effSeconds(graph, WEST_SIDEWALK, plain, 0, graph.edgeNodeA[WEST_SIDEWALK]) /
      5,
  );
});

test("the ride is in the trip's length and out of its miles and its shares", () => {
  // Resolved against the longer approach, so the train is still caught without a wait.
  const walkBack = 200;
  const graph = transitGraph();
  graph.transit = fixtureTimetable(
    departureReaching(walkBack / WALK_METERS_PER_SECOND + ACCESS_SECONDS),
  );
  const { start, dest } = ends(graph);
  const route = findRoute(
    graph,
    { ...start, metersFromA: walkBack },
    dest,
    transitWeights({ transit: 0 }),
  );
  expect(rides(route)).toBe(true);
  expect(route?.walkMeters).toBeCloseTo(walkBack, 3);
  // The ride's span is in the drawn distance but not the summary's miles.
  expect(route?.lengthMeters).toBeGreaterThan(graph.edgeLength[RIDE_EDGE]);
  // A chip is a share of the whole trip's time, and the ride is time under no canopy.
  const walkSeconds = walkBack / WALK_METERS_PER_SECOND;
  expect(route?.factors.tree).toBeCloseTo(
    (SIDEWALK_COVER * walkSeconds) / (route?.travelSeconds ?? 1),
    2,
  );
  expect(route?.factors.tree).toBeLessThan(SIDEWALK_COVER / 2);
  const walked = findRoute(
    graph,
    { ...start, metersFromA: walkBack },
    dest,
    transitWeights({ transit: 0, allowTransit: false }),
  );
  expect(rides(walked)).toBe(false);
  expect(walked?.factors.tree).toBeCloseTo(SIDEWALK_COVER, 2);
});

test("A* with the transit credit matches the Dijkstra oracle", () => {
  const graph = scheduled();
  const { start, dest } = ends(graph);
  for (const transit of [0, 0.5, 1, 2, MAX_TRANSIT_WEIGHT]) {
    for (const shelter of [0, 1]) {
      for (const allowTransit of [true, false]) {
        const weights = transitWeights({ transit, shelter, allowTransit });
        const route = findRoute(graph, start, dest, weights);
        expect(route, `${transit}/${shelter}/${allowTransit}`).not.toBeNull();
        expect(
          costOf(graph, route as RouteResult, weights),
          `${transit}/${shelter}/${allowTransit}`,
        ).toBeCloseTo(dijkstraCost(graph, start, dest, weights), 6);
      }
    }
  }
});

// Rides and crossings count at their own lengths; a tighter lower bound is still a lower bound.
test("the network estimate leaves the A* optimum where it was", () => {
  const graph = scheduled();
  const { start, dest } = ends(graph);
  const reuse = { networkMeters: networkMetersTo(graph, dest) };
  for (const transit of [0, 0.5, 1, 2, MAX_TRANSIT_WEIGHT]) {
    for (const shelter of [0, 1]) {
      for (const allowTransit of [true, false]) {
        const weights = transitWeights({ transit, shelter, allowTransit });
        const label = `${transit}/${shelter}/${allowTransit}`;
        const route = findRoute(graph, start, dest, weights, reuse);
        expect(route, label).not.toBeNull();
        expect(costOf(graph, route as RouteResult, weights), label).toBeCloseTo(
          dijkstraCost(graph, start, dest, weights),
          6,
        );
      }
    }
  }
});

test("the maneuvers name the line, where it is bound and both stations", () => {
  const graph = scheduled();
  const { start, dest } = ends(graph);
  const route = findRoute(graph, start, dest, transitWeights({ transit: 0 }));
  const maneuvers = buildDirections(graph, route as RouteResult);
  const transit = maneuvers.filter(
    (maneuver) => maneuver.kind === "transit" || maneuver.kind === "station",
  );
  expect(transit.map((maneuver) => maneuver.text)).toEqual([
    `Enter ${WEST_STATION} by the stair on Main Street`,
    `Take the ${ROUTE_SHORT_NAME} at 8:00 AM toward ${EAST_STATION} (1 stop)`,
    `Get off at ${EAST_STATION}`,
    // A curbside stop is left rather than exited.
    `Leave the ${EAST_STATION} stop`,
  ]);
  const ride = transit[1];
  expect(ride.durationSeconds).toBe(RIDE_SECONDS);
  expect(ride.stops).toBe(1);
  // So nav-progress advances along the ride as it does a ferry.
  expect(ride.lengthMeters).toBeCloseTo(graph.edgeLength[RIDE_EDGE], 3);
});

test("the leg says which train was caught, and for how long", () => {
  const graph = scheduled();
  const { start, dest } = ends(graph);
  const route = findRoute(graph, start, dest, transitWeights({ transit: 0 }));
  expect(route?.rides).toHaveLength(1);
  const [leg] = route?.rides ?? [];
  expect(leg.route?.shortName).toBe(ROUTE_SHORT_NAME);
  expect(leg.boardStation).toBe(WEST_STATION);
  expect(leg.alightStation).toBe(EAST_STATION);
  expect(leg.stops).toBe(1);
  expect(leg.waitSeconds).toBe(BOARDING_SECONDS); // caught with nothing to wait through
  expect(leg.rideSeconds).toBe(RIDE_SECONDS);
  // A clock time on the routed day, which is what a card prints.
  expect(leg.departureSeconds).toBe(FIRST_DEPARTURE);
  expect(route?.transitSeconds).toBeCloseTo(
    leg.waitSeconds + leg.rideSeconds,
    6,
  );
});

test("shelter is a mean over the trip's seconds, and a ride is all of them covered", () => {
  const graph = scheduled();
  const { start, dest } = ends(graph);
  const route = findRoute(graph, start, dest, transitWeights({ transit: 0 }));
  // The station walks are out in the weather; the platform and the train are not.
  const covered = BOARDING_SECONDS + RIDE_SECONDS;
  expect(route?.factors.shelter).toBeCloseTo(
    covered / (route?.travelSeconds ?? 1),
    6,
  );
  const walked = findRoute(
    graph,
    start,
    dest,
    transitWeights({ transit: MAX_TRANSIT_WEIGHT }),
  );
  expect(walked?.factors.shelter).toBe(0);
});

test("the floor stays under a board edge that spans a transfer complex", () => {
  const graph = transitGraph(undefined, { setback: true });
  graph.transit = fixtureTimetable(departureAt(FIRST_DEPARTURE));
  const length = graph.edgeLength[WEST_BOARD];
  expect(length).toBeCloseTo(PLATFORM_SETBACK_METERS, 0);
  for (const shelter of [0, 0.5, 0.6, 0.9]) {
    const weights = transitWeights({ shelter });
    // The wait is at least zero, so the boarding constant alone bounds a board edge.
    const cheapest = (BOARDING_SECONDS * transitMultiplier(weights)) / length;
    expect(
      heuristicFloor(graph, weights),
      `shelter=${shelter}`,
    ).toBeLessThanOrEqual(cheapest);
  }
  // Past half a shelter weight the passage is the cheapest meter, so omitting board edges breaks the bound.
  const strong = transitWeights({ shelter: 0.9 });
  expect(heuristicFloor(graph, strong)).toBeCloseTo(
    (BOARDING_SECONDS * transitMultiplier(strong)) / length,
    9,
  );
});

// The stay-aboard step makes it one boarding of two stops; the passed station is no maneuver.
test("a ride through a station is one leg of two stops", () => {
  const graph = threeStopGraph();
  const route = findRoute(
    graph,
    snapAtNode(graph, 0, THREE_STOP_WEST_SIDEWALK),
    snapAtNode(graph, 2, THREE_STOP_EAST_SIDEWALK),
    transitWeights(),
  ) as RouteResult;

  expect(route.rides).toHaveLength(1);
  const [leg] = route.rides;
  expect(leg.boardStation).toBe(THREE_STOP_WEST);
  expect(leg.alightStation).toBe(THREE_STOP_EAST);
  expect(leg.stops).toBe(2);
  expect(leg.rideSeconds).toBe(2 * RIDE_SECONDS);

  const maneuvers = buildDirections(graph, route).filter(
    (maneuver) => maneuver.kind === "transit" || maneuver.kind === "station",
  );
  expect(maneuvers.map((maneuver) => maneuver.text)).toEqual([
    `Enter ${THREE_STOP_WEST} by the stair on Main Street`,
    `Take the ${THREE_STOP_ROUTE_SHORT_NAME} at 8:04 AM toward ${THREE_STOP_EAST} (2 stops)`,
    `Get off at ${THREE_STOP_EAST}`,
    `Exit ${THREE_STOP_EAST} by the stair on Main Street`,
  ]);
  expect(
    maneuvers.every((maneuver) => !maneuver.text.includes(THREE_STOP_MIDDLE)),
  ).toBe(true);
  const [, ride] = maneuvers;
  expect(ride.durationSeconds).toBe(2 * RIDE_SECONDS);
  expect(ride.stops).toBe(2);
});

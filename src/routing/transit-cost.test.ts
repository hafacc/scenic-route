// What the router does with a published timetable: when it rides, what the ride costs, what it
// reports afterwards, and whether the A* credit that lets it consider rides at all is still a lower
// bound. The fixture is a straight kilometre of pavement with a two-station line beside it
// (./transit-graph.fixture.ts), which is the smallest network where riding and walking are both
// real answers.

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
  transitGraph,
  transitWeights,
  UNSCHEDULED_LANE,
  WEST_BOARD,
  WEST_SIDEWALK,
  WEST_STATION,
} from "./transit-graph.fixture";

// What the whole trip takes when the train is caught with no wait: down into the west station, the
// boarding constant, the ride, back up to the east stop and out to the pavement.
const RIDE_TRIP_SECONDS =
  ACCESS_SECONDS +
  BOARDING_SECONDS +
  RIDE_SECONDS +
  ALIGHT_SECONDS +
  EAST_ACCESS_SECONDS;

// The route the fixture is built around: the west end of the pavement to the east end, which the
// line runs beside. Every test snaps these two.
function ends(graph: RoutingGraph): { start: Snap; dest: Snap } {
  return {
    start: snapAtNode(graph, 0, WEST_SIDEWALK),
    dest: snapAtNode(graph, 2, EAST_SIDEWALK),
  };
}

// A graph with the fixture timetable already on it, resolved so a walker leaving now steps onto the
// west platform exactly as a train goes: no wait, which is what makes the ride's cost a number the
// tests can name.
function scheduled(lanes?: readonly number[]): RoutingGraph {
  const graph = transitGraph(lanes);
  graph.transit = fixtureTimetable(departureReaching(ACCESS_SECONDS));
  return graph;
}

function rides(result: RouteResult | null): boolean {
  return result?.steps.some((step) => step.kind === "ride") ?? false;
}

// The reference optimum: the same cost model with the heuristic taken away and no early exit, which
// is what "the credit never over-estimates" means. It carries the elapsed clock exactly as findRoute
// does, since a board edge's cost is a step function of it.
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
      const neighbour = otherEnd(graph, edge, node);
      if (relaxed < distance[neighbour]) {
        distance[neighbour] = relaxed;
        elapsed[neighbour] =
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

// The effective cost of a finished route, summed step by step the way the search paid for it.
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
  // 90 s down to the platform, no wait, the boarding constant, the ride, back up and out.
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
  // Reaching the platform this far after a train has gone is a wait for the next one, less that —
  // the band's own headway, not an average of it. Late enough to be worth waiting through and no
  // later: past about five minutes the walk wins, which is a different test.
  const late = 400;
  expect(boardSeconds(graph, WEST_BOARD, ACCESS_SECONDS + late)).toBeCloseTo(
    HEADWAY - late + BOARDING_SECONDS,
    6,
  );
  expect(stopIndexOf(graph, WEST_BOARD)).toBe(0);

  const waiting = transitGraph();
  // Leaving that much later than the train can be caught, so the platform is reached after it has
  // gone.
  waiting.transit = fixtureTimetable(departureReaching(ACCESS_SECONDS - late));
  const { start, dest } = ends(waiting);
  const route = findRoute(waiting, start, dest, transitWeights({ transit: 0 }));
  expect(rides(route)).toBe(true);
  expect(route?.travelSeconds).toBeCloseTo(
    RIDE_TRIP_SECONDS + (HEADWAY - late),
    6,
  );
  // The wait counts as time on the rail, since it is time the line costs you.
  expect(route?.transitSeconds).toBeCloseTo(
    HEADWAY - late + BOARDING_SECONDS + RIDE_SECONDS,
    6,
  );
});

test("past the last train the line is not a way anywhere", () => {
  const graph = transitGraph();
  // An hour after the band's last departure: there is no next train today, and tomorrow's is not an
  // answer to "how do I get there now".
  graph.transit = fixtureTimetable(departureAt(LAST_DEPARTURE + 3600));
  expect(boardSeconds(graph, WEST_BOARD, 0)).toBe(Number.POSITIVE_INFINITY);
  const { start, dest } = ends(graph);
  const route = findRoute(graph, start, dest, transitWeights({ transit: 0 }));
  expect(rides(route)).toBe(false);
});

test("a lane the timetable does not name is not a train either", () => {
  // No baked fallback, deliberately: a board edge bakes no departure, so a schedule that does not
  // cover this lane leaves nothing to ride.
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
  // The alight edge runs platform -> station; walking it the other way would board a train with no
  // wait at all, which is the whole reason the direction is checked.
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

  // A fully-shaded field at full shade preference makes a walked metre a tenth of its price; the
  // ride is priced by neither.
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
  // Two hundred metres back along the pavement, so the route walks some of it before it rides and
  // the means have something to average. The timetable is resolved against that longer approach, so
  // the train is still caught without a wait.
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
  // The ride's own span is in the distance the map draws, and out of the miles the summary reports.
  expect(route?.lengthMeters).toBeGreaterThan(graph.edgeLength[RIDE_EDGE]);
  // A chip is a share of the whole trip's time, and a kilometre of tunnel is time under no canopy:
  // half-shaded pavement walked for part of the trip reads that part of a half.
  const walkSeconds = walkBack / WALK_METERS_PER_SECOND;
  expect(route?.factors.tree).toBeCloseTo(
    (SIDEWALK_COVER * walkSeconds) / (route?.travelSeconds ?? 1),
    2,
  );
  expect(route?.factors.tree).toBeLessThan(SIDEWALK_COVER / 2);
  // The same pavement walked the whole way is the same canopy, and reads all of it.
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

// The same matrix with the estimate measured along the network — rides and crossings included at
// their own lengths — instead of through the air. A tighter lower bound is still a lower bound.
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
    `Enter ${WEST_STATION}`,
    `Take the ${ROUTE_SHORT_NAME} at 8:00 AM toward ${EAST_STATION} (1 stop)`,
    `Get off at ${EAST_STATION}`,
    // A kerbside stop is left rather than exited: the east end of this line is one.
    `Leave the ${EAST_STATION} stop`,
  ]);
  const ride = transit[1];
  expect(ride.durationSeconds).toBe(RIDE_SECONDS);
  expect(ride.stops).toBe(1);
  // The ride's span is the maneuver's length, so nav-progress advances along it as it does a ferry.
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
  // The departure is a clock time on the routed day, which is what a card prints: 08:00.
  expect(leg.departureSeconds).toBe(FIRST_DEPARTURE);
  // What the card calls the minutes on the train: the wait is in it, since the line cost you both.
  expect(route?.transitSeconds).toBeCloseTo(
    leg.waitSeconds + leg.rideSeconds,
    6,
  );
});

test("shelter is a mean over the trip's seconds, and a ride is all of them covered", () => {
  const graph = scheduled();
  const { start, dest } = ends(graph);
  const route = findRoute(graph, start, dest, transitWeights({ transit: 0 }));
  // The station walks are out in the weather; the platform and the train are not. The fixture has no
  // shed feed, so a walked metre shelters nobody, and the two access walks are the whole of the rest.
  const covered = BOARDING_SECONDS + RIDE_SECONDS;
  expect(route?.factors.shelter).toBeCloseTo(
    covered / (route?.travelSeconds ?? 1),
    6,
  );
  // The same trip walked has nothing overhead at all.
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
    // The least a board edge can cost per metre: the boarding constant, since the wait on top of it
    // is at least zero, priced the way a ride is.
    const cheapest = (BOARDING_SECONDS * transitMultiplier(weights)) / length;
    expect(
      heuristicFloor(graph, weights),
      `shelter=${shelter}`,
    ).toBeLessThanOrEqual(cheapest);
  }
  // Past half a shelter weight the passage is the cheapest metre in the graph, so the floor is it:
  // the bound would be broken rather than merely loose if board edges were left out.
  const strong = transitWeights({ shelter: 0.9 });
  expect(heuristicFloor(graph, strong)).toBeCloseTo(
    (BOARDING_SECONDS * transitMultiplier(strong)) / length,
    9,
  );
});

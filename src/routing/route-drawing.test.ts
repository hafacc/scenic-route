// A stay-aboard step read as a change would split one ride per hop and double-dot every stop.

import { beforeEach, expect, test } from "bun:test";
import { clearEdgePathCache } from "./graph";
import { buildDrawing } from "./route-drawing";
import { findRoute, type RouteResult } from "./search";
import {
  COMPLEX_NORTH_DOOR_NODE,
  COMPLEX_NORTH_SIDEWALK,
  COMPLEX_SOUTH_DOOR_NODE,
  COMPLEX_SOUTH_SIDEWALK,
  complexGraph,
  snapAtNode,
  THREE_STOP_EAST_SIDEWALK,
  THREE_STOP_WEST_SIDEWALK,
  threeStopGraph,
  transitWeights,
} from "./transit-graph.fixture";

beforeEach(clearEdgePathCache);

test("a ride through a station draws as one leg with a disc at each end", () => {
  const graph = threeStopGraph();
  const route = findRoute(
    graph,
    snapAtNode(graph, 0, THREE_STOP_WEST_SIDEWALK),
    snapAtNode(graph, 2, THREE_STOP_EAST_SIDEWALK),
    transitWeights(),
  ) as RouteResult;
  expect(route.rides).toHaveLength(1);

  const drawing = buildDrawing(graph, route, null);
  const ridden = drawing.steps.filter((step) => typeof step.mode === "object");
  expect(ridden).toHaveLength(1);

  expect(drawing.stations).toHaveLength(2);
  const places = drawing.stations.map(
    (station) => `${station.lat},${station.lng}`,
  );
  expect(new Set(places).size).toBe(places.length);
});

test("a change inside a complex is one connector between the two platforms' dots", () => {
  const graph = complexGraph();
  const route = findRoute(
    graph,
    snapAtNode(graph, COMPLEX_SOUTH_DOOR_NODE, COMPLEX_SOUTH_SIDEWALK),
    snapAtNode(graph, COMPLEX_NORTH_DOOR_NODE, COMPLEX_NORTH_SIDEWALK),
    transitWeights(),
  ) as RouteResult;
  expect(route.rides).toHaveLength(2);

  const drawing = buildDrawing(graph, route, null);
  const connectors = drawing.steps.filter((step) => step.mode === "transfer");
  expect(connectors).toHaveLength(1);
  // Both platforms keep their dot, since they are 145 m apart.
  expect(drawing.stations).toHaveLength(4);
  const [connector] = connectors;
  const end = connector.lats.length - 1;
  expect([connector.lats[0], connector.lngs[0]]).toEqual([
    drawing.stations[1].lat,
    drawing.stations[1].lng,
  ]);
  expect([connector.lats[end], connector.lngs[end]]).toEqual([
    drawing.stations[2].lat,
    drawing.stations[2].lng,
  ]);
  expect(drawing.changes).toHaveLength(1);
  const [change] = drawing.changes;
  expect(change.lng).toBeGreaterThan(drawing.stations[1].lng);
  expect(change.lng).toBeLessThan(drawing.stations[2].lng);

  // Nothing between the two rides is drawn as a walk on the street.
  const firstRide = drawing.steps.findIndex(
    (step) => typeof step.mode === "object",
  );
  const lastRide = drawing.steps.findLastIndex(
    (step) => typeof step.mode === "object",
  );
  for (const step of drawing.steps.slice(firstRide + 1, lastRide)) {
    if (step.mode === "walk") {
      expect(step.lats[0]).toBe(step.lats[step.lats.length - 1]);
      expect(step.lngs[0]).toBe(step.lngs[step.lngs.length - 1]);
    }
  }
});

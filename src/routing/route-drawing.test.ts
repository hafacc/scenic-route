// A stay-aboard step read as a change would split one ride per hop and double-dot every stop.

import { beforeEach, expect, test } from "bun:test";
import { clearEdgePathCache } from "./graph";
import { buildDrawing } from "./route-drawing";
import { findRoute, type RouteResult } from "./search";
import {
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

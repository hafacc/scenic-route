// The polyline cache belongs to one graph: the worker holds every city the reader has visited, and
// edge ids repeat between them.

import { expect, test } from "bun:test";
import { buildGraph } from "./ferry.fixture";
import { edgePath } from "./graph";

const NEW_YORK_LNG = -73.99;
const SAN_FRANCISCO_LNG = -122.4;

const newYork = buildGraph(
  [
    { lat: 40.75, lng: NEW_YORK_LNG },
    { lat: 40.75, lng: -73.98 },
  ],
  [{ a: 0, b: 1, ferry: false, cover: 0.5, durationSeconds: 0 }],
);
const sanFrancisco = buildGraph(
  [
    { lat: 37.79, lng: SAN_FRANCISCO_LNG },
    { lat: 37.79, lng: -122.39 },
  ],
  [{ a: 0, b: 1, ferry: false, cover: 0.5, durationSeconds: 0 }],
);

test("edge 0 of each city keeps its own polyline", () => {
  // Read alternately, so each read is the second one for the other graph — which is where a cache
  // keyed on the edge id alone answers with the wrong city's street.
  expect(edgePath(newYork, 0).lngs[0]).toBeCloseTo(NEW_YORK_LNG, 9);
  expect(edgePath(sanFrancisco, 0).lngs[0]).toBeCloseTo(SAN_FRANCISCO_LNG, 9);
  expect(edgePath(newYork, 0).lngs[0]).toBeCloseTo(NEW_YORK_LNG, 9);
  expect(edgePath(sanFrancisco, 0).lngs[0]).toBeCloseTo(SAN_FRANCISCO_LNG, 9);
});

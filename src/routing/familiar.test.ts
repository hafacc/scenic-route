import { expect, test } from "bun:test";
import { BOWED, STRAIGHT, walkGraph } from "../walks/walks.fixture";
import { edgeMultiplier, minMultiplier, walkSecondsCoeff } from "./cost";
import {
  decayedWeight,
  FAMILIAR_REACH,
  familiarByte,
  familiarField,
  familiarity,
  sighted,
  WALK_HALF_LIFE_MS,
  type WalkRecord,
} from "./familiar";
import { weights } from "./ferry.fixture";
import { edgeDurableKey } from "./graph";

const NOW = Date.UTC(2026, 9, 14);
const plain = weights(0, 0, false);

test("a weight halves every half-life and never grows by waiting", () => {
  const record = { weight: 4, at: NOW };
  expect(decayedWeight(record, NOW)).toBe(4);
  expect(decayedWeight(record, NOW + WALK_HALF_LIFE_MS)).toBeCloseTo(2, 12);
  expect(decayedWeight(record, NOW + 3 * WALK_HALF_LIFE_MS)).toBeCloseTo(
    0.5,
    12,
  );
  // A clock that ran backwards reads no time passed rather than inflating the count.
  expect(decayedWeight(record, NOW - WALK_HALF_LIFE_MS)).toBe(4);
});

test("a sighting decays what was there, then adds one", () => {
  const first = sighted(undefined, NOW);
  expect(first).toEqual({ weight: 1, at: NOW });
  const later = sighted(first, NOW + WALK_HALF_LIFE_MS);
  expect(later.weight).toBeCloseTo(1.5, 12);
  expect(later.at).toBe(NOW + WALK_HALF_LIFE_MS);
});

test("familiarity saturates below 1 and its byte is capped like a baked attribute", () => {
  expect(familiarity(0)).toBe(0);
  expect(familiarity(1)).toBeGreaterThan(0.3);
  expect(familiarity(3)).toBeGreaterThan(familiarity(1));
  expect(familiarity(1e9)).toBeLessThanOrEqual(1);
  expect(familiarByte(1e9)).toBe(254);
  expect(familiarByte(0)).toBe(0);
});

function fieldFor(edges: readonly number[], weight: number) {
  const graph = walkGraph();
  const records = new Map<number, WalkRecord>(
    edges.map((edge) => [edgeDurableKey(graph, edge), { weight, at: NOW }]),
  );
  graph.familiar = familiarField(graph, records, NOW);
  return graph;
}

test("the field lands each record on the edge with its durable key", () => {
  const graph = fieldFor(BOWED, 1);
  for (const edge of BOWED) {
    expect(graph.familiar?.edges[edge]).toBe(familiarByte(1));
  }
  for (const edge of STRAIGHT) {
    expect(graph.familiar?.edges[edge]).toBe(0);
  }
  expect(graph.familiar?.max).toBe(familiarByte(1) / 255);
});

test("no records, or only faded ones, build no field", () => {
  const graph = walkGraph();
  expect(familiarField(graph, new Map(), NOW)).toBeNull();
  const ghost = new Map([[edgeDurableKey(graph, 0), { weight: 0, at: NOW }]]);
  expect(familiarField(graph, ghost, NOW)).toBeNull();
});

test("neutral is exactly 1 on every edge, walked or not", () => {
  const graph = fieldFor(BOWED, 50);
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    expect(edgeMultiplier(graph, edge, { ...plain, familiar: 0 })).toBe(1);
  }
  expect(minMultiplier(graph, { ...plain, familiar: 0 })).toBe(1);
});

test("the multiplier stays within half to one and a half, never free nor doubled", () => {
  const graph = fieldFor(BOWED, 1e9);
  const walked = BOWED[0];
  const fresh = STRAIGHT[0];
  const familiar = edgeMultiplier(graph, walked, { ...plain, familiar: 1 });
  const avoided = edgeMultiplier(graph, walked, { ...plain, familiar: -1 });
  expect(familiar).toBeGreaterThan(1 - FAMILIAR_REACH);
  expect(familiar).toBeLessThan(1);
  expect(avoided).toBeGreaterThan(1);
  expect(avoided).toBeLessThan(1 + FAMILIAR_REACH);
  expect(edgeMultiplier(graph, fresh, { ...plain, familiar: 1 })).toBe(1);
  expect(edgeMultiplier(graph, fresh, { ...plain, familiar: -1 })).toBe(1);
});

test("the A* floor bounds every edge, and preferring new streets leaves it untouched", () => {
  const graph = fieldFor(BOWED, 3);
  for (const familiar of [-1, -0.5, 0.5, 1]) {
    const floor = minMultiplier(graph, { ...plain, familiar });
    for (let edge = 0; edge < graph.edgeCount; edge++) {
      expect(
        edgeMultiplier(graph, edge, { ...plain, familiar }),
      ).toBeGreaterThanOrEqual(floor);
    }
  }
  // A penalty discounts nothing, so the heuristic keeps its full strength.
  expect(walkSecondsCoeff(graph, { ...plain, familiar: -1 })).toBe(
    walkSecondsCoeff(graph, plain),
  );
});

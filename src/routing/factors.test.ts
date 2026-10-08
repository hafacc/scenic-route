import { expect, test } from "bun:test";
import {
  DEFAULT_ROUTE_STATE,
  DEFAULT_WEIGHTS,
  encodeRoute,
} from "../url-state";
import { FACTORS, factorPercent, factorWeight, stepFor } from "./factors";

test("every factor's default sits on its slider's grid", () => {
  for (const factor of FACTORS) {
    const fallback = DEFAULT_WEIGHTS[factor.key];
    const exact = (fallback / factor.max) * 100;
    const percent = factorPercent(factor, fallback);
    // The unrounded percent too, or 16.67 would pass as a rounded 17 on a step of 1.
    expect([factor.key, exact]).toEqual([
      factor.key,
      expect.closeTo(percent, 9),
    ]);
    expect([factor.key, percent % stepFor(factor)]).toEqual([factor.key, 0]);
  }
});

test("every factor's default survives the slider's value to weight conversion", () => {
  for (const factor of FACTORS) {
    const fallback = DEFAULT_WEIGHTS[factor.key];
    const weight = factorWeight(factor, factorPercent(factor, fallback));
    expect([factor.key, weight]).toEqual([
      factor.key,
      expect.closeTo(fallback, 9),
    ]);
    // Dragged back to its default, a weight leaves the link again.
    const weights = { ...DEFAULT_WEIGHTS, [factor.key]: weight };
    const link = encodeRoute({ ...DEFAULT_ROUTE_STATE, weights });
    expect([factor.key, link.has(factor.key)]).toEqual([factor.key, false]);
  }
});

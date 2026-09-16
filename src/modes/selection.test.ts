import { describe, expect, test } from "bun:test";
import { clampSelection, endpointsMoved } from "./selection";

describe("clampSelection", () => {
  test("a card the plan has stays selected", () => {
    expect(clampSelection(2, 4)).toBe(2);
    expect(clampSelection(0, 1)).toBe(0);
  });

  test("a link's index past the plan's last card selects nothing", () => {
    expect(clampSelection(9, 3)).toBeNull();
    expect(clampSelection(3, 3)).toBeNull();
  });

  test("a plan with no routes leaves nothing selected", () => {
    expect(clampSelection(0, 0)).toBeNull();
  });

  test("browsing them all survives", () => {
    expect(clampSelection(null, 4)).toBeNull();
  });

  test("a hand-typed index that is not a card is not one", () => {
    expect(clampSelection(-1, 4)).toBeNull();
    expect(clampSelection(1.5, 4)).toBeNull();
  });
});

describe("endpointsMoved", () => {
  const walk = { start: "40.80,-73.96", dest: "40.77,-73.95" };

  test("the first walk is not a move", () => {
    expect(endpointsMoved(null, walk)).toBe(false);
  });

  test("the live location being pinned as the start is not a move", () => {
    expect(endpointsMoved({ start: null, dest: walk.dest }, walk)).toBe(false);
  });

  test("a destination somewhere else is", () => {
    expect(endpointsMoved(walk, { ...walk, dest: "40.71,-74.00" })).toBe(true);
  });

  test("a start somewhere else is", () => {
    expect(endpointsMoved(walk, { ...walk, start: "40.71,-74.00" })).toBe(true);
  });

  test("clearing the destination is, so the next one starts on no card", () => {
    expect(endpointsMoved(walk, null)).toBe(true);
    expect(endpointsMoved(null, null)).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import type { Plan } from "../routing/alternatives";
import type { RoutingGraph } from "../routing/graph";
import type { RouteResult } from "../routing/search";
import { ALL_FACTORS, type Mode, modeById } from "./modes";
import {
  type LandedPlan,
  NO_PLAN,
  type PlanState,
  planClock,
  planReducer,
} from "./plan-state";

function modeOrThrow(id: string): Mode {
  const mode = modeById(id);
  if (mode === null) {
    throw new Error("the mode this test is about is gone");
  } else {
    return mode;
  }
}

const MODE = modeOrThrow("naturalist");

// The reducer never reads these, only moves them.
const GRAPH = {} as RoutingGraph;
const NOON = new Date(2026, 8, 2, 12, 0).getTime();
const ROUTE = { travelSeconds: 600 } as RouteResult;
const PLAN: Plan = {
  routes: [],
  bestByFactor: {},
  searches: 4,
  superseded: false,
};

function landedPlan(id: number): LandedPlan {
  return { id, graph: GRAPH, mode: MODE, available: ALL_FACTORS, plan: PLAN };
}

function started(id: number): PlanState {
  return planReducer(NO_PLAN, { kind: "started", id, graph: GRAPH });
}

describe("planReducer", () => {
  test("a sweep in flight holds the plan already on screen", () => {
    const held = planReducer(started(1), {
      kind: "landed",
      landed: landedPlan(1),
    });
    const next = planReducer(held, { kind: "started", id: 2, graph: GRAPH });
    expect(next.landed?.id).toBe(1);
    expect(next.pending?.id).toBe(2);
  });

  test("landing clears the flag it set", () => {
    const next = planReducer(started(1), {
      kind: "landed",
      landed: landedPlan(1),
    });
    expect(next.pending).toBeNull();
    expect(next.landed?.id).toBe(1);
  });

  test("a sweep that answers with nothing clears the flag", () => {
    expect(
      planReducer(started(1), { kind: "failed", id: 1 }).pending,
    ).toBeNull();
  });

  test("a stale sweep leaves the newer one's flag alone", () => {
    const newer = planReducer(started(1), {
      kind: "started",
      id: 2,
      graph: GRAPH,
    });
    expect(planReducer(newer, { kind: "failed", id: 1 }).pending?.id).toBe(2);
    const stale = planReducer(newer, { kind: "landed", landed: landedPlan(1) });
    expect(stale.pending?.id).toBe(2);
    expect(stale.landed).toBeNull();
  });

  test("a sweep that lands after the card closed draws nothing", () => {
    const closed = planReducer(started(1), { kind: "cleared" });
    expect(planReducer(closed, { kind: "landed", landed: landedPlan(1) })).toBe(
      NO_PLAN,
    );
  });

  test("only the running sweep's own preview is drawn", () => {
    const running = started(2);
    expect(
      planReducer(running, { kind: "preview", id: 1, result: ROUTE }).pending
        ?.preview,
    ).toBeNull();
    expect(
      planReducer(running, { kind: "preview", id: 2, result: ROUTE }).pending
        ?.preview,
    ).toBe(ROUTE);
  });

  test("a landing plan leaves the held departure time alone", () => {
    const asked = planReducer(NO_PLAN, {
      kind: "captured",
      clock: planClock(NOON),
    });
    const running = planReducer(asked, {
      kind: "started",
      id: 1,
      graph: GRAPH,
    });
    const done = planReducer(running, {
      kind: "landed",
      landed: landedPlan(1),
    });
    expect(running.capturedAt?.dateMs).toBe(NOON);
    expect(done.capturedAt?.dateMs).toBe(NOON);
  });

  test("asking again keeps the cards up while the new time is planned", () => {
    const asked = planReducer(NO_PLAN, {
      kind: "captured",
      clock: planClock(NOON),
    });
    const landed = planReducer(
      planReducer(asked, { kind: "started", id: 1, graph: GRAPH }),
      { kind: "landed", landed: landedPlan(1) },
    );
    const again = planReducer(landed, {
      kind: "captured",
      clock: planClock(NOON + 90 * 60_000),
    });
    expect(again.capturedAt?.dateMs).toBe(NOON + 90 * 60_000);
    expect(again.landed?.id).toBe(1);
  });

  test("two asks in the same minute cost the fields nothing", () => {
    expect(planClock(NOON).tick).toBe(planClock(NOON + 5_000).tick);
    expect(planClock(NOON).tick).not.toBe(planClock(NOON + 60_000).tick);
  });

  test("closing directions drops both", () => {
    const both = planReducer(
      planReducer(started(1), { kind: "landed", landed: landedPlan(1) }),
      { kind: "started", id: 2, graph: GRAPH },
    );
    expect(planReducer(both, { kind: "cleared" })).toEqual(NO_PLAN);
  });

  test("closing directions lets go of the departure time too", () => {
    const asked = planReducer(NO_PLAN, {
      kind: "captured",
      clock: planClock(NOON),
    });
    expect(planReducer(asked, { kind: "cleared" }).capturedAt).toBeNull();
  });
});

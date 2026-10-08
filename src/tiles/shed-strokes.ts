import { type RoutingGraph, subEdgePath } from "../routing/graph";
import { type Shed, type ShedHistory, shedsOn } from "../routing/sheds";
import { type Chain, chainPaths } from "./chain";
import { projectX, projectY } from "./mercator";
import { type PathStrokes, type Piece, packStrokes } from "./path-strokes";

// Scaffolding as a line on the sidewalk it covers; src/tiles/shed-decks.ts keeps the decks the sun reads.

// A span stops short of its corner because a shed covers its own lot's frontage (scripts/shed-map.ts).
export const CORNER_REACH_METERS = 6;

interface SpanEnd {
  span: number;
  tail: boolean;
}

// One piece per span; two ends of a shed within reach of a node, and no third, are drawn through it.
export function shedPieces(graph: RoutingGraph, shed: Shed): Piece[] {
  const spans = shed.spans.filter(({ edge, t0, t1 }) => edge >= 0 && t1 > t0);
  const facing = new Map<number, SpanEnd[]>();
  for (let span = 0; span < spans.length; span++) {
    const { edge, t0, t1 } = spans[span];
    const length = graph.edgeLength[edge];
    for (const [node, gap, tail] of [
      [graph.edgeNodeA[edge], t0 * length, false],
      [graph.edgeNodeB[edge], (1 - t1) * length, true],
    ] as const) {
      if (gap <= CORNER_REACH_METERS) {
        const ends = facing.get(node);
        if (ends) {
          ends.push({ span, tail });
        } else {
          facing.set(node, [{ span, tail }]);
        }
      }
    }
  }
  const joinedHead = new Uint8Array(spans.length);
  const joinedTail = new Uint8Array(spans.length);
  for (const ends of facing.values()) {
    // Two ends of one edge are a span joined to itself, or two spans with uncovered ground between.
    if (
      ends.length === 2 &&
      spans[ends[0].span].edge !== spans[ends[1].span].edge
    ) {
      for (const { span, tail } of ends) {
        (tail ? joinedTail : joinedHead)[span] = 1;
      }
    }
  }

  return spans.map(({ edge, t0, t1 }, span) => {
    const from = joinedHead[span] === 1 ? 0 : t0;
    const to = joinedTail[span] === 1 ? 1 : t1;
    const length = graph.edgeLength[edge];
    const { lngs, lats } = subEdgePath(graph, edge, from * length, to * length);
    return {
      xs: lngs.map((lng) => projectX(lng, 0)),
      ys: lats.map((lat) => projectY(lat, 0)),
      head: joinedHead[span] === 1 ? graph.edgeNodeA[edge] : -1,
      tail: joinedTail[span] === 1 ? graph.edgeNodeB[edge] : -1,
      headOnNode: from === 0,
      tailOnNode: to === 1,
    };
  });
}

// Sheds cut between yields: a day's 7,500 take a quarter of a second, which is no one frame's to give.
const BATCH = 250;

// Chained a shed at a time, so one shed's line never runs on into its neighbor's.
function* strokeSteps(
  graph: RoutingGraph,
  sheds: readonly Shed[],
): Generator<void, PathStrokes> {
  const pieces: Piece[] = [];
  const chains: Chain[] = [];
  for (let shed = 0; shed < sheds.length; shed++) {
    if (shed > 0 && shed % BATCH === 0) {
      yield;
    }
    const own = shedPieces(graph, sheds[shed]);
    for (const { steps, closed } of chainPaths(own)) {
      chains.push({
        steps: steps.map(({ path, reversed }) => ({
          path: path + pieces.length,
          reversed,
        })),
        closed,
      });
    }
    pieces.push(...own);
  }
  return packStrokes(pieces, chains);
}

export function strokesOf(
  graph: RoutingGraph,
  sheds: readonly Shed[],
): PathStrokes {
  const steps = strokeSteps(graph, sheds);
  for (;;) {
    const step = steps.next();
    if (step.done) {
      return step.value;
    }
  }
}

const nextTask = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve);
  });

// The same strokes a batch at a time; null once `wanted` says a later day has overtaken this one.
export async function strokesPaused(
  graph: RoutingGraph,
  sheds: readonly Shed[],
  wanted: () => boolean,
  pause: () => Promise<void> = nextTask,
): Promise<PathStrokes | null> {
  const steps = strokeSteps(graph, sheds);
  for (;;) {
    const step = steps.next();
    if (step.done) {
      return step.value;
    }
    await pause();
    if (!wanted()) {
      return null;
    }
  }
}

export function shedStrokes(
  graph: RoutingGraph,
  history: ShedHistory,
  day: number,
  wanted: () => boolean,
): Promise<PathStrokes | null> {
  return strokesPaused(graph, shedsOn(graph, history, day), wanted);
}

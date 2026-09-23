// Kept apart from the cost model so the graph can bake walk seconds without an import cycle.

import type { RoutingGraph } from "./graph";

// NYC DCP Pedestrian Level of Service Study (2006): Lower Manhattan pedestrians averaged 1.30 m/s.
export const WALK_METERS_PER_SECOND = 1.3;

// Mirrors REFERENCE_GRADE in crates/tiler/src/relief.rs; changing either needs a graph format bump.
const RELIEF_MAX_GRADE = 0.35;

// Grade climbed and dropped walking a -> b, as fractions rather than byte scale.
export function edgeAscentGrade(graph: RoutingGraph, edge: number): number {
  return (graph.edgeAscent[edge] / 255) * RELIEF_MAX_GRADE;
}

export function edgeDescentGrade(graph: RoutingGraph, edge: number): number {
  return (graph.edgeDescent[edge] / 255) * RELIEF_MAX_GRADE;
}

// Climb plus drop, so direction-free; reaches 70% on a cresting edge since the bytes clamp separately.
export function edgeGrade(graph: RoutingGraph, edge: number): number {
  return edgeAscentGrade(graph, edge) + edgeDescentGrade(graph, edge);
}

// Tobler's hiking function, signed and normalized to 1 on the flat, so a 5% descent is fastest.
const TOBLER_FALLOFF = 3.5;
const TOBLER_PEAK_GRADE = 0.05; // the descent Tobler walks fastest on

export function gradeSpeedFactor(grade: number): number {
  return Math.exp(
    -TOBLER_FALLOFF * (Math.abs(grade + TOBLER_PEAK_GRADE) - TOBLER_PEAK_GRADE),
  );
}

// Reads the edge as one climb then one drop at the same |grade|; exceeds 1 only on descents under 10%.
function speedFactor(ascent: number, descent: number): number {
  const grade = ascent + descent;
  if (grade === 0) {
    return 1;
  } else {
    return (
      grade /
      (ascent / gradeSpeedFactor(grade) + descent / gradeSpeedFactor(-grade))
    );
  }
}

// Every length-to-seconds conversion goes through here, so ETA and cost agree on hills.
export function walkSpeedOn(
  graph: RoutingGraph,
  edge: number,
  forward = true,
): number {
  const ascent = edgeAscentGrade(graph, edge);
  const descent = edgeDescentGrade(graph, edge);
  return (
    WALK_METERS_PER_SECOND *
    (forward ? speedFactor(ascent, descent) : speedFactor(descent, ascent))
  );
}

// Not stored in the graph header, where it would go stale; memoized since every drag frame calls it.
const DOWNHILL_GRADE_CEILING = 2 * TOBLER_PEAK_GRADE;
const maxSpeedFactors = new WeakMap<RoutingGraph, number>();

export function maxSpeedFactor(graph: RoutingGraph): number {
  const memoized = maxSpeedFactors.get(graph);
  if (memoized !== undefined) {
    return memoized;
  }
  let best = 1;
  for (let edge = 0; edge < graph.edgeAscent.length; edge++) {
    const grade = edgeGrade(graph, edge);
    if (grade === 0 || grade >= DOWNHILL_GRADE_CEILING) {
      continue;
    }
    // The faster direction puts more of the edge on the descent, so the larger byte is read as the drop.
    const ascent = Math.min(
      edgeAscentGrade(graph, edge),
      edgeDescentGrade(graph, edge),
    );
    best = Math.max(best, speedFactor(ascent, grade - ascent));
  }
  maxSpeedFactors.set(graph, best);
  return best;
}

// The bake below uses this same function, so baked and unbaked graphs give identical bits.
export function edgeWalkSeconds(
  graph: RoutingGraph,
  edge: number,
  forward: boolean,
): number {
  const baked = graph.walkSeconds;
  if (baked) {
    return forward ? baked.forward[edge] : baked.backward[edge];
  }
  const ascent = edgeAscentGrade(graph, edge);
  const descent = edgeDescentGrade(graph, edge);
  return (
    graph.edgeLength[edge] /
    (WALK_METERS_PER_SECOND *
      (forward ? speedFactor(ascent, descent) : speedFactor(descent, ascent)))
  );
}

// Doubles because costs are compared at the last bits; 10 MB a city, so only searched graphs carry it.
export interface WalkSeconds {
  forward: Float64Array; // walking the stored a -> b direction
  backward: Float64Array;
}

// Baked at decode so the relax loop skips four exponentials per edge.
export function bakeWalkSeconds(graph: {
  edgeLength: Float32Array;
  edgeAscent: Uint8Array;
  edgeDescent: Uint8Array;
}): WalkSeconds {
  const edgeCount = graph.edgeLength.length;
  const forward = new Float64Array(edgeCount);
  const backward = new Float64Array(edgeCount);
  for (let edge = 0; edge < edgeCount; edge++) {
    const ascent = (graph.edgeAscent[edge] / 255) * RELIEF_MAX_GRADE;
    const descent = (graph.edgeDescent[edge] / 255) * RELIEF_MAX_GRADE;
    const length = graph.edgeLength[edge];
    forward[edge] =
      length / (WALK_METERS_PER_SECOND * speedFactor(ascent, descent));
    backward[edge] =
      length / (WALK_METERS_PER_SECOND * speedFactor(descent, ascent));
  }
  return { forward, backward };
}

// Route ends are priced off this, not walkSpeedOn, so destination-edge ties don't turn on float noise.
export function walkSecondsPerMeter(
  graph: RoutingGraph,
  edge: number,
  forward: boolean,
): number {
  const length = graph.edgeLength[edge];
  return length === 0 ? 0 : edgeWalkSeconds(graph, edge, forward) / length;
}

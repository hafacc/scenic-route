// How long a metre of pavement takes to walk, which is where every length in the cost model turns
// into seconds. Its own module because the graph bakes these seconds per edge as it decodes and the
// cost model reads them back: one of the two has to be free of the other, and it is this one.

import type { RoutingGraph } from "./graph";

// NYC DCP's Pedestrian Level of Service Study (2006) timed 8,978 Lower Manhattan pedestrians at a
// mean of 1.30 m/s; work trips ran 1.34, over-65s 1.11.
export const WALK_METERS_PER_SECOND = 1.3;

// The grade each relief byte's full range spans. Mirrors REFERENCE_GRADE in crates/tiler/src/relief.rs
// — the byte carries a fraction, and this is what the fraction is a fraction OF. Change one and the
// other is wrong, which is why the graph format version moves with it.
const RELIEF_MAX_GRADE = 0.35;

// The height an edge climbs, and the height it drops, over its length, walking it a -> b: real
// grade fractions rather than the bytes' own scale.
export function edgeAscentGrade(graph: RoutingGraph, edge: number): number {
  return (graph.edgeAscent[edge] / 255) * RELIEF_MAX_GRADE;
}

export function edgeDescentGrade(graph: RoutingGraph, edge: number): number {
  return (graph.edgeDescent[edge] / 255) * RELIEF_MAX_GRADE;
}

// The absolute grade of one edge: everything it climbs plus everything it drops, over its length.
// Direction-free by construction, which is what the hill penalty wants — a route that avoids a hill
// avoids it both ways. Reaches 70% on an edge that crests, since the two bytes clamp separately.
export function edgeGrade(graph: RoutingGraph, edge: number): number {
  return edgeAscentGrade(graph, edge) + edgeDescentGrade(graph, edge);
}

// Tobler's hiking function, which is where the shape of "steep is slow" comes from: walking speed
// falls off exponentially in the grade, and its peak sits at a gentle DESCENT rather than at flat.
// Signed, so a downhill is no longer charged the climb's slowdown: a 5% descent is the fastest
// walking there is (factor 1.1912) and a 10% descent is back to flat, past which dropping is slow
// and unpleasant again.
//
// Normalized to 1 on the flat, so it scales the measured 1.3 m/s rather than replacing it with
// Tobler's own 1.4.
const TOBLER_FALLOFF = 3.5;
const TOBLER_PEAK_GRADE = 0.05; // the descent Tobler walks fastest on

export function gradeSpeedFactor(grade: number): number {
  return Math.exp(
    -TOBLER_FALLOFF * (Math.abs(grade + TOBLER_PEAK_GRADE) - TOBLER_PEAK_GRADE),
  );
}

// The speed multiplier for an edge that climbs `ascent` and drops `descent` per metre of it. With
// g = ascent + descent, the climbing run is a fraction ascent/g of the length and rises `ascent`
// times the length, so its grade is exactly g, and the dropping run's is -g. That collapses the whole
// edge to one effective speed: seconds = L/(V*g) * (ascent/f(g) + descent/f(-g)).
//
// Exact when the edge really is one constant-grade climb followed by one constant-grade drop, an
// approximation otherwise: the bytes do not say how the height was distributed along the polyline,
// and this reads them as the arrangement where every metre of it tips at the same |grade|.
//
// The result is a weighted harmonic mean of f(g) and f(-g), so it can exceed 1 only where f(-g)
// does, i.e. on descents under 10%; `maxSpeedFactor` below is what keeps the A* bound honest.
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

// How fast this edge is actually walked, in the given direction (the stored a -> b one by default).
// Every place that turns a length into seconds goes through here, so the ETA and the cost cannot
// disagree about how long a hill takes.
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

// The fastest any edge in the graph can be walked, as a multiple of the flat speed — the divisor the
// A* heuristic's per-metre floor needs now that a descent can beat flat. Deliberately computed here
// rather than baked into the graph header: a figure in the file would go silently stale the moment
// the Tobler constants moved without a format bump.
//
// Memoized per graph because `solveApprox` runs this on every drag frame. The scan is cheap: an
// edge's factor is a weighted harmonic mean of f(g) and f(-g), so it cannot exceed f(-g), which is
// itself at most 1 once the total grade reaches twice Tobler's peak. So only gentle edges need an
// `exp` at all, and a flat city (every byte 0) settles at exactly 1 without one.
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
    // Either direction may be walked, and the faster one is whichever puts more of the edge on the
    // descent, so the bound reads the larger byte as the drop.
    const ascent = Math.min(
      edgeAscentGrade(graph, edge),
      edgeDescentGrade(graph, edge),
    );
    best = Math.max(best, speedFactor(ascent, grade - ascent));
  }
  maxSpeedFactors.set(graph, best);
  return best;
}

// One edge's walking seconds, in the given direction: its length over the speed the two relief bytes
// give it. Everything that turns a length into seconds goes through here or through the bake below,
// which fills its arrays from this very function — so a graph that carries the bake and one that
// does not answer with the same bits, and a route's ETA cannot disagree with what it cost.
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

// Doubles rather than floats: a route's ETA is a sum of hundreds of these, and the cost model's own
// bounds are compared at the last bits, so the 5 MB a New York graph saves by halving them is not
// worth a route that turns on rounding. 10 MB a city, which is why only a graph that will be
// SEARCHED carries it — the page reads a handful of these per route and computes them as it goes.
export interface WalkSeconds {
  forward: Float64Array; // walking the stored a -> b direction
  backward: Float64Array;
}

// Every edge's walking seconds, both ways round, taken once as the graph is decoded. The relax loop
// would otherwise spend four exponentials on every edge it looks at, for a figure that depends on
// nothing but the edge's length and its two relief bytes.
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

// The seconds for ONE metre of an edge, walked in the given direction. What the two end edges of a
// route are charged per metre of the partial they walk: the interior is charged the whole, so
// pricing the ends off the same figure is what keeps a route's arithmetic self-consistent — a
// partial priced off `walkSpeedOn` instead differs in the last bits, and a tie between two ways into
// the destination edge then turns on float noise.
export function walkSecondsPerMeter(
  graph: RoutingGraph,
  edge: number,
  forward: boolean,
): number {
  const length = graph.edgeLength[edge];
  return length === 0 ? 0 : edgeWalkSeconds(graph, edge, forward) / length;
}

// The optimal path is piecewise-constant in one weight, so samples sharing a path bracket it; 1-D only.

import {
  GATE_KEYS,
  INTERNAL_FLAGS,
  type RouteWeights,
  WEIGHT_KEYS,
  type WeightKey,
} from "./cost";
import type { RoutingGraph } from "./graph";
import { findRoute, type RouteResult } from "./search";
import type { Snap } from "./snap";

// Read off the cost model's list, since a missing slider's moves would silently return the old route.
const AXES = WEIGHT_KEYS;
type Axis = WeightKey;

// Quantized so slider values equal in intent match despite float drift.
const WEIGHT_DECIMALS = 3;

function quantize(weight: number): number {
  const scale = 10 ** WEIGHT_DECIMALS;
  return Math.round(weight * scale) / scale;
}

function quantizeWeights(weights: RouteWeights): RouteWeights {
  const quantized = { ...weights };
  for (const axis of AXES) {
    quantized[axis] = quantize(weights[axis]);
  }
  return quantized;
}

// A missing switch would be a control that silently does nothing.
const SWITCHES = [...GATE_KEYS, ...INTERNAL_FLAGS] as const;

function sameGates(left: RouteWeights, right: RouteWeights): boolean {
  return SWITCHES.every((switched) => left[switched] === right[switched]);
}

function sameWeights(left: RouteWeights, right: RouteWeights): boolean {
  return (
    sameGates(left, right) && AXES.every((axis) => left[axis] === right[axis])
  );
}

function pathSignature(result: RouteResult | null): string {
  if (!result) {
    return "∅"; // no route — a distinct, stable signature
  }
  let signature = "";
  for (const step of result.steps) {
    signature += `${step.edge}${step.forward ? "f" : "b"};`;
  }
  return signature;
}

interface Sample {
  value: number; // the active axis's weight
  signature: string;
  result: RouteResult | null;
}

export interface CachedRoute {
  result: RouteResult | null;
  changed: boolean;
}

// Clears when the endpoints change, so the caller only needs a stable instance.
export class RouteCache {
  private endpointsKey = "";
  private axis: Axis | null = null; // the slider the samples bracket; null when none is established
  private samples: Sample[] = []; // ascending by the active axis's weight, all at one fixed context
  private last: RouteWeights | null = null; // the previous call's quantized weights
  private lastResult: RouteResult | null = null;
  private lastSignature: string | null = null;

  // Injected, not `mock.module`, since module mocks leak across bun test files.
  constructor(private readonly search: typeof findRoute = findRoute) {}

  route(
    graph: RoutingGraph,
    start: Snap,
    dest: Snap,
    weights: RouteWeights,
  ): CachedRoute {
    const current = quantizeWeights(weights);
    const endpointsKey = `${start.edge}:${start.metersFromA.toFixed(2)}|${dest.edge}:${dest.metersFromA.toFixed(2)}`;
    if (endpointsKey !== this.endpointsKey) {
      this.endpointsKey = endpointsKey;
      this.axis = null;
      this.samples = [];
      this.last = null;
      this.lastSignature = null;
    }

    if (this.last !== null && sameWeights(current, this.last)) {
      return { result: this.lastResult, changed: false };
    }

    // A first call, a toggled gate, or two weights moving at once has no single bracketable axis.
    let active: Axis | null = null;
    if (this.last !== null && sameGates(current, this.last)) {
      const moved = AXES.filter((axis) => current[axis] !== this.last?.[axis]);
      if (moved.length === 1) {
        active = moved[0];
      }
    }

    if (active === null) {
      this.axis = null;
      this.samples = [];
    } else if (active !== this.axis) {
      // The just-computed point is still valid, since only the active slider moved.
      this.axis = active;
      this.samples =
        this.last !== null && this.lastSignature !== null
          ? [
              {
                value: this.last[active],
                signature: this.lastSignature,
                result: this.lastResult,
              },
            ]
          : [];
    }

    let sample: Sample;
    if (this.axis === null) {
      const result = this.search(graph, start, dest, current);
      sample = {
        value: current.tree,
        signature: pathSignature(result),
        result,
      };
    } else {
      sample = this.sampleFor(graph, start, dest, current, this.axis);
    }

    const changed = sample.signature !== this.lastSignature;
    this.last = current;
    this.lastResult = sample.result;
    this.lastSignature = sample.signature;
    return { result: sample.result, changed };
  }

  // Only the active axis varies across samples, so an interval bracketed by one path stays that path.
  private sampleFor(
    graph: RoutingGraph,
    start: Snap,
    dest: Snap,
    weights: RouteWeights,
    axis: Axis,
  ): Sample {
    const axisValue = weights[axis];
    let below: Sample | null = null;
    let above: Sample | null = null;
    let insertAt = this.samples.length;
    for (let index = 0; index < this.samples.length; index++) {
      const sample = this.samples[index];
      if (sample.value === axisValue) {
        return sample;
      } else if (sample.value < axisValue) {
        below = sample;
      } else {
        above = sample;
        insertAt = index;
        break; // ascending, so the first sample above the value is the nearest one
      }
    }
    if (below && above && below.signature === above.signature) {
      return below; // the same path is optimal across the whole [below, above] interval
    }
    const result = this.search(graph, start, dest, weights);
    const sample: Sample = {
      value: axisValue,
      signature: pathSignature(result),
      result,
    };
    this.samples.splice(insertAt, 0, sample);
    return sample;
  }
}

// Familiarity is per device: built from this device's walk history, never baked or fetched.

import { edgeDurableKey, type RoutingGraph } from "./graph";

// A month: a street walked daily stays familiar, one walked once fades over a season.
export const WALK_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

// Sightings at which familiarity reaches 1 - 1/e; one walk reads 0.39, three 0.78.
export const FAMILIAR_SIGHTINGS = 2;

// Half the multiplier's room, so a familiar street costs at least half and a known one at most 1.5x.
export const FAMILIAR_REACH = 0.5;

// Below this a record is a ghost of one walk four months gone, and is dropped on write.
export const FORGOTTEN_WEIGHT = 0.05;

// An exponentially decaying count, decayed lazily from `at`.
export interface WalkRecord {
  weight: number;
  at: number; // epoch ms the weight was last brought forward
}

export interface FamiliarField {
  edges: Uint8Array; // 0..254 per edge, the familiarity byte
  max: number; // the greatest byte / 255, the A* clip floor's input
}

export function decayedWeight(record: WalkRecord, now: number): number {
  const elapsed = Math.max(0, now - record.at);
  return record.weight * 2 ** (-elapsed / WALK_HALF_LIFE_MS);
}

// One more sighting, counted after decaying what was there.
export function sighted(
  record: WalkRecord | undefined,
  now: number,
): WalkRecord {
  return {
    weight: (record ? decayedWeight(record, now) : 0) + 1,
    at: now,
  };
}

// In [0, 1): saturates, so the hundredth walk adds little over the tenth.
export function familiarity(weight: number): number {
  return 1 - Math.exp(-weight / FAMILIAR_SIGHTINGS);
}

// Capped at 254 like the baked attributes, so no edge is ever free.
export function familiarByte(weight: number): number {
  return Math.min(254, Math.round(familiarity(weight) * 255));
}

// One pass over the edges, since records are keyed by durable key and the graph has no reverse index.
export function familiarField(
  graph: RoutingGraph,
  records: ReadonlyMap<number, WalkRecord>,
  now: number,
): FamiliarField | null {
  if (records.size === 0) {
    return null;
  }
  const edges = new Uint8Array(graph.edgeCount);
  let max = 0;
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    const record = records.get(edgeDurableKey(graph, edge));
    if (record !== undefined) {
      const byte = familiarByte(decayedWeight(record, now));
      edges[edge] = byte;
      max = Math.max(max, byte);
    }
  }
  return max === 0 ? null : { edges, max: max / 255 };
}

export function familiarAttrOf(graph: RoutingGraph, edge: number): number {
  return graph.familiar
    ? (FAMILIAR_REACH * graph.familiar.edges[edge]) / 255
    : 0;
}

export function familiarMax(graph: RoutingGraph): number {
  return graph.familiar ? FAMILIAR_REACH * graph.familiar.max : 0;
}

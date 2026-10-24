// The graph's identity, recomputed from its bytes rather than trusted from version.json.

import { edgeDurableKey, type RoutingGraph } from "../src/routing/graph";

// FNV-1a 64, matching crates/tiler/src/graph.rs. 16-bit limbs: BigInt over 37 MB takes minutes.
export function graphHashOf(bytes: Uint8Array): string {
  const LOW = 0x01b3; // 0x100000001b3, as its two non-zero 16-bit limbs
  const HIGH = 0x0100;
  const limbs = [0x2325, 0x8422, 0x9ce4, 0xcbf2]; // 0xcbf29ce484222325, least significant first
  let [limb0, limb1, limb2, limb3] = limbs;
  for (const byte of bytes) {
    limb0 ^= byte;
    const product0 = limb0 * LOW;
    const product1 = limb1 * LOW + Math.floor(product0 / 0x10000);
    const product2 =
      limb2 * LOW + limb0 * HIGH + Math.floor(product1 / 0x10000);
    const product3 =
      limb3 * LOW + limb1 * HIGH + Math.floor(product2 / 0x10000);
    limb0 = product0 & 0xffff;
    limb1 = product1 & 0xffff;
    limb2 = product2 & 0xffff;
    limb3 = product3 & 0xffff;
  }
  return [limb3, limb2, limb1, limb0]
    .map((limb) => limb.toString(16).padStart(4, "0"))
    .join("");
}

// Must match `key_space_hash` in crates/tiler/src/graph.rs.
// The key set, not the bytes, which move on any rebuild (even an f32 ulp between Linux and macOS).
export function graphKeyHashOf(graph: RoutingGraph): string {
  const keys = new Float64Array(graph.edgeCount);
  let count = 0;
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    const key = edgeDurableKey(graph, edge);
    if (key >= 0) {
      keys[count] = key;
      count += 1;
    }
  }
  const durable = keys.subarray(0, count).sort();
  const bytes = new Uint8Array(8 * (count + 1));
  const view = new DataView(bytes.buffer);
  // Keys exceed a u32 but fit an exact double, so they're written as two u32 halves.
  const HALF = 0x1_0000_0000;
  view.setUint32(0, count, true);
  for (const [order, key] of durable.entries()) {
    view.setUint32(8 * order + 8, key % HALF, true);
    view.setUint32(8 * order + 12, Math.floor(key / HALF), true);
  }
  return graphHashOf(bytes);
}

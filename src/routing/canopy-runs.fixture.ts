// The bytes crates/tiler/src/canopy_runs.rs pins in its own test, so both readers answer for one file.

export const GRAPH_KEY_HASH = "a362598948ca0eb3";

// Four edges, the third uncovered: runs a short gap apart, a stretch through node 1, and a crown too short to draw.
export const CANOPY_RUNS_HEX =
  "4352554e020024000400000003000000b30eca48895962a30600000028001e00" +
  "a14c6da60032070a29031f10110132040013100802ac02029601d904";

export function fixtureBuffer(hex = CANOPY_RUNS_HEX): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let byte = 0; byte < bytes.length; byte++) {
    bytes[byte] = Number.parseInt(hex.slice(byte * 2, byte * 2 + 2), 16);
  }
  return bytes.buffer;
}

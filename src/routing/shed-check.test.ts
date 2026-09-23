// Real GRPH bytes, since the artifact must agree with the graph's durable key space, not its bytes.

import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGraphBytes } from "../../scripts/build-sheds";
import { checkSheds } from "../../scripts/check-sheds";
import { encodeSheds } from "../../scripts/shed-encode";
import { encodeGraph } from "./graph-bytes.fixture";

const LAST_DAY = 3136;
const KIND_SIDEWALK = 0;
const EDGE_LENGTH_SECTION = 8;

interface Edge {
  sourceId: number;
  side: number;
  ordinal: number;
  length: number;
}

const EDGES: readonly Edge[] = [
  { sourceId: 88, side: 1, ordinal: 0, length: 41.5 },
  { sourceId: 88, side: 1, ordinal: 1, length: 12.25 },
  { sourceId: 19, side: 4, ordinal: 0, length: 7.5 },
];

// Just enough for `decodeGraph`, which is all the gate reads.
function graphBytes(edges: readonly Edge[]): Uint8Array {
  return new Uint8Array(
    encodeGraph({
      originLng: -73.98,
      originLat: 40.75,
      scale: 1e-6,
      nodes: [
        { qx: 0, qy: 0 },
        { qx: 1_000, qy: 0 },
      ],
      edges: edges.map((edge) => ({
        a: 0,
        b: 1,
        kind: KIND_SIDEWALK,
        side: edge.side,
        length: edge.length,
        sourceId: edge.sourceId,
        ordinal: edge.ordinal,
      })),
    }),
  );
}

function lengthsAt(bytes: Uint8Array): number {
  return new DataView(bytes.buffer).getUint32(
    64 + 8 * EDGE_LENGTH_SECTION,
    true,
  );
}

async function deploy(
  graph: Uint8Array,
  placedAgainst: Uint8Array,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shed-check-"));
  const built = loadGraphBytes(graph);
  const artifact = encodeSheds(
    [],
    loadGraphBytes(placedAgainst).keyHash,
    LAST_DAY,
    [],
  );
  await Promise.all([
    writeFile(join(dir, "nyc.bin"), graph),
    writeFile(
      join(dir, "nyc.version.json"),
      JSON.stringify({
        graph: "nyc.bin",
        hash: built.hash,
        keyHash: built.keyHash,
      }),
    ),
    writeFile(join(dir, "open.bin"), artifact.open),
    writeFile(join(dir, "closed.bin"), artifact.closed),
  ]);
  return dir;
}

const GRAPH = graphBytes(EDGES);

test("a deploy whose artifact names its own key space passes", async () => {
  const dir = await deploy(GRAPH, GRAPH);

  await expect(checkSheds(join(dir, "nyc.bin"), dir)).resolves.toBeUndefined();
});

// Linux and macOS land a few f32 lengths a ulp apart; no shed moves, so this must pass.
test("a rebuild that moved only the lengths still passes", async () => {
  const perturbed = new Uint8Array(GRAPH);
  const view = new DataView(perturbed.buffer);
  const lengths = lengthsAt(perturbed);
  for (let edge = 0; edge < EDGES.length; edge++) {
    const at = lengths + edge * 4;
    const bits = new DataView(new ArrayBuffer(4));
    bits.setFloat32(0, view.getFloat32(at, true), true);
    bits.setUint32(0, bits.getUint32(0, true) + 1, true); // the next float up
    view.setFloat32(at, bits.getFloat32(0, true), true);
  }
  expect(loadGraphBytes(perturbed).hash).not.toBe(loadGraphBytes(GRAPH).hash);
  const dir = await deploy(perturbed, GRAPH);

  await expect(checkSheds(join(dir, "nyc.bin"), dir)).resolves.toBeUndefined();
});

test("a rebuild that split a source differently fails the deploy", async () => {
  // Cut in three where it was cut in two, so old ordinal 1 names different pavement.
  const resplit = graphBytes([
    ...EDGES,
    { sourceId: 88, side: 1, ordinal: 2, length: 12.25 },
  ]);
  const dir = await deploy(resplit, GRAPH);

  await expect(checkSheds(join(dir, "nyc.bin"), dir)).rejects.toThrow(
    `placed against key space ${loadGraphBytes(GRAPH).keyHash}, this graph's is` +
      ` ${loadGraphBytes(resplit).keyHash}`,
  );
});

test("a rebuild that shifted an ordinal fails the deploy", async () => {
  const shifted = graphBytes(
    EDGES.map((edge, index) =>
      index === 1 ? { ...edge, ordinal: 2 } : { ...edge },
    ),
  );
  const dir = await deploy(shifted, GRAPH);

  await expect(checkSheds(join(dir, "nyc.bin"), dir)).rejects.toThrow(
    "so every shed would resolve to nothing on the deployed map",
  );
});

test("a version file that has drifted from the graph fails too", async () => {
  const dir = await deploy(GRAPH, GRAPH);
  await writeFile(
    join(dir, "nyc.version.json"),
    JSON.stringify({
      graph: "nyc.bin",
      hash: loadGraphBytes(GRAPH).hash,
      keyHash: "0000000000000000",
    }),
  );

  // The client gates on this file, so a stale one blanks the map just as a stale artifact does.
  await expect(checkSheds(join(dir, "nyc.bin"), dir)).rejects.toThrow(
    "the deploy would serve a graph it names wrongly",
  );
});

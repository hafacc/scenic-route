// Fails the deploy if the committed shed artifact's key space doesn't match the built graph's,
// which would silently blank every shed. Compares key space, not bytes: f32 lengths differ by OS.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GraphIdentity } from "../src/routing/graph";
import { SHED_CITIES } from "../src/routing/shed-cities";
import { loadGraphBytes } from "./build-sheds";
import { shedDir as shedDirOf } from "./graph-inputs";
import { decodeShedArtifact, shedGraphMismatch } from "./shed-encode";

const ROUTING_DIR = join(import.meta.dirname, "..", "public", "routing");

export async function checkSheds(
  graphPath: string,
  shedDir: string,
): Promise<void> {
  const [graphBytes, open, closed] = await Promise.all([
    readFile(graphPath),
    readFile(join(shedDir, "open.bin")),
    readFile(join(shedDir, "closed.bin")),
  ]);
  // Recomputed in TypeScript, so this also checks the Rust key-space hash against this one.
  const { hash, keyHash } = loadGraphBytes(graphBytes);

  // The client trusts `version.json` without recomputing, so a drifted one blanks the map too.
  const version = await readFile(
    graphPath.replace(/\.bin$/, ".version.json"),
    "utf-8",
  ).catch(() => null);
  if (version !== null) {
    const declared = JSON.parse(version) as Partial<GraphIdentity>;
    if (declared.hash !== hash || declared.keyHash !== keyHash) {
      throw new Error(
        `${graphPath} is ${hash}/${keyHash} and its version file says` +
          ` ${declared.hash}/${declared.keyHash}: the deploy would serve a graph it names wrongly,` +
          " and every shed would resolve to nothing",
      );
    }
  }

  const artifact = decodeShedArtifact(
    new Uint8Array(open.buffer, open.byteOffset, open.byteLength),
    new Uint8Array(closed.buffer, closed.byteOffset, closed.byteLength),
  );
  const mismatch = shedGraphMismatch(artifact, keyHash);
  if (mismatch !== null) {
    throw new Error(
      `${mismatch}, so every shed would resolve to nothing on the deployed map.` +
        " A graph-input change and its re-place are one deploy: `bun run build-sheds`, commit" +
        ` ${shedDir}, then deploy. scripts/README.md has the whole refresh procedure.`,
    );
  }
  console.error(
    `sheds: ${artifact.open.length.toLocaleString()} standing, placed against key space ${keyHash}` +
      ` (graph ${hash}, ${graphPath})`,
  );
}

// Every shed city against its own graph, or one pair named on the command line.
if (import.meta.main) {
  const [graphPath, shedDir] = process.argv.slice(2);
  if (graphPath !== undefined && shedDir !== undefined) {
    await checkSheds(graphPath, shedDir);
  } else {
    for (const city of SHED_CITIES) {
      await checkSheds(join(ROUTING_DIR, `${city}.bin`), shedDirOf(city));
    }
  }
}

// Stamps what can change the graph's durable key set, which sheds resolve through; attribute-only
// inputs move no key. Reads the tiler's reports; computes nothing.

import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const PROBE_REPORT = join(ROOT, ".build", "key-probe.json");
const INPUTS_REPORT = join(ROOT, ".build", "graph-inputs.json");
// Beside the artifact, not in its header: a *.bin header change is a format bump for both readers.
export const SHED_INPUTS_PATH = join(ROOT, "public", "sheds", "inputs.json");

async function report<Report>(path: string, script: string): Promise<Report> {
  const text = await readFile(path, "utf-8").catch(() => null);
  if (text === null) {
    throw new Error(
      `${relative(ROOT, path)} is missing: run \`bun run ${script}\` first, which every` +
        " package.json script that needs the key space chains ahead of itself",
    );
  }
  return JSON.parse(text) as Report;
}

// Data half: the plan's sources plus their bytes. `files` makes a shrunken set visible in the diff.
export async function graphInputStamp(): Promise<{
  stamp: string;
  files: number;
}> {
  const { stamp, files } = await report<{ stamp?: string; files?: number }>(
    INPUTS_REPORT,
    "graph-inputs",
  );
  if (stamp === undefined || files === undefined) {
    throw new Error("tiler graph-inputs reported no stamp");
  }
  return { stamp, files };
}

// Code half: the key hash the pipeline produces on a fixture of real NYC slices, which stamps
// behavior rather than source text.
export async function keySpaceProbe(): Promise<string> {
  const { keyHash } = await report<{ keyHash?: string }>(
    PROBE_REPORT,
    "key-probe",
  );
  if (keyHash === undefined) {
    throw new Error("tiler key-probe reported no keyHash");
  }
  return keyHash;
}

// Halves kept apart so a mismatch can say which one moved.
export interface ShedInputs {
  stamp: string;
  files: number;
  keySpace: string;
}

export async function currentShedInputs(): Promise<ShedInputs> {
  const [{ stamp, files }, keySpace] = await Promise.all([
    graphInputStamp(),
    keySpaceProbe(),
  ]);
  return { stamp, files, keySpace };
}

export async function readShedInputs(): Promise<ShedInputs | null> {
  const text = await readFile(SHED_INPUTS_PATH, "utf-8").catch(() => null);
  return text === null ? null : (JSON.parse(text) as ShedInputs);
}

export async function writeShedInputs(): Promise<ShedInputs> {
  const inputs = await currentShedInputs();
  await writeFile(SHED_INPUTS_PATH, `${JSON.stringify(inputs, null, 2)}\n`);
  return inputs;
}

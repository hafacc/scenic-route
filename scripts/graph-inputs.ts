// Stamps what can change the graph's durable key set, which sheds resolve through; attribute-only
// inputs move no key. Reads the tiler's reports; computes nothing.

import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ShedCity } from "../src/routing/shed-cities";

const ROOT = join(import.meta.dirname, "..");
const PROBE_REPORT = join(ROOT, ".build", "key-probe.json");
const INPUTS_REPORT = join(ROOT, ".build", "graph-inputs.json");

// public/sheds/<city>/, placed on public/routing/<city>.bin.
export function shedDir(city: ShedCity): string {
  return join(ROOT, "public", "sheds", city);
}

// Beside the artifact, not in its header: a *.bin header change is a format bump for both readers.
export function shedInputsPath(city: ShedCity): string {
  return join(shedDir(city), "inputs.json");
}

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

// Data half: the city's sources plus their bytes. `files` makes a shrunken set visible in the diff.
export async function graphInputStamp(city: ShedCity): Promise<{
  stamp: string;
  files: number;
}> {
  const { cities } = await report<{
    cities?: Record<string, { stamp?: string; files?: number }>;
  }>(INPUTS_REPORT, "graph-inputs");
  const { stamp, files } = cities?.[city] ?? {};
  if (stamp === undefined || files === undefined) {
    throw new Error(`tiler graph-inputs reported no stamp for ${city}`);
  }
  return { stamp, files };
}

// Code half: the key hash the pipeline produces on a fixture of real NYC slices, which stamps
// behavior rather than source text. One per tiler, so every city's record carries the same one.
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

export async function currentShedInputs(city: ShedCity): Promise<ShedInputs> {
  const [{ stamp, files }, keySpace] = await Promise.all([
    graphInputStamp(city),
    keySpaceProbe(),
  ]);
  return { stamp, files, keySpace };
}

export async function readShedInputs(
  city: ShedCity,
): Promise<ShedInputs | null> {
  const text = await readFile(shedInputsPath(city), "utf-8").catch(() => null);
  return text === null ? null : (JSON.parse(text) as ShedInputs);
}

export async function writeShedInputs(city: ShedCity): Promise<ShedInputs> {
  const inputs = await currentShedInputs(city);
  await writeFile(shedInputsPath(city), `${JSON.stringify(inputs, null, 2)}\n`);
  return inputs;
}

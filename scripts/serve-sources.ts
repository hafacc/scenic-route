// Copies sources the client reads verbatim, data/<kind>/<id>.bin -> public/<kind>/<id>.bin.

import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import manifest from "../src/tree-cover/manifest.json";

type City = (typeof manifest.cities)[number];

// Structural test: the committed manifest JSON may predate the genus field.
function hasGenusLayer(city: City): boolean {
  return (city.field as { genus?: unknown }).genus != null;
}

const DATA_DIR = join(import.meta.dirname, "..", "data");
const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
// Tree points, for the genus dots the client draws live above the raster pyramid.
const TREE_DIR = join(PUBLIC_DIR, "trees");
// Only what the client fetches; tiler-only inputs like landuse stay in data/.
const SERVED_SOURCES = [
  "landmarks",
  "art",
  "legacy",
  "ferries",
  "subway",
  "highways",
  "dining",
  "industrial",
  "historic",
] as const;

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Emptied first so a dropped city or source doesn't keep serving its stale file.
async function serve(dir: string, files: [string, string][]): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [source, name] of files) {
    await copyFile(source, join(dir, name));
  }
}

async function serveSources(): Promise<void> {
  const cities: City[] = manifest.cities;
  for (const kind of SERVED_SOURCES) {
    const present: [string, string][] = [];
    for (const city of cities) {
      const source = join(DATA_DIR, kind, `${city.id}.bin`);
      if (await fileExists(source)) {
        present.push([source, `${city.id}.bin`]);
      }
    }
    await serve(join(PUBLIC_DIR, kind), present);
  }
  await serve(
    TREE_DIR,
    cities
      .filter(hasGenusLayer)
      .map((city) => [
        join(DATA_DIR, "trees", city.field.trees.file),
        city.field.trees.file,
      ]),
  );
}

await serveSources();

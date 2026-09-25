// Runs after `next build`, since the precache needs the export's hashed chunk names.
// Overwrites the committed no-cache stub public/sw.js, which lets dev register a worker safely.

import { execFileSync } from "node:child_process";
import { access, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { APP_PAGES, SHELL_EXTRAS } from "../src/pages";
import manifest from "../src/tree-cover/manifest.json";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "out");

// `_next/static/` is taken whole: filtering it risks missing a chunk a cold offline start needs.
const SHELL_FILES = [...APP_PAGES.map((page) => page.file), ...SHELL_EXTRAS];
const SHELL_DIRS = ["_next/static", "icons"];

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

// A missing precache file makes `cache.addAll` reject, so the worker silently never installs.
async function precacheList(): Promise<string[]> {
  const found: string[] = [];
  for (const file of SHELL_FILES) {
    const path = join(OUT, file);
    if (!(await exists(path))) {
      throw new Error(`out/${file} is missing — did \`next build\` finish?`);
    }
    found.push(path);
  }
  for (const dir of SHELL_DIRS) {
    const under = await filesUnder(join(OUT, dir));
    if (under.length === 0) {
      throw new Error(`out/${dir} is empty — did \`next build\` finish?`);
    }
    found.push(...under);
  }
  // Relative to the worker's scope, so the deploy's basePath need not be known here.
  return found.map((file) => relative(OUT, file).split("\\").join("/")).sort();
}

// Any change gives the worker new cache names, and old caches are deleted on activate.
function version(): string {
  const fromCi = process.env.GITHUB_SHA;
  if (fromCi) {
    return fromCi;
  }
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
}

const precache = await precacheList();

// Declared locally: @types/bun's globals clash with the DOM lib, and the CLI has no `--define`.
declare const Bun: {
  build(options: {
    entrypoints: string[];
    target: "browser";
    format: "iife";
    minify: boolean;
    define: Record<string, string>;
  }): Promise<{
    success: boolean;
    logs: unknown[];
    outputs: { text(): Promise<string> }[];
  }>;
};

const stamp = version();
const built = await Bun.build({
  entrypoints: [join(ROOT, "src/sw/worker.ts")],
  target: "browser",
  // Classic script: registration omits `{ type: "module" }`, and module workers aren't everywhere.
  format: "iife",
  minify: true,
  define: {
    SW_VERSION: JSON.stringify(stamp),
    SW_PRECACHE: JSON.stringify(precache),
    // Basemap tiles are cached only over these; baked in so the rule holds on the very first tile.
    SW_CITIES: JSON.stringify(
      manifest.cities.map(({ bounds }) => ({
        west: bounds.west,
        south: bounds.south,
        east: bounds.east,
        north: bounds.north,
      })),
    ),
  },
});
if (!built.success) {
  throw new AggregateError(built.logs, "could not bundle the service worker");
}

await writeFile(join(OUT, "sw.js"), await built.outputs[0].text());
console.log(`sw.js: ${precache.length} shell files precached at ${stamp}`);

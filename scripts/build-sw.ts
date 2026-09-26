// Runs after `next build`, since the precache needs the export's hashed chunk names.
// Overwrites the committed no-cache stub public/sw.js, which lets dev register a worker safely.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { APP_PAGES, SHELL_EXTRAS } from "../src/pages";
import { contentUnit, fileRequest } from "../src/sw/policy";
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

// Hashes what the deploy serves rather than trusting the tiler's stamps, which cover only its passes.
async function contentStamps(): Promise<Record<string, string>> {
  const scope = "https://sw.invalid/";
  const files = (await filesUnder(OUT))
    .map((file) => relative(OUT, file).split("\\").join("/"))
    .filter((path) => {
      const filed = fileRequest(`${scope}${path}`, scope);
      return filed !== null && filed.store !== "shell";
    })
    .sort();
  const hashes = new Map<string, ReturnType<typeof createHash>>();
  for (const path of files) {
    const unit = contentUnit(path);
    let hash = hashes.get(unit);
    if (!hash) {
      hash = createHash("sha256");
      hashes.set(unit, hash);
    }
    // The name too, so a file moving within its unit changes the stamp.
    hash.update(`${path}\0`);
    hash.update(await readFile(join(OUT, path)));
  }
  // 64 bits: a collision would only keep an entry the deploy changed.
  return Object.fromEntries(
    [...hashes].map(([unit, hash]) => [unit, hash.digest("hex").slice(0, 16)]),
  );
}

// Any change gives the worker a new shell cache, and the old one is deleted on activate.
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
const stamps = await contentStamps();
const built = await Bun.build({
  entrypoints: [join(ROOT, "src/sw/worker.ts")],
  target: "browser",
  // Classic script: registration omits `{ type: "module" }`, and module workers aren't everywhere.
  format: "iife",
  minify: true,
  define: {
    SW_VERSION: JSON.stringify(stamp),
    SW_PRECACHE: JSON.stringify(precache),
    SW_STAMPS: JSON.stringify(stamps),
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
console.log(
  `sw.js: ${precache.length} shell files precached at ${stamp}, ${Object.keys(stamps).length} data units stamped`,
);

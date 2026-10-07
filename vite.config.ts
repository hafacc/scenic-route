import { execFileSync } from "node:child_process";
import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { Features } from "lightningcss";
import { createLogger, defineConfig, loadEnv, type Plugin } from "vite";

// Every `process.env.NEXT_PUBLIC_*` that src/ reads (the names predate Vite); an unset one must still compile to `undefined`.
const PUBLIC_ENV = [
  "NEXT_PUBLIC_FERRY_SCHEDULE_BASE",
  "NEXT_PUBLIC_PROTOMAPS_KEY",
  "NEXT_PUBLIC_SHED_BASE",
  "NEXT_PUBLIC_TRANSIT_SCHEDULE_BASE",
];

// The same stamp scripts/build-sw.ts gives the worker, so one deploy has one version.
function version(): string {
  const fromCi = process.env.GITHUB_SHA;
  if (fromCi) {
    return fromCi;
  }
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: import.meta.dirname,
    encoding: "utf8",
  }).trim();
}

// Warnings are errors: Vite's and Rolldown's reach this logger, Svelte's reach `onwarn` below.
let warned = false;
const logger = createLogger();
const { warn, warnOnce } = logger;
logger.warn = (message, options) => {
  warned = true;
  warn(message, options);
};
logger.warnOnce = (message, options) => {
  warned = true;
  warnOnce(message, options);
};

// Fails at the end rather than on the first warning, so one build prints them all.
const failOnWarning: Plugin = {
  name: "fail-on-warning",
  apply: "build",
  closeBundle() {
    if (warned) {
      throw new Error("the build warned, and warnings are errors");
    }
  },
};

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, import.meta.dirname, "NEXT_PUBLIC_");
  return {
    plugins: [
      tailwindcss(),
      sveltekit({
        adapter: adapter({ pages: "out", assets: "out", strict: true }),
        files: { assets: "public" },
        paths: {
          relative: false,
        },
        version: { name: version() },
        onwarn(warning, defaultHandler) {
          warned = true;
          defaultHandler(warning);
        },
      }),
      failOnWarning,
    ],
    customLogger: logger,
    server: { port: 3000 },
    worker: { format: "es" },
    // Or the minifier turns the `min-width` queries Tailwind lowered back into range syntax.
    css: { lightningcss: { include: Features.MediaRangeSyntax } },
    build: {
      // Vite's defaults start at Firefox 114, which needs no fallback for `oklch()`; these keep it.
      cssTarget: ["chrome111", "edge111", "firefox111", "safari16.4"],
      // Leaflet's small images stay files the stylesheet points at, never inlined.
      assetsInlineLimit: 0,
      // Firebase is 626 kB minified as one vendor chunk, mostly Firestore.
      chunkSizeWarningLimit: 650,
      rolldownOptions: {
        // Plugin time as a share of the build is the machine's speed, not a fault in the code.
        checks: { bundlerTimings: false },
        output: {
          codeSplitting: {
            // Firebase gets its own chunk, shared by both pages and still loaded eagerly.
            groups: [
              {
                name: "firebase",
                test: /[\\/]node_modules[\\/]@?firebase[\\/]/,
              },
            ],
          },
        },
      },
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        command === "build" ? "production" : "development",
      ),
      ...Object.fromEntries(
        PUBLIC_ENV.map((name) => [
          `process.env.${name}`,
          JSON.stringify(env[name]) ?? "undefined",
        ]),
      ),
    },
  };
});

// @ts-check

// Must stay .js: configure-pages edits next.config.js, else writes a CommonJS one this ESM repo rejects.

/** @type {import("next").NextConfig} */
export default {
  images: { unoptimized: true },
  output: "export",
  // basePath is injected at deploy time by actions/configure-pages.
};

// Not end to end: bun 1.3 captures no spawnSync stdout from a subdirectory test; CI runs the script next.

import { expect, test } from "bun:test";
import { shedInputsMismatch } from "../../scripts/check-shed-inputs";

const PLACED = { stamp: "abc", files: 6, keySpace: "0123456789abcdef" };

test("an artifact placed against the committed inputs passes", () => {
  expect(shedInputsMismatch(PLACED, { ...PLACED })).toBeNull();
});

test("inputs that moved without a re-place say so, and say what to run", () => {
  const mismatch = shedInputsMismatch(PLACED, { ...PLACED, stamp: "def" });

  expect(mismatch).toContain("stamped abc");
  expect(mismatch).toContain("stamp def");
  expect(mismatch).toContain("bun run build-sheds");
  expect(mismatch).toContain("scripts/README.md");
});

test("a tiler that assigns keys differently says so on its own", () => {
  const mismatch = shedInputsMismatch(PLACED, {
    ...PLACED,
    keySpace: "fedcba9876543210",
  });

  expect(mismatch).toContain("0123456789abcdef");
  expect(mismatch).toContain("fedcba9876543210");
  expect(mismatch).toContain("bun run build-sheds");
  expect(mismatch).toContain("scripts/README.md");
});

test("an artifact that records nothing is not trusted", () => {
  expect(shedInputsMismatch(null, PLACED)).toContain(
    "public/sheds/inputs.json is missing",
  );
});

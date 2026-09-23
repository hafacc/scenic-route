import { expect, test } from "bun:test";
import { dueForCheck, offersReload, UPDATE_CHECK_MS } from "./update";

test("only a raised marker interrupts a session", () => {
  expect(offersReload(4, 3)).toBe(true);
  expect(offersReload(3, 3)).toBe(false);
  expect(offersReload(2, 3)).toBe(false);
});

test("flicking between apps does not re-check", () => {
  const opened = 1_700_000_000_000;
  expect(dueForCheck(opened + 30_000, opened)).toBe(false);
  expect(dueForCheck(opened + UPDATE_CHECK_MS - 1, opened)).toBe(false);
  expect(dueForCheck(opened + UPDATE_CHECK_MS, opened)).toBe(true);
});

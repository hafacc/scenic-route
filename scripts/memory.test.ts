import { expect, test } from "bun:test";
import { autoBudget, concurrencyOf, parseMemory, procKib } from "./memory";

const GIB = 2 ** 30;

test("a memory size reads with or without a binary suffix, as the tiler's", () => {
  expect(parseMemory("0")).toBe(0);
  expect(parseMemory("4096")).toBe(4096);
  expect(parseMemory("512M")).toBe(512 * 2 ** 20);
  expect(parseMemory("512m")).toBe(512 * 2 ** 20);
  expect(parseMemory("12G")).toBe(12 * GIB);
  expect(parseMemory("12GiB")).toBe(12 * GIB);
  expect(parseMemory("1.5G")).toBe(1.5 * GIB);
  expect(parseMemory("64K")).toBe(64 * 1024);
  expect(parseMemory("2T")).toBe(2 * 2 ** 40);
  expect(parseMemory("auto")).toBe("auto");
  expect(parseMemory(" AUTO ")).toBe("auto");
});

test("a nonsense memory size is rejected", () => {
  for (const value of [
    "",
    "G",
    "-1G",
    "12X",
    "1.2.3G",
    "twelve",
    "12 G",
    "1e3G",
  ]) {
    expect(() => parseMemory(value)).toThrow(/--memory/);
  }
});

test("auto keeps three GiB back and takes three quarters of the rest", () => {
  expect(autoBudget(0)).toBe(0);
  expect(autoBudget(7 * GIB)).toBe(3 * GIB);
  expect(autoBudget(15 * GIB)).toBe(9 * GIB);
});

test("auto takes an eighth of a small machine", () => {
  expect(autoBudget(3 * GIB)).toBe((3 * GIB) / 8);
  expect(autoBudget(2 * GIB)).toBe(GIB / 4);
  expect(autoBudget(4 * GIB)).toBe((3 * GIB) / 4);
  expect(autoBudget(5 * GIB)).toBe((3 * GIB) / 2);
});

test("a meminfo line reads in bytes", () => {
  const meminfo =
    "MemTotal:       16384000 kB\nMemFree:  100 kB\nMemAvailable:   15000000 kB\n";
  expect(procKib(meminfo, "MemAvailable")).toBe(15_000_000 * 1024);
  expect(procKib(meminfo, "Missing")).toBeNull();
});

test("a small budget runs one thing at a time, a large one runs ahead", () => {
  expect(concurrencyOf(0)).toEqual({ pageWorkers: 1, overlapStages: false });
  expect(concurrencyOf(GIB / 4)).toEqual({
    pageWorkers: 1,
    overlapStages: false,
  });
  expect(concurrencyOf(GIB)).toEqual({ pageWorkers: 2, overlapStages: false });
  expect(concurrencyOf(3 * GIB)).toEqual({
    pageWorkers: 4,
    overlapStages: true,
  });
});

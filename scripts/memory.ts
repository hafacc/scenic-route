// `--memory` for the fetch scripts, with the same semantics as crates/tiler/src/main.rs.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const GIB = 2 ** 30;
const MIB = 2 ** 20;

// What auto leaves the rest of the machine, as the tiler's AUTO_RESERVE.
const AUTO_RESERVE = 3 * GIB;

// Headroom per extra page in flight; a page's text, rows and derived records fit well inside.
const PAGE_BYTES = 512 * MIB;
const MAX_PAGE_WORKERS = 4;
// Overlapping stages can hold the canopy and a Socrata read's records at once.
const OVERLAP_BYTES = 2 * GIB;

export type Memory = "auto" | number;

// `auto`, or a size such as `0`, `512M`, `12G` or `1.5GiB`; suffixes are powers of 1024.
export function parseMemory(value: string): Memory {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === "auto") {
    return "auto";
  }
  const match = /^(\d+(?:\.\d*)?|\.\d+)([a-zA-Z]*)$/.exec(trimmed);
  const shifts: Record<string, number> = {
    "": 0,
    B: 0,
    K: 10,
    KB: 10,
    KIB: 10,
    M: 20,
    MB: 20,
    MIB: 20,
    G: 30,
    GB: 30,
    GIB: 30,
    T: 40,
    TB: 40,
    TIB: 40,
  };
  const shift = match ? shifts[match[2].toUpperCase()] : undefined;
  if (!match || shift === undefined) {
    throw new Error(
      `--memory: expected a size like 512M or 12G, or "auto", got ${JSON.stringify(value)}`,
    );
  }
  return Math.round(Number(match[1]) * 2 ** shift);
}

// 3/4 of what's free past the reserve, never under an eighth of it: the tiler's `auto_budget`.
export function autoBudget(available: number): number {
  return Math.max(
    Math.floor(Math.max(0, available - AUTO_RESERVE) / 4) * 3,
    Math.floor(available / 8),
  );
}

// A `/proc` style `Key:  1234 kB` line's value in bytes.
export function procKib(text: string, key: string): number | null {
  const match = new RegExp(`^${key}:\\s*(\\d+)\\s*kB$`, "m").exec(text);
  return match ? Number(match[1]) * 1024 : null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

// What this process's cgroup v2 still allows, null when unlimited or not on cgroup v2.
function cgroupRoom(): number | null {
  const membership = readText("/proc/self/cgroup");
  const path = membership
    ?.split("\n")
    .find((line) => line.startsWith("0::"))
    ?.slice(3);
  if (path === undefined) {
    return null;
  }
  const directory = join("/sys/fs/cgroup", path);
  const limit = Number.parseInt(
    readText(join(directory, "memory.max")) ?? "",
    10,
  );
  const current = Number.parseInt(
    readText(join(directory, "memory.current")) ?? "",
    10,
  );
  if (!Number.isFinite(limit) || !Number.isFinite(current)) {
    return null;
  }
  return Math.max(0, limit - current);
}

function gib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

// The budget in bytes, and how it was arrived at for the log.
export function memoryBudget(memory: Memory): { bytes: number; why: string } {
  if (memory !== "auto") {
    return { bytes: memory, why: "--memory" };
  }
  const free = procKib(readText("/proc/meminfo") ?? "", "MemAvailable");
  if (free === null) {
    return { bytes: 0, why: "auto: no MemAvailable, so none" };
  }
  const room = cgroupRoom();
  if (room !== null && room < free) {
    return {
      bytes: autoBudget(room),
      why: `auto: cgroup room ${gib(room)}, MemAvailable ${gib(free)}`,
    };
  }
  return { bytes: autoBudget(free), why: `auto: MemAvailable ${gib(free)}` };
}

// How far the fetch may run ahead of itself; a zero budget is strictly one thing at a time.
export interface Concurrency {
  pageWorkers: number; // Socrata pages fetched and parsed at once
  overlapStages: boolean; // independent stages run side by side
}

export function concurrencyOf(budgetBytes: number): Concurrency {
  return {
    pageWorkers: Math.max(
      1,
      Math.min(MAX_PAGE_WORKERS, Math.floor(budgetBytes / PAGE_BYTES)),
    ),
    overlapStages: budgetBytes >= OVERLAP_BYTES,
  };
}

function mib(bytes: number): string {
  return `${Math.round(bytes / MIB)} MiB`;
}

// Resident, peak resident (VmHWM) and JS heap, for `--log-memory`.
export function memoryLine(): string {
  const usage = process.memoryUsage();
  const peak = procKib(readText("/proc/self/status") ?? "", "VmHWM");
  return `rss ${mib(usage.rss)}, peak ${peak === null ? "?" : mib(peak)}, heap ${mib(usage.heapUsed)}/${mib(usage.heapTotal)}`;
}

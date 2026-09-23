"use client";

// Measured: NYC at every zoom is ~400 MB of overlay and SF far less. Routing is capped separately.

export interface CoverageOption {
  id: string;
  label: string;
  detail: string;
  bytes: number | null; // null is no cap
}

const MB = 1024 * 1024;

export const COVERAGE: readonly CoverageOption[] = [
  {
    id: "recent",
    label: "Recent areas only",
    detail: "about 250 MB",
    bytes: 250 * MB,
  },
  {
    id: "city",
    label: "One city",
    detail: "about 500 MB",
    bytes: 500 * MB,
  },
  {
    id: "both",
    label: "Both cities",
    detail: "about 1 GB",
    bytes: 1024 * MB,
  },
  {
    id: "unlimited",
    label: "Everything I look at",
    detail: "as much as your device allows",
    bytes: null,
  },
];

// The cap the worker was written with.
export const DEFAULT_COVERAGE = "both";

export function coverageBytes(id: string): number | null {
  return (COVERAGE.find((option) => option.id === id) ?? COVERAGE[2]).bytes;
}

// Coarse because the cap itself is approximate; "0 MB kept" would read as a failure.
export function formatBytes(bytes: number): string {
  if (bytes >= 0.95 * 1024 * MB) {
    return `${(bytes / (1024 * MB)).toFixed(1)} GB`;
  } else if (bytes >= MB) {
    return `${Math.round(bytes / MB)} MB`;
  } else if (bytes > 0) {
    return "under 1 MB";
  } else {
    return "";
  }
}

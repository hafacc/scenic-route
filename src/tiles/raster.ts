"use client";

// Tile canvas pixels are what gets the tab killed on iOS; capping ratio 3 at 2 saves 56% of bytes.
const MAX_RATIO = 2;

export function tileRatio(): number {
  return Math.min(window.devicePixelRatio || 1, MAX_RATIO);
}

// Off-screen tile rings; four is ~140 tiles per layer, and two still covers a fast wide-screen drag.
export const KEEP_BUFFER = 2;

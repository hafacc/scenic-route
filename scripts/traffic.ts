// Conflates traffic counts (AADT on count centerlines) onto OSM road lines in the planar.ts meter frame.

import { projectX, projectY } from "./planar";
import type { Coord } from "./socrata";

export interface VolumeLine {
  aadt: number; // two-way annual average daily traffic
  name: string | null;
  points: Coord[];
}

export interface RoadLine {
  name: string | null;
  points: Coord[];
}

export interface Conflation {
  aadt: number | null; // null when too little of the line found a count
  meters: number;
  matchedMeters: number;
}

// How far off, and how far askew, a count line may run from a road and still be its count.
export interface Reach {
  meters: number;
  degrees: number;
}

export const STRICT_REACH: Reach = { meters: 25, degrees: 20 };
// For a highway the strict pass missed: its count line can sit mid-median or off a curving ramp.
export const LOOSE_REACH: Reach = { meters: 60, degrees: 30 };

const SAMPLE_METERS = 10;
// Below this share a line's matches are crossings and junction slivers, not its own count.
const MIN_MATCHED_SHARE = 0.25;

const ABBREVIATIONS = new Map<string, string>([
  ["AVENUE", "AVE"],
  ["AV", "AVE"],
  ["STREET", "ST"],
  ["BOULEVARD", "BLVD"],
  ["PARKWAY", "PKWY"],
  ["ROAD", "RD"],
  ["PLACE", "PL"],
  ["DRIVE", "DR"],
  ["EXPRESSWAY", "EXPY"],
  ["EXP", "EXPY"],
  ["EXTENSION", "EXT"],
  ["BRIDGE", "BR"],
  ["HIGHWAY", "HWY"],
  ["TERRACE", "TER"],
  ["LANE", "LN"],
  ["SQUARE", "SQ"],
  ["EAST", "E"],
  ["WEST", "W"],
  ["NORTH", "N"],
  ["SOUTH", "S"],
]);

export function normalizedName(name: string | null): string[] | null {
  if (!name) {
    return null;
  }
  const tokens = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => token !== "")
    .map((token) => ABBREVIATIONS.get(token) ?? token);
  return tokens.length > 0 ? tokens : null;
}

// Equal, or one a whole-token prefix of the other ("4TH AVE" and "4TH AVE EXT").
export function namesAgree(left: string[], right: string[]): boolean {
  const [short, long] =
    left.length <= right.length ? [left, right] : [right, left];
  return short.every((token, index) => token === long[index]);
}

export function weightedMedian(
  values: readonly number[],
  weights: readonly number[],
): number | null {
  const order = values
    .map((_, index) => index)
    .filter((index) => weights[index] > 0)
    .sort((left, right) => values[left] - values[right]);
  let total = 0;
  for (const index of order) {
    total += weights[index];
  }
  if (total === 0) {
    return null;
  }
  let running = 0;
  for (const index of order) {
    running += weights[index];
    if (running >= total / 2) {
      return values[index];
    }
  }
  return values[order[order.length - 1]];
}

// Undirected: a carriageway drawn either way along the count line agrees with it.
function bearingGap(ax: number, ay: number, bx: number, by: number): number {
  const gap = Math.abs(Math.atan2(ay, ax) - Math.atan2(by, bx)) % Math.PI;
  return Math.min(gap, Math.PI - gap);
}

interface Segments {
  coords: Float64Array; // [ax, ay, bx, by] per segment
  line: Int32Array;
  cells: Map<number, number[]>;
}

function cellKey(gx: number, gy: number): number {
  return (gx + 0x8000) * 0x10000 + (gy + 0x8000);
}

// Cells at least the reach wide, so a sample's 3x3 block of cells holds every segment in reach.
function indexSegments(
  volumes: readonly VolumeLine[],
  cellMeters: number,
): Segments {
  let count = 0;
  for (const { points } of volumes) {
    count += Math.max(0, points.length - 1);
  }
  const coords = new Float64Array(count * 4);
  const line = new Int32Array(count);
  const cells = new Map<number, number[]>();
  let segment = 0;
  volumes.forEach(({ points }, index) => {
    for (let vertex = 0; vertex + 1 < points.length; vertex++) {
      const ax = projectX(points[vertex].lng);
      const ay = projectY(points[vertex].lat);
      const bx = projectX(points[vertex + 1].lng);
      const by = projectY(points[vertex + 1].lat);
      coords.set([ax, ay, bx, by], segment * 4);
      line[segment] = index;
      const gx0 = Math.floor(Math.min(ax, bx) / cellMeters);
      const gx1 = Math.floor(Math.max(ax, bx) / cellMeters);
      const gy0 = Math.floor(Math.min(ay, by) / cellMeters);
      const gy1 = Math.floor(Math.max(ay, by) / cellMeters);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const key = cellKey(gx, gy);
          const bucket = cells.get(key);
          if (bucket) {
            bucket.push(segment);
          } else {
            cells.set(key, [segment]);
          }
        }
      }
      segment += 1;
    }
  });
  return { coords, line, cells };
}

function distance2(
  px: number,
  py: number,
  coords: Float64Array,
  segment: number,
): number {
  const ax = coords[segment * 4];
  const ay = coords[segment * 4 + 1];
  const dx = coords[segment * 4 + 2] - ax;
  const dy = coords[segment * 4 + 3] - ay;
  const length2 = dx * dx + dy * dy;
  const t =
    length2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2));
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

// Each ~10 m of a road takes its nearest count line within reach, preferring one of the same
// name; the line's AADT is the length-weighted median of those.
export function conflateVolumes(
  roads: readonly RoadLine[],
  volumes: readonly VolumeLine[],
  reach: Reach = STRICT_REACH,
): Conflation[] {
  const cellMeters = 2 * reach.meters;
  const { coords, line, cells } = indexSegments(volumes, cellMeters);
  const volumeNames = volumes.map(({ name }) => normalizedName(name));
  const maxBearing = (reach.degrees * Math.PI) / 180;
  const reach2 = reach.meters * reach.meters;

  return roads.map(({ name, points }) => {
    const roadName = normalizedName(name);
    const values: number[] = [];
    const weights: number[] = [];
    let meters = 0;
    let matchedMeters = 0;
    for (let vertex = 0; vertex + 1 < points.length; vertex++) {
      const ax = projectX(points[vertex].lng);
      const ay = projectY(points[vertex].lat);
      const dx = projectX(points[vertex + 1].lng) - ax;
      const dy = projectY(points[vertex + 1].lat) - ay;
      const length = Math.hypot(dx, dy);
      meters += length;
      if (length === 0) {
        continue;
      }
      const samples = Math.max(1, Math.round(length / SAMPLE_METERS));
      for (let sample = 0; sample < samples; sample++) {
        const t = (sample + 0.5) / samples;
        const px = ax + t * dx;
        const py = ay + t * dy;
        const gx = Math.floor(px / cellMeters);
        const gy = Math.floor(py / cellMeters);
        let nearest = -1;
        let nearest2 = reach2;
        let named = -1;
        let named2 = reach2;
        for (let cx = gx - 1; cx <= gx + 1; cx++) {
          for (let cy = gy - 1; cy <= gy + 1; cy++) {
            for (const segment of cells.get(cellKey(cx, cy)) ?? []) {
              const d2 = distance2(px, py, coords, segment);
              if (d2 > nearest2 && d2 > named2) {
                continue;
              }
              const sx = coords[segment * 4 + 2] - coords[segment * 4];
              const sy = coords[segment * 4 + 3] - coords[segment * 4 + 1];
              if (bearingGap(dx, dy, sx, sy) > maxBearing) {
                continue;
              }
              if (d2 <= nearest2) {
                nearest = segment;
                nearest2 = d2;
              }
              const other = volumeNames[line[segment]];
              if (
                d2 <= named2 &&
                roadName &&
                other &&
                namesAgree(roadName, other)
              ) {
                named = segment;
                named2 = d2;
              }
            }
          }
        }
        const chosen = named >= 0 ? named : nearest;
        if (chosen >= 0) {
          values.push(volumes[line[chosen]].aadt);
          weights.push(length / samples);
          matchedMeters += length / samples;
        }
      }
    }
    const aadt =
      matchedMeters >= MIN_MATCHED_SHARE * meters && matchedMeters > 0
        ? weightedMedian(values, weights)
        : null;
    return { aadt, meters, matchedMeters };
  });
}

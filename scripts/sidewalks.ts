// OSM records sidewalks as separate ways or as `sidewalk*` road tags; the East Bay mostly tags.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildNameTable, densify, encodeNetwork, UNNAMED_ID } from "./geometry";
import type { LandContext } from "./land";
import type { SourceFile } from "./manifest";
import {
  fetchSidewalks,
  fetchSidewalkTags,
  type SidewalkTaggedRoad,
  type SidewalkWay,
} from "./overpass";
import { projectX, projectY } from "./planar";
import { SIDEWALK_WIDTH_COUNT, SIDEWALK_WIDTH_DATASET } from "./sf";
import { type Coord, DATA_SF, NYC_OPEN_DATA } from "./socrata";
import { FLAG_TUNNEL, toInt } from "./streets";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const SIDEWALK_DIR = join(DATA_DIR, "sidewalks");
const SIDEWALK_MAGIC = "SWLK";
const SIDEWALK_FORMAT = 1;
// Outside CSCL's rw_type (1..10) and PATH's 6/7, so a misread file can't pass for a road type.
const KIND_SIDEWALK = 20;
const KIND_CROSSING = 21;
const KIND_TRAFFIC_ISLAND = 22;
const DENSIFY_METERS = 25; // PATH's step
const U32_MAX = 0xffffffff; // the record id is a u32

// STRT byte 23, bits 3-6; left is 90 degrees counter-clockwise of digitization direction.
export const FLAG_OSM_LEFT = 1 << 3;
export const FLAG_OSM_RIGHT = 1 << 4;
// The city survey, else OSM's road tag, says there is a sidewalk; nothing about its surface.
export const FLAG_SURVEYED_LEFT = 1 << 5;
export const FLAG_SURVEYED_RIGHT = 1 << 6;

// Not the conflation's 6 m dedup band: a narrow street's sidewalk sits at ~5.7 m, inside it.
const SAMPLE_METERS = 20;
const MIN_MATCH_METERS = 2; // so a way on the centerline can't claim both sides
const EXTRA_MATCH_METERS = 12; // beyond the side's half-offset
const MATCH_BEARING_DEGREES = 30; // mod 180: a sidewalk may be digitized either way round
const MATCH_FRACTION = 0.5; // of a segment's samples, for the side to count as mapped

// The fan absorbs half-meter errors in CSCL's roadway width or centerline.
const STATION_METERS = 15;
const PROBE_FAN_METERS = [-1.5, 0, 1.5];
// Covers the 1st-99th percentile of recorded widths (10-70 ft) around the assumed median.
const ASSUMED_WIDTH_FAN_METERS = [-3, -1.5, 0, 1.5, 3, 4.5, 6];
const SURVEYED_FRACTION = 0.5;
const PROBE_GRID_METERS = 40;

const SIDEWALK_DATASET = "52n9-sdep"; // NYC planimetric SIDEWALK polygons
const SIDEWALK_SUB_CODE = "380000"; // street ROW; 380010 is the interior-campus walkway
const SIDEWALK_POLYGON_COUNT = 44_683; // a floor

// Mirrors crates/tiler/src/sidewalks.rs::half_offset_meters.
const METERS_PER_FOOT = 0.3048;
const MEDIAN_WIDTH_FEET = 30;
const SIDEWALK_INSET_METERS = 2;
const MAX_OFFSET_METERS = 25.5;
const FLAG_VEHICULAR_ONLY = 1 << 0;
const FLAG_NON_VEHICULAR = 1 << 1;
const FLAG_STRUCTURE = 1 << 2;
const WIDTH_BASED_TYPES = [1, 3, 4, 10]; // street, bridge, tunnel, alley

// `flags` is stamped in place.
export interface SidedSegment {
  physicalId: number;
  roadType: number;
  streetWidth: number;
  flags: number;
  lengthMeters: number;
  points: Coord[];
}

function halfOffsetMeters(segment: SidedSegment): number {
  if (
    !WIDTH_BASED_TYPES.includes(segment.roadType) ||
    (segment.flags & FLAG_NON_VEHICULAR) !== 0
  ) {
    return 0;
  }
  const feet =
    segment.streetWidth === 0 ? MEDIAN_WIDTH_FEET : segment.streetWidth;
  return Math.min(
    (feet * METERS_PER_FOOT) / 2 + SIDEWALK_INSET_METERS,
    MAX_OFFSET_METERS,
  );
}

function isOffsetted(segment: SidedSegment): boolean {
  return (
    (segment.flags & FLAG_VEHICULAR_ONLY) === 0 && halfOffsetMeters(segment) > 0
  );
}

class Grid<Item> {
  private readonly cells = new Map<number, Item[]>();

  constructor(private readonly cellMeters: number) {}

  private static key(cellX: number, cellY: number): number {
    return cellX * 100_003 + cellY;
  }

  insert(item: Item, box: readonly number[]): void {
    const [minX, minY, maxX, maxY] = box;
    for (
      let cellX = Math.floor(minX / this.cellMeters);
      cellX <= Math.floor(maxX / this.cellMeters);
      cellX++
    ) {
      for (
        let cellY = Math.floor(minY / this.cellMeters);
        cellY <= Math.floor(maxY / this.cellMeters);
        cellY++
      ) {
        const key = Grid.key(cellX, cellY);
        const cell = this.cells.get(key);
        if (cell === undefined) {
          this.cells.set(key, [item]);
        } else {
          cell.push(item);
        }
      }
    }
  }

  near(x: number, y: number, radiusMeters: number): Item[] {
    const ring = Math.ceil(radiusMeters / this.cellMeters);
    const centerX = Math.floor(x / this.cellMeters);
    const centerY = Math.floor(y / this.cellMeters);
    const found: Item[] = [];
    for (let cellX = centerX - ring; cellX <= centerX + ring; cellX++) {
      for (let cellY = centerY - ring; cellY <= centerY + ring; cellY++) {
        const cell = this.cells.get(Grid.key(cellX, cellY));
        if (cell !== undefined) {
          found.push(...cell);
        }
      }
    }
    return found;
  }
}

interface Piece {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function indexPieces(segments: readonly SidewalkSegment[]): Grid<Piece> {
  const grid = new Grid<Piece>(PROBE_GRID_METERS);
  for (const way of segments) {
    if (way.kind !== KIND_SIDEWALK) {
      continue;
    }
    for (let index = 1; index < way.points.length; index++) {
      const from = way.points[index - 1];
      const to = way.points[index];
      const piece = {
        x1: projectX(from.lng),
        y1: projectY(from.lat),
        x2: projectX(to.lng),
        y2: projectY(to.lat),
      };
      grid.insert(piece, [
        Math.min(piece.x1, piece.x2),
        Math.min(piece.y1, piece.y2),
        Math.max(piece.x1, piece.x2),
        Math.max(piece.y1, piece.y2),
      ]);
    }
  }
  return grid;
}

function sampleSides(
  pieces: Grid<Piece>,
  x: number,
  y: number,
  alongX: number,
  alongY: number,
  halfOffset: number,
): [boolean, boolean] {
  const limit = halfOffset + EXTRA_MATCH_METERS;
  const cosLimit = Math.cos((MATCH_BEARING_DEGREES * Math.PI) / 180);
  let left = false;
  let right = false;
  for (const piece of pieces.near(x, y, limit)) {
    const edgeX = piece.x2 - piece.x1;
    const edgeY = piece.y2 - piece.y1;
    const length = Math.hypot(edgeX, edgeY);
    if (length === 0) {
      continue;
    } else if (
      Math.abs((edgeX * alongX + edgeY * alongY) / length) < cosLimit
    ) {
      continue;
    }
    const along = Math.max(
      0,
      Math.min(
        1,
        ((x - piece.x1) * edgeX + (y - piece.y1) * edgeY) / (length * length),
      ),
    );
    const toX = piece.x1 + along * edgeX - x;
    const toY = piece.y1 + along * edgeY - y;
    const distance = Math.hypot(toX, toY);
    if (distance < MIN_MATCH_METERS || distance > limit) {
      continue;
    } else if (alongX * toY - alongY * toX > 0) {
      left = true;
    } else {
      right = true;
    }
    if (left && right) {
      return [true, true];
    }
  }
  return [left, right];
}

interface Station {
  x: number;
  y: number;
  alongX: number;
  alongY: number;
}

// Centered in equal pieces: a station on an end vertex would probe into the cross street.
function stations(points: readonly Coord[], stepMeters: number): Station[] {
  const xs = points.map((point) => projectX(point.lng));
  const ys = points.map((point) => projectY(point.lat));
  let total = 0;
  for (let index = 1; index < xs.length; index++) {
    total += Math.hypot(xs[index] - xs[index - 1], ys[index] - ys[index - 1]);
  }
  if (total === 0) {
    return [];
  }
  const count = Math.max(1, Math.ceil(total / stepMeters));
  const spacing = total / count;
  const found: Station[] = [];
  let traveled = 0; // arc length at the start of the current piece
  let which = 0;
  for (let index = 1; index < xs.length && which < count; index++) {
    const edgeX = xs[index] - xs[index - 1];
    const edgeY = ys[index] - ys[index - 1];
    const length = Math.hypot(edgeX, edgeY);
    if (length === 0) {
      continue;
    }
    const alongX = edgeX / length;
    const alongY = edgeY / length;
    while (which < count && (which + 0.5) * spacing <= traveled + length) {
      const at = (which + 0.5) * spacing - traveled;
      found.push({
        x: xs[index - 1] + alongX * at,
        y: ys[index - 1] + alongY * at,
        alongX,
        alongY,
      });
      which += 1;
    }
    traveled += length;
  }
  return found;
}

interface PolygonRow {
  the_geom?: { coordinates: [number, number][][][] };
}

// Interleaved meters; hits resolve even-odd per feature, not across every nearby ring.
interface Ring {
  feature: number;
  coords: Float64Array;
}

// The 2014 Sidewalk Widths study's `side` is "Both", "None" or a compass side; no row is unstated.
async function sfSurvey(): Promise<Survey> {
  const rows = await DATA_SF.dataset<{ cnn?: string; side?: string }>(
    SIDEWALK_WIDTH_DATASET,
    { $select: "cnn,side" },
    SIDEWALK_WIDTH_COUNT,
  );
  // `toInt` as the segment id got; a raw ".0" or leading zero would silently miss every join.
  const sides = new Map<string, string>();
  for (const row of rows) {
    if (row.cnn && row.side) {
      sides.set(String(toInt(row.cnn)), row.side.trim().toUpperCase());
    }
  }
  return (segment) => {
    const side = sides.get(String(segment.physicalId));
    if (side === undefined) {
      return { left: "unstated", right: "unstated" };
    }
    if (side === "NONE") {
      return { left: "bare", right: "bare" };
    }
    if (side === "BOTH") {
      return { left: "paved", right: "paved" };
    }
    // End to end is enough: a block doesn't turn far enough to flip a compass side.
    const first = segment.points[0];
    const last = segment.points[segment.points.length - 1];
    const bearing = Math.atan2(
      (last.lng - first.lng) * Math.cos(((first.lat + last.lat) / 2) * DEGREES),
      last.lat - first.lat,
    );
    const facing = (turn: number): number =>
      ((bearing + turn) / DEGREES + 360) % 360;
    const wanted = COMPASS[side];
    if (wanted === undefined) {
      return { left: "unstated", right: "unstated" };
    }
    const away = (from: number): number => {
      const gap = Math.abs(((from - wanted + 540) % 360) - 180);
      return gap;
    };
    // Naming one side states the other bare.
    const left = away(facing(-Math.PI / 2)) < away(facing(Math.PI / 2));
    return {
      left: left ? "paved" : "bare",
      right: left ? "bare" : "paved",
    };
  };
}

const DEGREES = Math.PI / 180;
const COMPASS: Record<string, number> = {
  // One row spells south "STH"; it is not "both".
  STH: 180,
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
};

export const NYC_SURVEY: () => Promise<Survey> = async () =>
  polygonSurvey(await fetchSurveyedSidewalks());
export const SF_SURVEY: () => Promise<Survey> = sfSurvey;

async function fetchSurveyedSidewalks(): Promise<Grid<Ring>> {
  // Geometry alone, not `*`: these polygons are ~450 MB of GeoJSON already.
  const rows = await NYC_OPEN_DATA.dataset<PolygonRow>(
    SIDEWALK_DATASET,
    { $select: "the_geom", $where: `sub_code='${SIDEWALK_SUB_CODE}'` },
    SIDEWALK_POLYGON_COUNT,
  );
  const grid = new Grid<Ring>(PROBE_GRID_METERS);
  let feature = 0;
  for (const row of rows) {
    for (const polygon of row.the_geom?.coordinates ?? []) {
      feature += 1;
      for (const ring of polygon) {
        const coords = new Float64Array(ring.length * 2);
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (let index = 0; index < ring.length; index++) {
          const x = projectX(ring[index][0]);
          const y = projectY(ring[index][1]);
          coords[index * 2] = x;
          coords[index * 2 + 1] = y;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
        grid.insert({ feature, coords }, [minX, minY, maxX, maxY]);
      }
    }
  }
  return grid;
}

function inRing(coords: Float64Array, x: number, y: number): boolean {
  let inside = false;
  for (
    let at = 0, previous = coords.length - 2;
    at < coords.length;
    previous = at, at += 2
  ) {
    const atY = coords[at + 1];
    const previousY = coords[previous + 1];
    if (
      atY > y !== previousY > y &&
      x <
        ((coords[previous] - coords[at]) * (y - atY)) / (previousY - atY) +
          coords[at]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function onSurveyedSidewalk(survey: Grid<Ring>, x: number, y: number): boolean {
  const hits: number[] = [];
  for (const ring of survey.near(x, y, 0)) {
    if (inRing(ring.coords, x, y)) {
      hits.push(ring.feature);
    }
  }
  if (hits.length < 2) {
    return hits.length === 1;
  } else {
    // Even-odd per feature; rings of different features never overlap.
    return hits.some(
      (feature) => hits.filter((other) => other === feature).length % 2 === 1,
    );
  }
}

// Only "paved" sets a bit, but a stated bare stops a weaker source from being asked.
export type SideState = "paved" | "bare" | "unstated";

// In the segment's own digitization left/right.
export interface SidewalkSides {
  left: SideState;
  right: SideState;
}

export type Survey = (segment: SidedSegment) => SidewalkSides;

// Not a union: OSM tags fill only sides the city survey leaves unstated.
export function statedSides(
  own: SidewalkSides,
  tagged: () => SidewalkSides,
): SidewalkSides {
  if (own.left !== "unstated" && own.right !== "unstated") {
    return own;
  } else {
    const tags = tagged();
    return {
      left: own.left === "unstated" ? tags.left : own.left,
      right: own.right === "unstated" ? tags.right : own.right,
    };
  }
}

// `separate` is no statement: the drawn way, if any, is already what the OSM bits read.
function sideState(value: string | undefined): SideState {
  switch (value) {
    case "yes":
      return "paved";
    case "no":
    case "none":
      return "bare";
    default:
      return "unstated";
  }
}

// In the way's direction; side-specific keys override the generic `sidewalk`, per OSM convention.
export function taggedSides(road: SidewalkTaggedRoad): SidewalkSides {
  let left: SideState = "unstated";
  let right: SideState = "unstated";
  switch (road.sidewalk) {
    case "both":
    // `yes` is deprecated in favor of sided values; it names no side, so read it as both.
    case "yes":
      left = "paved";
      right = "paved";
      break;
    // "Left only", so the other curb is a stated bare.
    case "left":
      left = "paved";
      right = "bare";
      break;
    case "right":
      left = "bare";
      right = "paved";
      break;
    case "no":
    case "none":
      left = "bare";
      right = "bare";
      break;
    default:
      break; // `separate`, `crossing`, absent
  }
  const both = sideState(road.both);
  if (both !== "unstated") {
    left = both;
    right = both;
  }
  const taggedLeft = sideState(road.left);
  if (taggedLeft !== "unstated") {
    left = taggedLeft;
  }
  const taggedRight = sideState(road.right);
  if (taggedRight !== "unstated") {
    right = taggedRight;
  }
  return { left, right };
}

// Sides are in the piece's own direction.
interface TaggedPiece extends Piece {
  left: SideState;
  right: SideState;
}

// Wide enough to reach an OSM dual carriageway whose halves straddle the city's one centerline.
const TAG_MATCH_METERS = 12;

function indexTaggedRoads(
  roads: readonly SidewalkTaggedRoad[],
): Grid<TaggedPiece> {
  const grid = new Grid<TaggedPiece>(PROBE_GRID_METERS);
  for (const road of roads) {
    const sides = taggedSides(road);
    if (sides.left === "unstated" && sides.right === "unstated") {
      continue; // e.g. `sidewalk:left:surface` or `separate`
    }
    for (let index = 1; index < road.points.length; index++) {
      const from = road.points[index - 1];
      const to = road.points[index];
      const piece = {
        x1: projectX(from.lng),
        y1: projectY(from.lat),
        x2: projectX(to.lng),
        y2: projectY(to.lat),
        left: sides.left,
        right: sides.right,
      };
      grid.insert(piece, [
        Math.min(piece.x1, piece.x2),
        Math.min(piece.y1, piece.y2),
        Math.max(piece.x1, piece.x2),
        Math.max(piece.y1, piece.y2),
      ]);
    }
  }
  return grid;
}

// Nearest only, so a spur grazing the radius can't outvote the road the station is on.
function nearestTagged(
  roads: Grid<TaggedPiece>,
  x: number,
  y: number,
  alongX: number,
  alongY: number,
): TaggedPiece | undefined {
  const cosLimit = Math.cos((MATCH_BEARING_DEGREES * Math.PI) / 180);
  let nearest: TaggedPiece | undefined;
  let nearestDistance = TAG_MATCH_METERS;
  for (const piece of roads.near(x, y, TAG_MATCH_METERS)) {
    const edgeX = piece.x2 - piece.x1;
    const edgeY = piece.y2 - piece.y1;
    const length = Math.hypot(edgeX, edgeY);
    if (length === 0) {
      continue;
    } else if (
      Math.abs((edgeX * alongX + edgeY * alongY) / length) < cosLimit
    ) {
      continue;
    }
    const along = Math.max(
      0,
      Math.min(
        1,
        ((x - piece.x1) * edgeX + (y - piece.y1) * edgeY) / (length * length),
      ),
    );
    const distance = Math.hypot(
      piece.x1 + along * edgeX - x,
      piece.y1 + along * edgeY - y,
    );
    if (distance < nearestDistance) {
      nearest = piece;
      nearestDistance = distance;
    }
  }
  return nearest;
}

// Fractions are over all stations, not matched ones: a tag on a fifth of a block doesn't state it.
export function tagSurvey(roads: readonly SidewalkTaggedRoad[]): Survey {
  const grid = indexTaggedRoads(roads);
  return (segment) => {
    const samples = stations(segment.points, SAMPLE_METERS);
    const paved = [0, 0]; // left, right
    const bare = [0, 0];
    for (const { x, y, alongX, alongY } of samples) {
      const piece = nearestTagged(grid, x, y, alongX, alongY);
      if (piece === undefined) {
        continue;
      }
      // The OSM way may run opposite to this street.
      const forward =
        (piece.x2 - piece.x1) * alongX + (piece.y2 - piece.y1) * alongY > 0;
      const sides = forward
        ? [piece.left, piece.right]
        : [piece.right, piece.left];
      for (const side of [0, 1]) {
        paved[side] += sides[side] === "paved" ? 1 : 0;
        bare[side] += sides[side] === "bare" ? 1 : 0;
      }
    }
    const decide = (side: number): SideState => {
      if (samples.length === 0) {
        return "unstated";
      } else if (paved[side] / samples.length >= MATCH_FRACTION) {
        return "paved";
      } else if (bare[side] / samples.length >= MATCH_FRACTION) {
        return "bare";
      } else {
        return "unstated";
      }
    };
    return { left: decide(0), right: decide(1) };
  };
}

function sidesOf(
  segment: SidedSegment,
  pieces: Grid<Piece>,
  surveyed: SidewalkSides,
): number {
  const halfOffset = halfOffsetMeters(segment);
  let osmLeft = 0;
  let osmRight = 0;
  const samples = stations(segment.points, SAMPLE_METERS);
  for (const { x, y, alongX, alongY } of samples) {
    const [left, right] = sampleSides(pieces, x, y, alongX, alongY, halfOffset);
    osmLeft += left ? 1 : 0;
    osmRight += right ? 1 : 0;
  }
  const covered = (hits: number, total: number, fraction: number): boolean =>
    total > 0 && hits / total >= fraction;
  return (
    (covered(osmLeft, samples.length, MATCH_FRACTION) ? FLAG_OSM_LEFT : 0) |
    (covered(osmRight, samples.length, MATCH_FRACTION) ? FLAG_OSM_RIGHT : 0) |
    (surveyed.left === "paved" ? FLAG_SURVEYED_LEFT : 0) |
    (surveyed.right === "paved" ? FLAG_SURVEYED_RIGHT : 0)
  );
}

function polygonSurvey(rings: Grid<Ring>): Survey {
  return (segment) => {
    const halfOffset = halfOffsetMeters(segment);
    const probes = stations(segment.points, STATION_METERS);
    const fanMeters =
      segment.streetWidth === 0 ? ASSUMED_WIDTH_FAN_METERS : PROBE_FAN_METERS;
    let left = 0;
    let right = 0;
    for (const { x, y, alongX, alongY } of probes) {
      for (const side of [1, -1]) {
        const hit = fanMeters.some((fan) => {
          const offset = side * (halfOffset + fan);
          return onSurveyedSidewalk(
            rings,
            x - alongY * offset,
            y + alongX * offset,
          );
        });
        if (side === 1) {
          left += hit ? 1 : 0;
        } else {
          right += hit ? 1 : 0;
        }
      }
    }
    // A citywide aerial trace, so no polygon means bare, not unstated.
    const covered = (hits: number): SideState =>
      probes.length > 0 && hits / probes.length >= SURVEYED_FRACTION
        ? "paved"
        : "bare";
    return { left: covered(left), right: covered(right) };
  };
}

const KIND_OF = {
  sidewalk: KIND_SIDEWALK,
  crossing: KIND_CROSSING,
  traffic_island: KIND_TRAFFIC_ISLAND,
} as const;

interface SidewalkSegment {
  osmId: number;
  kind: number;
  name: string;
  nameId: number;
  structure: boolean;
  tunnel: boolean;
  points: Coord[];
  lengthMeters: number;
}

// As the path ingest does: kept if its midpoint or either endpoint is on land.
function toSidewalkSegments(
  ways: readonly SidewalkWay[],
  onLand: (coord: Coord) => boolean,
): { segments: SidewalkSegment[]; onLandCount: number } {
  const segments: SidewalkSegment[] = [];
  let onLandCount = 0;
  for (const way of ways) {
    const { points } = way;
    const midpoint = points[Math.floor(points.length / 2)];
    if (
      !onLand(midpoint) &&
      !onLand(points[0]) &&
      !onLand(points[points.length - 1])
    ) {
      continue;
    }
    onLandCount += 1;
    if (way.id > U32_MAX) {
      continue;
    }
    const dense = densify(points, DENSIFY_METERS);
    segments.push({
      osmId: way.id,
      kind: KIND_OF[way.footway],
      name: (way.name ?? "").trim().toUpperCase(),
      nameId: UNNAMED_ID,
      structure: way.structure,
      tunnel: way.tunnel,
      points: dense.points,
      lengthMeters: dense.lengthMeters,
    });
  }
  return { segments, onLandCount };
}

function encodeSidewalks(
  segments: readonly SidewalkSegment[],
  names: readonly string[],
): Uint8Array {
  return encodeNetwork(
    SIDEWALK_MAGIC,
    SIDEWALK_FORMAT,
    segments.map((segment) => ({
      id: segment.osmId,
      nameId: segment.nameId,
      lengthMeters: segment.lengthMeters,
      kind: segment.kind,
      width: 0,
      speed: 0,
      flags:
        (segment.structure ? FLAG_STRUCTURE : 0) |
        (segment.tunnel ? FLAG_TUNNEL : 0),
      points: segment.points,
    })),
    names,
  );
}

// Also stamps the per-side bits into each offsetted street's flags, in place.
export async function ingestSidewalks(
  cityId: string,
  streets: SidedSegment[],
  land: LandContext,
  buildSurvey: () => Promise<Survey>,
): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(SIDEWALK_DIR, { recursive: true });

  const { south, west, north, east } = land.box;
  const ways = await fetchSidewalks(south, west, north, east);
  const roads = await fetchSidewalkTags(south, west, north, east);
  const { segments, onLandCount } = toSidewalkSegments(ways, land.onLand);
  const names = buildNameTable(segments);
  const bytes = encodeSidewalks(segments, names);
  const file = `${cityId}.bin`;
  await writeFile(join(SIDEWALK_DIR, file), bytes);

  const kept = segments.filter((segment) => segment.kind === KIND_SIDEWALK);
  const sidewalkKm =
    kept.reduce((total, segment) => total + segment.lengthMeters, 0) / 1000;
  console.error(
    `  sidewalks: ${ways.length} ways fetched, ${onLandCount} on land, ${segments.length} encoded (${sidewalkKm.toFixed(0)} km of sidewalk, ${names.length} distinct names)`,
  );

  const pieces = indexPieces(segments);
  const survey = await buildSurvey();
  const tags = tagSurvey(roads);
  const stating = roads.filter((road) => {
    const sides = taggedSides(road);
    return sides.left !== "unstated" || sides.right !== "unstated";
  }).length;

  let offsettedKm = 0;
  let osmBothKm = 0;
  let osmOneKm = 0;
  let surveyedBothKm = 0;
  let surveyedOneKm = 0;
  // Where the survey was silent; stated bare tells missing sidewalks from missing data.
  let taggedPavedSideKm = 0;
  let taggedBareSideKm = 0;
  for (const street of streets) {
    if (!isOffsetted(street)) {
      continue;
    }
    const own = survey(street);
    const stated = statedSides(own, () => tags(street));
    const bits = sidesOf(street, pieces, stated);
    street.flags |= bits;
    const km = street.lengthMeters / 1000;
    offsettedKm += km;
    for (const side of ["left", "right"] as const) {
      if (own[side] !== "unstated") {
        continue;
      }
      taggedPavedSideKm += stated[side] === "paved" ? km : 0;
      taggedBareSideKm += stated[side] === "bare" ? km : 0;
    }
    const osm =
      ((bits & FLAG_OSM_LEFT) !== 0 ? 1 : 0) +
      ((bits & FLAG_OSM_RIGHT) !== 0 ? 1 : 0);
    const surveyed =
      ((bits & FLAG_SURVEYED_LEFT) !== 0 ? 1 : 0) +
      ((bits & FLAG_SURVEYED_RIGHT) !== 0 ? 1 : 0);
    osmBothKm += osm === 2 ? km : 0;
    osmOneKm += osm === 1 ? km : 0;
    surveyedBothKm += surveyed === 2 ? km : 0;
    surveyedOneKm += surveyed === 1 ? km : 0;
  }

  const percent = (km: number): string => ((100 * km) / offsettedKm).toFixed(1);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.error(
    `  sidewalks: ${offsettedKm.toFixed(0)} km offsetted — OSM maps both sides of ${percent(osmBothKm)}%, one of ${percent(osmOneKm)}%; the survey draws both of ${percent(surveyedBothKm)}%, one of ${percent(surveyedOneKm)}% (${seconds}s)`,
  );
  console.error(
    `  sidewalk tags: ${stating} of ${roads.length} roads state a side — ${taggedPavedSideKm.toFixed(0)} km of side paved and ${taggedBareSideKm.toFixed(0)} km stated bare where the survey was silent`,
  );
  return {
    file,
    format: SIDEWALK_FORMAT,
    count: segments.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

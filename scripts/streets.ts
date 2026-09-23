import type { Coord } from "./socrata";

// Numbered as NYC's CSCL `rw_type`; other cities map onto these rather than adding numbers.
export type RoadType = 1 | 3 | 4 | 5 | 6 | 7 | 10;

export const ROAD_STREET: RoadType = 1;
export const ROAD_BRIDGE: RoadType = 3;
export const ROAD_TUNNEL: RoadType = 4;
export const ROAD_BOARDWALK: RoadType = 5;
export const ROAD_PATH: RoadType = 6;
export const ROAD_STEPS: RoadType = 7;
export const ROAD_ALLEY: RoadType = 10;

export const ROAD_TYPES: readonly RoadType[] = [1, 3, 4, 5, 6, 7, 10];

// STRT record byte 23, bits 0-2; bits 3-6 are per-side sidewalk bits owned by scripts/sidewalks.ts.
export const FLAG_VEHICULAR_ONLY = 1 << 0; // drawn, never routed
export const FLAG_NON_VEHICULAR = 1 << 1; // dedicated ped/bike deck, offset 0
export const FLAG_STRUCTURE = 1 << 2; // bridge or tunnel deck
// PATH and SWLK only; a STRT record spends bit 3 on its left sidewalk and uses road type 4.
export const FLAG_TUNNEL = 1 << 3;

export interface Segment {
  physicalId: number; // city's durable id (CSCL physicalid, SF cnn)
  roadType: RoadType;
  streetWidth: number; // feet, curb to curb, 0 unknown
  postedSpeed: number; // mph, 0 unknown
  flags: number;
  name: string;
  nameId: number; // UNNAMED_ID until buildNameTable assigns it
  points: Coord[]; // densified to at most DENSIFY_METERS apart
  lengthMeters: number;
}

export function toInt(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

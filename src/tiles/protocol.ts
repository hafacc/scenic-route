import type { ThemeName } from "../theme/palette";
import type { ShedDecks } from "./shed-decks";

export interface TileCoords {
  x: number;
  y: number;
  z: number;
}

// Everything a draw reads beyond module constants: the worker has no map, DOM or app stores.
export interface StreetScoreParams {
  kind: "street-score";
}

export interface CommercialParams {
  kind: "commercial";
}

export interface LinesParams {
  kind: "lines";
  url: string;
  format: "hway" | "ferr";
  color: Record<ThemeName, string>; // stroke
}

export interface IndustrialParams {
  kind: "industrial";
  url: string;
}

export interface HistoricParams {
  kind: "historic";
  url: string;
}

export interface SubwayParams {
  kind: "subway";
  url: string;
}

export interface PoiParams {
  kind: "poi";
  url: string;
  magic: string;
  color: Record<ThemeName, string>; // dot fill
  labelAnchor: "top" | "bottom";
}

export interface TreeDotsParams {
  kind: "tree-dots";
  file: string;
  // the legend's selection, snapshotted at request
  enabled: number[];
}

export interface CanopyParams {
  kind: "canopy";
  url: string; // a {z}/{x}/{y} template
  maxNativeZoom: number; // finest baked level; deeper tiles are magnified
}

export interface ElevationParams {
  kind: "elevation";
  url: string; // a {z}/{x}/{y} template
  maxNativeZoom: number; // finest baked level; deeper tiles are magnified
}

export interface ShadeParams {
  kind: "shade";
  url: string; // a {bin}/{z}/{x}/{y} template
  treeUrl: string; // same template over the tree-shade pyramid, composited in
  bin: number; // which baked sun-position pyramid to read
  maxNativeZoom: number; // finest baked level; deeper tiles are magnified
  tau: number; // fraction of light the canopy blocks on the picked date
  intensity: number; // max(0, sin(elevation)), which scales the bin's alphas
  vectorZoom: number; // from here up shadows are swept from caster chunks, not magnified
  binElevation: number; // the bin's sun in degrees, where the sweep starts so the
  binAzimuth: number; // vectorZoom handoff does not jump
  sunElevation: number; // the true sun, ramped to over the levels above
  sunAzimuth: number;
}

export type TileParams =
  | StreetScoreParams
  | CommercialParams
  | LinesParams
  | IndustrialParams
  | HistoricParams
  | SubwayParams
  | PoiParams
  | TreeDotsParams
  | CanopyParams
  | ElevationParams
  | ShadeParams;

// Sent once per worker, before any draw.
export interface InitMessage {
  type: "init";
  base: string;
}

export interface DrawMessage {
  type: "draw";
  tileKey: number;
  coords: TileCoords;
  ratio: number; // capped (./raster); unreadable in a worker
  params: TileParams;
  canvas: OffscreenCanvas;
}

// Leaflet dropped the tile before its data arrived.
export interface CancelMessage {
  type: "cancel";
  tileKey: number;
}

// Warms the cache so a bin the clock is about to reach paints straight away.
export interface ShadePrefetchMessage {
  type: "shade-prefetch";
  url: string; // the same {bin}/{z}/{x}/{y} template a draw uses
  treeUrl: string; // warmed too, so a scrub composites without a fetch
  bins: number[]; // nearest the picked time first; the tail drops if the set won't fit
  coords: TileCoords[]; // source tiles covering the view, at their baked zoom
}

// Sent on each toggle; the layers redraw right after.
export interface ThemeMessage {
  type: "theme";
  theme: ThemeName;
}

// Built from the main thread's routing graph, too big to copy to the worker; ~440 KB a day.
export interface ShedDecksMessage {
  type: "shed-decks";
  decks: ShedDecks;
}

export type ToWorker =
  | InitMessage
  | DrawMessage
  | CancelMessage
  | ShadePrefetchMessage
  | ShedDecksMessage
  | ThemeMessage;

export interface DoneMessage {
  type: "done";
  tileKey: number;
  error?: string;
}

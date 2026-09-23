import type { ReverseHit } from "./reverse";
import type { DocKind } from "./search-format";

// The worker has no DOM, so file URLs arrive absolute, resolved against the page's base.

export interface InitMessage {
  type: "init";
  city: string;
  searchUrl: string;
  // Labels need ADDR: the index holds only street and place ordinals.
  addressUrl: string;
}

export interface QueryMessage {
  type: "query";
  id: number;
  text: string;
  center: { lat: number; lng: number };
  limit: number;
}

export interface ReverseMessage {
  type: "reverse";
  id: number;
  at: { lat: number; lng: number };
}

export type ToSearchWorker = InitMessage | QueryMessage | ReverseMessage;

export type { ReverseHit };

export interface IndexHit {
  kind: DocKind;
  name: string;
  label: string; // "205 E Houston St, Manhattan", or "" where the index knows of no address
  lat: number;
  lng: number;
  score: number;
  // The Overture slug, or the routes a station serves.
  category: string | null;
  // Whether the house number asked for is the one found; null when no number was asked.
  exact: boolean | null;
}

export interface ReadyMessage {
  type: "ready";
  city: string;
}

export interface ErrorMessage {
  type: "error";
  city: string;
  message: string;
}

export interface ResultsMessage {
  type: "results";
  id: number;
  hits: IndexHit[];
}

export interface ReverseResultMessage {
  type: "reverse";
  id: number;
  hit: ReverseHit | null; // null where the city has nothing near enough to name the point with
}

export type FromSearchWorker =
  | ReadyMessage
  | ErrorMessage
  | ResultsMessage
  | ReverseResultMessage;

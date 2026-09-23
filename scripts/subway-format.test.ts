// The clustering both rail ingests merge their stations with: the display markers (scripts/subway.ts,
// scripts/subway-sf.ts) and the routing stations (scripts/transit.ts) are one rule, so the network
// drawn on the map and the network a route rides agree about what one station is.

import { expect, test } from "bun:test";
import { centroid, clusterByName, STATION_MERGE_METERS } from "./subway-format";

const LAT = 37.79;
const LNG = -122.4;
// A degree of latitude is about 111 km, so this is meters.
const DEGREES_PER_METER = 1 / 111_320;

function stop(
  name: string,
  meters: number,
): { name: string; lat: number; lng: number } {
  return { name, lat: LAT + meters * DEGREES_PER_METER, lng: LNG };
}

const names = (clusters: { name: string }[][]): string[][] =>
  clusters.map((cluster) => cluster.map((point) => point.name));

test("same-named curbs a median apart are one station", () => {
  const clusters = clusterByName([
    stop("Church & Duboce", 0),
    stop("Church & Duboce", 30),
  ]);
  expect(names(clusters)).toEqual([["Church & Duboce", "Church & Duboce"]]);
});

test("a row of curbs chains through its members", () => {
  // Single-link: the ends are 180 m apart, further than the threshold, and still one station.
  const clusters = clusterByName([
    stop("Embarcadero", 0),
    stop("Embarcadero", 90),
    stop("Embarcadero", 180),
  ]);
  expect(clusters).toHaveLength(1);
  expect(centroid(clusters[0]).lat).toBeCloseTo(stop("", 90).lat, 9);
});

test("different stops that happen to share a name stay apart", () => {
  // 19th Ave & Randolph St is three stops over 245 m, which is exactly what must not merge.
  const clusters = clusterByName([
    stop("19th Ave & Randolph St", 0),
    stop("19th Ave & Randolph St", 245),
  ]);
  expect(clusters).toHaveLength(2);
});

test("two names never join, however close they stand", () => {
  expect(
    clusterByName([stop("Powell", 0), stop("Montgomery", 1)]),
  ).toHaveLength(2);
});

test("the threshold is the one both ingests measured", () => {
  expect(STATION_MERGE_METERS).toBe(100);
});

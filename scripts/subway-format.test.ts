import { expect, test } from "bun:test";
import {
  buildComplexes,
  type ComplexStation,
  centroid,
  clusterByName,
  STATION_MERGE_METERS,
} from "./subway-format";

const LAT = 37.79;
const LNG = -122.4;
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
  // Single-link: the ends are 180 m apart, past the threshold.
  const clusters = clusterByName([
    stop("Embarcadero", 0),
    stop("Embarcadero", 90),
    stop("Embarcadero", 180),
  ]);
  expect(clusters).toHaveLength(1);
  expect(centroid(clusters[0]).lat).toBeCloseTo(stop("", 90).lat, 9);
});

test("different stops that happen to share a name stay apart", () => {
  // 19th Ave & Randolph St is really three stops over 245 m.
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

function station(key: string, name: string, meters: number): ComplexStation {
  return { key, ...stop(name, meters) };
}

// 14 St (A31) and 8 Av (L01) as transfers.txt and the MTA's complex list describe them.
const FOURTEENTH = [
  station("mta:A31", "14 St", 0),
  station("mta:L01", "8 Av", 145),
  station("mta:A32", "W 4 St-Wash Sq", 1200),
];

test("a published pair joins its stations and keeps its minimum transfer time", () => {
  const model = buildComplexes(
    FOURTEENTH,
    [
      { from: "mta:A31", to: "mta:L01", seconds: 90 },
      { from: "mta:L01", to: "mta:A31", seconds: 90 },
    ],
    [{ keys: ["mta:A31", "mta:L01"], name: "14 St/8 Av" }],
  );
  const complex = model.complexOf.get("mta:A31");
  expect(complex).toBeGreaterThan(0);
  expect(model.complexOf.get("mta:L01")).toBe(complex);
  expect(model.names.get(complex ?? 0)).toBe("14 St / 8 Av");
  expect(model.transfers).toEqual([
    { from: "mta:A31", to: "mta:L01", seconds: 90 },
    { from: "mta:L01", to: "mta:A31", seconds: 90 },
  ]);
});

test("where an agency publishes transfers, a lone station is its own complex", () => {
  const model = buildComplexes(
    FOURTEENTH,
    [{ from: "mta:A31", to: "mta:L01", seconds: 90 }],
    [],
  );
  const lone = model.complexOf.get("mta:A32") ?? 0;
  expect(lone).toBeGreaterThan(0);
  expect(lone).not.toBe(model.complexOf.get("mta:A31"));
  expect(model.names.has(lone)).toBe(false);
});

test("South Ferry and Whitehall St share a complex id but no pair, so both ways are estimated", () => {
  const model = buildComplexes(
    [
      station("mta:142", "South Ferry", 0),
      station("mta:R27", "Whitehall St-South Ferry", 110),
      ...FOURTEENTH,
    ],
    [{ from: "mta:A31", to: "mta:L01", seconds: 90 }],
    [
      { keys: ["mta:142", "mta:R27"], name: "Whitehall St-South Ferry" },
      { keys: ["mta:A32"], name: "W 4 St-Wash Sq" },
    ],
  );
  expect(model.complexOf.get("mta:142")).toBe(model.complexOf.get("mta:R27"));
  expect(
    model.transfers.filter(
      ({ from }) => from === "mta:142" || from === "mta:R27",
    ),
  ).toEqual([
    { from: "mta:142", to: "mta:R27", seconds: null },
    { from: "mta:R27", to: "mta:142", seconds: null },
  ]);
});

test("an agency's list never overrides a published time", () => {
  const model = buildComplexes(
    FOURTEENTH,
    [{ from: "mta:A31", to: "mta:L01", seconds: 90 }],
    [{ keys: ["mta:A31", "mta:L01"] }],
  );
  expect(model.transfers).toEqual([
    { from: "mta:A31", to: "mta:L01", seconds: 90 },
    { from: "mta:L01", to: "mta:A31", seconds: null },
  ]);
});

test("unnamed complexes join their members' names, and agreeing names keep the shortest", () => {
  const joined = buildComplexes(
    [station("mta:254", "Junius St", 0), station("mta:L26", "Livonia Av", 170)],
    [{ from: "mta:254", to: "mta:L26", seconds: 300 }],
    [],
  );
  expect([...joined.names.values()]).toEqual(["Junius St / Livonia Av"]);
  const agreeing = buildComplexes(
    [station("bart:POWL", "Powell Street", 0), station("muni:1", "Powell", 60)],
    [],
    [{ keys: ["bart:POWL", "muni:1"] }],
  );
  expect([...agreeing.names.values()]).toEqual(["Powell"]);
});

test("with no published pair, only joined stations get a complex id", () => {
  const model = buildComplexes(
    [
      station("muni:1", "Castro", 0),
      station("muni:2", "Castro", 9),
      station("muni:3", "Church", 900),
    ],
    [],
    [{ keys: ["muni:1", "muni:2"] }],
  );
  expect(model.complexOf.get("muni:1")).toBe(1);
  expect(model.complexOf.get("muni:2")).toBe(1);
  expect(model.complexOf.get("muni:3")).toBe(0);
});

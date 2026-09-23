// Run with `NODE_ENV=development bun run src/routing/bench-alternatives.ts` so readers use local artifacts.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_TOGGLES,
  effectiveWeights,
  graphFactors,
  MODES,
} from "../modes/modes";
import {
  planRoutes,
  routeDistanceMeters,
  selectionDiagnostics,
} from "./alternatives";
import { setArtifactBase } from "./artifact-base";
import { MAX_TRANSIT_WEIGHT, minMultiplier, type RouteWeights } from "./cost";
import { graphFactorMax, RoutingEngine } from "./engine";
import { decodeGraph, routeOf } from "./graph";
import { type RouteResult, routeDiagnostics } from "./search";
import { buildSnapIndex, snapPair } from "./snap";

const PUBLIC_DIR = join(import.meta.dirname, "../../public");
const GRAPH_PATH = join(PUBLIC_DIR, "routing/nyc.bin");
// The shed artifact is checked against this, so a made-up one is refused.
const VERSION_PATH = join(PUBLIC_DIR, "routing/nyc.version.json");
const CITY = "nyc";
// Must be a day the standing timetables cover; earlier days need a history file that may not exist.
const CLOCK = { tick: 0, dateMs: Date.UTC(2026, 8, 3, 16, 0, 0) };

interface Trip {
  name: string;
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
}

const TRIPS: Trip[] = [
  {
    name: "Times Sq - Battery Park",
    from: { lat: 40.758, lng: -73.9855 },
    to: { lat: 40.7033, lng: -74.017 },
  },
  {
    name: "Cathedral Pkwy - Grand Central",
    from: { lat: 40.8005, lng: -73.9666 },
    to: { lat: 40.7527, lng: -73.9772 },
  },
  {
    name: "Union Sq - Prospect Park",
    from: { lat: 40.7359, lng: -73.9911 },
    to: { lat: 40.6602, lng: -73.969 },
  },
  {
    name: "Williamsburg - Barclays Center",
    from: { lat: 40.7081, lng: -73.9571 },
    to: { lat: 40.6826, lng: -73.9754 },
  },
  {
    name: "East Village - Chelsea Piers",
    from: { lat: 40.7265, lng: -73.9815 },
    to: { lat: 40.7466, lng: -74.008 },
  },
  {
    name: "Brooklyn Heights - Bushwick",
    from: { lat: 40.696, lng: -73.995 },
    to: { lat: 40.6944, lng: -73.9213 },
  },
];

setArtifactBase(pathToFileURL(`${PUBLIC_DIR}/`).href);

const bytes = await readFile(GRAPH_PATH);
const identity = JSON.parse(await readFile(VERSION_PATH, "utf8")) as {
  hash: string;
  keyHash: string;
};
const graph = decodeGraph(
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer,
  identity,
);
const index = buildSnapIndex(graph);
const available = graphFactors(graph);
const engine = new RoutingEngine();
engine.load(CITY, graph);
console.log(`nyc.bin: ${graph.nodeCount} nodes, ${graph.edgeCount} edges\n`);

const kilometers = (meters: number): string => (meters / 1000).toFixed(2);
const minutes = (seconds: number): string => (seconds / 60).toFixed(1);

function ridden(result: RouteResult): string {
  const lines: string[] = [];
  for (const step of result.steps) {
    const line = step.kind === "board" ? routeOf(graph, step.edge) : null;
    if (line && !lines.includes(line.shortName)) {
      lines.push(line.shortName);
    }
  }
  return lines.length === 0
    ? ""
    : `${lines.join("+")} ${minutes(result.transitSeconds)}`;
}

for (const mode of MODES) {
  for (const transitOn of [true, false]) {
    const weights = {
      ...effectiveWeights(mode, DEFAULT_TOGGLES, available),
      allowTransit: transitOn,
    };
    await engine.prepare(CITY, CLOCK, weights);
    const fields = [
      graph.sheds
        ? `sheds ${graph.sheds.maxCoverage.toFixed(2)} max`
        : "no sheds",
      graph.shade ? "shade" : "no shade",
      graph.ferries ? "ferry timetable" : "no ferry timetable",
      graph.transit ? "rail timetable" : "no rail timetable",
      `transit ${weights.transit}`,
    ].join(", ");
    console.log(
      `## ${mode.name}, subway ${transitOn ? "on" : "off"} (${fields})`,
    );
    console.log(
      "trip                            | searches | ms    | sets seen/all | dropped | cards | card times (min) | km per card       | scenic scores     | closest (m) | rides",
    );
    for (const trip of TRIPS) {
      const snapped = snapPair(graph, index, trip.from, trip.to);
      if (!snapped.ok) {
        console.log(`${trip.name}: no snap (${snapped.reason})`);
        continue;
      }
      selectionDiagnostics.dominated = 0;
      selectionDiagnostics.visited = 0;
      selectionDiagnostics.enumerated = 0;
      const started = performance.now();
      const plan = await planRoutes({
        weights,
        search: (candidate) =>
          engine.search(snapped.start, snapped.dest, candidate),
        minMultiplier: (candidate) => minMultiplier(engine.graph, candidate),
        factorMax: graphFactorMax(engine.graph),
      });
      const elapsed = performance.now() - started;
      let closest = Number.POSITIVE_INFINITY;
      for (let left = 0; left < plan.routes.length; left++) {
        for (let right = left + 1; right < plan.routes.length; right++) {
          closest = Math.min(
            closest,
            routeDistanceMeters(
              plan.routes[left].result,
              plan.routes[right].result,
            ),
          );
        }
      }
      const cells = [
        trip.name.padEnd(31),
        String(plan.searches).padStart(8),
        elapsed.toFixed(0).padStart(5),
        `${selectionDiagnostics.visited}/${selectionDiagnostics.enumerated}`.padStart(
          13,
        ),
        String(selectionDiagnostics.dominated).padStart(7),
        String(plan.routes.length).padStart(5),
        plan.routes
          .map((route) => minutes(route.result.travelSeconds))
          .join(" ")
          .padEnd(16),
        plan.routes
          .map((route) => kilometers(route.result.lengthMeters))
          .join(" ")
          .padEnd(17),
        plan.routes
          .map((route) => route.scenicScore.toFixed(2))
          .join(" ")
          .padEnd(17),
        (plan.routes.length > 1 ? closest.toFixed(0) : "-").padStart(12),
        plan.routes
          .map((route) => ridden(route.result))
          .filter((line) => line !== "")
          .join(", "),
      ];
      console.log(cells.join(" | "));
    }
    console.log("");
  }
}

// Scenic weights are zero, since a mode that flattens the estimate would hide the transit credit's cost.
const longest = TRIPS[2]; // Union Sq - Prospect Park, the longest of them
const snapped = snapPair(graph, index, longest.from, longest.to);
if (snapped.ok) {
  console.log(`## one search, ${longest.name}, every scenic weight at zero`);
  console.log("transit weight | rail | ms    | settled | ride");
  for (const transitOn of [true, false]) {
    for (const transit of [0, MAX_TRANSIT_WEIGHT]) {
      const weights: RouteWeights = {
        ...effectiveWeights(
          MODES[0],
          DEFAULT_TOGGLES,
          Object.fromEntries(
            Object.keys(available).map((key) => [key, false]),
          ) as typeof available,
        ),
        transit,
        allowTransit: transitOn,
      };
      await engine.prepare(CITY, CLOCK, weights);
      const started = performance.now();
      const result = engine.search(snapped.start, snapped.dest, weights);
      const elapsed = performance.now() - started;
      console.log(
        [
          String(transit).padStart(14),
          (transitOn ? "on" : "off").padStart(4),
          elapsed.toFixed(0).padStart(5),
          String(routeDiagnostics.nodesSettled).padStart(7),
          result ? ridden(result) || "walks" : "no route",
        ].join(" | "),
      );
    }
  }
}

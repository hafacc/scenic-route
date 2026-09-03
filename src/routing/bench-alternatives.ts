// What a plan costs on the real New York graph, through the engine the worker runs. Run with
// `NODE_ENV=development bun run src/routing/bench-alternatives.ts`: the env points the shed and
// ferry readers at the local copies, without which shelter falls back to the canopy alone.

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
import { minMultiplier } from "./cost";
import { graphFactorMax, RoutingEngine } from "./engine";
import { decodeGraph } from "./graph";
import { buildSnapIndex, snapPair } from "./snap";

const PUBLIC_DIR = join(import.meta.dirname, "../../public");
const GRAPH_PATH = join(PUBLIC_DIR, "routing/nyc.bin");
// The graph's own identity, which the shed artifact is checked against: a made-up one is refused.
const VERSION_PATH = join(PUBLIC_DIR, "routing/nyc.version.json");
const CITY = "nyc";
// A weekday lunchtime in New York: the sheds stand, the boats run, and the sun is up.
const CLOCK = { tick: 0, dateMs: Date.UTC(2026, 8, 2, 16, 0, 0) };

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

const kilometres = (meters: number): string => (meters / 1000).toFixed(2);
const minutes = (seconds: number): string => (seconds / 60).toFixed(1);

for (const mode of MODES) {
  const weights = effectiveWeights(mode, DEFAULT_TOGGLES, available);
  await engine.prepare(CITY, CLOCK, weights);
  const fields = [
    graph.sheds
      ? `sheds ${graph.sheds.maxCoverage.toFixed(2)} max`
      : "no sheds",
    graph.shade ? "shade" : "no shade",
    graph.ferries ? "ferry timetable" : "no ferry timetable",
  ].join(", ");
  console.log(`## ${mode.name} (${fields})`);
  console.log(
    "trip                            | searches | ms    | sets seen/all | cards | card times (min) | km per card       | scenic scores     | closest (m)",
  );
  for (const trip of TRIPS) {
    const snapped = snapPair(graph, index, trip.from, trip.to);
    if (!snapped.ok) {
      console.log(`${trip.name}: no snap (${snapped.reason})`);
      continue;
    }
    selectionDiagnostics.visited = 0;
    selectionDiagnostics.enumerated = 0;
    const started = performance.now();
    const plan = planRoutes({
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
      String(plan.routes.length).padStart(5),
      plan.routes
        .map((route) => minutes(route.result.travelSeconds))
        .join(" ")
        .padEnd(16),
      plan.routes
        .map((route) => kilometres(route.result.lengthMeters))
        .join(" ")
        .padEnd(17),
      plan.routes
        .map((route) => route.scenicScore.toFixed(2))
        .join(" ")
        .padEnd(17),
      (plan.routes.length > 1 ? closest.toFixed(0) : "-").padStart(12),
    ];
    console.log(cells.join(" | "));
  }
  console.log("");
}

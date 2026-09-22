// Turn-by-turn directions: a pure function of the labeled step sequence, no React or Leaflet. The
// A* result carries, per step, its kind ("sidewalk"|"crossing"|"link"|"path"|the boat and rail
// kinds), stored side, raw
// street name, cover, and walked length; directions are assembled from those plus the step geometry
// (for bearings and the maneuver anchor). Grouping collapses steps into runs, then emission turns
// runs into human maneuvers.

import type { RideSummary } from "../modes/cards";
import {
  doorStreet,
  edgeName,
  edgePath,
  isElevatorDoor,
  isStayAboard,
  isSurfaceStop,
  otherEnd,
  patternTerminus,
  type RoutingGraph,
  routeOf,
  type SideLabel,
  stationName,
} from "./graph";
import type { PassedPoi } from "./pois";
import {
  type RouteResult,
  type RouteStep,
  stepFrom,
  stepSeconds,
  type TransitLeg,
} from "./search";
import { prettifyStreetName } from "./street-names";

export type Turn =
  | "left"
  | "right"
  | "slight left"
  | "slight right"
  | "around"
  | null;

export interface Maneuver {
  kind:
    | "start"
    | "continue"
    | "turn"
    | "cross"
    | "path"
    | "ferry"
    | "transit" // boarding a train and riding it, however many stops that is
    | "station" // stepping into, out of, or off at one: the walks a ride is bracketed by
    | "arrive"
    | "landmark" // a POI passed along the route, spliced in between the walking maneuvers
    | "art";
  text: string; // assembled, prettified, ready to render
  name: string | null; // prettified street name
  side: SideLabel;
  turn: Turn;
  lengthMeters: number; // walked length this maneuver covers
  // Along-route distance to where this maneuver begins, in the same metric as RouteStep.lengthMeters
  // (summed graph edge lengths, not the geodesic length of the drawn polyline).
  startMeters: number;
  durationSeconds?: number; // a ferry or rail leg's ride time, shown where a walk shows its distance
  stops?: number; // a rail leg's stop count, which is what says how long it is
  // The line ridden, in the livery the agency publishes: a ride row wears its bullet where every
  // other row wears an icon.
  ride?: RideSummary;
  // Which of the three station acts this row is, since all of them share one kind. "change" is an
  // alight the reader gets straight back onto a train from.
  station?: "enter" | "exit" | "alight" | "change";
  // The door an enter or an exit goes through, which wears its own icon. Absent on an alight, which
  // happens on a platform, and on a curbside stop, which has no door at all.
  door?: "stair" | "elevator";
  // A rail leg's departure, seconds from midnight of the routed day. Taken from the route's own leg
  // rather than looked up here: the timetable lives in the worker, and these are built on the page.
  departureSeconds?: number;
  stepRange: [number, number]; // half-open indexes into RouteResult.steps
  at: { lat: number; lng: number };
}

const METERS_PER_MILE = 1609.344;
const METERS_PER_FOOT = 0.3048;
const FEET_ROUNDING = 50;

// Miles at one decimal from 0.1 mi up, else feet rounded to the nearest 50 (never below 50 for a
// real walked leg, so a short crossing never reads "0 ft").
export function formatDistance(meters: number): string {
  const miles = meters / METERS_PER_MILE;
  if (miles >= 0.1) {
    return `${miles.toFixed(1)} mi`;
  }
  const feet =
    Math.round(meters / METERS_PER_FOOT / FEET_ROUNDING) * FEET_ROUNDING;
  return `${Math.max(FEET_ROUNDING, feet)} ft`;
}

// A ride whose route the graph does not name, which is what an unliveried bullet falls back to.
const UNLIVERIED = { color: "#334155", textColor: "#ffffff" };

// A ferry leg's crossing time, shown in the same slot a walking leg shows its distance.
export function formatDuration(seconds: number): string {
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

const COMPASS_8: readonly string[] = [
  "north",
  "northeast",
  "east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest",
];

// Compass bearing (0 = north, clockwise) of the great-circle segment; the short legs here make the
// spherical formula and a flat one agree to well within a degree.
function bearing(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = Math.PI / 180;
  const deltaLng = (lng2 - lng1) * toRad;
  const y = Math.sin(deltaLng) * Math.cos(lat2 * toRad);
  const x =
    Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(deltaLng);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

// Signed turn from bearing `from` to bearing `to`, in (-180, 180]; positive is clockwise (a right).
function signedTurn(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

function compass8(deg: number): string {
  return COMPASS_8[Math.round(deg / 45) % 8];
}

// A step's polyline in travel order (edge geometry is stored a -> b; a reverse step walks it b -> a).
function stepTravelPoints(
  graph: RoutingGraph,
  step: RouteStep,
): { lngs: number[]; lats: number[] } {
  const { lngs, lats } = edgePath(graph, step.edge);
  if (step.forward) {
    return { lngs: Array.from(lngs), lats: Array.from(lats) };
  }
  return { lngs: Array.from(lngs).reverse(), lats: Array.from(lats).reverse() };
}

// One run: a maximal group of same-labeled steps, with its travel polyline retained for bearings and
// the maneuver anchor.
interface Run {
  kind: "sidewalk" | "crossing" | "path" | "ferry" | "transit" | "station";
  name: string | null; // raw, unprettified
  side: SideLabel;
  stepStart: number;
  stepEnd: number; // half-open
  lengthMeters: number;
  durationSeconds: number; // summed ferry crossing seconds; 0 for walking runs
  ferryRoute: string | null; // a ferry run's route display name (its first edge's), else null
  ferryDest: string | null; // a ferry run's destination terminal (its final edge's), else null
  // A ferry run's boarding time, seconds from midnight of the departure day: the sailing the walker
  // actually catches, so the maneuver can name it. Null with no timetable loaded, where the graph's
  // baked figure is an average wait rather than a departure.
  ferryDeparture: number | null;
  // A rail run's line, where it is bound and how many stops are ridden; a station run's own name and
  // which of the three things it is. Both null on every other kind.
  transitRoute: string | null;
  transitLivery: { color: string; textColor: string } | null;
  transitToward: string | null;
  transitStops: number;
  // The caught train's departure, from the route's own leg — the page has no timetable to ask.
  transitDeparture: number | null;
  // The platform wait that bought that departure. Not part of the maneuver's own duration, which is
  // the ride; carried so the line pill can say what a card says, which counts the wait.
  transitWaitSeconds: number;
  station: string | null;
  stationAction: "enter" | "exit" | "alight" | null;
  stationSurface: boolean; // a stop in the street rather than a station with a way in
  stationElevator: boolean; // the door is a lift rather than a stair
  // The street the door stands on and which side of it, off the walking step at the door: what
  // tells a reader WHICH of a station's several ways in to take. Raw name, null when there is none.
  doorName: string | null;
  doorSide: SideLabel;
  lngs: number[];
  lats: number[];
}

// Everything a run carries beyond the walking kinds, so one object literal per run does not have to
// spell out the seven that do not apply to it.
const NO_TRANSIT = {
  ferryRoute: null,
  ferryDest: null,
  ferryDeparture: null,
  transitRoute: null,
  transitLivery: null,
  transitToward: null,
  transitStops: 0,
  transitDeparture: null,
  transitWaitSeconds: 0,
  station: null,
  stationAction: null,
  stationSurface: false,
  stationElevator: false,
  doorName: null,
  doorSide: null,
} as const;

// A ferry step's destination terminal: node b when traveled a -> b, else node a.
function ferryDestName(graph: RoutingGraph, step: RouteStep): string | null {
  const ends = graph.ferryEndpointNames.get(step.edge);
  if (!ends) {
    return null;
  }
  return step.forward ? ends.b : ends.a;
}

// A sailing's departure as a 12-hour clock label. Seconds run from midnight of the DEPARTURE day, so
// a boat after midnight reads past 86400 and wraps back to a small hour here.
function formatDeparture(seconds: number): string {
  const minutes = Math.round(seconds / 60) % 1440;
  const hour = Math.floor(minutes / 60);
  const period = hour >= 12 ? "PM" : "AM";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${String(minutes % 60).padStart(2, "0")} ${period}`;
}

// Strip a trailing " Ferry Terminal" or " Ferry" from a terminal name for the maneuver destination:
// "St. George Ferry Terminal" -> "St. George", while "Wall St/Pier 11" is left alone.
function stripTerminalSuffix(name: string): string {
  return name.replace(/\s+Ferry Terminal$/i, "").replace(/\s+Ferry$/i, "");
}

function sameRunKey(run: Run, step: RouteStep): boolean {
  if (run.kind !== step.kind) {
    return false;
  }
  if (step.kind === "sidewalk") {
    return run.name === step.name && run.side === step.side;
  }
  // crossings and paths merge on name alone (a divided road is one "Cross ...").
  return run.name === step.name;
}

function appendPoints(
  run: Run,
  points: { lngs: number[]; lats: number[] },
): void {
  // Drop the shared junction vertex where this step meets the previous one.
  const skipFirst = run.lngs.length > 0;
  for (let index = 0; index < points.lngs.length; index++) {
    if (skipFirst && index === 0) {
      continue;
    }
    run.lngs.push(points.lngs[index]);
    run.lats.push(points.lats[index]);
  }
}

// Collapse steps into runs. Link steps are silent — their length is absorbed into the run they touch
// and they contribute no maneuver.
function buildRuns(
  graph: RoutingGraph,
  steps: RouteStep[],
  rides: readonly TransitLeg[],
): Run[] {
  const runs: Run[] = [];
  let current: Run | null = null;
  let pendingLinkMeters = 0;
  // How far into the trip each step is reached, which is what picks a ferry's sailing. It has to be
  // the SAME clock the ETA summary runs (hence the shared `stepSeconds`), or the two disagree about
  // which boat is caught and the maneuver names a sailing the reported time never allowed for.
  let elapsedSeconds = 0;
  let legIndex = 0; // which of the route's rail legs the next board step is
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const reachedAt = elapsedSeconds;
    // A board edge's seconds come off the leg the search recorded rather than out of the timetable:
    // these are built on the page, which has none, and asking for one there would answer Infinity
    // and stop the clock every later leg is read against.
    const leg = step.kind === "board" ? rides[legIndex] : undefined;
    elapsedSeconds += leg?.waitSeconds ?? stepSeconds(graph, step, reachedAt);
    // A ferry is its own run: flush any open walk run, then start (or extend) a ferry run. Its
    // crossing seconds sum onto the run so the maneuver can report the ride time.
    if (step.kind === "ferry") {
      if (current) {
        runs.push(current);
        current = null;
      }
      const last = runs[runs.length - 1];
      const points = stepTravelPoints(graph, step);
      const sailing =
        graph.ferries?.board(step.edge, stepFrom(graph, step), reachedAt) ??
        null;
      // The ride time the maneuver reports is the crossing alone — the wait before it belongs to the
      // walk up to the pier, not to the leg — falling back to the baked crossing-plus-average-wait
      // figure when no timetable is loaded.
      const rideSeconds =
        sailing?.crossing ?? graph.edgeDurationSeconds[step.edge];
      // A ferry line calls at several piers, and each pier-to-pier leg is its own edge — but you
      // board once, so those legs are one maneuver. Still aboard means the timetable put you on the
      // same line with nothing to wait for; a wait, or a different line, is a CHANGE OF BOAT and gets
      // its own maneuver rather than disappearing into the previous one. With no timetable loaded
      // there is no sailing to compare, and consecutive legs merge as they always did.
      const stillAboard =
        last?.kind === "ferry" &&
        (!sailing || (sailing.route === last.ferryRoute && sailing.wait === 0));
      if (last && last.kind === "ferry" && stillAboard) {
        last.lengthMeters += step.lengthMeters;
        last.durationSeconds += rideSeconds;
        last.stepEnd = index + 1;
        // The run keeps its first edge's route; the destination advances to this edge's terminal.
        last.ferryDest = ferryDestName(graph, step);
        appendPoints(last, points);
      } else {
        const ferryRun: Run = {
          ...NO_TRANSIT,
          kind: "ferry",
          name: null,
          side: null,
          stepStart: index,
          stepEnd: index + 1,
          lengthMeters: step.lengthMeters,
          durationSeconds: rideSeconds,
          // The route the timetable says is sailing beats the edge's own name: a stop pair several
          // routes serve is one graph edge carrying whichever route the ingest picked as primary.
          ferryRoute: sailing?.route ?? edgeName(graph, step.edge),
          ferryDest: ferryDestName(graph, step),
          ferryDeparture: sailing?.departure ?? null,
          lngs: [],
          lats: [],
        };
        appendPoints(ferryRun, points);
        runs.push(ferryRun);
      }
      continue;
    }
    // Rail: a board edge opens a run that every ride edge after it extends, since a walker boards
    // once and stays on. The station walks either side of it are their own runs — they are what a
    // reader is actually told to do, and the ride between them is where the time goes.
    if (step.kind === "board") {
      legIndex += 1;
      if (current) {
        runs.push(current);
        current = null;
      }
      const platform = step.forward
        ? graph.edgeNodeB[step.edge]
        : graph.edgeNodeA[step.edge];
      const route = routeOf(graph, step.edge);
      runs.push({
        ...NO_TRANSIT,
        kind: "transit",
        name: null,
        side: null,
        stepStart: index,
        stepEnd: index + 1,
        lengthMeters: step.lengthMeters,
        durationSeconds: 0, // the wait is the walk's, not the ride's; the rides add themselves
        transitRoute: route?.shortName ?? null,
        transitLivery: route
          ? { color: route.color, textColor: route.textColor }
          : null,
        transitToward: patternTerminus(graph, platform),
        transitStops: 0,
        transitDeparture: leg?.departureSeconds ?? null,
        transitWaitSeconds: leg?.waitSeconds ?? 0,
        lngs: [],
        lats: [],
      });
      appendPoints(runs[runs.length - 1], stepTravelPoints(graph, step));
      continue;
    }
    if (step.kind === "ride") {
      // Staying aboard between two stops is nothing a reader does: no stop, no distance, no time.
      if (isStayAboard(graph, step.edge)) {
        continue;
      }
      const open = runs[runs.length - 1];
      if (open?.kind === "transit") {
        open.lengthMeters += step.lengthMeters;
        open.durationSeconds += graph.edgeDurationSeconds[step.edge];
        open.transitStops += 1;
        open.stepEnd = index + 1;
        appendPoints(open, stepTravelPoints(graph, step));
      }
      continue;
    }
    if (step.kind === "access") {
      if (current) {
        runs.push(current);
        current = null;
      }
      const from = stepFrom(graph, step);
      const to = otherEnd(graph, step.edge, from);
      // Four walks wear this one kind, told apart by their two ends: a platform is an alight, a
      // station node at both ends is the change of train, a station node at the near end is the way
      // out, and anything else set off from the pavement, so the way in. Only a station node answers
      // `stationName`, which is what tells the last two apart.
      const fromStation = stationName(graph, from);
      const action =
        graph.nodePlatform[from] === 1
          ? "alight"
          : fromStation === null
            ? "enter"
            : stationName(graph, to) === null
              ? "exit"
              : "change";
      // The change of train is the station's own exit walking round to its own entry: no distance,
      // no time, and nothing to tell a reader beyond the "Change at ..." the alight before it
      // already says.
      if (action === "change") {
        continue;
      }
      const door = doorStreet(graph, step.edge);
      runs.push({
        ...NO_TRANSIT,
        kind: "station",
        name: null,
        side: null,
        stepStart: index,
        stepEnd: index + 1,
        lengthMeters: step.lengthMeters,
        durationSeconds: 0,
        station: action === "exit" ? fromStation : stationName(graph, to),
        stationAction: action,
        stationSurface: isSurfaceStop(graph, step.edge),
        stationElevator: isElevatorDoor(graph, step.edge),
        doorName: door?.street ?? null,
        doorSide: door?.side ?? null,
        lngs: [],
        lats: [],
      });
      appendPoints(runs[runs.length - 1], stepTravelPoints(graph, step));
      continue;
    }
    if (step.kind === "link") {
      if (current) {
        current.lengthMeters += step.lengthMeters;
      } else {
        pendingLinkMeters += step.lengthMeters;
      }
      continue;
    }
    if (current && sameRunKey(current, step)) {
      current.lengthMeters += step.lengthMeters;
      current.stepEnd = index + 1;
      appendPoints(current, stepTravelPoints(graph, step));
    } else {
      if (current) {
        runs.push(current);
      }
      current = {
        ...NO_TRANSIT,
        kind: step.kind,
        name: step.name,
        side: step.side,
        stepStart: index,
        stepEnd: index + 1,
        lengthMeters: step.lengthMeters + pendingLinkMeters,
        durationSeconds: 0,
        lngs: [],
        lats: [],
      };
      pendingLinkMeters = 0;
      appendPoints(current, stepTravelPoints(graph, step));
    }
  }
  if (current) {
    runs.push(current);
  }
  return runs;
}

function firstBearing(run: Run): number | null {
  const { lngs, lats } = run;
  for (let index = 1; index < lngs.length; index++) {
    if (lngs[index] !== lngs[0] || lats[index] !== lats[0]) {
      return bearing(lats[0], lngs[0], lats[index], lngs[index]);
    }
  }
  return null;
}

function lastBearing(run: Run): number | null {
  const { lngs, lats } = run;
  const end = lngs.length - 1;
  for (let index = end - 1; index >= 0; index--) {
    if (lngs[index] !== lngs[end] || lats[index] !== lats[end]) {
      return bearing(lats[index], lngs[index], lats[end], lngs[end]);
    }
  }
  return null;
}

function chordBearing(run: Run): number | null {
  const { lngs, lats } = run;
  const end = lngs.length - 1;
  if (end < 1) {
    return firstBearing(run);
  }
  return bearing(lats[0], lngs[0], lats[end], lngs[end]);
}

function runStart(run: Run): { lat: number; lng: number } {
  return { lat: run.lats[0], lng: run.lngs[0] };
}

function runEnd(run: Run): { lat: number; lng: number } {
  const end = run.lngs.length - 1;
  return { lat: run.lats[end], lng: run.lngs[end] };
}

// "the west side of 5th Avenue" / "5th Avenue" / "the west side" / null, from a side and raw name.
function descriptor(side: SideLabel, prettyName: string | null): string | null {
  if (prettyName && side) {
    return `the ${side} side of ${prettyName}`;
  }
  if (prettyName) {
    return prettyName;
  }
  if (side) {
    return `the ${side} side`;
  }
  return null;
}

// A crossing is "linear" when the walking run immediately before it and immediately after it are the
// same street and side — you keep walking the same street+side across it, so it carries no action. A
// crossing is otherwise an "action" (a turn onto a new street, or a switch to the other side).
function crossingIsLinear(runs: Run[], index: number): boolean {
  const before = runs[index - 1];
  const after = runs[index + 1];
  if (!before || !after) {
    return false;
  }
  if (before.kind !== "sidewalk" || after.kind !== "sidewalk") {
    return false;
  }
  return before.name === after.name && before.side === after.side;
}

function classifyTurn(delta: number): { turn: Turn; word: string } {
  const magnitude = Math.abs(delta);
  const hand = delta > 0 ? "right" : "left";
  if (magnitude < 25) {
    return { turn: null, word: "Continue" };
  }
  if (magnitude <= 60) {
    return { turn: `slight ${hand}` as Turn, word: `Slight ${hand}` };
  }
  if (magnitude <= 150) {
    return { turn: hand as Turn, word: `Turn ${hand}` };
  }
  return { turn: "around", word: "Turn around" };
}

// Maneuvers are assembled without their starts, since a collapsed crossing and the walk after one
// fold their length into a row already pushed; the running sum is only right once the list is final.
type UnplacedManeuver = Omit<Maneuver, "startMeters">;

function placeManeuvers(maneuvers: readonly UnplacedManeuver[]): Maneuver[] {
  let running = 0;
  return maneuvers.map((maneuver) => {
    const placed = { ...maneuver, startMeters: running };
    running += maneuver.lengthMeters;
    return placed;
  });
}

// A passed POI as its own maneuver: "Pass <name>", anchored at the POI, sharing the step it is
// nearest so the render can key on it. It carries no distance and no turn.
function poiManeuver(poi: PassedPoi, startMeters: number): Maneuver {
  return {
    kind: poi.kind,
    text: `Pass ${poi.name}`,
    name: poi.name,
    side: null,
    turn: null,
    lengthMeters: 0,
    startMeters,
    stepRange: [poi.stepIndex, poi.stepIndex],
    at: poi.at,
  };
}

// Splice each passed POI in after the maneuver whose run contains its nearest step, so a landmark or
// artwork shows up at the point of the walk where you actually reach it. Ties within one maneuver are
// ordered by step; identical names within a maneuver collapse to the first.
function interleavePois(
  maneuvers: Maneuver[],
  passed: readonly PassedPoi[],
): Maneuver[] {
  if (passed.length === 0) {
    return maneuvers;
  }
  const following = new Map<number, PassedPoi[]>();
  for (const poi of passed) {
    let host = 0;
    for (let index = 0; index < maneuvers.length; index++) {
      if (maneuvers[index].stepRange[0] <= poi.stepIndex) {
        host = index;
      } else {
        break;
      }
    }
    const bucket = following.get(host);
    if (bucket) {
      bucket.push(poi);
    } else {
      following.set(host, [poi]);
    }
  }
  const merged: Maneuver[] = [];
  for (let index = 0; index < maneuvers.length; index++) {
    const host = maneuvers[index];
    merged.push(host);
    const bucket = following.get(index);
    if (!bucket) {
      continue;
    }
    // navProgress stops scanning at the first start past the walker, so a POI anchored outside its
    // host's span would truncate that scan and freeze progress: hold it inside the span.
    const next = maneuvers[index + 1];
    const lowest = host.startMeters;
    const highest = next
      ? next.startMeters
      : host.startMeters + host.lengthMeters;
    bucket.sort((left, right) => left.alongMeters - right.alongMeters);
    const seen = new Set<string>();
    for (const poi of bucket) {
      if (seen.has(poi.name)) {
        continue;
      }
      seen.add(poi.name);
      merged.push(
        poiManeuver(poi, Math.min(highest, Math.max(lowest, poi.alongMeters))),
      );
    }
  }
  return merged;
}

export function buildDirections(
  graph: RoutingGraph,
  result: RouteResult,
  {
    collapseLinearCrossings = false,
    passed = [],
  }: {
    collapseLinearCrossings?: boolean;
    passed?: readonly PassedPoi[];
  } = {},
): Maneuver[] {
  const runs = buildRuns(graph, result.steps, result.rides);
  const maneuvers: UnplacedManeuver[] = [];
  if (runs.length === 0) {
    return placeManeuvers(maneuvers);
  }

  // The last emitted walking run, for the next turn's reference bearing and the suppression check —
  // a crossing does not update it, so a turn after a crossing is measured from the walk before it.
  let lastWalk: Run | null = null;
  let lastCrossIndex = -1; // index in `maneuvers` of the crossing that a suppressed run folds into
  // Index in `maneuvers` of the walk maneuver the current straight segment belongs to, so a collapsed
  // linear crossing and the walk after it extend it in place instead of emitting anything.
  let walkManeuverIndex = -1;

  for (let runIndex = 0; runIndex < runs.length; runIndex++) {
    const run = runs[runIndex];
    const prettyName = run.name ? prettifyStreetName(run.name) : null;

    // A ferry leg is a standalone maneuver reporting the crossing time; it carries no turn and its
    // span isn't a walked distance, so the walk-tracking state resets and the leg after it starts a
    // fresh "Walk ..." rather than turning off the ferry's bearing.
    if (run.kind === "ferry") {
      const dest = run.ferryDest ? stripTerminalSuffix(run.ferryDest) : null;
      // "Take the {route} ferry to {dest}", or "Take the {route} to {dest}" when the route name
      // already ends in "Ferry"; falls back to the generic phrasing if the data lacks the names. The
      // crossing time rides in durationSeconds, rendered where a walking maneuver shows its distance.
      let text: string;
      if (run.ferryRoute && dest) {
        // With a timetable the sailing is named: "Take the 4:40 PM East River ferry to ...".
        const at =
          run.ferryDeparture === null
            ? ""
            : `${formatDeparture(run.ferryDeparture)} `;
        const lead = /ferry$/i.test(run.ferryRoute)
          ? `Take the ${at}${run.ferryRoute}`
          : `Take the ${at}${run.ferryRoute} ferry`;
        text = `${lead} to ${dest}`;
      } else {
        text = "Take the ferry";
      }
      maneuvers.push({
        kind: "ferry",
        text,
        name: null,
        side: null,
        turn: null,
        lengthMeters: run.lengthMeters,
        durationSeconds: run.durationSeconds,
        stepRange: [run.stepStart, run.stepEnd],
        at: runStart(run),
      });
      lastWalk = null;
      walkManeuverIndex = -1;
      lastCrossIndex = -1;
      continue;
    }

    // A ride is a standalone maneuver: it names the line, where the train is bound and how many
    // stops it is ridden, and reports the ride time where a walk reports its distance. Like a ferry
    // it resets the walk-tracking state, so the pavement after it starts a fresh "Walk ...".
    if (run.kind === "transit") {
      const line = run.transitRoute;
      const stops = run.transitStops;
      const count = `${stops} stop${stops === 1 ? "" : "s"}`;
      const at =
        run.transitDeparture === null
          ? ""
          : ` at ${formatDeparture(run.transitDeparture)}`;
      maneuvers.push({
        kind: "transit",
        text: line
          ? `Take the ${line}${at}${run.transitToward ? ` toward ${run.transitToward}` : ""} (${count})`
          : `Take the train${at} (${count})`,
        name: line,
        side: null,
        turn: null,
        lengthMeters: run.lengthMeters,
        durationSeconds: run.durationSeconds,
        stops,
        departureSeconds: run.transitDeparture ?? undefined,
        ride: {
          shortName: line ?? "",
          color: run.transitLivery?.color ?? UNLIVERIED.color,
          textColor: run.transitLivery?.textColor ?? UNLIVERIED.textColor,
          // Wait plus ride, which is what the card's pill says: waiting for the A is time spent
          // taking the A, and one number cannot mean two things across two screens.
          seconds: run.transitWaitSeconds + run.durationSeconds,
        },
        stepRange: [run.stepStart, run.stepEnd],
        at: runStart(run),
      });
      lastWalk = null;
      walkManeuverIndex = -1;
      lastCrossIndex = -1;
      continue;
    }

    // The walks a ride is bracketed by. Each is a real distance underground and carries it, but none
    // of them is a turn on any street, so they leave the walk-tracking state where the ride did.
    if (run.kind === "station") {
      const place = run.station;
      // Getting off one train to get straight onto another is one act, not two: the reader is told
      // to change here, and the "Take the L ..." under it says which train to change to.
      const changing =
        run.stationAction === "alight" &&
        runs[runIndex + 1]?.kind === "transit";
      // A tram stop is not a building: you go to one and you leave it, where a station is entered
      // and exited. The alight is the same words either way — you get off a train wherever it is.
      const stop = run.stationSurface;
      // A station has several ways in and they are not interchangeable — which stair you take
      // settles which platform you reach — so the door is named by the street it stands on.
      const doorName = run.doorName ? prettifyStreetName(run.doorName) : null;
      const doorKind = run.stationElevator ? "elevator" : "stair";
      const through =
        doorName === null
          ? ""
          : ` by the ${doorKind} on ${descriptor(run.doorSide, doorName)}`;
      const text = changing
        ? `Change at ${place ?? "the station"}`
        : run.stationAction === "alight"
          ? `Get off at ${place ?? "your stop"}`
          : run.stationAction === "enter"
            ? stop
              ? `Go to the ${place ?? "stop"} stop`
              : `Enter ${place ?? "the station"}${through}`
            : stop
              ? `Leave the ${place ?? "stop"} stop`
              : `Exit ${place ?? "the station"}${through}`;
      maneuvers.push({
        kind: "station",
        text,
        station: changing ? "change" : (run.stationAction ?? "enter"),
        // A curbside stop has no door, and an alight happens on a platform: neither takes one.
        door:
          changing || stop || run.stationAction === "alight"
            ? undefined
            : doorKind,
        name: place,
        side: null,
        turn: null,
        lengthMeters: run.lengthMeters,
        stepRange: [run.stepStart, run.stepEnd],
        at: runStart(run),
      });
      lastWalk = null;
      walkManeuverIndex = -1;
      lastCrossIndex = -1;
      continue;
    }

    if (run.kind === "crossing") {
      // A linear crossing carries no action: when collapsing, fold its length into the current walk
      // maneuver and emit nothing (the walk run after it, same street+side, extends it below).
      if (collapseLinearCrossings && crossingIsLinear(runs, runIndex)) {
        if (walkManeuverIndex >= 0) {
          const walk = maneuvers[walkManeuverIndex];
          walk.lengthMeters += run.lengthMeters;
          walk.stepRange = [walk.stepRange[0], run.stepEnd];
        }
        continue;
      }
      maneuvers.push({
        kind: "cross",
        text: `Cross ${prettyName ?? "the street"}`,
        name: prettyName,
        side: null,
        turn: null,
        lengthMeters: run.lengthMeters,
        stepRange: [run.stepStart, run.stepEnd],
        at: runStart(run),
      });
      lastCrossIndex = maneuvers.length - 1;
      continue;
    }

    if (!lastWalk) {
      const walkDeg = chordBearing(run);
      const phrase = descriptor(run.side, prettyName);
      maneuvers.push({
        kind: "start",
        text:
          walkDeg === null
            ? `Walk${phrase ? ` on ${phrase}` : ""}`
            : `Walk ${compass8(walkDeg)}${phrase ? ` on ${phrase}` : ""}`,
        name: prettyName,
        side: run.side,
        turn: null,
        lengthMeters: run.lengthMeters,
        stepRange: [run.stepStart, run.stepEnd],
        at: runStart(run),
      });
      lastWalk = run;
      walkManeuverIndex = maneuvers.length - 1;
      continue;
    }

    // A walk right after a crossing that keeps the same street and side is the crossing's own
    // continuation — the "Cross ..." already said it, so fold its length in and emit nothing.
    if (
      lastCrossIndex === maneuvers.length - 1 &&
      run.kind === "sidewalk" &&
      run.name === lastWalk.name &&
      run.side === lastWalk.side
    ) {
      const crossing = maneuvers[lastCrossIndex];
      crossing.lengthMeters += run.lengthMeters;
      crossing.stepRange = [crossing.stepRange[0], run.stepEnd];
      lastWalk = run;
      continue;
    }

    // A walk after one or more collapsed linear crossings resumes the same street+side: extend the
    // walk maneuver those crossings folded into rather than emitting a fresh one.
    if (
      collapseLinearCrossings &&
      walkManeuverIndex >= 0 &&
      run.kind === "sidewalk" &&
      run.name === lastWalk.name &&
      run.side === lastWalk.side
    ) {
      const walk = maneuvers[walkManeuverIndex];
      walk.lengthMeters += run.lengthMeters;
      walk.stepRange = [walk.stepRange[0], run.stepEnd];
      lastWalk = run;
      continue;
    }

    if (run.kind === "path") {
      maneuvers.push({
        kind: "path",
        text: `Follow ${prettyName ?? "the path"}`,
        name: prettyName,
        side: null,
        turn: null,
        lengthMeters: run.lengthMeters,
        stepRange: [run.stepStart, run.stepEnd],
        at: runStart(run),
      });
      lastWalk = run;
      walkManeuverIndex = maneuvers.length - 1;
      continue;
    }

    const fromDeg = lastBearing(lastWalk);
    const toDeg = firstBearing(run);
    const delta =
      fromDeg === null || toDeg === null ? 0 : signedTurn(fromDeg, toDeg);
    const { turn, word } = classifyTurn(delta);
    const phrase = descriptor(run.side, prettyName);
    const connector = turn === null ? "on" : "onto";
    maneuvers.push({
      kind: turn === null ? "continue" : "turn",
      text: `${word}${phrase ? ` ${connector} ${phrase}` : ""}`,
      name: prettyName,
      side: run.side,
      turn,
      lengthMeters: run.lengthMeters,
      stepRange: [run.stepStart, run.stepEnd],
      at: runStart(run),
    });
    lastWalk = run;
    walkManeuverIndex = maneuvers.length - 1;
  }

  const finalRun = runs[runs.length - 1];
  const arrivePhrase = lastWalk
    ? descriptor(
        lastWalk.side,
        lastWalk.name ? prettifyStreetName(lastWalk.name) : null,
      )
    : null;
  maneuvers.push({
    kind: "arrive",
    text: `Arrive${arrivePhrase ? ` — on ${arrivePhrase}` : ""}`,
    name: lastWalk?.name ? prettifyStreetName(lastWalk.name) : null,
    side: lastWalk?.side ?? null,
    turn: null,
    lengthMeters: 0,
    stepRange: [result.steps.length, result.steps.length],
    at: runEnd(finalRun),
  });

  return interleavePois(placeManeuvers(maneuvers), passed);
}

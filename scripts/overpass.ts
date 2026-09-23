import pRetry from "p-retry";
import { cached } from "./cache";
import { USER_AGENT } from "./http";
import type { Coord } from "./socrata";

// Rings of one area, filled even-odd, so a multipolygon's inner rings punch holes.
export type Polygon = Coord[][];

interface OverpassPoint {
  lat: number;
  lon: number;
}

interface OverpassWay {
  type: "way";
  id?: number;
  tags?: Record<string, string>;
  geometry?: OverpassPoint[];
  center?: OverpassPoint; // only with `out center;`
}

interface OverpassRelation {
  type: "relation";
  members?: { type: string; role: string; geometry?: OverpassPoint[] }[];
}

// `out;` (no geom) returns a node's position at the top level, not inside a geometry array.
interface OverpassNode {
  type: "node";
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
}

type OverpassElement = OverpassWay | OverpassRelation | OverpassNode;

// Attempts rotate: no one mirror serves a query this size reliably under load.
const ENDPOINTS: readonly string[] = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const ROTATIONS = 2;
const MAX_ATTEMPTS = ROTATIONS * ENDPOINTS.length;
const RETRY_BASE_MS = 30_000; // a busy Overpass frees a slot in minutes, not seconds
const QUERY_TIMEOUT_SECONDS = 300;
const REQUEST_TIMEOUT_MS = (QUERY_TIMEOUT_SECONDS + 60) * 1000; // only cuts off a hung request

function toCoords(geometry: OverpassPoint[]): Coord[] {
  return geometry.map(({ lat, lon }) => ({ lat, lng: lon }));
}

// A busy Overpass returns an HTML error page under a 200, so the body is checked too.
async function queryEndpoint(
  endpoint: string,
  overpassQl: string,
): Promise<OverpassElement[]> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    },
    body: new URLSearchParams({ data: overpassQl }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  } else if (!body.startsWith("{")) {
    throw new Error(body.slice(0, 200).replace(/\s+/g, " "));
  }
  const parsed = JSON.parse(body) as { elements?: OverpassElement[] };
  if (!Array.isArray(parsed.elements)) {
    throw new Error("no elements in the response");
  }
  return parsed.elements;
}

// Backoff waits between passes over all mirrors; within a pass the next mirror is tried at once.
async function queryRotation(
  overpassQl: string,
  rotation: number,
): Promise<OverpassElement[]> {
  let lastError: unknown;
  for (const [index, endpoint] of ENDPOINTS.entries()) {
    try {
      return await queryEndpoint(endpoint, overpassQl);
    } catch (error) {
      lastError = error;
      const attempt = (rotation - 1) * ENDPOINTS.length + index + 1;
      console.error(
        `  attempt ${attempt}/${MAX_ATTEMPTS} (${new URL(endpoint).host}) failed: ${error}`,
      );
    }
  }
  throw lastError;
}

export async function overpassQuery(
  cacheKey: string,
  overpassQl: string,
): Promise<OverpassElement[]> {
  return cached(cacheKey, overpassQl, async () => {
    try {
      return await pRetry((rotation) => queryRotation(overpassQl, rotation), {
        retries: ROTATIONS - 1,
        minTimeout: RETRY_BASE_MS,
        randomize: true,
      });
    } catch (error) {
      throw new Error(`Overpass query "${cacheKey}" failed: ${error}`);
    }
  });
}

export interface PathWay {
  id: number;
  name?: string;
  steps: boolean;
  structure: boolean; // bridge/tunnel deck or non-zero layer; suppresses false conflation welds
  tunnel: boolean;
  points: Coord[];
}

const WALKABLE = '["area"!="yes"]["indoor"!="yes"]["foot"!~"^(no|private)$"]';

// cycleway brings the greenways; a bike-only segment carries foot=no and drops out.
const FOOT_CLASSES =
  '["highway"~"^(footway|path|pedestrian|steps|cycleway|bridleway|track)$"]';
// `footway` values that describe a street's own pavement rather than a way of its own.
const SIDEWALK_CLASSES = "^(sidewalk|crossing|traffic_island)$";

// Sidewalk classes are excluded (fetchSidewalks is the complement): path dedup must not touch them.
const FOOT_WAYS =
  `way${FOOT_CLASSES}["footway"!~"${SIDEWALK_CLASSES}"]` +
  '["access"!~"^(no|private)$"]' +
  WALKABLE;

// Park drives; motor_vehicle=private also needs a foot grant or a name to keep gated driveways out.
const DRIVE_ROAD =
  '["highway"~"^(unclassified|service|residential|tertiary|living_street)$"]' +
  '["service"!~"^(driveway|parking_aisle|alley|drive-through|emergency_access)$"]';
const DRIVE_CLAUSES = [
  `way["motor_vehicle"="no"]${DRIVE_ROAD}${WALKABLE}`,
  `way["motor_vehicle"="private"]["foot"~"^(yes|designated)$"]${DRIVE_ROAD}${WALKABLE}`,
  `way["motor_vehicle"="private"]["name"]${DRIVE_ROAD}${WALKABLE}`,
];

// Overpass returns each way once even where the unioned clauses overlap.
const PATH_CLAUSES = [FOOT_WAYS, ...DRIVE_CLAUSES];

function pathsQuery(
  south: number,
  west: number,
  north: number,
  east: number,
): string {
  const box = `${south},${west},${north},${east}`;
  const union = PATH_CLAUSES.map((clause) => `${clause}(${box});`).join("");
  return `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];(${union});out geom;`;
}

function tagged(value: string | undefined): boolean {
  return value !== undefined && value !== "no";
}

// Other `covered` values (arcade, colonnade) are open along one side, so not a tunnel.
export function tunneled(tags: Record<string, string>): boolean {
  return tagged(tags.tunnel) || tags.covered === "yes";
}

export async function fetchPaths(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<PathWay[]> {
  const elements = await overpassQuery(
    "overpass-paths",
    pathsQuery(south, west, north, east),
  );
  const ways: PathWay[] = [];
  for (const element of elements) {
    if (element.type !== "way" || element.id === undefined) {
      continue;
    }
    const geometry = element.geometry ?? [];
    if (geometry.length < 2) {
      continue;
    }
    const tags = element.tags ?? {};
    const layer = Number.parseInt(tags.layer ?? "", 10);
    ways.push({
      id: element.id,
      name: tags.name,
      steps: tags.highway === "steps",
      structure:
        tagged(tags.bridge) ||
        tagged(tags.tunnel) ||
        (tags.layer !== undefined && layer !== 0),
      tunnel: tunneled(tags),
      points: toCoords(geometry),
    });
  }
  return ways;
}

// A road's per-side `sidewalk` tags, raw; scripts/sidewalks.ts interprets them.
export interface SidewalkTaggedRoad {
  id: number;
  sidewalk?: string; // `sidewalk` — both/left/right/yes/no/none/separate
  left?: string; // `sidewalk:left`
  right?: string; // `sidewalk:right`
  both?: string; // `sidewalk:both`
  points: Coord[];
}

// No motorways: no ingested centerline is one, so it could only match the frontage road beside it.
const ROAD_CLASSES =
  '["highway"~"^(trunk|primary|secondary|tertiary)(_link)?$|' +
  '^(unclassified|residential|living_street|service|road|busway)$"]';
const SIDEWALK_KEYS = [
  "sidewalk",
  "sidewalk:left",
  "sidewalk:right",
  "sidewalk:both",
];

// One clause per key, not a key regex, to keep `sidewalk:left:surface` and its kin out.
export async function fetchSidewalkTags(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<SidewalkTaggedRoad[]> {
  const box = `${south},${west},${north},${east}`;
  const union = SIDEWALK_KEYS.map(
    (key) => `way${ROAD_CLASSES}["${key}"](${box});`,
  ).join("");
  const query = `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];(${union});out geom;`;
  const elements = await overpassQuery("overpass-sidewalk-tags", query);
  const roads: SidewalkTaggedRoad[] = [];
  for (const element of elements) {
    if (element.type !== "way" || element.id === undefined) {
      continue;
    }
    const geometry = element.geometry ?? [];
    if (geometry.length < 2) {
      continue;
    }
    const tags = element.tags ?? {};
    roads.push({
      id: element.id,
      sidewalk: tags.sidewalk,
      left: tags["sidewalk:left"],
      right: tags["sidewalk:right"],
      both: tags["sidewalk:both"],
      points: toCoords(geometry),
    });
  }
  return roads;
}

export interface SidewalkWay {
  id: number;
  name?: string;
  footway: "sidewalk" | "crossing" | "traffic_island";
  structure: boolean;
  tunnel: boolean;
  points: Coord[];
}

const SIDEWALK_VALUES = ["sidewalk", "crossing", "traffic_island"] as const;

// Keeps traffic islands: crossings chain through them, so dropping them splits median crossings.
export async function fetchSidewalks(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<SidewalkWay[]> {
  const box = `${south},${west},${north},${east}`;
  const clause =
    `way${FOOT_CLASSES}["footway"~"${SIDEWALK_CLASSES}"]` +
    '["access"!~"^(no|private)$"]' +
    WALKABLE;
  const query = `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];${clause}(${box});out geom;`;
  const elements = await overpassQuery("overpass-sidewalks", query);
  const ways: SidewalkWay[] = [];
  for (const element of elements) {
    if (element.type !== "way" || element.id === undefined) {
      continue;
    }
    const geometry = element.geometry ?? [];
    if (geometry.length < 2) {
      continue;
    }
    const tags = element.tags ?? {};
    const footway = SIDEWALK_VALUES.find((value) => value === tags.footway);
    if (footway === undefined) {
      continue;
    }
    const layer = Number.parseInt(tags.layer ?? "", 10);
    ways.push({
      id: element.id,
      name: tags.name,
      footway,
      structure:
        tagged(tags.bridge) ||
        tagged(tags.tunnel) ||
        (tags.layer !== undefined && layer !== 0),
      tunnel: tunneled(tags),
      points: toCoords(geometry),
    });
  }
  return ways;
}

// Fills ForMS holes: Central Park has 697 ForMS trees against ~3,945 in OSM.
export interface OsmTree {
  lat: number;
  lng: number;
  crownDiameterMeters?: number; // diameter_crown, meters
}

function osmTreesQuery(
  south: number,
  west: number,
  north: number,
  east: number,
): string {
  const box = `${south},${west},${north},${east}`;
  return `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];node["natural"="tree"](${box});out;`;
}

export async function fetchOsmTrees(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<OsmTree[]> {
  const elements = await overpassQuery(
    "overpass-trees",
    osmTreesQuery(south, west, north, east),
  );
  const trees: OsmTree[] = [];
  for (const element of elements) {
    if (
      element.type !== "node" ||
      element.lat === undefined ||
      element.lon === undefined
    ) {
      continue;
    }
    // Values come as "12", "12 m", "12.5"; parseFloat takes the leading number.
    const diameter = Number.parseFloat(element.tags?.diameter_crown ?? "");
    trees.push({
      lat: element.lat,
      lng: element.lon,
      crownDiameterMeters:
        Number.isFinite(diameter) && diameter > 0 ? diameter : undefined,
    });
  }
  return trees;
}

export interface OsmArtwork extends Coord {
  name?: string;
}

// Supplements the NYC PDC inventory, which is thin on murals. A way is taken at its center.
export async function fetchOsmArtwork(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<OsmArtwork[]> {
  const box = `${south},${west},${north},${east}`;
  const query =
    `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];` +
    `(node["tourism"="artwork"](${box});way["tourism"="artwork"](${box}););out center;`;
  const elements = await overpassQuery("overpass-artwork", query);
  const points: OsmArtwork[] = [];
  for (const element of elements) {
    if (
      element.type === "node" &&
      element.lat !== undefined &&
      element.lon !== undefined
    ) {
      points.push({
        lat: element.lat,
        lng: element.lon,
        name: element.tags?.name?.trim(),
      });
    } else if (element.type === "way" && element.center) {
      points.push({
        lat: element.center.lat,
        lng: element.center.lon,
        name: element.tags?.name?.trim(),
      });
    }
  }
  return points;
}

export interface OsmSeating extends Coord {
  name?: string;
}

// Supplements the NYC Dining Out café-license inventory. A way is taken at its center.
export async function fetchOutdoorSeating(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<OsmSeating[]> {
  const box = `${south},${west},${north},${east}`;
  const query =
    `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];` +
    `nwr["outdoor_seating"="yes"](${box});out center tags;`;
  const elements = await overpassQuery("overpass-outdoor-seating", query);
  const points: OsmSeating[] = [];
  for (const element of elements) {
    if (
      element.type === "node" &&
      element.lat !== undefined &&
      element.lon !== undefined
    ) {
      points.push({
        lat: element.lat,
        lng: element.lon,
        name: element.tags?.name?.trim(),
      });
    } else if (element.type === "way" && element.center) {
      points.push({
        lat: element.center.lat,
        lng: element.center.lon,
        name: element.tags?.name?.trim(),
      });
    }
  }
  return points;
}

export interface NuisanceLine {
  kind: "highway" | "rail"; // only for the ingest log; the penalty treats them alike
  points: Coord[];
}

const HIGHWAY_CLASSES = "^(motorway|trunk|motorway_link|trunk_link)$";
const RAIL_CLASSES = "^(rail|subway|light_rail)$";

// Any rail not underground: open cuts carry no bridge/layer tag, so "elevated only" misses them.
export async function fetchNuisanceLines(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<NuisanceLine[]> {
  const box = `${south},${west},${north},${east}`;
  const query =
    `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];(` +
    `way["highway"~"${HIGHWAY_CLASSES}"](${box});` +
    `way["railway"~"${RAIL_CLASSES}"]["tunnel"!~"yes"](${box});` +
    `);out geom;`;
  const elements = await overpassQuery("overpass-nuisance", query);
  const lines: NuisanceLine[] = [];
  for (const element of elements) {
    if (
      element.type !== "way" ||
      !element.geometry ||
      element.geometry.length < 2
    ) {
      continue;
    }
    const tags = element.tags ?? {};
    let kind: NuisanceLine["kind"] | null = null;
    if (tags.highway !== undefined) {
      kind = "highway";
    } else if (tags.railway !== undefined && tags.tunnel !== "yes") {
      const layer = Number.parseInt(tags.layer ?? "", 10);
      if (!Number.isFinite(layer) || layer >= 0) {
        kind = "rail";
      }
    }
    if (kind !== null) {
      lines.push({ kind, points: toCoords(element.geometry) });
    }
  }
  return lines;
}

// No tag reliably ties an entrance to its station; only some carry `station_name`.
export interface OsmStationEntrance extends Coord {
  stationName?: string;
  name?: string; // the corner or plaza the door stands on, not the station
  ref?: string; // the agency's door letter, "A1", "B3"
  access?: string;
  elevator: boolean;
  escalator: boolean;
  ramp: boolean;
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text === "" ? undefined : text;
}

// Lifts are tagged three equivalent ways by survey era; `conveying` is OSM's escalator tag.
export async function fetchStationEntrances(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<OsmStationEntrance[]> {
  const box = `${south},${west},${north},${east}`;
  const query =
    `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];(` +
    `node["railway"="subway_entrance"](${box});` +
    `node["railway"="train_station_entrance"](${box});` +
    `);out;`;
  const elements = await overpassQuery("overpass-station-entrances", query);
  const entrances: OsmStationEntrance[] = [];
  for (const element of elements) {
    if (
      element.type !== "node" ||
      element.lat === undefined ||
      element.lon === undefined
    ) {
      continue;
    }
    const tags = element.tags ?? {};
    entrances.push({
      lat: element.lat,
      lng: element.lon,
      stationName: trimmed(tags.station_name),
      name: trimmed(tags.name),
      ref: trimmed(tags.ref),
      access: trimmed(tags.access),
      elevator:
        tags.highway === "elevator" ||
        tags.elevator === "yes" ||
        tags.entrance === "elevator",
      escalator: tags.conveying === "yes" || tags.escalator === "yes",
      ramp: tags.ramp === "yes" || tags.highway === "ramp",
    });
  }
  return entrances;
}

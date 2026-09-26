import pRetry from "p-retry";
import { cached } from "./cache";
import { densify, haversineMeters } from "./geometry";
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
  id?: number;
  tags?: Record<string, string>;
  members?: { type: string; role: string; geometry?: OverpassPoint[] }[];
}

// `out;` (no geom) returns a node's position at the top level, not inside a geometry array.
interface OverpassNode {
  type: "node";
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
}

export type OverpassElement = OverpassWay | OverpassRelation | OverpassNode;

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
const BARRED = /^(no|private)$/;

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

const PRIVATE_SERVICE =
  "^(driveway|parking_aisle|alley|drive-through|emergency_access)$";

// Park drives; motor_vehicle=private also needs a foot grant or a name to keep gated driveways out.
const DRIVE_ROAD =
  '["highway"~"^(unclassified|service|residential|tertiary|living_street)$"]' +
  `["service"!~"${PRIVATE_SERVICE}"]`;
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

function pathWayOf(element: OverpassElement): PathWay | null {
  if (element.type !== "way" || element.id === undefined) {
    return null;
  }
  const geometry = element.geometry ?? [];
  if (geometry.length < 2) {
    return null;
  }
  const tags = element.tags ?? {};
  const layer = Number.parseInt(tags.layer ?? "", 10);
  return {
    id: element.id,
    name: tags.name,
    steps: tags.highway === "steps",
    structure:
      tagged(tags.bridge) ||
      tagged(tags.tunnel) ||
      (tags.layer !== undefined && layer !== 0),
    tunnel: tunneled(tags),
    points: toCoords(geometry),
  };
}

// Green-Wood's avenues are highway=service, access=permissive, so no clause above admits them.
const CEMETERY_LANE_SHARE = 0.8; // of a lane's length inside a cemetery; the rest is its gate
const LANE_STEP_METERS = 5;
const PRIVATE_SERVICE_PATTERN = new RegExp(PRIVATE_SERVICE);

function isCemetery(tags: Record<string, string> | undefined): boolean {
  return tags?.landuse === "cemetery" || tags?.amenity === "grave_yard";
}

// No name required: Oakland's Mountain View names none of its lanes; the polygon is the guard.
function isCemeteryLane(tags: Record<string, string>): boolean {
  return (
    tags.highway === "service" &&
    !PRIVATE_SERVICE_PATTERN.test(tags.service ?? "") &&
    !BARRED.test(tags.access ?? "") &&
    !BARRED.test(tags.foot ?? "") &&
    tags.area !== "yes" &&
    tags.indoor !== "yes"
  );
}

interface CemeteryArea {
  south: number;
  west: number;
  north: number;
  east: number;
  chains: OverpassPoint[][];
}

const AREA_RELATIONS = new Set(["multipolygon", "boundary"]);
const RING_ROLES = new Set(["outer", "inner"]);

// Closed only if every chain end meets another, as each ring's first and last node do.
function chainsClose(chains: readonly OverpassPoint[][]): boolean {
  const ends = new Map<string, number>();
  for (const chain of chains) {
    for (const end of [chain[0], chain[chain.length - 1]]) {
      const key = `${end.lat},${end.lon}`;
      ends.set(key, (ends.get(key) ?? 0) + 1);
    }
  }
  return [...ends.values()].every((count) => count % 2 === 0);
}

// A relation's member ways close only together, so each is kept as an open chain.
function cemeteryArea(element: OverpassElement): CemeteryArea | null {
  let chains: OverpassPoint[][] = [];
  if (element.type === "way" && isCemetery(element.tags)) {
    chains = [element.geometry ?? []];
  } else if (
    element.type === "relation" &&
    isCemetery(element.tags) &&
    AREA_RELATIONS.has(element.tags?.type ?? "")
  ) {
    chains = (element.members ?? [])
      .filter((member) => member.type === "way" && RING_ROLES.has(member.role))
      .map((member) => member.geometry ?? []);
  }
  chains = chains.filter((chain) => chain.length > 0);
  const points = chains.flat();
  if (points.length < 3) {
    return null;
  }
  // An open outline would read everything to one side of it as inside.
  if (!chainsClose(chains)) {
    console.error(
      `  cemetery ${element.type} ${"id" in element ? element.id : "?"}: its rings don't close; skipped`,
    );
    return null;
  }
  const lats = points.map((point) => point.lat);
  const lngs = points.map((point) => point.lon);
  return {
    south: Math.min(...lats),
    west: Math.min(...lngs),
    north: Math.max(...lats),
    east: Math.max(...lngs),
    chains,
  };
}

const EDGE_METERS = 1; // nearer an outline than this, which side a point lies on is rounding
const METERS_PER_DEGREE = 111_320;

// Within EDGE_METERS of any of the area's edges, measured on a local flat plane.
function nearEdge(area: CemeteryArea, { lat, lng }: Coord): boolean {
  const latPad = EDGE_METERS / METERS_PER_DEGREE;
  const scale = Math.cos((lat * Math.PI) / 180) * METERS_PER_DEGREE;
  const lngPad = EDGE_METERS / scale;
  if (
    lat < area.south - latPad ||
    lat > area.north + latPad ||
    lng < area.west - lngPad ||
    lng > area.east + lngPad
  ) {
    return false;
  }
  for (const chain of area.chains) {
    for (let index = 1; index < chain.length; index++) {
      const ax = (chain[index - 1].lon - lng) * scale;
      const ay = (chain[index - 1].lat - lat) * METERS_PER_DEGREE;
      const bx = (chain[index].lon - lng) * scale;
      const by = (chain[index].lat - lat) * METERS_PER_DEGREE;
      const dx = bx - ax;
      const dy = by - ay;
      const length = dx * dx + dy * dy;
      const along =
        length === 0
          ? 0
          : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length));
      if (Math.hypot(ax + along * dx, ay + along * dy) < EDGE_METERS) {
        return true;
      }
    }
  }
  return false;
}

// Even-odd over every member edge; OSM closes a ring by repeating its first node.
function insideArea(area: CemeteryArea, { lat, lng }: Coord): boolean {
  if (
    lat < area.south ||
    lat > area.north ||
    lng < area.west ||
    lng > area.east
  ) {
    return false;
  }
  let inside = false;
  for (const chain of area.chains) {
    for (let index = 1; index < chain.length; index++) {
      const from = chain[index - 1];
      const to = chain[index];
      if (from.lat > lat !== to.lat > lat) {
        const at =
          from.lon +
          ((lat - from.lat) / (to.lat - from.lat)) * (to.lon - from.lon);
        if (lng < at) {
          inside = !inside;
        }
      }
    }
  }
  return inside;
}

// The walkable service ways lying mostly inside a cemetery, out of one mixed result.
export function cemeteryLanes(elements: readonly OverpassElement[]): PathWay[] {
  const areas: CemeteryArea[] = [];
  for (const element of elements) {
    const area = cemeteryArea(element);
    if (area !== null) {
      areas.push(area);
    }
  }
  const lanes: PathWay[] = [];
  for (const element of elements) {
    if (element.type !== "way" || !isCemeteryLane(element.tags ?? {})) {
      continue;
    }
    const lane = pathWayOf(element);
    if (lane === null) {
      continue;
    }
    // Densified, so a long straight lane is credited a step at a time rather than all-or-nothing.
    const dense = densify(lane.points, LANE_STEP_METERS).points;
    let total = 0;
    let inside = 0;
    for (let index = 1; index < dense.length; index++) {
      const from = dense[index - 1];
      const to = dense[index];
      const middle = {
        lat: (from.lat + to.lat) / 2,
        lng: (from.lng + to.lng) / 2,
      };
      // A step along the fence is neither in nor out, so the rest of the lane decides.
      if (areas.some((area) => nearEdge(area, middle))) {
        continue;
      }
      const meters = haversineMeters(from, to);
      total += meters;
      if (areas.some((area) => insideArea(area, middle))) {
        inside += meters;
      }
    }
    if (total > 0 && inside >= CEMETERY_LANE_SHARE * total) {
      lanes.push(lane);
    }
  }
  return lanes;
}

// The area filter only narrows the fetch to service ways touching a cemetery; cemeteryLanes decides.
function cemeteryLanesQuery(
  south: number,
  west: number,
  north: number,
  east: number,
): string {
  const box = `${south},${west},${north},${east}`;
  const areas = ['["landuse"="cemetery"]', '["amenity"="grave_yard"]']
    .map((filter) => `way${filter}(${box});rel${filter}(${box});`)
    .join("");
  return (
    `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];(${areas})->.cemeteries;` +
    ".cemeteries out geom;.cemeteries map_to_area->.grounds;" +
    `way(area.grounds)["highway"="service"](${box});out geom;`
  );
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
    const way = pathWayOf(element);
    if (way !== null) {
      ways.push(way);
    }
  }
  const lanes = cemeteryLanes(
    await overpassQuery(
      "overpass-cemetery-lanes",
      cemeteryLanesQuery(south, west, north, east),
    ),
  );
  const seen = new Set(ways.map((way) => way.id));
  const added = lanes.filter((lane) => !seen.has(lane.id));
  console.error(
    `  cemetery lanes: ${lanes.length} kept, ${added.length} not already paths`,
  );
  return [...ways, ...added];
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
  kind: "highway" | "rail"; // only for the ingest log
  klass: number; // NUISANCE_CLASS
  name: string | null; // OSM `name`, for matching traffic counts
  points: Coord[];
}

// The HWAY class byte.
export const NUISANCE_CLASS = {
  motorway: 0,
  trunk: 1,
  primary: 2,
  secondary: 3,
  tertiary: 4,
  rail: 5,
} as const;

const HIGHWAY_CLASS_CODES = new Map<string, number>([
  ["motorway", NUISANCE_CLASS.motorway],
  ["trunk", NUISANCE_CLASS.trunk],
  ["primary", NUISANCE_CLASS.primary],
  ["secondary", NUISANCE_CLASS.secondary],
  ["tertiary", NUISANCE_CLASS.tertiary],
]);
const LINK_SUFFIX = "_link";

const HIGHWAY_CLASSES = "^(motorway|trunk|primary|secondary|tertiary)(_link)?$";
const RAIL_CLASSES = "^(rail|subway|light_rail)$";

// Tunnels drop out on both branches. Any rail not underground counts: open cuts carry no bridge/layer
// tag, so "elevated only" misses them.
export function nuisanceLineOf(element: OverpassElement): NuisanceLine | null {
  if (
    element.type !== "way" ||
    !element.geometry ||
    element.geometry.length < 2 ||
    element.tags?.tunnel === "yes"
  ) {
    return null;
  }
  const tags = element.tags ?? {};
  if (tags.highway !== undefined) {
    const value = tags.highway.endsWith(LINK_SUFFIX)
      ? tags.highway.slice(0, -LINK_SUFFIX.length)
      : tags.highway;
    const klass = HIGHWAY_CLASS_CODES.get(value);
    return klass === undefined
      ? null
      : {
          kind: "highway",
          klass,
          name: tags.name?.trim() || null,
          points: toCoords(element.geometry),
        };
  }
  if (tags.railway !== undefined) {
    const layer = Number.parseInt(tags.layer ?? "", 10);
    if (Number.isFinite(layer) && layer < 0) {
      return null;
    }
    return {
      kind: "rail",
      klass: NUISANCE_CLASS.rail,
      name: tags.name?.trim() || null,
      points: toCoords(element.geometry),
    };
  }
  return null;
}

export async function fetchNuisanceLines(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<NuisanceLine[]> {
  const box = `${south},${west},${north},${east}`;
  const query =
    `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];(` +
    `way["highway"~"${HIGHWAY_CLASSES}"]["tunnel"!~"yes"](${box});` +
    `way["railway"~"${RAIL_CLASSES}"]["tunnel"!~"yes"](${box});` +
    `);out geom;`;
  const elements = await overpassQuery("overpass-nuisance", query);
  const lines: NuisanceLine[] = [];
  for (const element of elements) {
    const line = nuisanceLineOf(element);
    if (line !== null) {
      lines.push(line);
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

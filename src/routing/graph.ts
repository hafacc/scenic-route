// The client's view of the routing graph baked by the graph pass. Layout: scripts/README.md
// (magic GRPH, v12 — the sidewalk graph with inert ferry and transit edges, laid out by column).
// Every column is viewed in place over the fetched buffer through the header's section directory,
// so decoding copies nothing and both threads hold one set of bytes each.

import { cityById } from "../cities";
import type { FerryTimetable } from "./ferry-schedule";
import type { ShadeField } from "./shade";
import type { ShedField } from "./sheds";
import type { TransitTimetable } from "./transit-schedule";
import { WALK_METERS_PER_SECOND, type WalkSeconds } from "./walk-speed";

// A no-geometry edge (a crossing, a link, or a straight ferry) stores this sentinel in its geometry
// offset; its polyline is the straight line between its two node coordinates.
export const NO_GEOMETRY = 0xffffffff;
const NAME_NONE = 0xffff;
// Edge kind lives in bits 0-2 of the kind+side byte; the side in bits 3-5.
const KIND_MASK = 0x7;
const SIDE_SHIFT = 3;
const SIDE_MASK = 0x7;
const KIND_CROSSING = 1;
// The three transit kinds: the walk in and out of a station, the step onto a pattern's platform
// (whose wait the timetable answers at route time, so it bakes no duration), and one stop to the
// next. All three are DIRECTED — see `transitForward`.
const KIND_ACCESS = 5;
const KIND_BOARD = 6;
const KIND_RIDE = 7;
// flags byte bit 2 marks a sidewalk that lies to the right of its stored geometry direction.
const GEOMETRY_RIGHT_FLAG = 0x4;
// flags byte bit 4 marks an edge running through a tunnel. No format bump came with it: the byte was
// already there, so a graph written before the bit reads it as 0 and behaves as it always did.
export const TUNNEL_FLAG = 0x10;
// The top three flag bits belong to an ACCESS edge alone, where none of the walking bits apply: the
// door's own direction and kind. An older graph reads them as 0, which is a two-way stair.
export const EXIT_ONLY_FLAG = 0x20;
export const ENTRY_ONLY_FLAG = 0x40;
export const ELEVATOR_FLAG = 0x80;
// The one flag bit a RIDE edge carries: this ride is the free step from a stop's arrival node onto
// its boarding node, which is a rider staying on the train. It borrows the entry-only door's bit,
// since a ride carries no door bit and no walking one; the kind is what tells the two apart.
export const STAY_ABOARD_FLAG = 0x40;

// An edge with no durable identity — a crossing, a link or a ferry, none of which comes from a
// source segment. Its source-id slot carries this sentinel.
export const NO_SOURCE_ID = 0xffffffff;
// The durable key packs (source id, side, ordinal) into one number: the ordinal is a u8 and the side
// fits three bits, so a source id up to a u32 still lands well inside an exact double.
const DURABLE_SIDE_STRIDE = 256;
const DURABLE_SOURCE_STRIDE = 2048;

// The rebuild-surviving name of one edge, as `sheds.ts` and the SHED artifact spell it. Positional
// edge ids all shift when the graph is rebuilt; this does not, because the source id is CSCL's own
// `physicalid` (or an OSM way id for a path), the side is the sidewalk's N/E/S/W label, and the
// ordinal only separates the several edges one source segment can become.
export function durableKey(
  sourceId: number,
  side: number,
  ordinal: number,
): number {
  return (
    sourceId * DURABLE_SOURCE_STRIDE + side * DURABLE_SIDE_STRIDE + ordinal
  );
}

// One edge's durable key, or -1 when it has no durable identity.
export function edgeDurableKey(graph: RoutingGraph, edge: number): number {
  const sourceId = graph.edgeSourceId[edge];
  if (sourceId === NO_SOURCE_ID) {
    return -1;
  } else {
    return durableKey(
      sourceId,
      (graph.edgeKindSide[edge] >> SIDE_SHIFT) & SIDE_MASK,
      graph.edgeOrdinal[edge],
    );
  }
}

// The nodes standing in a roadway rather than on pavement: those whose every walking edge is a
// crossing. A marked crossing of a divided street is drawn as several ways chained through the
// islands between them, so these are the joints inside one crossing. Charging a wait per crossing
// EDGE would bill a wide avenue two or three times for a single wait. Transit edges do not count:
// a station whose access edge happens to land on a traffic island does not pave it.
export function markMidRoadwayNodes(
  nodeCount: number,
  csr: Uint32Array,
  adjacency: Uint32Array,
  edgeKindSide: Uint8Array,
): Uint8Array {
  const midRoadway = new Uint8Array(nodeCount);
  for (let node = 0; node < nodeCount; node += 1) {
    const from = csr[node];
    const to = csr[node + 1];
    let walking = 0;
    let allCrossings = true;
    for (let slot = from; slot < to && allCrossings; slot += 1) {
      const kind = edgeKindSide[adjacency[slot]] & KIND_MASK;
      if (kind === KIND_ACCESS || kind === KIND_BOARD || kind === KIND_RIDE) {
        continue;
      }
      walking += 1;
      allCrossings = kind === KIND_CROSSING;
    }
    midRoadway[node] = allCrossings && walking > 0 ? 1 : 0;
  }
  return midRoadway;
}

export type EdgeKind =
  | "sidewalk"
  | "crossing"
  | "link"
  | "path"
  | "ferry"
  | "access"
  | "board"
  | "ride";
export type SideLabel = "north" | "east" | "south" | "west" | null;

// Where a station door stands: the street the pavement it was cut into carries, and which side of
// that street that pavement lies on. A door on a corner is on the street its own kerb belongs to,
// which the step a route happens to arrive along need not be.
export interface DoorStreet {
  street: string;
  side: SideLabel;
}

const EDGE_KINDS: readonly EdgeKind[] = [
  "sidewalk",
  "crossing",
  "link",
  "path",
  "ferry",
  "access",
  "board",
  "ride",
];
const TRANSIT_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  "access",
  "board",
  "ride",
]);
const SIDE_LABELS: readonly SideLabel[] = [
  null,
  "north",
  "east",
  "south",
  "west",
];

// The two figures routing/<city>.version.json names a graph by, both FNV-1a 64 in hex.
export interface GraphIdentity {
  // What this graph IS: the hash of the GRPH file's own bytes. It changes on any rebuild at all,
  // including one that only moved an f32 length, so nothing an artifact is gated on rides on it.
  hash: string;
  // What a placed artifact resolves THROUGH: the hash of the durable key space — every
  // `(source id, side, ordinal)` the graph carries, ascending. `sheds.ts` gates on this one.
  keyHash: string;
}

export interface RoutingGraph extends GraphIdentity {
  nodeCount: number;
  edgeCount: number;
  originLng: number;
  originLat: number;
  scale: number; // degrees per quantized unit; degrees = origin + q * scale
  nodeQx: Int32Array;
  nodeQy: Int32Array;
  nodeComponent: Uint16Array;
  csr: Uint32Array; // nodeCount + 1; node n owns half-edges [csr[n], csr[n + 1])
  adjacency: Uint32Array; // 2 * edgeCount edge ids; the neighbour is the edge's other endpoint
  edgeNodeA: Uint32Array;
  edgeNodeB: Uint32Array;
  edgeLength: Float32Array; // geodesic metres
  edgeGeomOffset: Uint32Array; // byte offset into the geometry blob; NO_GEOMETRY = straight a -> b
  edgeGeomCount: Uint16Array; // geometry vertices, 0 when no geometry
  edgeCover: Uint8Array; // 0..254, this edge's own single value; 0 for a ferry
  edgeNameId: Uint16Array; // index into names, or NAME_NONE
  edgeKindSide: Uint8Array; // bits 0-2 kind, bits 3-5 side
  edgeSourceId: Uint32Array; // the CSCL physicalid or OSM way id; NO_SOURCE_ID for a crossing, link or ferry
  edgeOrdinal: Uint8Array; // which edge of the several one source segment becomes; both feed `edgeDurableKey`
  // 1 where every edge on the node is a crossing, i.e. a traffic island: a walker standing there is
  // mid-roadway, part way through one crossing rather than at the start of another. Baked by the
  // tiler, whose rule is `markMidRoadwayNodes` below.
  nodeMidRoadway: Uint8Array;
  maxCover: number; // the greatest per-edge cover in the graph, 0..1; sets the cost clip floor

  edgeLandmark: Uint8Array; // 0..254, this edge's landmark-amenity discount attribute; 0 for a ferry
  edgeArt: Uint8Array; // 0..254, this edge's public-art discount attribute; 0 for a ferry
  edgeHighway: Uint8Array; // 0..254, this edge's highway/rail nuisance penalty attribute; 0 for a ferry
  edgeCommercial: Uint8Array; // 0..254, this edge's nice-commercial-frontage discount attribute; 0 for a ferry
  edgeIndustrial: Uint8Array; // 0..254, this edge's industrial-frontage penalty attribute; 0 for a ferry
  // 0..254, the share of this edge inside a designated historic district — a discount attribute, so
  // its max below is a term of the A* lower bound and not only a slider gate. 0 for a ferry.
  edgeHistoric: Uint8Array;
  // 0..254, the share of this edge that crosses open water on a bridge deck — a discount attribute,
  // so its max below is a term of the A* lower bound as well as the slider's gate. A tunnel and a
  // viaduct over a rail yard read 0, and so does everything off a deck. 0 for a ferry.
  edgeBridge: Uint8Array;
  maxLandmark: number; // the greatest per-edge landmark amenity, 0..1; sets that discount's clip floor
  maxArt: number; // the greatest per-edge art amenity, 0..1; sets that discount's clip floor
  maxCommercial: number; // the greatest per-edge commercial amenity, 0..1; sets that discount's clip floor
  maxIndustrial: number; // the greatest per-edge industrial frontage, 0..1; gates the slider, never the heuristic
  maxHistoric: number; // the greatest per-edge historic share, 0..1; sets that discount's clip floor
  maxBridge: number; // the greatest per-edge over-water share, 0..1; sets that discount's clip floor

  // The share of the edge that lies DIRECTLY under a crown, unblurred — what edgeCover, the smoothed
  // field the overlay is coloured from, cannot answer.
  edgeDirectCanopy: Uint8Array; // 0..254; 0 for a ferry
  // 0..254 each: the height this edge CLIMBS and the height it DROPS walking it a -> b, over its
  // length, as a fraction of 35%. Reversing the edge swaps them; their sum is the absolute grade the
  // hill penalty steers by, and the two apart are what makes a descent quicker than the climb back.
  // 0 for a ferry and for a city with no DEM.
  edgeAscent: Uint8Array;
  edgeDescent: Uint8Array;
  // Every edge's walking seconds both ways round, taken from the two bytes above: the relax loop
  // reads them rather than running Tobler's exponential four times an edge. Baked by the thread that
  // searches, so it is null on the page and on a hand-built fixture, which fall back per edge
  // (./walk-speed).
  walkSeconds: WalkSeconds | null;
  // The largest total grade present, as a fraction of 35% — up to 2, since the two bytes clamp
  // separately. NOT a heuristic bound — hill is a penalty, whose minimum factor is 1, so it never
  // loosens the A* lower bound. This is read to tell a city with no elevation source (every edge 0)
  // from one that has it, which is what greys the slider out.
  maxRelief: number;
  maxDirectCanopy: number; // the greatest per-edge direct canopy, 0..1; that factor's clip-floor input

  // The route-time signed shade field, filled from the SHDE artifact by computeEdgeShade: the per-edge
  // sun/shade attribute as a function of elapsed walking time, so a metre is costed against the sun at
  // the moment it is reached. Null when no artifact is loaded or the sun is below the horizon for the
  // whole walk (no shade to bias); its maxAbs (0..1) is the shade factor's clip-floor input.
  shade: ShadeField | null;

  // How long this region's walker will wait on a pier, and how long on a platform, from
  // src/cities.ts. Not baked into the artifact: both are judgements about a timetable rather than
  // facts about the geometry, and changing one should not mean rebuilding a 40 MB graph.
  maxFerryWaitSeconds?: number;
  maxTransitWaitSeconds?: number;

  // The picked day's sidewalk sheds, filled from the SHED artifact by computeEdgeSheds: per edge, how
  // much of it stands under a deck. A deck is opaque and dry, so it feeds the shade composite, the
  // shelter factor and the avoid penalty. Null until that resolves, and the cost model reads no
  // scaffolding at all while it is.
  sheds: ShedField | null;

  // The departure date's ferry timetable, filled from the FSCH artifact by computeFerrySchedule: per
  // ferry edge, the sailings out of each of its two terminals. Null until that resolves and on any day
  // no record covers, and every ferry then costs the baked `edgeDurationSeconds` below instead.
  ferries: FerryTimetable | null;

  // A ferry edge's crossing-plus-average-wait seconds, the whole timetable flattened to one number,
  // and the walk or ride seconds of a transit edge; 0 for every walking kind. What a ferry costs
  // when `ferries` is null.
  edgeDurationSeconds: Uint16Array;
  ferryEdges: Uint32Array; // ids of the ferry edges, for the A* ferry-credit heuristic
  // The transit topology baked into the graph: the ids of every access, board and ride edge, and
  // the board subset on its own, which is what the A* transit credit and the mode gating read.
  transitEdges: Uint32Array;
  boardEdges: Uint32Array;
  // Every route the city's transit topology carries, in the order the side table lists them, which
  // is the order `routeOf` indexes.
  transitRoutes: TransitRoute[];
  minFerrySecPerMetre: number; // min over ferry edges of duration/length, Infinity when there are none
  // The same figure for the two transit kinds that carry their seconds in the graph, and the floor
  // the A* heuristic keeps under the transit credit. Infinity when the city has no rail.
  minRideSecPerMetre: number;
  minAccessSecPerMetre: number;
  // bit0 structure, bit1 steps, bit2 geometry-right (sidewalks), bit3 OSM-sourced, bit4 tunnel
  edgeFlags: Uint8Array;
  // Whether any edge carries the tunnel bit, which is what lets `maxShelter` raise its bound to meet
  // a tunnel's shelter of 1 without loosening the heuristic for a city with nothing underground.
  hasTunnels: boolean;
  names: string[];
  geometry: Uint8Array;
  // Per ferry edge, its two terminal stop names at the node-a and node-b ends (aligned to
  // edgeNodeA/edgeNodeB). The route name is the edge's own name (`edgeName`).
  ferryEndpointNames: Map<number, { a: string; b: string }>;
  // Per board edge, the lane (route, direction, stop pattern) the daily timetable is keyed by and
  // which of that lane's stops this platform is, and per board and ride edge, the route it runs.
  // `laneOf`, `stopIndexOf` and `routeOf` read these.
  transitLaneOf: Map<number, number>;
  transitStopOf: Map<number, number>;
  transitRouteOf: Map<number, number>;
  // Per street door, the street it opens onto and which side of that street it stands on, as the
  // tiler read them off the pavement it cut the door into. `doorStreet` reads it.
  transitDoorStreet: Map<number, DoorStreet>;
  // 1 for a node of a pattern's own platform — the one its board edge lands on and the one its ride
  // lands on — rather than a place anyone walks. It is what tells an alight edge from the walk out of
  // a station: both are access edges, and only one of them may be walked backwards. Derived from the
  // board and ride edges, not stored.
  nodePlatform: Uint8Array;

  // The departure date's rail timetable, filled from the TSCH artifact by computeTransitSchedule:
  // per lane, when the next train leaves each of its stops. Null until that resolves and on any day
  // no record covers, and every board edge then costs Infinity — no schedule, no train.
  transit: TransitTimetable | null;
}

// One transit route as the graph carries it: what a rider calls it, the corridor it runs, its feed
// id (the same id the display artifact uses, so the two join on it) and the published livery as CSS
// colours.
export interface TransitRoute {
  shortName: string;
  longName: string;
  id: string;
  color: string;
  textColor: string;
}

const MAGIC = "GRPH";
// Exported so a fixture cannot drift from it: a test writing its own header must write this.
export const FORMAT_VERSION = 12;
// 64 fixed bytes then a 48-entry (u32 offset, u32 byteLength, u32 column tag) section directory, of
// which v12 fills 35. Checked at decode, which is what binds a fixture's own copy of the figure to
// this one.
const HEADER_BYTES = 640;
const DIRECTORY_AT = 64;
const DIRECTORY_ENTRY_BYTES = 12;

// The column a directory entry holds, as FNV-1a 32 over the name this file calls it by. A section is
// found by its POSITION in the directory, so two same-sized columns written in the other order would
// each be read as the other and misprice every route silently; the tag is what makes that a throw.
function columnTag(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
const HAS_TUNNELS_FLAG = 0x1; // header byte 58

// What `column` below needs of a typed-array constructor: build one empty, or view one in place.
interface ColumnKind<Column> {
  new (length: number): Column;
  new (buffer: ArrayBuffer, byteOffset: number, length: number): Column;
  readonly BYTES_PER_ELEMENT: number;
}

// relative, so both pick up the deploy basePath
// Written by the same pass as the graph itself, and named after it: one directory holds
// every city's, so a shared name would describe whichever built last.
const versionUrl = (cityId: string): string => `routing/${cityId}.version.json`;
// Above the edge count of one long route, which is the run this cache has to hold: a search reads an
// edge's geometry and the stitching reads it again, so a limit under a route's length threw the
// first half away before the second half asked for it. New York's longest bench trip is 13 km of
// pavement at some 30 m an edge.
const PATH_CACHE_LIMIT = 4096;

// `identity` is what these bytes hash to and what their key space hashes to, neither of which the
// bytes themselves can carry — a file cannot hold its own FNV, and walking 600k keys to recover the
// second is work the graph pass already did. The deploy writes both beside the graph and the pipeline
// recomputes them; either way the caller is the one that knows.
export function decodeGraph(
  buffer: ArrayBuffer,
  identity: GraphIdentity,
): RoutingGraph {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const version = view.getUint16(4, true);
  if (magic !== MAGIC || version !== FORMAT_VERSION) {
    throw new Error(`not a v${FORMAT_VERSION} routing graph`);
  }
  // The one thing the directory cannot say about itself: a writer that put it anywhere else says so
  // here, rather than handing back columns read off the wrong offsets.
  if (view.getUint16(6, true) !== HEADER_BYTES) {
    throw new Error(
      `a v${FORMAT_VERSION} routing graph's header is ${HEADER_BYTES} bytes`,
    );
  }

  const nodeCount = view.getUint32(8, true);
  const edgeCount = view.getUint32(12, true);
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const sectionCount = view.getUint32(44, true);

  // Sections are taken in the order the directory lists them, which is the order the writer appends
  // them in — one cursor rather than 35 index constants that could drift from it. Each entry names
  // the column it holds, so a writer that wrote them in another order is caught rather than read.
  let nextSection = 0;
  const section = (name: string): { offset: number; byteLength: number } => {
    const index = nextSection;
    nextSection += 1;
    if (index >= sectionCount) {
      return { offset: 0, byteLength: 0 };
    } else {
      const at = DIRECTORY_AT + DIRECTORY_ENTRY_BYTES * index;
      const offset = view.getUint32(at, true);
      const tag = view.getUint32(at + 8, true);
      if (offset !== 0 && tag !== columnTag(name)) {
        throw new Error(`section ${index} of this graph is not ${name}`);
      }
      return { offset, byteLength: view.getUint32(at + 4, true) };
    }
  };
  // One column, viewed in place. A section the file does not carry — a column baked after this
  // graph was written — reads as the zeros that graph behaved as if it held.
  const column = <Column>(
    kind: ColumnKind<Column>,
    count: number,
    name: string,
  ): Column => {
    const { offset, byteLength } = section(name);
    if (offset === 0) {
      return new kind(count);
    } else if (byteLength !== count * kind.BYTES_PER_ELEMENT) {
      throw new Error(`${name}: ${byteLength} bytes is not ${count} elements`);
    } else {
      return new kind(buffer, offset, count);
    }
  };
  // One of the three edge-id lists, whose length only the directory records.
  const idList = (name: string): Uint32Array => {
    const { offset, byteLength } = section(name);
    if (offset === 0) {
      return new Uint32Array(0);
    } else if (byteLength % 4 !== 0) {
      throw new Error(`${name}: ${byteLength} bytes is not whole edge ids`);
    } else {
      return new Uint32Array(buffer, offset, byteLength / 4);
    }
  };

  const nodeQx = column(Int32Array, nodeCount, "nodeQx");
  const nodeQy = column(Int32Array, nodeCount, "nodeQy");
  const nodeComponent = column(Uint16Array, nodeCount, "nodeComponent");
  const nodeMidRoadway = column(Uint8Array, nodeCount, "nodeMidRoadway");
  const csr = column(Uint32Array, nodeCount + 1, "csr");
  const adjacency = column(Uint32Array, 2 * edgeCount, "adjacency");
  const edgeNodeA = column(Uint32Array, edgeCount, "edgeNodeA");
  const edgeNodeB = column(Uint32Array, edgeCount, "edgeNodeB");
  const edgeLength = column(Float32Array, edgeCount, "edgeLength");
  const edgeGeomOffset = column(Uint32Array, edgeCount, "edgeGeomOffset");
  const edgeGeomCount = column(Uint16Array, edgeCount, "edgeGeomCount");
  const edgeNameId = column(Uint16Array, edgeCount, "edgeNameId");
  const edgeDurationSeconds = column(
    Uint16Array,
    edgeCount,
    "edgeDurationSeconds",
  );
  const edgeKindSide = column(Uint8Array, edgeCount, "edgeKindSide");
  const edgeFlags = column(Uint8Array, edgeCount, "edgeFlags");
  const edgeCover = column(Uint8Array, edgeCount, "edgeCover");
  const edgeLandmark = column(Uint8Array, edgeCount, "edgeLandmark");
  const edgeArt = column(Uint8Array, edgeCount, "edgeArt");
  const edgeHighway = column(Uint8Array, edgeCount, "edgeHighway");
  const edgeCommercial = column(Uint8Array, edgeCount, "edgeCommercial");
  const edgeDirectCanopy = column(Uint8Array, edgeCount, "edgeDirectCanopy");
  const edgeIndustrial = column(Uint8Array, edgeCount, "edgeIndustrial");
  const edgeHistoric = column(Uint8Array, edgeCount, "edgeHistoric");
  const edgeBridge = column(Uint8Array, edgeCount, "edgeBridge");
  const edgeAscent = column(Uint8Array, edgeCount, "edgeAscent");
  const edgeDescent = column(Uint8Array, edgeCount, "edgeDescent");
  const edgeSourceId = column(Uint32Array, edgeCount, "edgeSourceId");
  const edgeOrdinal = column(Uint8Array, edgeCount, "edgeOrdinal");
  const ferryEdges = idList("ferryEdges");
  const transitEdges = idList("transitEdges");
  const boardEdges = idList("boardEdges");
  const nameTable = section("names");
  const geometrySection = section("geometry");
  const ferryTable = section("ferryEndpoints");
  const transitTable = section("transitTables");

  // The maxima and the tunnel flag come baked: reading them off the columns is a pass over every
  // edge, on both threads, for eight bytes the writer already knew.
  const maxCover = bytes[48] / 255;
  const maxLandmark = bytes[49] / 255;
  const maxArt = bytes[50] / 255;
  const maxCommercial = bytes[51] / 255;
  const maxDirectCanopy = bytes[52] / 255;
  const maxIndustrial = bytes[53] / 255;
  const maxHistoric = bytes[54] / 255;
  const maxBridge = bytes[55] / 255;
  const maxRelief = view.getUint16(56, true) / 255;
  const hasTunnels = (bytes[58] & HAS_TUNNELS_FLAG) !== 0;

  // The three per-metre floors stay derived rather than baked: they are f64 arithmetic over a few
  // thousand edges, and a figure in the file would go stale the moment a duration moved.
  let minFerrySecPerMetre = Number.POSITIVE_INFINITY;
  for (const edge of ferryEdges) {
    const length = edgeLength[edge];
    if (length > 0) {
      minFerrySecPerMetre = Math.min(
        minFerrySecPerMetre,
        edgeDurationSeconds[edge] / length,
      );
    }
  }
  let minRideSecPerMetre = Number.POSITIVE_INFINITY;
  let minAccessSecPerMetre = Number.POSITIVE_INFINITY;
  for (const edge of transitEdges) {
    const length = edgeLength[edge];
    const kind = edgeKindSide[edge] & KIND_MASK;
    if (length <= 0) {
      continue;
    }
    if (kind === KIND_RIDE) {
      minRideSecPerMetre = Math.min(
        minRideSecPerMetre,
        edgeDurationSeconds[edge] / length,
      );
    } else if (kind === KIND_ACCESS) {
      minAccessSecPerMetre = Math.min(
        minAccessSecPerMetre,
        edgeDurationSeconds[edge] / length,
      );
    }
  }

  const names: string[] =
    nameTable.offset === 0 ? [] : decodeNames(buffer, nameTable.offset);
  const geometry = new Uint8Array(
    buffer,
    geometrySection.offset,
    geometrySection.byteLength,
  );
  const ferryEndpointNames = decodeFerryEndpointNames(
    buffer,
    ferryTable.offset,
    names,
  );
  const {
    transitRoutes,
    transitLaneOf,
    transitStopOf,
    transitRouteOf,
    transitDoorStreet,
  } = decodeTransitTables(
    buffer,
    transitTable.offset,
    transitTable.byteLength,
    names,
  );
  const nodePlatform = new Uint8Array(nodeCount);
  for (const edge of boardEdges) {
    nodePlatform[edgeNodeB[edge]] = 1;
  }
  for (const edge of transitEdges) {
    if ((edgeKindSide[edge] & KIND_MASK) === KIND_RIDE) {
      nodePlatform[edgeNodeA[edge]] = 1;
      nodePlatform[edgeNodeB[edge]] = 1;
    }
  }

  return {
    ...identity,
    nodeCount,
    edgeCount,
    originLng,
    originLat,
    scale,
    nodeQx,
    nodeQy,
    nodeComponent,
    csr,
    adjacency,
    edgeNodeA,
    edgeNodeB,
    edgeLength,
    edgeGeomOffset,
    edgeGeomCount,
    edgeCover,
    edgeNameId,
    edgeKindSide,
    edgeSourceId,
    edgeOrdinal,
    nodeMidRoadway,
    maxCover,
    edgeLandmark,
    edgeArt,
    edgeHighway,
    edgeCommercial,
    edgeIndustrial,
    edgeHistoric,
    edgeBridge,
    maxLandmark,
    maxArt,
    maxCommercial,
    maxIndustrial,
    maxHistoric,
    maxBridge,
    edgeDirectCanopy,
    maxDirectCanopy,
    edgeAscent,
    edgeDescent,
    walkSeconds: null, // baked by the thread that searches, in RoutingEngine.load
    maxRelief,
    shade: null, // populated lazily once the SHDE artifact loads, keyed on the departure instant
    sheds: null, // populated lazily once the SHED artifact loads, keyed on the picked day
    ferries: null, // populated lazily once the FSCH artifact loads, keyed on the departure day
    transit: null, // and this once the TSCH artifact loads, keyed on the same day
    edgeDurationSeconds,
    ferryEdges,
    minFerrySecPerMetre,
    minRideSecPerMetre,
    minAccessSecPerMetre,
    edgeFlags,
    hasTunnels,
    names,
    geometry,
    ferryEndpointNames,
    transitEdges,
    boardEdges,
    transitRoutes,
    transitLaneOf,
    transitStopOf,
    transitRouteOf,
    transitDoorStreet,
    nodePlatform,
  };
}

// The name table: a u32 count, (count + 1) u32 byte offsets into the trailing UTF-8 blob, then
// the blob. The offsets bracket each name, so access is O(1) and the strings are decoded once.
function decodeNames(buffer: ArrayBuffer, tableOffset: number): string[] {
  const view = new DataView(buffer);
  const count = view.getUint32(tableOffset, true);
  const offsetsAt = tableOffset + 4;
  const blobAt = offsetsAt + (count + 1) * 4;
  const decoder = new TextDecoder();
  const names: string[] = new Array(count);
  for (let index = 0; index < count; index++) {
    const start = view.getUint32(offsetsAt + index * 4, true);
    const end = view.getUint32(offsetsAt + (index + 1) * 4, true);
    names[index] = decoder.decode(
      new Uint8Array(buffer, blobAt + start, end - start),
    );
  }
  return names;
}

// The ferry endpoint-stop-name side table (byte-60 offset): a u32 count, then per ferry edge a
// (u32 edge id, u16 a-stop name id, u16 b-stop name id) triple, both ids into the name table. The
// route name rides on the edge itself, so only the two terminal names live here.
function decodeFerryEndpointNames(
  buffer: ArrayBuffer,
  tableOffset: number,
  names: string[],
): Map<number, { a: string; b: string }> {
  const map = new Map<number, { a: string; b: string }>();
  if (tableOffset === 0 || tableOffset + 4 > buffer.byteLength) {
    return map;
  }
  const view = new DataView(buffer);
  const count = view.getUint32(tableOffset, true);
  let at = tableOffset + 4;
  for (let index = 0; index < count; index++) {
    const edge = view.getUint32(at, true);
    const aId = view.getUint16(at + 4, true);
    const bId = view.getUint16(at + 6, true);
    at += 8;
    map.set(edge, { a: names[aId] ?? "", b: names[bId] ?? "" });
  }
  return map;
}

// The transit side tables (the byte-64 offset, 4-aligned after the ferry table): a u32 count and a
// 12-byte record per route (RGB, text RGB, three u16 name ids), then a u32 count and a 12-byte
// record per board edge (edge id, lane id, route index, stop index), then a u32 count and an 8-byte
// record per ride edge (edge id, route index, pad), then a u32 count and an 8-byte record per street
// door (edge id, street name id, side, pad). All are empty for a city with no transit source, and
// the doors are absent altogether from a graph written before the tiler recorded them — which is
// why the table's own length, not the buffer's, is where the reading stops.
function decodeTransitTables(
  buffer: ArrayBuffer,
  tableOffset: number,
  tableBytes: number,
  names: string[],
): {
  transitRoutes: TransitRoute[];
  transitLaneOf: Map<number, number>;
  transitStopOf: Map<number, number>;
  transitRouteOf: Map<number, number>;
  transitDoorStreet: Map<number, DoorStreet>;
} {
  const transitRoutes: TransitRoute[] = [];
  const transitLaneOf = new Map<number, number>();
  const transitStopOf = new Map<number, number>();
  const transitRouteOf = new Map<number, number>();
  const transitDoorStreet = new Map<number, DoorStreet>();
  if (tableOffset === 0 || tableOffset + 4 > buffer.byteLength) {
    return {
      transitRoutes,
      transitLaneOf,
      transitStopOf,
      transitRouteOf,
      transitDoorStreet,
    };
  }
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const hex = (at: number): string =>
    `#${[bytes[at], bytes[at + 1], bytes[at + 2]]
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("")}`;
  const routeCount = view.getUint32(tableOffset, true);
  let at = tableOffset + 4;
  for (let index = 0; index < routeCount; index++) {
    transitRoutes.push({
      color: hex(at),
      textColor: hex(at + 3),
      shortName: names[view.getUint16(at + 6, true)] ?? "",
      longName: names[view.getUint16(at + 8, true)] ?? "",
      id: names[view.getUint16(at + 10, true)] ?? "",
    });
    at += 12;
  }
  const boardCount = view.getUint32(at, true);
  at += 4;
  for (let index = 0; index < boardCount; index++) {
    const edge = view.getUint32(at, true);
    transitLaneOf.set(edge, view.getUint32(at + 4, true));
    transitRouteOf.set(edge, view.getUint16(at + 8, true));
    transitStopOf.set(edge, view.getUint16(at + 10, true));
    at += 12;
  }
  const rideCount = view.getUint32(at, true);
  at += 4;
  for (let index = 0; index < rideCount; index++) {
    transitRouteOf.set(view.getUint32(at, true), view.getUint16(at + 4, true));
    at += 8;
  }
  const end = tableOffset + tableBytes;
  if (at + 4 <= end) {
    const doorCount = view.getUint32(at, true);
    at += 4;
    for (let index = 0; index < doorCount && at + 8 <= end; index++) {
      transitDoorStreet.set(view.getUint32(at, true), {
        street: names[view.getUint16(at + 4, true)] ?? "",
        side: SIDE_LABELS[bytes[at + 6] & SIDE_MASK],
      });
      at += 8;
    }
  }
  return {
    transitRoutes,
    transitLaneOf,
    transitStopOf,
    transitRouteOf,
    transitDoorStreet,
  };
}

// The lane the daily timetable answers this board edge against — a (route, direction, stop pattern),
// hashed by the ingest so a graph and a timetable written days apart still agree. -1 for every edge
// that is not a board edge.
export function laneOf(graph: RoutingGraph, edge: number): number {
  return graph.transitLaneOf.get(edge) ?? -1;
}

// Which of its lane's stops this board edge's platform is, counted as the FEED lists them — the
// index TSCH's per-stop offsets are in, so a station the snap dropped leaves a hole in the graph's
// chain and none in this numbering. -1 for every edge that is not a board edge.
export function stopIndexOf(graph: RoutingGraph, edge: number): number {
  return graph.transitStopOf.get(edge) ?? -1;
}

// The route a board or ride edge runs, or null for anything else — an access edge included, since
// the walk in and out of a station belongs to no one line.
export function routeOf(
  graph: RoutingGraph,
  edge: number,
): TransitRoute | null {
  const index = graph.transitRouteOf.get(edge);
  return index === undefined ? null : (graph.transitRoutes[index] ?? null);
}

// Is this edge part of the transit topology rather than the walking network? Read where something
// walks the graph and only pavement will do — the waypoint proxy, the reversal check.
export function isTransitEdge(graph: RoutingGraph, edge: number): boolean {
  return TRANSIT_KINDS.has(edgeKind(graph, edge));
}

// May this edge be entered at `fromNode`? The topology is directed — you board a platform from its
// station's ENTRY node, ride to the next stop's ARRIVAL node, and alight onto that station's EXIT
// node — but the graph stores every edge undirected, so each of those has a reverse the search must
// refuse. Riding backwards is the obvious one; the quiet one is stepping onto a platform through an
// alight edge, which would put a walker on a train with no wait at all. Every door is one-way too:
// in to the entry node, out of the exit one, which is what keeps a station from being a walkable
// underpass — the only edge back from an exit to its entry is the change of train, and it runs that
// way alone. The stay-aboard edge runs one way for the same reason, arrival onto boarding, so a
// board and an alight at one stop cannot be strung together either. Every walking edge is
// traversable.
export function transitForward(
  graph: RoutingGraph,
  edge: number,
  fromNode: number,
): boolean {
  const kind = edgeKind(graph, edge);
  if (kind === "board" || kind === "ride") {
    return fromNode === graph.edgeNodeA[edge];
  } else if (kind === "access" && graph.nodePlatform[graph.edgeNodeA[edge]]) {
    return fromNode === graph.edgeNodeA[edge]; // an alight: off the platform only
  } else if (kind === "access" && isExitOnlyDoor(graph, edge)) {
    return fromNode === graph.edgeNodeA[edge]; // a way out: out of the station, never into it
  } else if (kind === "access" && isEntryOnlyDoor(graph, edge)) {
    return fromNode !== graph.edgeNodeA[edge];
  } else {
    return true;
  }
}

// What a station is called, asked of either of a station side's two nodes. The doors carry the name
// and the change of train between the two carries it as well — an alight edge is unnamed and a board
// edge is named for its line — so the named access edge leaving this node is the one to read. Null
// for any other node, a platform and a pavement node included: no named access edge leaves either.
export function stationName(graph: RoutingGraph, node: number): string | null {
  for (let slot = graph.csr[node]; slot < graph.csr[node + 1]; slot++) {
    const edge = graph.adjacency[slot];
    if (edgeKind(graph, edge) === "access" && graph.edgeNodeA[edge] === node) {
      const name = edgeName(graph, edge);
      if (name !== null) {
        return name;
      }
    }
  }
  return null;
}

// The seconds the tiler bakes for the walk between a kerbside stop and the pavement, against the
// longer one it bakes for a station with a way in (crates/tiler/src/graph.rs, SURFACE_ACCESS_SECONDS
// and UNDERGROUND_ACCESS_SECONDS). The feed's own surface flag is not in the graph, and this is the
// only trace of it left: what a rider is told to do differs — you go to a tram stop and you enter a
// station — so the distinction has to survive somehow.
const SURFACE_ACCESS_SECONDS = 30;
const UNDERGROUND_ACCESS_SECONDS = 90;

// Is this access edge the walk to a stop standing in the street rather than into a station? The
// baked seconds are the stair plus the walk out to this particular door, and the edge's length is
// that walk, so taking it back off leaves the one of the two figures above that the tiler started
// from — read at the midpoint, which no rounding of either can cross.
export function isSurfaceStop(graph: RoutingGraph, edge: number): boolean {
  const stair =
    graph.edgeDurationSeconds[edge] -
    graph.edgeLength[edge] / WALK_METERS_PER_SECOND;
  return stair < (SURFACE_ACCESS_SECONDS + UNDERGROUND_ACCESS_SECONDS) / 2;
}

// True when this ride is the free step from a stop's arrival node onto its boarding node — a rider
// staying on the train rather than getting off. It is internal to one boarding: it costs nothing, it
// covers no ground, and it is no stop of the ride it sits inside.
export function isStayAboard(graph: RoutingGraph, edge: number): boolean {
  return (
    edgeKind(graph, edge) === "ride" &&
    (graph.edgeFlags[edge] & STAY_ABOARD_FLAG) !== 0
  );
}

// The arrival node beside a boarding node: the far end of the stay-aboard edge that runs into it.
// The alight hangs off that one, never off the node a board lands on.
function platformArrival(graph: RoutingGraph, boardingNode: number): number {
  for (
    let slot = graph.csr[boardingNode];
    slot < graph.csr[boardingNode + 1];
    slot++
  ) {
    const edge = graph.adjacency[slot];
    if (isStayAboard(graph, edge) && graph.edgeNodeB[edge] === boardingNode) {
      return graph.edgeNodeA[edge];
    }
  }
  return boardingNode;
}

// The last station a pattern calls at, ridden from this platform: the ride chain followed to its
// end. This is what a rider is told a train is bound FOR, which the graph never writes down — it is
// simply where the line the walker is standing on runs out. The last platform's alight edge is what
// names it, that edge climbing to the station's exit node.
//
// The chain alternates, a ride onto the next stop's arrival node and a stay-aboard onto its boarding
// node, so it runs out at a boarding node and the alight is one step back from there.
export function patternTerminus(
  graph: RoutingGraph,
  platformNode: number,
): string | null {
  let node = platformNode;
  let station: string | null = null;
  for (;;) {
    let next = -1;
    for (let slot = graph.csr[node]; slot < graph.csr[node + 1]; slot++) {
      const edge = graph.adjacency[slot];
      if (edgeKind(graph, edge) === "ride" && graph.edgeNodeA[edge] === node) {
        next = graph.edgeNodeB[edge];
        break;
      }
    }
    if (next < 0) {
      break;
    }
    node = next;
  }
  const arrival = platformArrival(graph, node);
  for (let slot = graph.csr[arrival]; slot < graph.csr[arrival + 1]; slot++) {
    const edge = graph.adjacency[slot];
    // The platform's alight edge, whose node b is the station it climbs back up to.
    if (
      edgeKind(graph, edge) === "access" &&
      graph.edgeNodeA[edge] === arrival
    ) {
      station = stationName(graph, graph.edgeNodeB[edge]);
    }
  }
  return station;
}

export function edgeKind(graph: RoutingGraph, edge: number): EdgeKind {
  return EDGE_KINDS[graph.edgeKindSide[edge] & KIND_MASK];
}

export function edgeSideLabel(graph: RoutingGraph, edge: number): SideLabel {
  return SIDE_LABELS[(graph.edgeKindSide[edge] >> SIDE_SHIFT) & SIDE_MASK];
}

export function edgeName(graph: RoutingGraph, edge: number): string | null {
  const nameId = graph.edgeNameId[edge];
  return nameId === NAME_NONE ? null : graph.names[nameId];
}

// True when this sidewalk lies to the right of its stored geometry direction (flags bit 2).
export function edgeGeometryRight(graph: RoutingGraph, edge: number): boolean {
  return (graph.edgeFlags[edge] & GEOMETRY_RIGHT_FLAG) !== 0;
}

// True when this edge runs through a tunnel (flags bit 4): roofed, and out of the sun.
export function isTunnel(graph: RoutingGraph, edge: number): boolean {
  return (graph.edgeFlags[edge] & TUNNEL_FLAG) !== 0;
}

// The three door bits, each asked of an access edge: the station's own way in and out. A walking
// edge carries other things in these bits, so every one of them is a question about a door first.
// A door out of the station only — the gate at the top of a stair a rider cannot come back down.
export function isExitOnlyDoor(graph: RoutingGraph, edge: number): boolean {
  return (
    edgeKind(graph, edge) === "access" &&
    (graph.edgeFlags[edge] & EXIT_ONLY_FLAG) !== 0
  );
}

// A door into the station only, which is the same fixture the other way round.
export function isEntryOnlyDoor(graph: RoutingGraph, edge: number): boolean {
  return (
    edgeKind(graph, edge) === "access" &&
    (graph.edgeFlags[edge] & ENTRY_ONLY_FLAG) !== 0
  );
}

// A lift rather than a stair: the one door kind whose baked seconds differ, and the one the
// directions and their icon name differently.
export function isElevatorDoor(graph: RoutingGraph, edge: number): boolean {
  return (
    edgeKind(graph, edge) === "access" &&
    (graph.edgeFlags[edge] & ELEVATOR_FLAG) !== 0
  );
}

// The street this door opens onto, or null where the tiler recorded none — the pavement it was cut
// into has no name, or the edge is not a door at all. The alternative, naming the door by whichever
// step the route reaches it along, calls a door on a corner by the cross street and a door reached
// across a crossing by nothing.
export function doorStreet(
  graph: RoutingGraph,
  edge: number,
): DoorStreet | null {
  return graph.transitDoorStreet.get(edge) ?? null;
}

// Keyed by city: switching city loads a different graph, and coming back must not refetch the first.
const graphPromises = new Map<string, Promise<RoutingGraph>>();
// Kept so the routing worker can be handed a copy without a second download; the decoded graph
// views most of these bytes in place.
const graphBuffers = new Map<string, ArrayBuffer>();

export function graphBuffer(cityId: string): ArrayBuffer | undefined {
  return graphBuffers.get(cityId);
}

// How the graph beside it names itself, read out of the deploy's own record rather than recomputed
// here: FNV-1a over 30 MB of graph is ~0.5 s of blocked main thread on a laptop and several times
// that on a phone, and the key space would want a 600k-element sort on top, to arrive at two numbers
// the graph pass already wrote down. The two files are written by one pass, so they cannot skew. An
// unreadable version file leaves both unknown, which no artifact then matches — the graph itself
// still loads, so only what is placed against it goes quiet. A version file from before `keyHash`
// existed is the same case.
async function fetchGraphIdentity(cityId: string): Promise<GraphIdentity> {
  const url = versionUrl(cityId);
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    const version = (await response.json()) as Partial<GraphIdentity>;
    return { hash: version.hash ?? "", keyHash: version.keyHash ?? "" };
  } catch (error: unknown) {
    console.error(`${url} is unreadable:`, error);
    return { hash: "", keyHash: "" };
  }
}

// The pier and platform waits are not in the artifact, and both decoders go through here — the
// page's fetch and the worker's copy of the same bytes — so neither can be the one that forgets them.
export function decodeCityGraph(
  cityId: string,
  buffer: ArrayBuffer,
  identity: GraphIdentity,
): RoutingGraph {
  const graph = decodeGraph(buffer, identity);
  const city = cityById(cityId);
  graph.maxFerryWaitSeconds = city?.maxFerryWaitSeconds;
  graph.maxTransitWaitSeconds = city?.maxTransitWaitSeconds;
  return graph;
}

export function loadGraph(cityId: string): Promise<RoutingGraph> {
  const pending = graphPromises.get(cityId);
  if (pending) {
    return pending;
  }
  const url = `routing/${cityId}.bin`;
  const request = Promise.all([fetch(url), fetchGraphIdentity(cityId)])
    .then(async ([response, identity]) => {
      if (!response.ok) {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
      }
      const buffer = await response.arrayBuffer();
      graphBuffers.set(cityId, buffer);
      return decodeCityGraph(cityId, buffer, identity);
    })
    .catch((error: unknown) => {
      graphPromises.delete(cityId); // a failed load must not be memoized
      throw error;
    });
  graphPromises.set(cityId, request);
  return request;
}

function readVarint(bytes: Uint8Array, cursor: { offset: number }): number {
  let value = 0;
  let shift = 0;
  let byte = 0;
  do {
    byte = bytes[cursor.offset];
    cursor.offset += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return (value >>> 1) ^ -(value & 1);
}

export interface EdgePath {
  lngs: Float64Array;
  lats: Float64Array;
}

// Bounded most-recently-used cache: a route decodes an edge's geometry once for the search and
// again while stitching, and adjacent queries revisit the same corridor. Edge ids repeat between
// cities, so each graph gets its own cache and drops it when the graph itself is dropped.
let pathCaches = new WeakMap<RoutingGraph, Map<number, EdgePath>>();

export function clearEdgePathCache(): void {
  pathCaches = new WeakMap<RoutingGraph, Map<number, EdgePath>>();
}

function cacheFor(graph: RoutingGraph): Map<number, EdgePath> {
  const existing = pathCaches.get(graph);
  if (existing) {
    return existing;
  } else {
    const created = new Map<number, EdgePath>();
    pathCaches.set(graph, created);
    return created;
  }
}

export function edgePath(graph: RoutingGraph, edge: number): EdgePath {
  const pathCache = cacheFor(graph);
  const cached = pathCache.get(edge);
  if (cached) {
    pathCache.delete(edge);
    pathCache.set(edge, cached);
    return cached;
  }

  let path: EdgePath;
  if (graph.edgeGeomOffset[edge] === NO_GEOMETRY) {
    // Crossings and links carry no geometry: the polyline is the straight line between the two
    // node coordinates, in a -> b order.
    const nodeA = graph.edgeNodeA[edge];
    const nodeB = graph.edgeNodeB[edge];
    path = {
      lngs: Float64Array.of(
        graph.originLng + graph.nodeQx[nodeA] * graph.scale,
        graph.originLng + graph.nodeQx[nodeB] * graph.scale,
      ),
      lats: Float64Array.of(
        graph.originLat + graph.nodeQy[nodeA] * graph.scale,
        graph.originLat + graph.nodeQy[nodeB] * graph.scale,
      ),
    };
  } else {
    const count = graph.edgeGeomCount[edge];
    const lngs = new Float64Array(count);
    const lats = new Float64Array(count);
    const cursor = { offset: graph.edgeGeomOffset[edge] };
    // Geometry entries are origin-anchored: the first pair is the absolute quantized position (a
    // delta from the graph origin) and the rest are previous-vertex deltas.
    let quantizedX = 0;
    let quantizedY = 0;
    for (let vertex = 0; vertex < count; vertex++) {
      quantizedX += readVarint(graph.geometry, cursor);
      quantizedY += readVarint(graph.geometry, cursor);
      lngs[vertex] = graph.originLng + quantizedX * graph.scale;
      lats[vertex] = graph.originLat + quantizedY * graph.scale;
    }
    path = { lngs, lats };
  }

  pathCache.set(edge, path);
  if (pathCache.size > PATH_CACHE_LIMIT) {
    const oldest = pathCache.keys().next().value;
    if (oldest !== undefined) {
      pathCache.delete(oldest);
    }
  }
  return path;
}

// The edge's polyline between two along-distances, in a -> b order, with the two boundaries
// interpolated. Along-distance is measured in the same scaled metric as Snap.metersFromA — the
// polyline's own planar arc length rescaled to the edge's geodesic length — so a fraction of the
// edge's length is the same fraction of its polyline.
export function subEdgePath(
  graph: RoutingGraph,
  edge: number,
  fromMeters: number,
  toMeters: number,
): { lngs: number[]; lats: number[] } {
  const { lngs, lats } = edgePath(graph, edge);
  const toRad = Math.PI / 180;
  const cosLat = Math.cos(lats[0] * toRad);
  const cumulative = new Float64Array(lngs.length);
  for (let vertex = 1; vertex < lngs.length; vertex++) {
    const deltaX = (lngs[vertex] - lngs[vertex - 1]) * cosLat;
    const deltaY = lats[vertex] - lats[vertex - 1];
    cumulative[vertex] = cumulative[vertex - 1] + Math.hypot(deltaX, deltaY);
  }
  const total = cumulative[lngs.length - 1];
  const scale = total > 0 ? graph.edgeLength[edge] / total : 0;

  const at = (distance: number): { lng: number; lat: number } => {
    if (scale === 0) {
      return { lng: lngs[0], lat: lats[0] };
    }
    const raw = distance / scale;
    let vertex = 1;
    while (vertex < lngs.length - 1 && cumulative[vertex] < raw) {
      vertex += 1;
    }
    const span = cumulative[vertex] - cumulative[vertex - 1];
    const param = span > 0 ? (raw - cumulative[vertex - 1]) / span : 0;
    return {
      lng: lngs[vertex - 1] + param * (lngs[vertex] - lngs[vertex - 1]),
      lat: lats[vertex - 1] + param * (lats[vertex] - lats[vertex - 1]),
    };
  };

  const start = at(fromMeters);
  const outLngs = [start.lng];
  const outLats = [start.lat];
  for (let vertex = 0; vertex < lngs.length; vertex++) {
    const along = cumulative[vertex] * scale;
    if (along > fromMeters && along < toMeters) {
      outLngs.push(lngs[vertex]);
      outLats.push(lats[vertex]);
    }
  }
  const end = at(toMeters);
  outLngs.push(end.lng);
  outLats.push(end.lat);
  return { lngs: outLngs, lats: outLats };
}

export function otherEnd(
  graph: RoutingGraph,
  edge: number,
  node: number,
): number {
  return graph.edgeNodeA[edge] === node
    ? graph.edgeNodeB[edge]
    : graph.edgeNodeA[edge];
}

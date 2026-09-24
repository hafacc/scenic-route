// Layout in scripts/README.md (GRPH v12); columns are viewed in place, so decoding copies nothing.

import { cityById } from "../cities";
import type { FerryTimetable } from "./ferry-schedule";
import type { ShadeField } from "./shade";
import type { ShedField } from "./sheds";
import type { TransitTimetable } from "./transit-schedule";
import { WALK_METERS_PER_SECOND, type WalkSeconds } from "./walk-speed";

// A no-geometry edge (crossing, link, straight ferry) is the straight line between its nodes.
export const NO_GEOMETRY = 0xffffffff;
const NAME_NONE = 0xffff;
// Edge kind lives in bits 0-2 of the kind+side byte; the side in bits 3-5.
const KIND_MASK = 0x7;
const SIDE_SHIFT = 3;
const SIDE_MASK = 0x7;
const KIND_CROSSING = 1;
// All three transit kinds are directed; see `transitForward`.
const KIND_ACCESS = 5;
const KIND_BOARD = 6;
const KIND_RIDE = 7;
const GEOMETRY_RIGHT_FLAG = 0x4;
// No format bump: a graph written before this bit reads it as 0.
export const TUNNEL_FLAG = 0x10;
// The top three flag bits are an access edge's door bits; an older graph reads 0, a two-way stair.
export const EXIT_ONLY_FLAG = 0x20;
export const ENTRY_ONLY_FLAG = 0x40;
export const ELEVATOR_FLAG = 0x80;
// A ride's only flag, borrowing the entry-only door bit; the edge kind tells the two apart.
export const STAY_ABOARD_FLAG = 0x40;

export const NO_SOURCE_ID = 0xffffffff;
// The ordinal is a u8 and the side fits three bits, so a u32 source id stays inside an exact double.
const DURABLE_SIDE_STRIDE = 256;
const DURABLE_SOURCE_STRIDE = 2048;

// Survives a rebuild: CSCL's physicalid (or an OSM way id) plus the sidewalk's N/E/S/W label.
export function durableKey(
  sourceId: number,
  side: number,
  ordinal: number,
): number {
  return (
    sourceId * DURABLE_SOURCE_STRIDE + side * DURABLE_SIDE_STRIDE + ordinal
  );
}

// -1 when the edge has no durable identity.
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

// Joints inside one divided-street crossing, so a wide avenue isn't billed a wait per carriageway.
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

// A corner door is on the street its own curb belongs to, not the one a route arrives along.
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

// Both FNV-1a 64 in hex.
export interface GraphIdentity {
  // Changes on any rebuild at all, so nothing an artifact is gated on rides on it.
  hash: string;
  // Hash of the ascending durable key space; `sheds.ts` gates on this one.
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
  adjacency: Uint32Array; // 2 * edgeCount edge ids; the neighbor is the edge's other endpoint
  edgeNodeA: Uint32Array;
  edgeNodeB: Uint32Array;
  edgeLength: Float32Array; // geodesic meters
  edgeGeomOffset: Uint32Array; // byte offset into the geometry blob; NO_GEOMETRY = straight a -> b
  edgeGeomCount: Uint16Array; // geometry vertices, 0 when no geometry
  edgeCover: Uint8Array; // 0..254, this edge's own single value; 0 for a ferry
  edgeNameId: Uint16Array; // index into names, or NAME_NONE
  edgeKindSide: Uint8Array; // bits 0-2 kind, bits 3-5 side
  edgeSourceId: Uint32Array; // the CSCL physicalid or OSM way id; NO_SOURCE_ID for a crossing, link or ferry
  edgeOrdinal: Uint8Array; // which edge of the several one source segment becomes; both feed `edgeDurableKey`
  nodeMidRoadway: Uint8Array;
  maxCover: number; // the greatest per-edge cover in the graph, 0..1; sets the cost clip floor

  edgeLandmark: Uint8Array;
  edgeArt: Uint8Array; // 0..254, this edge's public-art discount attribute; 0 for a ferry
  edgeHighway: Uint8Array; // 0..254, this edge's road/rail nuisance penalty, graded by traffic; 0 for a ferry
  edgeCommercial: Uint8Array; // 0..254, this edge's nice-commercial-frontage discount attribute; 0 for a ferry
  edgeIndustrial: Uint8Array; // 0..254, this edge's industrial-frontage penalty attribute; 0 for a ferry
  // A discount attribute, so its max is an A* lower-bound term and not only a slider gate.
  edgeHistoric: Uint8Array;
  // A tunnel and a viaduct over a rail yard read 0.
  edgeBridge: Uint8Array;
  maxLandmark: number; // the greatest per-edge landmark amenity, 0..1; sets that discount's clip floor
  maxArt: number; // the greatest per-edge art amenity, 0..1; sets that discount's clip floor
  maxCommercial: number; // the greatest per-edge commercial amenity, 0..1; sets that discount's clip floor
  maxIndustrial: number; // the greatest per-edge industrial frontage, 0..1; gates the slider, never the heuristic
  maxHistoric: number; // the greatest per-edge historic share, 0..1; sets that discount's clip floor
  maxBridge: number; // the greatest per-edge over-water share, 0..1; sets that discount's clip floor

  // Unblurred, unlike edgeCover, which is smoothed for the overlay.
  edgeDirectCanopy: Uint8Array; // 0..254; 0 for a ferry
  // 0..254 as a fraction of 35%; reversing the edge swaps them. 0 for a ferry or a city with no DEM.
  edgeAscent: Uint8Array;
  edgeDescent: Uint8Array;
  // Null on the page and in hand-built fixtures, which compute per edge instead.
  walkSeconds: WalkSeconds | null;
  // Up to 2 since the bytes clamp separately; 0 means the city has no elevation source.
  maxRelief: number;
  maxDirectCanopy: number; // the greatest per-edge direct canopy, 0..1; that factor's clip-floor input

  // Null when no artifact is loaded or the sun is down for the whole walk.
  shade: ShadeField | null;

  // From src/cities.ts, not baked, so tuning one doesn't mean rebuilding a 40 MB graph.
  maxFerryWaitSeconds?: number;
  maxTransitWaitSeconds?: number;

  // Null until the SHED artifact resolves, and the cost model reads no scaffolding while it is.
  sheds: ShedField | null;

  // Null until FSCH resolves or on a day no record covers; ferries then cost `edgeDurationSeconds`.
  ferries: FerryTimetable | null;

  // A ferry's crossing-plus-average-wait, or a transit edge's seconds; 0 for walking kinds.
  edgeDurationSeconds: Uint16Array;
  ferryEdges: Uint32Array; // ids of the ferry edges, for the A* ferry-credit heuristic
  transitEdges: Uint32Array;
  boardEdges: Uint32Array;
  // In side-table order, which `routeOf` indexes.
  transitRoutes: TransitRoute[];
  minFerrySecPerMeter: number; // min over ferry edges of duration/length, Infinity when there are none
  // Infinity when the city has no rail.
  minRideSecPerMeter: number;
  minAccessSecPerMeter: number;
  // bit0 structure, bit1 steps, bit2 geometry-right (sidewalks), bit3 OSM-sourced, bit4 tunnel
  edgeFlags: Uint8Array;
  // Lets `maxShelter` meet a tunnel's shelter without loosening the heuristic where there are none.
  hasTunnels: boolean;
  names: string[];
  geometry: Uint8Array;
  // Aligned to edgeNodeA/edgeNodeB; the route name is the edge's own name.
  ferryEndpointNames: Map<number, { a: string; b: string }>;
  transitLaneOf: Map<number, number>;
  transitStopOf: Map<number, number>;
  transitRouteOf: Map<number, number>;
  transitDoorStreet: Map<number, DoorStreet>;
  // Tells an alight edge from a station's way out (both access edges); derived, not stored.
  nodePlatform: Uint8Array;

  // Null until TSCH resolves or on a day no record covers, and every board edge then costs Infinity.
  transit: TransitTimetable | null;
}

// The feed id matches the display artifact's, so the two join on it.
export interface TransitRoute {
  shortName: string;
  longName: string;
  id: string;
  color: string;
  textColor: string;
}

const MAGIC = "GRPH";
// Exported so a fixture writing its own header can't drift from it.
export const FORMAT_VERSION = 12;
// 64 fixed bytes then a 48-entry (offset, byteLength, tag) directory, of which v12 fills 35.
const HEADER_BYTES = 640;
const DIRECTORY_AT = 64;
const DIRECTORY_ENTRY_BYTES = 12;

// Sections are found by position, so the tag turns two swapped same-size columns into a throw.
function columnTag(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
const HAS_TUNNELS_FLAG = 0x1; // header byte 58

interface ColumnKind<Column> {
  new (length: number): Column;
  new (buffer: ArrayBuffer, byteOffset: number, length: number): Column;
  readonly BYTES_PER_ELEMENT: number;
}

// Relative, to pick up the deploy basePath; named per city since one directory holds every city's.
const versionUrl = (cityId: string): string => `routing/${cityId}.version.json`;
// Must hold one long route's edges, since the search and the stitching both read its geometry.
const PATH_CACHE_LIMIT = 4096;

// A file can't hold its own FNV, so the caller supplies both hashes.
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

  // One cursor in directory order; each entry's tag catches a writer that ordered them differently.
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
  // A section the file doesn't carry reads as zeros, which is how the older graph behaved.
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

  // Baked, since reading them off the columns would be a pass over every edge on both threads.
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

  // Derived, since a baked figure would go stale the moment a duration moved.
  let minFerrySecPerMeter = Number.POSITIVE_INFINITY;
  for (const edge of ferryEdges) {
    const length = edgeLength[edge];
    if (length > 0) {
      minFerrySecPerMeter = Math.min(
        minFerrySecPerMeter,
        edgeDurationSeconds[edge] / length,
      );
    }
  }
  let minRideSecPerMeter = Number.POSITIVE_INFINITY;
  let minAccessSecPerMeter = Number.POSITIVE_INFINITY;
  for (const edge of transitEdges) {
    const length = edgeLength[edge];
    const kind = edgeKindSide[edge] & KIND_MASK;
    if (length <= 0) {
      continue;
    }
    if (kind === KIND_RIDE) {
      minRideSecPerMeter = Math.min(
        minRideSecPerMeter,
        edgeDurationSeconds[edge] / length,
      );
    } else if (kind === KIND_ACCESS) {
      minAccessSecPerMeter = Math.min(
        minAccessSecPerMeter,
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
    minFerrySecPerMeter,
    minRideSecPerMeter,
    minAccessSecPerMeter,
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

// A u32 count, (count + 1) u32 offsets into the trailing UTF-8 blob, then the blob.
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

// At the byte-60 offset: a u32 count, then (u32 edge id, u16 a-stop name id, u16 b-stop name id).
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

// Route, board, ride and door records; older graphs lack doors, so stop at the table's own length.
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

// Hashed by the ingest so a graph and a timetable written days apart still agree; -1 off a board edge.
export function laneOf(graph: RoutingGraph, edge: number): number {
  return graph.transitLaneOf.get(edge) ?? -1;
}

// Counted as the feed lists them, so a stop the snap dropped leaves no hole; -1 off a board edge.
export function stopIndexOf(graph: RoutingGraph, edge: number): number {
  return graph.transitStopOf.get(edge) ?? -1;
}

// Null for an access edge, since the walk into a station belongs to no one line.
export function routeOf(
  graph: RoutingGraph,
  edge: number,
): TransitRoute | null {
  const index = graph.transitRouteOf.get(edge);
  return index === undefined ? null : (graph.transitRoutes[index] ?? null);
}

export function isTransitEdge(graph: RoutingGraph, edge: number): boolean {
  return TRANSIT_KINDS.has(edgeKind(graph, edge));
}

// Edges are stored undirected; refusing reverses stops backwards rides and boarding via an alight.
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

// Read off the named access edge, since alights are unnamed and boards are named for their line.
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

// Mirrors crates/tiler/src/graph.rs; the only trace of the feed's surface flag left in the graph.
const SURFACE_ACCESS_SECONDS = 30;
const UNDERGROUND_ACCESS_SECONDS = 90;

// Baked seconds less the walk leave the tiler's base figure; the midpoint test survives rounding.
export function isSurfaceStop(graph: RoutingGraph, edge: number): boolean {
  const stair =
    graph.edgeDurationSeconds[edge] -
    graph.edgeLength[edge] / WALK_METERS_PER_SECOND;
  return stair < (SURFACE_ACCESS_SECONDS + UNDERGROUND_ACCESS_SECONDS) / 2;
}

// Internal to one boarding: costs nothing, covers no ground, and is no stop of the ride.
export function isStayAboard(graph: RoutingGraph, edge: number): boolean {
  return (
    edgeKind(graph, edge) === "ride" &&
    (graph.edgeFlags[edge] & STAY_ABOARD_FLAG) !== 0
  );
}

// The alight hangs off the arrival node, never off the node a board lands on.
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

// The graph never stores a train's destination; it's where the ride chain runs out.
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

export function edgeGeometryRight(graph: RoutingGraph, edge: number): boolean {
  return (graph.edgeFlags[edge] & GEOMETRY_RIGHT_FLAG) !== 0;
}

export function isTunnel(graph: RoutingGraph, edge: number): boolean {
  return (graph.edgeFlags[edge] & TUNNEL_FLAG) !== 0;
}

// Only meaningful on an access edge; a walking edge uses these bits for other things.
export function isExitOnlyDoor(graph: RoutingGraph, edge: number): boolean {
  return (
    edgeKind(graph, edge) === "access" &&
    (graph.edgeFlags[edge] & EXIT_ONLY_FLAG) !== 0
  );
}

export function isEntryOnlyDoor(graph: RoutingGraph, edge: number): boolean {
  return (
    edgeKind(graph, edge) === "access" &&
    (graph.edgeFlags[edge] & ENTRY_ONLY_FLAG) !== 0
  );
}

export function isElevatorDoor(graph: RoutingGraph, edge: number): boolean {
  return (
    edgeKind(graph, edge) === "access" &&
    (graph.edgeFlags[edge] & ELEVATOR_FLAG) !== 0
  );
}

// Naming a door by the arriving step would call a corner door by the cross street.
export function doorStreet(
  graph: RoutingGraph,
  edge: number,
): DoorStreet | null {
  return graph.transitDoorStreet.get(edge) ?? null;
}

// Coming back to a city must not refetch its graph.
const graphPromises = new Map<string, Promise<RoutingGraph>>();
// Kept so the routing worker can be handed a copy without a second download.
const graphBuffers = new Map<string, ArrayBuffer>();

export function graphBuffer(cityId: string): ArrayBuffer | undefined {
  return graphBuffers.get(cityId);
}

// Read, not recomputed: hashing 30 MB blocks the main thread; a missing file matches no artifact.
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

// Both decoders go through here so neither forgets the city's pier and platform waits.
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

// Per graph, since edge ids repeat between cities; search and stitching both read an edge's geometry.
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
    // The first pair is absolute (from the graph origin); the rest are previous-vertex deltas.
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

// Along-distance uses Snap.metersFromA's scaled metric, so a length fraction is a polyline fraction.
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

// GRPH v12 bytes built the way the tiler builds them, so tests exercise the Rust writer's layout.

import {
  FORMAT_VERSION,
  markMidRoadwayNodes,
  NO_GEOMETRY,
  NO_SOURCE_ID,
} from "./graph";

// Its own copy of the figures, bound to the reader's by the check on header byte 6.
const HEADER_BYTES = 640;
const DIRECTORY_AT = 64;
const DIRECTORY_ENTRY_BYTES = 12;
const SECTION_ALIGN = 8;
export const NAME_NONE = 0xffff;

const KIND_MASK = 0x7;
const SIDE_SHIFT = 3;
const KIND_FERRY = 4;
const KIND_ACCESS = 5;
const KIND_BOARD = 6;
const KIND_RIDE = 7;
const TUNNEL_FLAG = 0x10;

const SECTIONS = [
  "nodeQx",
  "nodeQy",
  "nodeComponent",
  "nodeMidRoadway",
  "csr",
  "adjacency",
  "edgeNodeA",
  "edgeNodeB",
  "edgeLength",
  "edgeGeomOffset",
  "edgeGeomCount",
  "edgeNameId",
  "edgeDurationSeconds",
  "edgeKindSide",
  "edgeFlags",
  "edgeCover",
  "edgeLandmark",
  "edgeArt",
  "edgeHighway",
  "edgeCommercial",
  "edgeDirectCanopy",
  "edgeIndustrial",
  "edgeHistoric",
  "edgeBridge",
  "edgeAscent",
  "edgeDescent",
  "edgeSourceId",
  "edgeOrdinal",
  "ferryEdges",
  "transitEdges",
  "boardEdges",
  "names",
  "geometry",
  "ferryEndpoints",
  "transitTables",
] as const;

export type GraphSection = (typeof SECTIONS)[number];

export interface NodeSpec {
  qx: number;
  qy: number;
  component?: number;
}

export interface EdgeSpec {
  a: number;
  b: number;
  kind: number;
  side?: number;
  length: number;
  // Quantized, in a node's units; absent means the straight line between the endpoints.
  geometry?: readonly (readonly [number, number])[];
  nameId?: number;
  durationSeconds?: number; // a ferry's or a transit edge's; a walking kind carries 0
  cover?: number; // 0..254
  flags?: number;
  landmark?: number;
  art?: number;
  highway?: number;
  commercial?: number;
  directCanopy?: number;
  industrial?: number;
  historic?: number;
  bridge?: number;
  ascent?: number;
  descent?: number;
  sourceId?: number;
  ordinal?: number;
}

export interface RouteSpec {
  color: readonly [number, number, number];
  textColor: readonly [number, number, number];
  shortName: number; // name ids, as the tiler writes them
  longName: number;
  id: number;
}

export interface GraphSpec {
  originLng: number;
  originLat: number;
  scale: number;
  componentCount?: number;
  nodes: readonly NodeSpec[];
  edges: readonly EdgeSpec[];
  names?: readonly string[];
  ferryEndpoints?: readonly { edge: number; a: number; b: number }[];
  transitRoutes?: readonly RouteSpec[];
  board?: readonly {
    edge: number;
    lane: number;
    route: number;
    stop: number;
  }[];
  ride?: readonly { edge: number; route: number }[];
  doors?: readonly { edge: number; street: number; side: number }[];
  // Stands in for a graph written before that column; its directory entry stays, zeroed.
  omit?: readonly GraphSection[];
  // Stands in for a writer that appended them in the other order.
  swap?: readonly [GraphSection, GraphSection];
}

// Mirrors ./graph and crates/tiler/src/graph.rs.
function columnTag(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function u8Column(
  edges: readonly EdgeSpec[],
  read: (edge: EdgeSpec) => number | undefined,
): Uint8Array {
  return Uint8Array.from(edges, (edge) => read(edge) ?? 0);
}

function writeVarint(out: number[], value: number): void {
  let rest = (value << 1) ^ (value >> 31);
  do {
    const byte = rest & 0x7f;
    rest >>>= 7;
    out.push(rest === 0 ? byte : byte | 0x80);
  } while (rest !== 0);
}

function encodeGeometry(edges: readonly EdgeSpec[]): {
  blob: Uint8Array;
  offsets: Uint32Array;
  counts: Uint16Array;
} {
  const blob: number[] = [];
  const offsets = new Uint32Array(edges.length);
  const counts = new Uint16Array(edges.length);
  for (const [edge, spec] of edges.entries()) {
    if (spec.geometry === undefined) {
      offsets[edge] = NO_GEOMETRY;
      continue;
    }
    offsets[edge] = blob.length;
    counts[edge] = spec.geometry.length;
    let previousX = 0;
    let previousY = 0;
    for (const [vertexX, vertexY] of spec.geometry) {
      writeVarint(blob, vertexX - previousX);
      writeVarint(blob, vertexY - previousY);
      previousX = vertexX;
      previousY = vertexY;
    }
  }
  return { blob: Uint8Array.from(blob), offsets, counts };
}

function encodeNames(names: readonly string[]): Uint8Array {
  const blob = new TextEncoder().encode(names.join(""));
  const table = new Uint8Array(4 + 4 * (names.length + 1) + blob.length);
  const view = new DataView(table.buffer);
  view.setUint32(0, names.length, true);
  let cursor = 0;
  for (const [index, name] of names.entries()) {
    view.setUint32(4 + 4 * index, cursor, true);
    cursor += new TextEncoder().encode(name).length;
  }
  view.setUint32(4 + 4 * names.length, cursor, true);
  table.set(blob, 4 + 4 * (names.length + 1));
  return table;
}

function encodeFerryEndpoints(
  endpoints: readonly { edge: number; a: number; b: number }[],
): Uint8Array {
  const table = new Uint8Array(4 + 8 * endpoints.length);
  const view = new DataView(table.buffer);
  view.setUint32(0, endpoints.length, true);
  for (const [index, endpoint] of endpoints.entries()) {
    const at = 4 + 8 * index;
    view.setUint32(at, endpoint.edge, true);
    view.setUint16(at + 4, endpoint.a, true);
    view.setUint16(at + 6, endpoint.b, true);
  }
  return table;
}

function encodeTransitTables(spec: GraphSpec): Uint8Array {
  const routes = spec.transitRoutes ?? [];
  const board = spec.board ?? [];
  const ride = spec.ride ?? [];
  const doors = spec.doors ?? [];
  const table = new Uint8Array(
    4 +
      12 * routes.length +
      4 +
      12 * board.length +
      4 +
      8 * ride.length +
      4 +
      8 * doors.length,
  );
  const view = new DataView(table.buffer);
  view.setUint32(0, routes.length, true);
  let at = 4;
  for (const route of routes) {
    table.set(route.color, at);
    table.set(route.textColor, at + 3);
    view.setUint16(at + 6, route.shortName, true);
    view.setUint16(at + 8, route.longName, true);
    view.setUint16(at + 10, route.id, true);
    at += 12;
  }
  view.setUint32(at, board.length, true);
  at += 4;
  for (const stop of board) {
    view.setUint32(at, stop.edge, true);
    view.setUint32(at + 4, stop.lane, true);
    view.setUint16(at + 8, stop.route, true);
    view.setUint16(at + 10, stop.stop, true);
    at += 12;
  }
  view.setUint32(at, ride.length, true);
  at += 4;
  for (const leg of ride) {
    view.setUint32(at, leg.edge, true);
    view.setUint16(at + 4, leg.route, true);
    at += 8;
  }
  view.setUint32(at, doors.length, true);
  at += 4;
  for (const door of doors) {
    view.setUint32(at, door.edge, true);
    view.setUint16(at + 4, door.street, true);
    table[at + 6] = door.side;
    at += 8;
  }
  return table;
}

function buildAdjacency(spec: GraphSpec): {
  csr: Uint32Array;
  adjacency: Uint32Array;
} {
  const incident: number[][] = spec.nodes.map(() => []);
  for (const [edge, edgeSpec] of spec.edges.entries()) {
    incident[edgeSpec.a].push(edge);
    incident[edgeSpec.b].push(edge);
  }
  const csr = new Uint32Array(spec.nodes.length + 1);
  const adjacency = new Uint32Array(2 * spec.edges.length);
  let cursor = 0;
  for (const [node, edges] of incident.entries()) {
    csr[node] = cursor;
    for (const edge of edges) {
      adjacency[cursor] = edge;
      cursor += 1;
    }
  }
  csr[spec.nodes.length] = cursor;
  return { csr, adjacency };
}

export function encodeGraph(spec: GraphSpec): ArrayBuffer {
  const { nodes, edges } = spec;
  const omitted = new Set<GraphSection>(spec.omit ?? []);
  const { csr, adjacency } = buildAdjacency(spec);
  const geometry = encodeGeometry(edges);
  const edgeKindSide = Uint8Array.from(
    edges,
    (edge) => (edge.kind & KIND_MASK) | ((edge.side ?? 0) << SIDE_SHIFT),
  );
  const edgeFlags = u8Column(edges, (edge) => edge.flags);
  const edgeAscent = u8Column(edges, (edge) => edge.ascent);
  const edgeDescent = u8Column(edges, (edge) => edge.descent);

  const ferryEdges: number[] = [];
  const transitEdges: number[] = [];
  const boardEdges: number[] = [];
  for (const [edge, edgeSpec] of edges.entries()) {
    const kind = edgeSpec.kind & KIND_MASK;
    if (kind === KIND_FERRY) {
      ferryEdges.push(edge);
    } else if (kind === KIND_ACCESS || kind === KIND_RIDE) {
      transitEdges.push(edge);
    } else if (kind === KIND_BOARD) {
      transitEdges.push(edge);
      boardEdges.push(edge);
    }
  }

  const payloads = new Map<GraphSection, Uint8Array>([
    [
      "nodeQx",
      new Uint8Array(Int32Array.from(nodes, (node) => node.qx).buffer),
    ],
    [
      "nodeQy",
      new Uint8Array(Int32Array.from(nodes, (node) => node.qy).buffer),
    ],
    [
      "nodeComponent",
      new Uint8Array(
        Uint16Array.from(nodes, (node) => node.component ?? 0).buffer,
      ),
    ],
    [
      "nodeMidRoadway",
      markMidRoadwayNodes(nodes.length, csr, adjacency, edgeKindSide),
    ],
    ["csr", new Uint8Array(csr.buffer)],
    ["adjacency", new Uint8Array(adjacency.buffer)],
    [
      "edgeNodeA",
      new Uint8Array(Uint32Array.from(edges, (edge) => edge.a).buffer),
    ],
    [
      "edgeNodeB",
      new Uint8Array(Uint32Array.from(edges, (edge) => edge.b).buffer),
    ],
    [
      "edgeLength",
      new Uint8Array(Float32Array.from(edges, (edge) => edge.length).buffer),
    ],
    ["edgeGeomOffset", new Uint8Array(geometry.offsets.buffer)],
    ["edgeGeomCount", new Uint8Array(geometry.counts.buffer)],
    [
      "edgeNameId",
      new Uint8Array(
        Uint16Array.from(edges, (edge) => edge.nameId ?? NAME_NONE).buffer,
      ),
    ],
    [
      "edgeDurationSeconds",
      new Uint8Array(
        Uint16Array.from(edges, (edge) => edge.durationSeconds ?? 0).buffer,
      ),
    ],
    ["edgeKindSide", edgeKindSide],
    ["edgeFlags", edgeFlags],
    ["edgeCover", u8Column(edges, (edge) => edge.cover)],
    ["edgeLandmark", u8Column(edges, (edge) => edge.landmark)],
    ["edgeArt", u8Column(edges, (edge) => edge.art)],
    ["edgeHighway", u8Column(edges, (edge) => edge.highway)],
    ["edgeCommercial", u8Column(edges, (edge) => edge.commercial)],
    ["edgeDirectCanopy", u8Column(edges, (edge) => edge.directCanopy)],
    ["edgeIndustrial", u8Column(edges, (edge) => edge.industrial)],
    ["edgeHistoric", u8Column(edges, (edge) => edge.historic)],
    ["edgeBridge", u8Column(edges, (edge) => edge.bridge)],
    ["edgeAscent", edgeAscent],
    ["edgeDescent", edgeDescent],
    [
      "edgeSourceId",
      new Uint8Array(
        Uint32Array.from(edges, (edge) => edge.sourceId ?? NO_SOURCE_ID).buffer,
      ),
    ],
    ["edgeOrdinal", u8Column(edges, (edge) => edge.ordinal)],
    ["ferryEdges", new Uint8Array(Uint32Array.from(ferryEdges).buffer)],
    ["transitEdges", new Uint8Array(Uint32Array.from(transitEdges).buffer)],
    ["boardEdges", new Uint8Array(Uint32Array.from(boardEdges).buffer)],
    ["names", encodeNames(spec.names ?? [])],
    ["geometry", geometry.blob],
    ["ferryEndpoints", encodeFerryEndpoints(spec.ferryEndpoints ?? [])],
    ["transitTables", encodeTransitTables(spec)],
  ]);

  const body: number[] = [];
  const directory: [number, number, number][] = [];
  for (const section of SECTIONS) {
    const payload = payloads.get(section) as Uint8Array;
    if (omitted.has(section)) {
      directory.push([0, 0, 0]);
      continue;
    }
    while ((HEADER_BYTES + body.length) % SECTION_ALIGN !== 0) {
      body.push(0);
    }
    directory.push([
      HEADER_BYTES + body.length,
      payload.length,
      columnTag(section),
    ]);
    for (const byte of payload) {
      body.push(byte);
    }
  }
  if (spec.swap) {
    const [left, right] = spec.swap.map((section) => SECTIONS.indexOf(section));
    [directory[left], directory[right]] = [directory[right], directory[left]];
  }

  const buffer = new ArrayBuffer(HEADER_BYTES + body.length);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(new TextEncoder().encode("GRPH"));
  view.setUint16(4, FORMAT_VERSION, true);
  view.setUint16(6, HEADER_BYTES, true);
  view.setUint32(8, nodes.length, true);
  view.setUint32(12, edges.length, true);
  view.setFloat64(16, spec.originLng, true);
  view.setFloat64(24, spec.originLat, true);
  view.setFloat64(32, spec.scale, true);
  view.setUint32(40, spec.componentCount ?? 1, true);
  view.setUint32(44, directory.length, true);

  // A missing column has no maximum, so it reads as pre-bake rather than as a slider that's off.
  const greatest = (section: GraphSection): number =>
    omitted.has(section)
      ? 0
      : (payloads.get(section) as Uint8Array).reduce(
          (best, value) => Math.max(best, value),
          0,
        );
  for (const [index, section] of (
    [
      "edgeCover",
      "edgeLandmark",
      "edgeArt",
      "edgeCommercial",
      "edgeDirectCanopy",
      "edgeIndustrial",
      "edgeHistoric",
      "edgeBridge",
    ] as const
  ).entries()) {
    bytes[48 + index] = greatest(section);
  }
  const relief = omitted.has("edgeAscent")
    ? 0
    : edgeAscent.reduce(
        (best, climb, edge) => Math.max(best, climb + edgeDescent[edge]),
        0,
      );
  view.setUint16(56, relief, true);
  const tunnels =
    !omitted.has("edgeFlags") &&
    edgeFlags.some((flags) => (flags & TUNNEL_FLAG) !== 0);
  bytes[58] = tunnels ? 1 : 0;

  for (const [index, [offset, byteLength, tag]] of directory.entries()) {
    const at = DIRECTORY_AT + DIRECTORY_ENTRY_BYTES * index;
    view.setUint32(at, offset, true);
    view.setUint32(at + 4, byteLength, true);
    view.setUint32(at + 8, tag, true);
  }
  bytes.set(Uint8Array.from(body), HEADER_BYTES);
  return buffer;
}

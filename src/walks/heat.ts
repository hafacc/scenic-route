// The walks layer further out: a heat raster built from points along your streets, on this device only.

import type { FamiliarField } from "../routing/familiar";
import { edgePath, type RoutingGraph } from "../routing/graph";
import { projectX, projectY } from "../tiles/mercator";

// Cut here, where the graph is; ./heat-raster.ts draws them in the service worker.

// Under a pixel apart at z13, so a line reads as a line rather than a row of dots.
const SAMPLE_WORLD_PX = 1 / 2 ** 13;

// [x, y, weight] triples in zoom-0 world pixels; the weight is familiarity times the sample's length.
export function heatPoints(
  graph: RoutingGraph,
  field: FamiliarField,
): Float64Array {
  const points: number[] = [];
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    const byte = field.edges[edge];
    if (byte === 0) {
      continue;
    }
    const familiarity = byte / 255;
    const { lngs, lats } = edgePath(graph, edge);
    for (let vertex = 0; vertex + 1 < lngs.length; vertex++) {
      const x0 = projectX(lngs[vertex], 0);
      const y0 = projectY(lats[vertex], 0);
      const x1 = projectX(lngs[vertex + 1], 0);
      const y1 = projectY(lats[vertex + 1], 0);
      const length = Math.hypot(x1 - x0, y1 - y0);
      const count = Math.max(1, Math.ceil(length / SAMPLE_WORLD_PX));
      for (let sample = 0; sample < count; sample++) {
        const share = (sample + 0.5) / count;
        points.push(
          x0 + share * (x1 - x0),
          y0 + share * (y1 - y0),
          (familiarity * length) / count,
        );
      }
    }
  }
  return Float64Array.from(points);
}

// FNV-1a over the points, so an unchanged history keeps the tiles already cached for it.
export function heatVersion(points: Float64Array): string {
  const bytes = new Uint8Array(
    points.buffer,
    points.byteOffset,
    points.byteLength,
  );
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

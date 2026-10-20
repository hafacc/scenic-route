// Your walks along their streets, cut once per band of familiarity for one StrokeGrid each.

import type { FamiliarField } from "../routing/familiar";
import { edgePath, type RoutingGraph } from "../routing/graph";
import { type Chain, chainPaths } from "../tiles/chain";
import { projectX, projectY } from "../tiles/mercator";
import {
  type PathStrokes,
  type Piece,
  packStrokes,
} from "../tiles/path-strokes";

// Upper familiarity of each band: about one walk, two, and three or more (see `familiarity`).
export const WALK_BANDS = [0.5, 0.7, 1] as const;
// Each band's layer opacity, so strength reads as the one indigo getting stronger, as the heat does.
export const WALK_BAND_OPACITY = [0.4, 0.7, 1] as const;

export function walkBand(familiarity: number): number {
  return WALK_BANDS.findIndex((top) => familiarity <= top);
}

// A whole edge per piece, joined through its nodes so a walked block runs on as one line.
export function walkStrokes(
  graph: RoutingGraph,
  field: FamiliarField,
): PathStrokes[] {
  const pieces: Piece[][] = WALK_BANDS.map(() => []);
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    const byte = field.edges[edge];
    if (byte > 0) {
      const { lngs, lats } = edgePath(graph, edge);
      pieces[walkBand(byte / 255)].push({
        xs: Array.from(lngs, (lng) => projectX(lng, 0)),
        ys: Array.from(lats, (lat) => projectY(lat, 0)),
        head: graph.edgeNodeA[edge],
        tail: graph.edgeNodeB[edge],
        headOnNode: true,
        tailOnNode: true,
      });
    }
  }
  return pieces.map((band) => {
    const chains: Chain[] = chainPaths(band);
    return packStrokes(band, chains);
  });
}

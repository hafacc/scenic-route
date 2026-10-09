import { replayStrokes } from "./path-strokes";
import type { StrokesParams } from "./protocol";
import type { TileRenderer } from "./renderer";
import { themeName } from "./theme";

// Strokes a tile's lines here so their raster never costs the main thread a frame; nothing to load.
export const strokesRenderer: TileRenderer<StrokesParams, StrokesParams> = {
  load: (params) => Promise.resolve(params),
  // Opaque, with the fade left to the layer: lines of one kind that overlap must not add up.
  draw(context, strokes) {
    const lines = new Path2D();
    const ends = new Path2D();
    replayStrokes(strokes, lines, ends, strokes.width);
    context.lineCap = "butt";
    context.lineJoin = "round";
    context.lineWidth = strokes.width;
    const color = strokes.color[themeName()];
    context.strokeStyle = color;
    context.stroke(lines);
    context.fillStyle = color;
    context.fill(ends);
  },
};

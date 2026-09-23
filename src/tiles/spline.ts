// Centripetal Catmull-Rom (Yuksel et al. 2011), which unlike uniform can't loop on uneven spacing.

const ALPHA = 0.5;
// Keeps a repeated vertex from dividing by zero.
const MIN_KNOT = 1e-6;
// GTFS repeats a terminal as stop and first shape point; such a pair only swings the tangent.
const MIN_GAP_PX = 0.25;
// Sharper turns are corners: shapes follow boats backing out of slips, which would fit as loops.
const MIN_SMOOTH_COSINE = Math.cos((90 * Math.PI) / 180);

export interface PathSink {
  moveTo(x: number, y: number): void;
  bezierCurveTo(
    controlX1: number,
    controlY1: number,
    controlX2: number,
    controlY2: number,
    x: number,
    y: number,
  ): void;
}

function knot(fromX: number, fromY: number, toX: number, toY: number): number {
  return Math.max(Math.hypot(toX - fromX, toY - fromY) ** ALPHA, MIN_KNOT);
}

// Fritsch–Carlson (1980): monotone per axis keeps each span inside its endpoints' box, off the shore.
function monotone(
  secant: number,
  startTangent: number,
  endTangent: number,
): [number, number] {
  if (secant === 0) {
    return [0, 0];
  } else {
    const start = Math.max(startTangent / secant, 0);
    const end = Math.max(endTangent / secant, 0);
    const reach = Math.hypot(start, end);
    const shrink = reach > 3 ? 3 / reach : 1;
    return [start * shrink * secant, end * shrink * secant];
  }
}

// Ends are reflected through, so a corner between two runs stays a corner.
function runPath(
  sink: PathSink,
  xs: readonly number[],
  ys: readonly number[],
  from: number,
  to: number,
): void {
  for (let span = from; span < to; span++) {
    const beforeX = span > from ? xs[span - 1] : 2 * xs[from] - xs[from + 1];
    const beforeY = span > from ? ys[span - 1] : 2 * ys[from] - ys[from + 1];
    const startX = xs[span];
    const startY = ys[span];
    const endX = xs[span + 1];
    const endY = ys[span + 1];
    const afterX = span + 2 <= to ? xs[span + 2] : 2 * endX - startX;
    const afterY = span + 2 <= to ? ys[span + 2] : 2 * endY - startY;

    const beforeKnot = knot(beforeX, beforeY, startX, startY);
    const spanKnot = knot(startX, startY, endX, endY);
    const afterKnot = knot(endX, endY, afterX, afterY);

    // Barry-Goldman tangents, scaled to the span and thirded into Bezier control points.
    const startTangentX =
      ((startX - beforeX) / beforeKnot -
        (endX - beforeX) / (beforeKnot + spanKnot) +
        (endX - startX) / spanKnot) *
      spanKnot;
    const startTangentY =
      ((startY - beforeY) / beforeKnot -
        (endY - beforeY) / (beforeKnot + spanKnot) +
        (endY - startY) / spanKnot) *
      spanKnot;
    const endTangentX =
      ((endX - startX) / spanKnot -
        (afterX - startX) / (spanKnot + afterKnot) +
        (afterX - endX) / afterKnot) *
      spanKnot;
    const endTangentY =
      ((endY - startY) / spanKnot -
        (afterY - startY) / (spanKnot + afterKnot) +
        (afterY - endY) / afterKnot) *
      spanKnot;

    const [limitedStartX, limitedEndX] = monotone(
      endX - startX,
      startTangentX,
      endTangentX,
    );
    const [limitedStartY, limitedEndY] = monotone(
      endY - startY,
      startTangentY,
      endTangentY,
    );
    sink.bezierCurveTo(
      startX + limitedStartX / 3,
      startY + limitedStartY / 3,
      endX - limitedEndX / 3,
      endY - limitedEndY / 3,
      endX,
      endY,
    );
  }
}

// Pass the whole polyline, not a tile's clipped piece, or the curve kinks at the seam.
export function splinePath(
  sink: PathSink,
  xs: readonly number[],
  ys: readonly number[],
): void {
  const count = Math.min(xs.length, ys.length);
  const keptX: number[] = [];
  const keptY: number[] = [];
  for (let vertex = 0; vertex < count; vertex++) {
    const last = keptX.length - 1;
    if (
      last < 0 ||
      Math.hypot(xs[vertex] - keptX[last], ys[vertex] - keptY[last]) >
        MIN_GAP_PX
    ) {
      keptX.push(xs[vertex]);
      keptY.push(ys[vertex]);
    }
  }
  if (keptX.length === 0) {
    return;
  } else {
    sink.moveTo(keptX[0], keptY[0]);
    let from = 0;
    for (let vertex = 1; vertex + 1 < keptX.length; vertex++) {
      const inX = keptX[vertex] - keptX[vertex - 1];
      const inY = keptY[vertex] - keptY[vertex - 1];
      const outX = keptX[vertex + 1] - keptX[vertex];
      const outY = keptY[vertex + 1] - keptY[vertex];
      const straightness =
        (inX * outX + inY * outY) /
        (Math.hypot(inX, inY) * Math.hypot(outX, outY));
      if (straightness < MIN_SMOOTH_COSINE) {
        runPath(sink, keptX, keptY, from, vertex);
        from = vertex;
      }
    }
    runPath(sink, keptX, keptY, from, keptX.length - 1);
  }
}

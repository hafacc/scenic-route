// Fillets, not ./spline: a curve through every vertex bows a ferry's out-and-back legs apart.
// The subway keeps the spline: its vertices are meters apart, too close for a fillet to round.

const RADIUS_PX = 14;
// A corner eats at most half of each segment, so two corners can never overlap and fold the line.
const MAX_SEGMENT_FRACTION = 0.5;
// GTFS repeats a terminal as both stop and first shape point, a direction made of rounding error.
const MIN_GAP_PX = 0.25;
// A fillet cutting less than this off its vertex is invisible, so the corner stays a plain lineTo.
const MIN_CUT_PX = 0.05;
// A quadratic's control point as a cubic's two; exact, not an approximation.
const QUADRATIC_AS_CUBIC = 2 / 3;

export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(
    controlX1: number,
    controlY1: number,
    controlX2: number,
    controlY2: number,
    x: number,
    y: number,
  ): void;
}

// Pass the whole polyline: clipping first would round seam vertices toward a direction it lacks.
export function roundedPath(
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
    for (let vertex = 1; vertex + 1 < keptX.length; vertex++) {
      const inX = keptX[vertex] - keptX[vertex - 1];
      const inY = keptY[vertex] - keptY[vertex - 1];
      const outX = keptX[vertex + 1] - keptX[vertex];
      const outY = keptY[vertex + 1] - keptY[vertex];
      const inLength = Math.hypot(inX, inY);
      const outLength = Math.hypot(outX, outY);
      const trim = Math.min(
        RADIUS_PX,
        inLength * MAX_SEGMENT_FRACTION,
        outLength * MAX_SEGMENT_FRACTION,
      );
      const enterX = keptX[vertex] - (inX / inLength) * trim;
      const enterY = keptY[vertex] - (inY / inLength) * trim;
      const leaveX = keptX[vertex] + (outX / outLength) * trim;
      const leaveY = keptY[vertex] + (outY / outLength) * trim;
      // Depth cut off the corner: 0 on a straight, trim/2 on a reversal, so hairpins need no case.
      const cut =
        Math.hypot(
          enterX + leaveX - 2 * keptX[vertex],
          enterY + leaveY - 2 * keptY[vertex],
        ) / 4;
      if (cut >= MIN_CUT_PX) {
        sink.lineTo(enterX, enterY);
        sink.bezierCurveTo(
          enterX + (keptX[vertex] - enterX) * QUADRATIC_AS_CUBIC,
          enterY + (keptY[vertex] - enterY) * QUADRATIC_AS_CUBIC,
          leaveX + (keptX[vertex] - leaveX) * QUADRATIC_AS_CUBIC,
          leaveY + (keptY[vertex] - leaveY) * QUADRATIC_AS_CUBIC,
          leaveX,
          leaveY,
        );
      }
    }
    sink.lineTo(keptX[keptX.length - 1], keptY[keptY.length - 1]);
  }
}

// Max px the path sits off the polyline: a fillet's trim·sin(turn)/4 peaks at 90°, plus the gap drop.
export const MAX_ROUNDING_PX = RADIUS_PX / 4 + MIN_GAP_PX;

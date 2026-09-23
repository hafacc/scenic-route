// A reclaimed canvas is never re-requested, and only a canceled contextlost is ever restored.
// The detach must run on tile unload: the listeners hold the canvas and its decoded data.
export function repaintOnRestore(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  paint: () => void,
): () => void {
  const onLost = (event: Event): void => {
    event.preventDefault();
  };
  canvas.addEventListener("contextlost", onLost);
  canvas.addEventListener("contextrestored", paint);
  return () => {
    canvas.removeEventListener("contextlost", onLost);
    canvas.removeEventListener("contextrestored", paint);
  };
}

// Resets first: a repaint starts from the last draw's state, so the scale would compound.
export function repeatable<
  Context extends CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
>(
  context: Context,
  ratio: number,
  draw: (context: Context) => void,
): () => void {
  return () => {
    context.reset();
    context.scale(ratio, ratio);
    draw(context);
  };
}

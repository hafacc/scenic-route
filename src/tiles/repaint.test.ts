import { expect, test } from "bun:test";
import { repaintOnRestore, repeatable } from "./repaint";

// bun has neither HTMLCanvasElement nor OffscreenCanvas, and the contract is only the event pair.
class FakeCanvas extends EventTarget {}

function lose(canvas: FakeCanvas): Event {
  const event = new Event("contextlost", { cancelable: true });
  canvas.dispatchEvent(event);
  return event;
}

function restore(canvas: FakeCanvas): void {
  canvas.dispatchEvent(new Event("contextrestored"));
}

test("a restored context paints the tile again", () => {
  const canvas = new FakeCanvas();
  let paints = 0;
  repaintOnRestore(canvas as never, () => {
    paints += 1;
  });

  expect(paints).toBe(0);
  restore(canvas);
  expect(paints).toBe(1);
  restore(canvas);
  expect(paints).toBe(2);
});

// An uncanceled loss is permanent: the restore never comes.
test("the loss is canceled, so the pixels can come back", () => {
  const canvas = new FakeCanvas();
  repaintOnRestore(canvas as never, () => undefined);

  expect(lose(canvas).defaultPrevented).toBe(true);
});

// The listener holds the canvas and decoded data, so a watcher outliving its tile leaks every pan.
test("detaching stops the watch", () => {
  const canvas = new FakeCanvas();
  let paints = 0;
  const detach = repaintOnRestore(canvas as never, () => {
    paints += 1;
  });

  restore(canvas);
  detach();
  restore(canvas);

  expect(paints).toBe(1);
  expect(lose(canvas).defaultPrevented).toBe(false);
});

// A repaint starts from the previous draw's context, so the scale and other state would carry over.
test("a repeatable paint starts from the same state every time", () => {
  const calls: string[] = [];
  let scale = 1;
  let alpha = 1;
  const context = {
    reset() {
      calls.push("reset");
      scale = 1;
      alpha = 1;
    },
    scale(x: number) {
      calls.push(`scale ${x}`);
      scale *= x;
    },
  };
  const paint = repeatable(context as never, 2, (target) => {
    calls.push(`draw at ${scale}, alpha ${alpha}`);
    // A renderer is free to leave state behind; the next paint must not inherit it.
    (target as unknown as { scale(x: number): void }).scale(3);
    alpha = 0.5;
  });

  paint();
  paint();

  expect(calls).toEqual([
    "reset",
    "scale 2",
    "draw at 2, alpha 1",
    "scale 3",
    "reset",
    "scale 2",
    "draw at 2, alpha 1",
    "scale 3",
  ]);
});

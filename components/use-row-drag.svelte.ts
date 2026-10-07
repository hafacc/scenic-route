// Drag-to-reorder for a list's rows.

// Offsets are in rows, with the row height measured since the two lists differ.

interface Drag {
  from: number; // row index at the start
  to: number; // row index if dropped now
  offset: number; // px
  height: number; // px, measured when the drag began
}

export interface RowDrag {
  shiftOf: (index: number) => number;
  isDragging: (index: number) => boolean;
  readonly active: boolean;
  // The handle needs `touch-action: none`, or a finger on it scrolls the sheet instead of dragging.
  start: (
    event: PointerEvent & { currentTarget: EventTarget & HTMLElement },
    index: number,
  ) => void;
}

// `count` is a getter, read inside pointer handlers registered once per drag.
export function useRowDrag(
  count: () => number,
  move: (from: number, to: number) => void,
): RowDrag {
  let drag = $state.raw<Drag | null>(null);

  const start: RowDrag["start"] = (event, from) => {
    const handle = event.currentTarget;
    const row = handle.closest("li");
    const height = row?.getBoundingClientRect().height ?? 0;
    if (height === 0) {
      return;
    }
    handle.setPointerCapture(event.pointerId);
    const originY = event.clientY;
    let landing = from;

    const onMove = (moved: PointerEvent): void => {
      const offset = moved.clientY - originY;
      landing = Math.min(
        count() - 1,
        Math.max(0, from + Math.round(offset / height)),
      );
      drag = { from, to: landing, offset, height };
    };
    const onEnd = (): void => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      drag = null;
      if (landing !== from) {
        move(from, landing);
      }
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  };

  const shiftOf = (index: number): number => {
    if (!drag) {
      return 0;
    } else if (index === drag.from) {
      return drag.offset;
    } else if (drag.to > drag.from && index > drag.from && index <= drag.to) {
      return -drag.height;
    } else if (drag.to < drag.from && index >= drag.to && index < drag.from) {
      return drag.height;
    } else {
      return 0;
    }
  };

  return {
    shiftOf,
    isDragging: (index) => drag?.from === index,
    get active() {
      return drag !== null;
    },
    start,
  };
}

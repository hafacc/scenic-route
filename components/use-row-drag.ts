"use client";

import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";

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
  active: boolean;
  // The handle needs `touch-action: none`, or a finger on it scrolls the sheet instead of dragging.
  start: (event: ReactPointerEvent<HTMLElement>, index: number) => void;
}

export function useRowDrag(
  count: number,
  move: (from: number, to: number) => void,
): RowDrag {
  const [drag, setDrag] = useState<Drag | null>(null);
  // Read inside pointer handlers registered once per drag.
  const rows = useRef(count);
  rows.current = count;

  const start = (
    event: ReactPointerEvent<HTMLElement>,
    from: number,
  ): void => {
    const handle = event.currentTarget;
    const row = handle.closest("li");
    const height = row?.getBoundingClientRect().height ?? 0;
    if (height === 0) {
      return;
    }
    handle.setPointerCapture(event.pointerId);
    const originY = event.clientY;
    let landing = from;

    const onMove = (moved: globalThis.PointerEvent): void => {
      const offset = moved.clientY - originY;
      landing = Math.min(
        rows.current - 1,
        Math.max(0, from + Math.round(offset / height)),
      );
      setDrag({ from, to: landing, offset, height });
    };
    const onEnd = (): void => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      setDrag(null);
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
    active: drag !== null,
    start,
  };
}

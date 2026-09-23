"use client";

import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";

// Portaled above the toolbar's z-1200 stacking context, or a dialog paints under its buttons.

export const SHEET_WRAPPER =
  "fixed inset-0 z-[1300] flex items-end justify-center pb-[var(--sheet-keyboard,0px)] md:items-center";

export const SHEET_SCRIM =
  "absolute inset-0 cursor-default bg-slate-950/40 backdrop-blur-sm";

// `dvh`, since `100vh` overflows when browser chrome shows; iOS `dvh` ignores the keyboard.
export const SHEET_CARD =
  "relative flex w-full flex-col rounded-t-3xl bg-white p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl ring-1 ring-black/5 max-h-[min(90dvh,calc(100dvh-var(--sheet-keyboard,0px)-0.5rem))] dark:bg-slate-800 dark:ring-white/10 md:rounded-3xl md:p-6";

// Reaching the end mustn't hand the gesture to the map behind the scrim.
export const SHEET_SCROLL = "min-h-0 flex-1 overflow-y-auto overscroll-contain";

export function Sheet({
  onClose,
  closeLabel,
  labeledBy,
  width,
  children,
}: {
  // The scrim, Escape and the close button all exit through this; some dialogs save a draft first.
  onClose: () => void;
  closeLabel: string;
  labeledBy?: string;
  width: string; // the md+ max width
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useKeyboardInset();

  return createPortal(
    <div className={SHEET_WRAPPER}>
      <button
        type="button"
        aria-label={closeLabel}
        onClick={onClose}
        className={SHEET_SCRIM}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labeledBy}
        className={`${SHEET_CARD} ${width}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

// iOS Safari shrinks only the visual viewport for the keyboard.
export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) {
      return undefined;
    }
    const root = document.documentElement;
    const update = () => {
      // Pinch zoom also shrinks the visual viewport; counting it would push the sheet off the top.
      const covered =
        viewport.scale > 1.01
          ? 0
          : Math.max(
              0,
              window.innerHeight - viewport.height - viewport.offsetTop,
            );
      root.style.setProperty("--sheet-keyboard", `${Math.round(covered)}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    // iOS scrolls the visual viewport to reveal a focused field, changing only the offset.
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      root.style.removeProperty("--sheet-keyboard");
    };
  }, []);
}

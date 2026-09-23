"use client";

import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";

// What every dialog in here is made of. They differ in everything they hold and in nothing that
// holds it, so the portal, the scrim, the capped card and the key that closes it live here once.

// Portalled to the body at a z-index above the toolbar: the toolbar that opens these sits in a
// stacking context of its own at z-1200, and a dialog left inside the page's layers paints under its
// buttons while its scrim no longer blocks them.

// A bottom sheet on a phone, a centred card from md up. The bottom padding is the keyboard's: see
// `useKeyboardInset` for why the browser cannot be trusted to shorten the viewport itself.
export const SHEET_WRAPPER =
  "fixed inset-0 z-[1300] flex items-end justify-center pb-[var(--sheet-keyboard,0px)] md:items-center";

export const SHEET_SCRIM =
  "absolute inset-0 cursor-default bg-slate-950/40 backdrop-blur-sm";

// Capped against the viewport and laid out as a column, so each sheet can pin its header and its
// buttons and scroll only the middle. `dvh` rather than `vh` because on a phone `100vh` is the
// viewport with the browser chrome RETRACTED, which overflows by exactly the chrome's height
// whenever it is showing — and the `100dvh` term takes the keyboard off as well, since `dvh` on iOS
// does not. The bottom padding clears the home indicator on a device that reports one.
export const SHEET_CARD =
  "relative flex w-full flex-col rounded-t-3xl bg-white p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl ring-1 ring-black/5 max-h-[min(90dvh,calc(100dvh-var(--sheet-keyboard,0px)-0.5rem))] dark:bg-slate-800 dark:ring-white/10 md:rounded-3xl md:p-6";

// The one region of a sheet allowed to scroll. `overscroll-contain` so reaching its end does not
// hand the gesture to the map behind the scrim.
export const SHEET_SCROLL = "min-h-0 flex-1 overflow-y-auto overscroll-contain";

export function Sheet({
  onClose,
  closeLabel,
  labelledBy,
  width,
  children,
}: {
  // Whatever the dialog does on its way out — some of these save a draft first — so the scrim, the
  // Escape key and the dialog's own close button are all the same way out.
  onClose: () => void;
  closeLabel: string; // what the scrim is called to a screen reader
  labelledBy?: string;
  width: string; // the md+ cap, which is the one thing that differs card to card
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
        aria-labelledby={labelledBy}
        className={`${SHEET_CARD} ${width}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

// How much of the window the on-screen keyboard is sitting on, published as `--sheet-keyboard`.
// iOS Safari shortens only the VISUAL viewport when the keyboard comes up — the layout viewport, and
// with it every `dvh`, stays the full height of the screen — so a sheet capped at `90dvh` keeps its
// buttons somewhere under the keys. The visual viewport is the only place that number is readable.
export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) {
      return undefined;
    }
    const root = document.documentElement;
    const update = () => {
      // A pinched-in page shrinks the visual viewport too, and that is not a keyboard: measuring it
      // would shove the sheet off the top of a zoomed page.
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
    // Scrolling the visual viewport is how iOS moves a focused field into view, which changes the
    // offset without changing its height.
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      root.style.removeProperty("--sheet-keyboard");
    };
  }, []);
}

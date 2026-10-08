// What settings-dialog.svelte exports, and the helpers its row components share.
import { tick } from "svelte";
import type { RowDrag } from "./use-row-drag.svelte";

// Named once here so the deep links, the scroll-to and the headings can't disagree.
export const SECTIONS = ["layers", "routing", "offline"] as const;

// Long enough to be seen after a smooth scroll, short enough to read as a flash.
export const HIGHLIGHT_MS = 1600;
export type SettingsSection = (typeof SECTIONS)[number];

export const SECTION_TITLE: Record<SettingsSection, string> = {
  layers: "Map layers",
  routing: "Route preferences",
  offline: "Offline maps",
};

export const LIFTED =
  "bg-white shadow-lg ring-1 ring-black/5 dark:bg-slate-700 dark:ring-white/10";

const ROW_LABEL = "flex min-w-0 flex-1 items-baseline gap-2 text-sm";

// A row's name, grayed while the row is hidden from its menu or panel.
export function rowLabel(off: boolean): string {
  return `${ROW_LABEL} ${off ? "text-slate-400 dark:text-slate-500" : "text-slate-700 dark:text-slate-200"}`;
}

export function draggingRow(index: number, drag: RowDrag): string {
  const lifted = drag.isDragging(index);
  const transition = drag.active && !lifted ? "transform 120ms" : "none";
  return `transform:translateY(${drag.shiftOf(index)}px);transition:${transition};z-index:${lifted ? 1 : 0}`;
}

// Svelte's reorder drops focus from a row it moves; put it back.
export function keepFocus(): void {
  const focused = document.activeElement;
  void tick().then(() => {
    if (
      focused instanceof HTMLElement &&
      focused.isConnected &&
      document.activeElement !== focused
    ) {
      focused.focus({ preventScroll: true });
    }
  });
}

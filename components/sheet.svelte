<script lang="ts">
import type { Snippet } from "svelte";
import { portal } from "./portal";
import {
  SHEET_CARD,
  SHEET_SCRIM,
  SHEET_WRAPPER,
  useKeyboardInset,
} from "./sheet-shell";

interface SheetProps {
  // The scrim, Escape and the close button all exit through this; some dialogs save a draft first.
  onClose: () => void;
  closeLabel: string;
  labeledBy?: string;
  width: string; // the md+ max width
  children: Snippet;
}

const { onClose, closeLabel, labeledBy, width, children }: SheetProps =
  $props();

function closeOnEscape(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    onClose();
  }
}

useKeyboardInset();
</script>

<svelte:window onkeydown={closeOnEscape} />

<div class={SHEET_WRAPPER} {@attach portal}>
  <button
    type="button"
    aria-label={closeLabel}
    onclick={onClose}
    class={SHEET_SCRIM}
  ></button>
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby={labeledBy}
    class={`${SHEET_CARD} ${width}`}
  >
    {@render children()}
  </div>
</div>

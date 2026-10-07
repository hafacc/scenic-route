<script lang="ts">
import { onMount } from "svelte";
import { FiCheck, FiCopy, FiMapPin, FiTrash2, FiX } from "../src/icons/glyphs";
import type { Pin, PinDraft } from "../src/pin";
import { encodePlusCode } from "../src/plus-code";
import Icon from "./icon.svelte";
import Sheet from "./sheet.svelte";

interface PinEditorProps {
  target: Pin | PinDraft;
  mode: "create" | "edit";
  onSave: (text: string) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
  onCancel: () => void;
}

const { target, mode, onSave, onDelete, onCancel }: PinEditorProps = $props();

// The target's note until typed over; a new target starts from its own note again.
let text = $derived(target.text);
let isBusy = $state.raw<boolean>(false);
let copiedCode = $state.raw<boolean>(false);
let textarea = $state.raw<HTMLTextAreaElement | null>(null);

const plusCode = $derived(encodePlusCode(target.lat, target.lng));

const handleCopyCode = async () => {
  try {
    await navigator.clipboard.writeText(plusCode);
    copiedCode = true;
    window.setTimeout(() => {
      copiedCode = false;
    }, 1500);
  } catch {}
};

onMount(() => {
  textarea?.focus();
});

const handleSave = async () => {
  isBusy = true;
  try {
    await onSave(text);
  } finally {
    isBusy = false;
  }
};

const handleDelete = async () => {
  if (!onDelete) {
    return;
  }
  isBusy = true;
  try {
    await onDelete();
  } finally {
    isBusy = false;
  }
};

const eyebrow = $derived(mode === "create" ? "New pin" : "Edit pin");
</script>

<Sheet onClose={onCancel} closeLabel="Close editor" width="md:max-w-lg">
  <div class="flex shrink-0 items-start gap-3">
    <span
      class="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-md"
    >
      <Icon icon={FiMapPin} class="h-5 w-5" />
    </span>
    <div class="min-w-0 flex-1">
      <p
        class="text-[11px] font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400"
      >
        {eyebrow}
      </p>
      <h2
        class="mt-0.5 break-words text-base font-semibold text-slate-900 dark:text-slate-100"
      >
        {target.address}
      </h2>
      <button
        type="button"
        onclick={handleCopyCode}
        title="Copy Plus Code — paste into Google or Apple Maps to find this spot"
        class="mt-2 inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 font-mono text-[11px] font-semibold tracking-wider text-brand-700 ring-1 ring-brand-100 transition hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-400 dark:ring-brand-500/20 dark:hover:bg-brand-500/20"
      >
        <span>{plusCode}</span>
        {#if copiedCode}
          <Icon icon={FiCheck} class="h-3 w-3" aria-label="Copied" />
        {:else}
          <Icon icon={FiCopy} class="h-3 w-3" aria-hidden="true" />
        {/if}
        <span class="sr-only">Copy Plus Code</span>
      </button>
    </div>
    <button
      type="button"
      onclick={onCancel}
      disabled={isBusy}
      class="-m-1 grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
      aria-label="Close"
    >
      <Icon icon={FiX} />
    </button>
  </div>
  <!-- 16px on a phone, or iOS Safari zooms the page on a focused control. -->
  <label
    class="mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
  >
    <span class="sr-only">Note</span>
    <textarea
      bind:this={textarea}
      bind:value={text}
      placeholder="Add a note about this place…"
      rows={5}
      class="min-h-20 w-full resize-none rounded-2xl border border-slate-200 bg-slate-50 p-3.5 text-base leading-relaxed text-slate-800 outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-brand-500 dark:focus:bg-slate-900 dark:focus:ring-brand-500/20 md:text-sm"
    ></textarea>
  </label>
  <div class="mt-4 flex shrink-0 items-center justify-between gap-2">
    <div>
      {#if mode === "edit" && onDelete}
        <button
          type="button"
          onclick={handleDelete}
          disabled={isBusy}
          class="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:text-rose-400 dark:hover:bg-rose-900/30"
        >
          <Icon icon={FiTrash2} />Delete
        </button>
      {/if}
    </div>
    <div class="flex items-center gap-2">
      <button
        type="button"
        onclick={onCancel}
        disabled={isBusy}
        class="rounded-xl px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-700"
      >
        Cancel
      </button>
      <button
        type="button"
        onclick={handleSave}
        disabled={isBusy}
        class="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-br from-brand-500 to-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:from-brand-600 hover:to-brand-700 disabled:opacity-50"
      >
        <Icon icon={FiCheck} />Save
      </button>
    </div>
  </div>
</Sheet>

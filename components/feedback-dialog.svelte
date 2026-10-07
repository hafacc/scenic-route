<script lang="ts">
import { onDestroy, onMount } from "svelte";
import { sendFeedback } from "../src/firebase";
import { FiCheck, FiMessageSquare, FiSend, FiX } from "../src/icons/glyphs";
import Icon from "./icon.svelte";
import Sheet from "./sheet.svelte";

// Whole strings, since a line break inside markup text would reach the DOM.
const KEEP_TAB_OPEN =
  "It waits in this browser, so if yours stores nothing between visits, keep the tab open until you are back online.";

interface FeedbackDialogProps {
  onClose: () => void;
}

// A draft is not a preference, so it stays on this device rather than in the synced settings.
const DRAFT_KEY = "scenic-route:feedback-draft";

// Counted like the security rule: Firestore's string size() is UTF-8 bytes, not UTF-16 units.
const MAX_BYTES = 2000;
const COUNTER_FROM = 1800;

// A coarse UTF-16 cap that spares measuring a pasted document's bytes on every keystroke.
const MAX_CHARS = 2000;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function readDraft(): string {
  try {
    return window.localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(text: string): void {
  try {
    if (text) {
      window.localStorage.setItem(DRAFT_KEY, text);
    } else {
      window.localStorage.removeItem(DRAFT_KEY);
    }
  } catch {}
}

const { onClose }: FeedbackDialogProps = $props();

let text = $state.raw<string>(readDraft());
const used = $derived(byteLength(text));
const counter = $derived(
  `${used.toLocaleString()} / ${MAX_BYTES.toLocaleString()}`,
);
let sent = $state.raw<"online" | "offline" | null>(null);
let error = $state.raw<string | null>(null);
const thanks = $derived(
  sent === "online"
    ? "Sent — thank you."
    : "Saved — it will be sent next time you're online.",
);
let textarea = $state.raw<HTMLTextAreaElement | null>(null);
// A send refused after the dialog has gone has no dialog to report to.
let open = true;

onMount(() => {
  textarea?.focus();
});

onDestroy(() => {
  open = false;
});

const handleChange = (next: string) => {
  text = next;
  writeDraft(next);
};

// Never awaited: offline, the SDK queues the write in IndexedDB until next launch.
const handleSend = () => {
  const note = text.trim();
  if (!note) {
    return;
  }
  sendFeedback(note).catch(() => {
    if (open) {
      sent = null;
      text = note;
      writeDraft(note);
      error = "Couldn't send. Your note is below — try again.";
    }
  });
  error = null;
  text = "";
  writeDraft("");
  sent = navigator.onLine ? "online" : "offline";
};
</script>

<Sheet
  {onClose}
  closeLabel="Close feedback"
  labeledBy="feedback-title"
  width="md:max-w-md"
>
  <div class="flex shrink-0 items-start gap-3">
    <span
      class="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-md"
    >
      <Icon icon={FiMessageSquare} class="h-5 w-5" />
    </span>
    <div class="min-w-0 flex-1">
      <h2
        id="feedback-title"
        class="text-base font-semibold text-slate-900 dark:text-slate-100"
      >
        Feedback
      </h2>
      <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        Goes straight to the maintainer
      </p>
    </div>
    <button
      type="button"
      onclick={onClose}
      class="-m-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
      aria-label="Close"
    >
      <Icon icon={FiX} />
    </button>
  </div>
  {#if sent}
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div
        class="mt-5 flex items-center gap-2.5 text-sm text-slate-700 dark:text-slate-200"
      >
        <span
          class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
        >
          <Icon icon={FiCheck} class="h-4 w-4" />
        </span>{thanks}
      </div>
      <!-- Where IndexedDB is refused, Firestore's queue lasts only as long as the tab. -->
      {#if sent === "offline"}
        <p
          class="mt-2 pl-[2.625rem] text-xs text-slate-500 dark:text-slate-400"
        >
          {KEEP_TAB_OPEN}
        </p>
      {/if}
    </div>
    <div class="mt-5 flex shrink-0 justify-end">
      <button
        type="button"
        onclick={onClose}
        class="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-br from-brand-500 to-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:from-brand-600 hover:to-brand-700"
      >
        Done
      </button>
    </div>
  {:else}
    <!-- The note shrinks before the sheet does, keeping Send above a phone keyboard. -->
    <div
      class="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
    >
      {#if error}
        <div
          class="mt-4 shrink-0 rounded-xl bg-rose-100 px-3 py-2 text-xs text-rose-800 dark:bg-rose-900/40 dark:text-rose-100"
        >
          {error}
        </div>
      {/if}
      <label class="mt-4 flex min-h-0 flex-col">
        <span class="sr-only">Your feedback</span>
        <!-- 16px on a phone: iOS Safari zooms the page on a focused control with smaller text. -->
        <textarea
          bind:this={textarea}
          value={text}
          oninput={(event) => handleChange(event.currentTarget.value)}
          placeholder="What's broken, confusing, or missing?"
          rows={6}
          maxlength={MAX_CHARS}
          class="min-h-20 w-full resize-none rounded-2xl border border-slate-200 bg-slate-50 p-3.5 text-base leading-relaxed text-slate-800 outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-brand-500 dark:focus:bg-slate-900 dark:focus:ring-brand-500/20 md:text-sm"
        ></textarea>
      </label>
      {#if used >= COUNTER_FROM}
        <p
          class="mt-1 shrink-0 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500"
        >
          {counter}
        </p>
      {/if}
    </div>
    <div class="mt-4 flex shrink-0 items-center justify-end gap-2">
      <button
        type="button"
        onclick={onClose}
        class="rounded-xl px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
      >
        Cancel
      </button>
      <button
        type="button"
        onclick={handleSend}
        disabled={!text.trim() || used > MAX_BYTES}
        class="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-br from-brand-500 to-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:from-brand-600 hover:to-brand-700 disabled:opacity-50"
      >
        <Icon icon={FiSend} />Send
      </button>
    </div>
  {/if}
</Sheet>

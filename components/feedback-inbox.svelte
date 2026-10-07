<script lang="ts">
import { onMount } from "svelte";
import type { Feedback } from "../src/feedback";
import { deleteFeedback, watchFeedback } from "../src/firebase";
import { FiInbox, FiTrash2, FiX } from "../src/icons/glyphs";
import Icon from "./icon.svelte";
import Sheet from "./sheet.svelte";
import { SHEET_SCROLL } from "./sheet-shell";

interface FeedbackInboxProps {
  onClose: () => void;
}

function formatSent(when: Date): string {
  return when.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const { onClose }: FeedbackInboxProps = $props();

let notes = $state.raw<Feedback[] | null>(null);
let error = $state.raw<string | null>(null);

onMount(() =>
  watchFeedback(
    (next) => {
      error = null;
      notes = next;
    },
    () => {
      error = "Couldn't load feedback.";
    },
  ),
);
</script>

<Sheet
  {onClose}
  closeLabel="Close feedback inbox"
  labeledBy="feedback-inbox-title"
  width="md:max-w-lg"
>
  <div class="flex shrink-0 items-start gap-3">
    <span
      class="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-md"
    >
      <Icon icon={FiInbox} class="h-5 w-5" />
    </span>
    <div class="min-w-0 flex-1">
      <h2
        id="feedback-inbox-title"
        class="text-base font-semibold text-slate-900 dark:text-slate-100"
      >
        Feedback inbox
      </h2>
      <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        What readers have sent in
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
  {#if error}
    <div
      class="mt-4 shrink-0 rounded-xl bg-rose-100 px-3 py-2 text-xs text-rose-800 dark:bg-rose-900/40 dark:text-rose-100"
    >
      {error}
    </div>
  {/if}
  <div class={`mt-4 ${SHEET_SCROLL}`}>
    {#if notes && notes.length > 0}
      <ul class="flex flex-col gap-2">
        {#each notes as note (note.id)}
          <li
            class="rounded-2xl border border-slate-200 bg-slate-50 p-3.5 dark:border-slate-700 dark:bg-slate-900"
          >
            <p
              class="text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500"
            >
              {formatSent(note.createdAt)}
            </p>
            <p
              class="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800 dark:text-slate-100"
            >
              {note.text}
            </p>
            <div class="mt-2 flex justify-end">
              <button
                type="button"
                onclick={() => void deleteFeedback(note.id)}
                class="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                <Icon icon={FiTrash2} />Delete
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
        {notes === null ? "Loading…" : "Nothing yet."}
      </p>
    {/if}
  </div>
</Sheet>

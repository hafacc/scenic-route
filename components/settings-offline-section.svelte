<script lang="ts">
import { onMount } from "svelte";
import { COVERAGE, formatBytes } from "../src/settings/offline";
import { updateSettings } from "../src/settings/store";
import { totals } from "../src/sw/ledger";
import Section from "./settings-section.svelte";
import { clearOfflineMaps } from "./sw-messages";
import { useSettings } from "./use-settings.svelte";

interface Props {
  wanted: boolean;
}

const RADIO =
  "grid h-4 w-4 shrink-0 place-items-center rounded-full border peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500";
const RADIO_ON = "border-brand-500";
const RADIO_OFF = "border-slate-300 dark:border-slate-600";
const CAPTION =
  "Ground you have looked at is kept, so a walk works with no signal. The routes themselves are always kept.";

const { wanted }: Props = $props();

const settings = useSettings();
const coverage = $derived(settings.current.coverage);
let held = $state.raw<number | null>(null);

function measure(): void {
  void totals()
    .then((stores) => {
      // The overlay store only; the routing graphs have their own cap.
      held = stores.overlay ?? 0;
    })
    .catch(() => {
      held = null;
    });
}

onMount(measure);

// Empty covers both nothing cached and an unreadable ledger; the reader can act on neither.
const kept = $derived(held === null ? "" : formatBytes(held));

function choose(
  event: Event & { currentTarget: EventTarget & HTMLInputElement },
  id: string,
): void {
  updateSettings({ coverage: id });
  // A choice the settings did not take snaps the whole group back.
  const group = event.currentTarget.closest("ul")?.querySelectorAll("input");
  for (const radio of group ?? []) {
    radio.checked = radio.value === coverage;
  }
}

function clear(): void {
  clearOfflineMaps();
  // The worker deletes in the background, so the figure is re-read shortly after.
  window.setTimeout(measure, 600);
}
</script>

<!-- Read from the worker's ledger (src/sw/ledger.ts), since the worker stops between requests. -->
<Section id="offline" {wanted} caption={CAPTION}>
  <ul class="mt-3">
    {#each COVERAGE as option (option.id)}
      <li>
        <label
          class="flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-2 hover:bg-slate-50 dark:hover:bg-slate-700/60"
        >
          <!-- Styled by proxy, since a button would lose the native radio's arrow-key group. -->
          <input
            type="radio"
            name="offline-coverage"
            value={option.id}
            checked={option.id === coverage}
            oninput={(event) => choose(event, option.id)}
            class="peer sr-only"
          >
          <span
            aria-hidden="true"
            class={`${RADIO} ${option.id === coverage ? RADIO_ON : RADIO_OFF}`}
          >
            {#if option.id === coverage}
              <span class="h-2 w-2 rounded-full bg-brand-500"></span>
            {/if}
          </span>
          <span
            class="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200"
          >
            {option.label}
          </span>
          <span class="shrink-0 text-xs text-slate-400 dark:text-slate-500">
            {option.detail}
          </span>
        </label>
      </li>
    {/each}
  </ul>
  <div
    class="mt-2 flex items-center justify-between px-2 text-xs text-slate-500 dark:text-slate-400"
  >
    <span>{kept === "" ? "Nothing kept yet" : `${kept} kept`}</span>
    <button
      type="button"
      onclick={clear}
      class="font-medium text-brand-600 hover:underline dark:text-brand-400"
    >
      Clear stored maps
    </button>
  </div>
</Section>

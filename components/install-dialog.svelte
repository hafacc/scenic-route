<script lang="ts">
import { FiCheck, FiCopy, FiDownload, FiX } from "../src/icons/glyphs";
import { useCopy } from "./copy-status.svelte";
import Icon from "./icon.svelte";
import { inAppBrowser } from "./in-app-browser";
import Sheet from "./sheet.svelte";
import { SHEET_SCROLL } from "./sheet-shell";

interface InstallDialogProps {
  onClose: () => void;
}

// Read off the user agent: an install command is a menu item, not a feature-detectable API.
function steps(app: string | null): string[] {
  const agent = window.navigator.userAgent;
  // An iPad has reported itself as a Macintosh since iPadOS 13; the touch points give it away.
  const isIos =
    /iPhone|iPad|iPod/.test(agent) ||
    (/Macintosh/.test(agent) && window.navigator.maxTouchPoints > 1);
  if (app) {
    // App menus word it differently: Open in Safari, Open in browser, Open in external browser.
    const browser = isIos ? "Safari" : "Chrome";
    return [
      `The browser inside ${app} can't install web apps.`,
      `Tap the ⋯ or ⋮ menu and pick Open in ${browser}, or Open in browser.`,
      `No such option? Copy the link and paste it into ${browser}.`,
      "Install from there.",
    ];
  } else if (isIos) {
    // Since iOS 16.4 other browsers may offer Add to Home Screen, but Firefox doesn't.
    return /FxiOS/.test(agent)
      ? [
          "Firefox for iOS may not offer Add to Home Screen.",
          "Open this page in Safari.",
          "Tap Share, then Add to Home Screen.",
        ]
      : [
          "Tap Share — the box with an arrow out of the top.",
          // An app's SFSafariViewController passes for Safari but its Share sheet can't install.
          "Scroll down the list and pick Add to Home Screen. Not there? Open this page in Safari first.",
          "Tap Add.",
        ];
  } else if (/Firefox/.test(agent)) {
    return /Android/.test(agent)
      ? [
          "Open the ⋮ menu.",
          "Pick Install, or Add to Home screen on older versions.",
        ]
      : [
          "Firefox on the desktop can't install web apps.",
          "Open this page in Chrome, Edge or Safari to install it.",
        ];
  } else if (/Safari/.test(agent) && !/Chrome|Chromium|Android/.test(agent)) {
    return [
      "Open Safari's File menu.",
      "Pick Add to Dock. (Safari 17 and later.)",
    ];
  } else {
    return [
      "Open the browser's menu.",
      "Pick Install app, or Add to Home screen.",
    ];
  }
}

const { onClose }: InstallDialogProps = $props();

const app = inAppBrowser(window.navigator.userAgent);
const copier = useCopy();
const copied = $derived(copier.status);

const subtitle = app
  ? "Open it in your browser first"
  : "This browser installs from its own menu";

const copyLabel = $derived(
  copied === "copied"
    ? "Link copied"
    : copied === "failed"
      ? "Couldn't copy the link"
      : "Copy link",
);
</script>

<Sheet
  {onClose}
  closeLabel="Close install instructions"
  labeledBy="install-title"
  width="md:max-w-sm"
>
  <div class="flex shrink-0 items-start gap-3">
    <span
      class="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-lg"
    >
      <Icon icon={FiDownload} class="h-5 w-5" />
    </span>
    <div class="min-w-0 flex-1">
      <h2 id="install-title" class="text-lg font-semibold tracking-tight">
        Install Scenic Route
      </h2>
      <p class="text-xs text-slate-500 dark:text-slate-400">
        {subtitle}
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
  <ol
    class={`mt-5 space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300 ${SHEET_SCROLL}`}
  >
    {#each steps(app) as step, index (step)}
      <li class="flex gap-3">
        <span
          class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-500 dark:bg-slate-700 dark:text-slate-300"
        >
          {index + 1}
        </span>{step}
      </li>
    {/each}
  </ol>
  {#if app}
    <button
      type="button"
      onclick={() => void copier.copy(() => window.location.href)}
      class="mt-5 inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-brand-50 px-4 py-2 text-sm font-medium text-brand-700 ring-1 ring-brand-100 transition hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-400 dark:ring-brand-500/20 dark:hover:bg-brand-500/20"
    >
      {#if copied === "copied"}
        <Icon icon={FiCheck} aria-hidden="true" />
      {:else}
        <Icon icon={FiCopy} aria-hidden="true" />
      {/if}
      <span aria-live="polite">
        {copyLabel}
      </span>
    </button>
  {/if}
</Sheet>

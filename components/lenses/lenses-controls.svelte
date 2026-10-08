<script lang="ts">
import { untrack } from "svelte";
import { lensIconHref } from "../../src/lenses/favicon";
import {
  type LensId,
  lensesForCity,
  lensForCity,
  type Toggles,
} from "../../src/lenses/lenses";
import { EXPLORER_PAGE } from "../../src/pages";
import { encodeLenses, encodeView, shareUrl } from "../../src/url-state";
import ShellToolbar from "../shell-toolbar.svelte";
import type { ShellDeck } from "../shell-types";
import UrlSync from "../url-sync.svelte";
import LensBar from "./lens-bar.svelte";
import { expand, type LensesState } from "./lenses-state";

interface Props {
  shell: ShellDeck;
  deck: LensesState;
}

const FLOATING_BAR =
  "flex items-center rounded-full bg-white/85 px-2 py-1.5 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10";

const { shell, deck }: Props = $props();

const city = $derived(shell.city);
const lenses = $derived(lensesForCity(city));
const lens = $derived(lensForCity(city, deck.lensId));

const color = $derived(lens.color);
// Both are restored on unmount, so Explorer and the installed app keep the app's green.
$effect(() => {
  const tint = color;
  const icon =
    document.head.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  const themeColor = document.head.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  const iconWas = icon?.getAttribute("href") ?? null;
  const themeWas = themeColor?.getAttribute("content") ?? null;
  icon?.setAttribute("href", lensIconHref(tint));
  themeColor?.setAttribute("content", tint);
  return () => {
    if (iconWas !== null) {
      icon?.setAttribute("href", iconWas);
    }
    if (themeWas !== null) {
      themeColor?.setAttribute("content", themeWas);
    }
  };
});

// Strings, so a relabelled endpoint compares equal; the start is null until one is named.
const startKey = $derived(
  shell.manualStart
    ? `${shell.manualStart.lat},${shell.manualStart.lng}`
    : null,
);
const destKey = $derived(
  shell.dest ? `${shell.dest.lat},${shell.dest.lng}` : null,
);
// Only the endpoints moving replans; the handler reads and writes the plan, so it runs untracked.
$effect(() => {
  const key = destKey === null ? null : { start: startKey, dest: destKey };
  untrack(() => {
    if (deck.onEndpoints(key)) {
      expand(shell);
    }
  });
});

function handleLens(id: LensId): void {
  deck.onLens(id);
  expand(shell);
}
function handleToggles(next: Toggles): void {
  deck.onToggles(next);
  expand(shell);
}

// The clock is in neither: Lenses routes at now, and `encodeLenses` writes no hour.
function encode(): URLSearchParams {
  return encodeLenses({
    start: shell.manualStart,
    dest: shell.dest,
    pin: shell.searchPin,
    lens: lens.id,
    alt: deck.alt,
    toggles: deck.toggles,
    customHour: null,
    customDay: null,
  });
}

function composeShareUrl(): string {
  const params = encode();
  const camera = shell.camera();
  if (camera) {
    // The layers are the lens's, so the link names the lens rather than listing them.
    for (const [key, value] of encodeView(camera, [], city.id)) {
      if (key !== "layers") {
        params.append(key, value);
      }
    }
  }
  return shareUrl(window.location, params);
}
</script>

<ShellToolbar
  {shell}
  otherPage={EXPLORER_PAGE}
  clock={false}
  controls={null}
  {composeShareUrl}
/>
<div
  class={`absolute top-3 left-1/2 z-[1000] hidden max-w-[56vw] -translate-x-1/2 md:flex ${FLOATING_BAR}`}
>
  <LensBar
    {lenses}
    lens={lens.id}
    toggles={deck.toggles}
    available={shell.available}
    onLens={handleLens}
    onToggles={handleToggles}
  />
</div>
<UrlSync
  start={shell.manualStart}
  dest={shell.dest}
  pin={shell.searchPin}
  {encode}
  enabled={shell.hashApplied}
/>

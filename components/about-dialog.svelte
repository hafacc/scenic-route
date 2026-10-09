<script lang="ts">
import { cityInSentence } from "../src/cities";
import { CITY_SOURCES, SHARED_SOURCES } from "../src/credits";
import {
  FiExternalLink,
  FiInfo,
  FiMapPin,
  FiX,
  SiGithub,
} from "../src/icons/glyphs";
import { ABOUT_PAGE } from "../src/pages";
import { REPO_URL } from "../src/site";
import { useCity } from "./city-context";
import Icon from "./icon.svelte";
import Sheet from "./sheet.svelte";
import { SHEET_SCROLL } from "./sheet-shell";

// Whole strings, since a line break inside markup text would reach the DOM.
const WALK_ACROSS = "Scenic Route finds nicer ways to walk across ";
const USE_DIRECTIONS =
  ". Use Directions to plan a path — weighting it toward tree cover, sun or shade, shelter from the rain, landmarks, public art, historic districts, nice commercial streets and ferries, and away from highways, industrial areas and scaffolding — or switch between the map overlays to explore what's around you. Which of those a region offers depends on what its cities publish; the sliders say so when one is missing.";
const MORE = "More about Scenic Route";
const SOURCE = "Source code";
const HOW_TO =
  "To use it, tap the layers button to toggle overlays like tree canopy or building shade, and drag the clock to see how shade shifts through the day. Open Directions to set a start and destination, then open the sliders to bias the route toward what you care about — the summary shows how much of each the route picks up. Drag either endpoint on the map to nudge the route, and drop it to lock the new point in.";

interface AboutDialogProps {
  onClose: () => void;
}

const { onClose }: AboutDialogProps = $props();

const active = useCity();
const dataHeading = $derived(`${active().name} data`);
</script>

<Sheet
  {onClose}
  closeLabel="Close about"
  labeledBy="about-title"
  width="md:max-w-md"
>
  <div class="flex shrink-0 items-start gap-3">
    <span
      class="scenic-logo-pin grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-lg"
    >
      <Icon icon={FiMapPin} class="h-5 w-5" />
    </span>
    <div class="min-w-0 flex-1">
      <h2 id="about-title" class="text-lg font-semibold tracking-tight">
        Scenic Route
      </h2>
      <p class="text-xs text-slate-500 dark:text-slate-400">
        Nicer ways to walk the city
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

  <div class={SHEET_SCROLL}>
    <div
      class="mt-5 space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300"
    >
      <p>
        {WALK_ACROSS}{cityInSentence(active())}{USE_DIRECTIONS}
      </p>
      <p>
        {HOW_TO}
      </p>
    </div>

    <div
      class="mt-6 border-t border-slate-200/60 pt-4 dark:border-slate-700/60"
    >
      <p
        class="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500"
      >
        {dataHeading}
      </p>
      <ul class="mt-2 space-y-2 text-xs">
        {#each [
          ...(CITY_SOURCES[active().id] ?? []),
          ...SHARED_SOURCES,
        ] as { label, detail, license } (label)}
          <li class="flex flex-col">
            <span class="font-medium text-slate-700 dark:text-slate-200">
              {label}
            </span>
            {#if license === undefined}
              <span class="text-slate-500 dark:text-slate-400">{detail}</span>
            {:else}
              <!-- Relative to the page, which sits at the site root. -->
              <a
                href={license}
                target="_blank"
                rel="noreferrer"
                class="text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700 dark:text-slate-400 dark:decoration-slate-600 dark:hover:text-slate-200"
              >
                {detail}
              </a>
            {/if}
          </li>
        {/each}
      </ul>
    </div>

    <div
      class="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-200/60 pt-4 dark:border-slate-700/60"
    >
      <!-- Relative to the page, which sits at the site root. -->
      <a
        href={ABOUT_PAGE.href}
        class="inline-flex items-center gap-1.5 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
      >
        <Icon icon={FiInfo} class="h-3.5 w-3.5" aria-hidden="true" />{MORE}
      </a>
      <a
        href={REPO_URL}
        target="_blank"
        rel="noreferrer"
        class="inline-flex items-center gap-1.5 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
      >
        <!-- biome-ignore format: a line break after the first icon would put a space before the label -->
        <Icon icon={SiGithub} class="h-3.5 w-3.5" aria-hidden="true" />{SOURCE}<Icon
          icon={FiExternalLink}
          class="h-3 w-3"
          aria-hidden="true"
        />
      </a>
    </div>
  </div>
</Sheet>

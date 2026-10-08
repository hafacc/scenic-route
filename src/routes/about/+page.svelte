<script lang="ts">
// Prerendered on purpose: the one page a reader without JavaScript, or a crawler, can read.

import Icon from "../../../components/icon.svelte";
import PageHead from "../../../components/page-head.svelte";
import { CITIES } from "../../cities";
import { CITY_SOURCES, type DataSource, SHARED_SOURCES } from "../../credits";
import { FiExternalLink, FiMapPin, SiGithub } from "../../icons/glyphs";
import type { LensId } from "../../lenses/lenses";
import { EXPLORER_PAGE, LENSES_PAGE } from "../../pages";
import { pageMetadata, REPO_URL } from "../../site";

// Whole strings, since a line break inside markup text would reach the DOM.
const INTRO =
  "Scenic Route finds nicer ways to walk across New York City and the San Francisco Bay Area. Use Directions to plan a path — weighting it toward tree cover, sun or shade, shelter from the rain, landmarks, public art, historic districts, nice commercial streets and ferries, and away from highways, industrial areas and scaffolding — or switch between the map overlays to explore what's around you. Which of those a region offers depends on what its cities publish; the sliders say so when one is missing.";
const HOW_TO =
  "To use it, tap the layers button to toggle overlays like tree canopy or building shade, and drag the clock to see how shade shifts through the day. Open Directions to set a start and destination, then open the sliders to bias the route toward what you care about — the summary shows how much of each the route picks up. Drag either endpoint on the map to nudge the route, and drop it to lock the new point in.";
const LENSES_INTRO =
  "A lens is a set of routing weights and the map layers that explain them. Each one also takes the same three switches: sun or shade, how many hills you will accept, and whether a ferry counts as walking.";
const SOURCE = "Source code";
const DATA_INTRO =
  "Every layer is public data. Several of the licenses ask to be carried rather than cited; those are linked below.";

const meta = pageMetadata({
  path: "about",
  title: "About Scenic Route",
  absoluteTitle: true,
  description:
    "What Scenic Route optimizes for, its four walking lenses, where it works, and the open data behind every layer.",
});

// Not read off LENSES, which would pull the whole lens table into this page's bundle.
const LENS_COPY: Record<LensId, { name: string; color: string }> = {
  naturalist: { name: "Naturalist", color: "#0d9488" },
  rain: { name: "Rain", color: "#0284c7" },
  historic: { name: "Historic", color: "#9c3a11" },
  streetlife: { name: "Street life", color: "#7e1f97" },
};

// Switcher order, as LENSES has it.
const LENS_ORDER: readonly LensId[] = [
  "naturalist",
  "rain",
  "historic",
  "streetlife",
];

// A city with nothing to credit gets no heading.
const CITY_CREDITS = CITIES.flatMap((city) => {
  const sources = CITY_SOURCES[city.id];
  return sources === undefined ? [] : [{ city, sources }];
});
</script>

{#snippet sourceList(
  sources: readonly DataSource[],
)}
  <ul class="mt-3 space-y-2 text-sm">
    {#each sources as { label, detail, license } (label)}
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
            class="text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700 dark:text-slate-400 dark:decoration-slate-600 dark:hover:text-slate-200"
          >
            {detail}
          </a>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<PageHead {meta} />

<main class="mx-auto max-w-2xl px-5 py-10 md:py-16">
  <header class="flex items-start gap-3">
    <span
      class="scenic-logo-pin grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-lg"
    >
      <Icon icon={FiMapPin} class="h-6 w-6" aria-hidden="true" />
    </span>
    <div class="min-w-0">
      <h1 class="text-2xl font-semibold tracking-tight md:text-3xl">
        Scenic Route
      </h1>
      <p class="mt-1 text-slate-500 dark:text-slate-400">
        Nicer ways to walk New York and the Bay Area
      </p>
    </div>
  </header>

  <div
    class="mt-8 space-y-4 leading-relaxed text-slate-600 dark:text-slate-300"
  >
    <p>
      {INTRO}
    </p>
    <p>
      {HOW_TO}
    </p>
  </div>

  <section class="mt-10">
    <h2 class="text-lg font-semibold tracking-tight">The four lenses</h2>
    <p class="mt-2 text-sm text-slate-500 dark:text-slate-400">
      {LENSES_INTRO}
    </p>
    <ul class="mt-4 flex flex-wrap gap-x-5 gap-y-2">
      {#each LENS_ORDER as id (id)}
        <li
          class="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200"
        >
          <span
            aria-hidden="true"
            class="h-2.5 w-2.5 shrink-0 rounded-full"
            style="background-color:{LENS_COPY[id].color}"
          ></span>{LENS_COPY[id].name}
        </li>
      {/each}
    </ul>
  </section>

  <section class="mt-10">
    <h2 class="text-lg font-semibold tracking-tight">Where it works</h2>
    <p class="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
      {CITIES.map((city) => city.name).join(" and ")}.
    </p>
  </section>

  <section class="mt-10">
    <h2 class="text-lg font-semibold tracking-tight">
      Where the data comes from
    </h2>
    <p class="mt-2 text-sm text-slate-500 dark:text-slate-400">
      {DATA_INTRO}
    </p>
    {#each CITY_CREDITS as { city, sources } (city.id)}
      <div class="mt-6">
        <h3
          class="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500"
        >
          {`${city.name} data`}
        </h3>
        {@render sourceList(sources)}
      </div>
    {/each}
    <div class="mt-6">
      <h3
        class="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500"
      >
        Everywhere
      </h3>
      {@render sourceList(SHARED_SOURCES)}
    </div>
  </section>

  <!-- Relative to the page, which sits at the site root. -->
  <nav
    class="mt-10 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-200/60 pt-5 text-sm font-medium dark:border-slate-700/60"
  >
    <a
      href={LENSES_PAGE.href}
      class="text-brand-600 hover:underline dark:text-brand-400"
    >
      Open the map
    </a>
    <a
      href={EXPLORER_PAGE.href}
      class="text-brand-600 hover:underline dark:text-brand-400"
    >
      {EXPLORER_PAGE.label}
    </a>
    <a
      href={REPO_URL}
      target="_blank"
      rel="noreferrer"
      class="inline-flex items-center gap-1.5 text-brand-600 hover:underline dark:text-brand-400"
    >
      <!-- biome-ignore format: a line break after the first icon would put a space before the label -->
      <Icon icon={SiGithub} class="h-3.5 w-3.5" aria-hidden="true" />{SOURCE}<Icon
        icon={FiExternalLink}
        class="h-3 w-3"
        aria-hidden="true"
      />
    </a>
  </nav>
</main>

// Server-rendered on purpose: the one page a reader without JavaScript, or a crawler, can read.

import type { Metadata } from "next";
import { FiExternalLink, FiMapPin } from "react-icons/fi";
import { SiGithub } from "react-icons/si";
import { CITIES } from "../../src/cities";
import {
  CITY_SOURCES,
  type DataSource,
  SHARED_SOURCES,
} from "../../src/credits";
import type { ModeId } from "../../src/modes/modes";
import { EXPLORER_PAGE, MODES_PAGE } from "../../src/pages";
import { pageMetadata, REPO_URL } from "../../src/site";

export const metadata: Metadata = pageMetadata({
  path: "about",
  title: "About Scenic Route",
  absoluteTitle: true,
  description:
    "What Scenic Route optimizes for, its four walking modes, where it works, and the open data behind every layer.",
});

// Not read off MODES: it imports a "use client" module, which a server component sees as a proxy.
const MODE_COPY: Record<ModeId, { name: string; color: string }> = {
  naturalist: { name: "Naturalist", color: "#0d9488" },
  rain: { name: "Rain", color: "#0284c7" },
  historic: { name: "Historic", color: "#4338ca" },
  streetlife: { name: "Street life", color: "#7c3aed" },
};

// Switcher order, as MODES has it.
const MODE_ORDER: readonly ModeId[] = [
  "naturalist",
  "rain",
  "historic",
  "streetlife",
];

function SourceList({ sources }: { sources: readonly DataSource[] }) {
  return (
    <ul className="mt-3 space-y-2 text-sm">
      {sources.map(({ label, detail, license }) => (
        <li key={label} className="flex flex-col">
          <span className="font-medium text-slate-700 dark:text-slate-200">
            {label}
          </span>
          {license === undefined ? (
            <span className="text-slate-500 dark:text-slate-400">{detail}</span>
          ) : (
            // Relative, so it resolves under the base path the deploy injects.
            <a
              href={license}
              className="text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700 dark:text-slate-400 dark:decoration-slate-600 dark:hover:text-slate-200"
            >
              {detail}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-10 md:py-16">
      <header className="flex items-start gap-3">
        <span className="scenic-logo-pin grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-lg">
          <FiMapPin className="h-6 w-6" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            Scenic Route
          </h1>
          <p className="mt-1 text-slate-500 dark:text-slate-400">
            Nicer ways to walk New York and the Bay Area
          </p>
        </div>
      </header>

      <div className="mt-8 space-y-4 leading-relaxed text-slate-600 dark:text-slate-300">
        <p>
          Scenic Route finds nicer ways to walk across New York City and the San
          Francisco Bay Area. Use Directions to plan a path — weighting it
          toward tree cover, sun or shade, shelter from the rain, landmarks,
          public art, historic districts, nice commercial streets and ferries,
          and away from highways, industrial areas and scaffolding — or switch
          between the map overlays to explore what's around you. Which of those
          a region offers depends on what its cities publish; the sliders say so
          when one is missing.
        </p>
        <p>
          To use it, tap the layers button to toggle overlays like tree canopy
          or building shade, and drag the clock to see how shade shifts through
          the day. Open Directions to set a start and destination, then open the
          sliders to bias the route toward what you care about — the summary
          shows how much of each the route picks up. Drag either endpoint on the
          map to nudge the route, and drop it to lock the new point in.
        </p>
      </div>

      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight">The four modes</h2>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          A mode is a set of routing weights and the map layers that explain
          them. Each one also takes the same three switches: sun or shade, how
          many hills you will accept, and whether a ferry counts as walking.
        </p>
        <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
          {MODE_ORDER.map((id) => (
            <li
              key={id}
              className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200"
            >
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: MODE_COPY[id].color }}
              />
              {MODE_COPY[id].name}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight">Where it works</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          {CITIES.map((city) => city.name).join(" and ")}.
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight">
          Where the data comes from
        </h2>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Every layer is public data. Several of the licenses ask to be carried
          rather than cited; those are linked below.
        </p>
        {CITIES.map((city) => {
          const sources = CITY_SOURCES[city.id];
          return sources === undefined ? null : (
            <div key={city.id} className="mt-6">
              <h3 className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                {city.name} data
              </h3>
              <SourceList sources={sources} />
            </div>
          );
        })}
        <div className="mt-6">
          <h3 className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Everywhere
          </h3>
          <SourceList sources={SHARED_SOURCES} />
        </div>
      </section>

      {/* Relative: the deploy's basePath is unknown here, and a root-absolute href leaves the site. */}
      <nav className="mt-10 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-200/60 pt-5 text-sm font-medium dark:border-slate-700/60">
        <a
          href={MODES_PAGE.href}
          className="text-brand-600 hover:underline dark:text-brand-400"
        >
          Open the map
        </a>
        <a
          href={EXPLORER_PAGE.href}
          className="text-brand-600 hover:underline dark:text-brand-400"
        >
          {EXPLORER_PAGE.label}
        </a>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-brand-600 hover:underline dark:text-brand-400"
        >
          <SiGithub className="h-3.5 w-3.5" aria-hidden="true" />
          Source code
          <FiExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      </nav>
    </main>
  );
}

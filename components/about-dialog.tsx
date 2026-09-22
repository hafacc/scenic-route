"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { FiExternalLink, FiInfo, FiMapPin, FiX } from "react-icons/fi";
import { SiGithub } from "react-icons/si";
import { cityInSentence } from "../src/cities";
import { CITY_SOURCES, type DataSource, SHARED_SOURCES } from "../src/credits";
import { ABOUT_PAGE } from "../src/pages";
import { REPO_URL } from "../src/site";
import { useCity } from "./city-context";

interface AboutDialogProps {
  onClose: () => void;
}

function Source({ label, detail, licence }: DataSource) {
  return (
    <li className="flex flex-col">
      <span className="font-medium text-slate-700 dark:text-slate-200">
        {label}
      </span>
      {licence === undefined ? (
        <span className="text-slate-500 dark:text-slate-400">{detail}</span>
      ) : (
        // Relative, so it resolves under whatever base path the deploy injects.
        <a
          href={licence}
          target="_blank"
          rel="noreferrer"
          className="text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700 dark:text-slate-400 dark:decoration-slate-600 dark:hover:text-slate-200"
        >
          {detail}
        </a>
      )}
    </li>
  );
}

export default function AboutDialog({ onClose }: AboutDialogProps) {
  const active = useCity();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Portalled to the body at a z-index above the toolbar: the toolbar that opens these sits in a
  // stacking context of its own at z-1200, and a dialog left inside the page's layers paints under
  // its buttons while its scrim no longer blocks them.
  return createPortal(
    <div className="fixed inset-0 z-[1300] flex items-end justify-center md:items-center">
      <button
        type="button"
        aria-label="Close about"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-slate-950/40 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        className="relative flex max-h-[90dvh] w-full flex-col rounded-t-3xl bg-white p-6 shadow-2xl ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10 md:max-w-md md:rounded-3xl md:p-7"
      >
        {/* Pinned: the title and the way out stay put while the sources scroll under them, which is
            the one scrolling region this sheet is allowed. */}
        <div className="flex shrink-0 items-start gap-3">
          <span className="scenic-logo-pin grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-lg">
            <FiMapPin className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="about-title"
              className="text-lg font-semibold tracking-tight"
            >
              Scenic Route
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Nicer ways to walk the city
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-m-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
            aria-label="Close"
          >
            <FiX />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mt-5 space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
            <p>
              Scenic Route finds nicer ways to walk across{" "}
              {cityInSentence(active)}. Use Directions to plan a path —
              weighting it toward tree cover, sun or shade, shelter from the
              rain, landmarks, public art, historic districts, nice commercial
              streets and ferries, and away from highways, industrial areas and
              scaffolding — or switch between the map overlays to explore what's
              around you. Which of those a region offers depends on what its
              cities publish; the sliders say so when one is missing.
            </p>
            <p>
              To use it, tap the layers button to toggle overlays like tree
              canopy or building shade, and drag the clock to see how shade
              shifts through the day. Open Directions to set a start and
              destination, then open the sliders to bias the route toward what
              you care about — the summary shows how much of each the route
              picks up. Drag either endpoint on the map to nudge the route, and
              drop it to lock the new point in.
            </p>
          </div>

          <div className="mt-6 border-t border-slate-200/60 pt-4 dark:border-slate-700/60">
            <p className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
              {active.name} data
            </p>
            <ul className="mt-2 space-y-2 text-xs">
              {[...(CITY_SOURCES[active.id] ?? []), ...SHARED_SOURCES].map(
                (source) => (
                  <Source key={source.label} {...source} />
                ),
              )}
            </ul>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-200/60 pt-4 dark:border-slate-700/60">
            {/* Relative, like every other in-app href: the deploy sits under a basePath the app is
                never told about. */}
            <a
              href={ABOUT_PAGE.href}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
            >
              <FiInfo className="h-3.5 w-3.5" aria-hidden="true" />
              More about Scenic Route
            </a>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
            >
              <SiGithub className="h-3.5 w-3.5" aria-hidden="true" />
              Source code
              <FiExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

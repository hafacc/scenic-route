import type { Metadata } from "next";
import { ABOUT_PAGE, MODES_PAGE } from "../src/pages";

// The export writes this to out/404.html, which GitHub Pages serves for anything it cannot find and
// the service worker precaches as part of the shell.
export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false },
};

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-lg flex-col items-start gap-4 px-5 py-20">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-slate-600 dark:text-slate-300">
        There is nothing at this address. The map is the place to start.
      </p>
      {/* Relative, so they resolve under whatever base path the deploy injects — which is also why
          they only land right for a miss one level down, the shape a typed-in URL actually takes.
          A root-absolute href would leave the site entirely, which is worse at every depth. */}
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium">
        <a
          href={MODES_PAGE.href}
          className="text-brand-600 hover:underline dark:text-brand-400"
        >
          Open the map
        </a>
        <a
          href={ABOUT_PAGE.href}
          className="text-brand-600 hover:underline dark:text-brand-400"
        >
          About Scenic Route
        </a>
      </div>
    </main>
  );
}

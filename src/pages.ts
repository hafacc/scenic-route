// The documents the export emits, in one place: the build precaches them, the service worker decides
// which one answers a navigation, and each deck's menu links to the other.

export interface AppPage {
  file: string; // what `next build` writes into out/
  path: string; // where a link to it lands, relative to the deploy root
  // How the OTHER page links here. Relative, because the deploy sits under a basePath the app is
  // never told about: a root-absolute href leaves the site altogether.
  href: string;
  label: string; // the menu row's words
}

export const MODES_PAGE: AppPage = {
  file: "index.html",
  path: "",
  href: "./",
  label: "Modes",
};

// A FILE beside the root document rather than a directory index: every artifact path is resolved
// against the document, so a page one directory down would fetch its data from `explorer/`.
export const EXPLORER_PAGE: AppPage = {
  file: "explorer.html",
  path: "explorer",
  href: "explorer",
  label: "Explorer",
};

export const APP_PAGES: readonly AppPage[] = [MODES_PAGE, EXPLORER_PAGE];

// The rest of the export's shell: the not-found document is the app's own, and the manifest is what
// an installed copy starts from.
export const SHELL_EXTRAS: readonly string[] = [
  "404.html",
  "manifest.webmanifest",
];

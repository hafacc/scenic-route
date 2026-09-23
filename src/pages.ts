export interface AppPage {
  file: string; // what `next build` writes into out/
  path: string; // where a link to it lands, relative to the deploy root
  // Relative: the deploy sits under a basePath the app is never told about.
  href: string;
  label: string; // the menu row's words
}

export const MODES_PAGE: AppPage = {
  file: "index.html",
  path: "",
  href: "./",
  label: "Modes",
};

// A file, not a directory index: artifact paths resolve against the document.
export const EXPLORER_PAGE: AppPage = {
  file: "explorer.html",
  path: "explorer",
  href: "explorer",
  label: "Explorer",
};

export const ABOUT_PAGE: AppPage = {
  file: "about.html",
  path: "about",
  href: "about",
  label: "About",
};

export const APP_PAGES: readonly AppPage[] = [
  MODES_PAGE,
  EXPLORER_PAGE,
  ABOUT_PAGE,
];

export const SHELL_EXTRAS: readonly string[] = [
  "404.html",
  "manifest.webmanifest",
];

// Where the deploy lives, spelled out. The app itself never needs this — every in-app href is
// relative, because the basePath is injected at deploy time and the code is never told about it —
// but metadata is the one place a relative URL is not an option: a canonical, an OpenGraph url and a
// sitemap entry all have to be absolute. Hardcoded for the same reason scripts/update-sheds.ts and
// .github/workflows/search-data.yml hardcode it: the deploy target is one known address.

import type { Metadata } from "next";

export const SITE_ORIGIN = "https://hafaio.github.io";
export const SITE_URL = `${SITE_ORIGIN}/scenic-route`; // no trailing slash
export const SITE_NAME = "Scenic Route";
export const REPO_URL = "https://github.com/hafaio/scenic-route";

export const SITE_TITLE =
  "Scenic Route: nicer ways to walk New York and the Bay Area";
export const SITE_DESCRIPTION =
  "Walking directions for New York City and the SF Bay Area that favor more than the fastest route.";

// The export writes `out/<path>.html` and the deploy serves it without a trailing slash, so a page's
// canonical is the bare path — `explorer`, not `explorer/` and not `explorer.html`. The root is the
// one that keeps its slash, because a directory index has nowhere else to sit.
export function pageUrl(path: string): string {
  return path === "" ? `${SITE_URL}/` : `${SITE_URL}/${path}`;
}

// Next does NOT deep-merge `openGraph`, `twitter` or `alternates` across layout and page: a page that
// sets any of them replaces the layout's whole object rather than filling gaps in it. So this builds
// the complete set every time, and every page calls it rather than overriding a field or two.
export function pageMetadata({
  path,
  title,
  description,
  absoluteTitle = false,
}: {
  path: string;
  title: string;
  description: string;
  absoluteTitle?: boolean;
}): Metadata {
  const url = pageUrl(path);
  const fullTitle = absoluteTitle ? title : `${title} · ${SITE_NAME}`;
  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      locale: "en_US",
      url,
      title: fullTitle,
      description,
      images: [
        {
          url: `${SITE_URL}/og.png`,
          width: 1200,
          height: 630,
          alt: SITE_NAME,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      images: [`${SITE_URL}/og.png`],
    },
  };
}

// Emitted once, in the root layout. Kept to facts a crawler can check against the app itself —
// no feature claims, no author — rather than copy that reads as written for the search engine.
export const SITE_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: SITE_NAME,
  url: `${SITE_URL}/`,
  description: SITE_DESCRIPTION,
  applicationCategory: "TravelApplication",
  operatingSystem: "Any",
  browserRequirements: "Requires JavaScript",
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  areaServed: [
    { "@type": "City", name: "New York City" },
    { "@type": "Place", name: "San Francisco Bay Area" },
  ],
  sameAs: [REPO_URL],
  license: `${REPO_URL}/blob/main/LICENSE`,
} as const;

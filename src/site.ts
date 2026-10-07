// Metadata URLs must be absolute, though every in-app href is relative.

export const SITE_URL = "https://scenic.hafa.cc"; // no trailing slash
export const SITE_NAME = "Scenic Route";
export const REPO_URL = "https://github.com/hafacc/scenic-route";

export const SITE_TITLE =
  "Scenic Route: nicer ways to walk New York and the Bay Area";
export const SITE_DESCRIPTION =
  "Walking directions for New York City and the SF Bay Area that favor more than the fastest route.";

// The deploy serves `out/<path>.html` without a trailing slash; only the root keeps one.
export function pageUrl(path: string): string {
  return path === "" ? `${SITE_URL}/` : `${SITE_URL}/${path}`;
}

// What a page's <head> says about it; every page sets the whole set.
export interface PageMeta {
  title: string; // the document's own <title>, which never gains the site name
  description: string;
  alternates: { canonical: string };
  robots?: string; // unset leaves the page indexable
  openGraph: {
    type: "website";
    siteName: string;
    locale: string;
    url: string;
    title: string;
    description: string;
    images: { url: string; width: number; height: number; alt: string }[];
  };
  twitter: {
    card: "summary_large_image";
    title: string;
    description: string;
    images: string[];
  };
}

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
}): PageMeta {
  const url = pageUrl(path);
  const fullTitle = absoluteTitle ? title : `${title} · ${SITE_NAME}`;
  return {
    title,
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

// The root page's, and what the not-found page inherits all but its title from.
export const HOME_META: PageMeta = pageMetadata({
  path: "",
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  absoluteTitle: true,
});

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

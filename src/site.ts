// Metadata URLs must be absolute, though every in-app href is relative to the injected basePath.
import type { Metadata } from "next";

export const SITE_ORIGIN = "https://hafa.cc";
export const SITE_URL = `${SITE_ORIGIN}/scenic-route`; // no trailing slash
export const SITE_NAME = "Scenic Route";
export const REPO_URL = "https://github.com/hafaio/scenic-route";

export const SITE_TITLE =
  "Scenic Route: nicer ways to walk New York and the Bay Area";
export const SITE_DESCRIPTION =
  "Walking directions for New York City and the SF Bay Area that favor more than the fastest route.";

// The deploy serves `out/<path>.html` without a trailing slash; only the root keeps one.
export function pageUrl(path: string): string {
  return path === "" ? `${SITE_URL}/` : `${SITE_URL}/${path}`;
}

// Next doesn't deep-merge `openGraph`, `twitter` or `alternates`, so pages must set the whole set.
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

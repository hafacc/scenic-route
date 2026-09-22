import type { MetadataRoute } from "next";
import { APP_PAGES } from "../src/pages";
import { pageUrl } from "../src/site";

// A static export has no request to serve this from, so it is written once at build time into
// out/sitemap.xml.
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return APP_PAGES.map((page) => ({
    url: pageUrl(page.path),
    changeFrequency: "monthly",
    priority: page.path === "" ? 1 : 0.6,
  }));
}

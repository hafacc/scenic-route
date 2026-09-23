import type { MetadataRoute } from "next";
import { APP_PAGES } from "../src/pages";
import { pageUrl } from "../src/site";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return APP_PAGES.map((page) => ({
    url: pageUrl(page.path),
    changeFrequency: "monthly",
    priority: page.path === "" ? 1 : 0.6,
  }));
}

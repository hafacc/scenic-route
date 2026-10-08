import { APP_PAGES } from "../../pages";
import { pageUrl } from "../../site";

export const prerender = true;

export function GET(): Response {
  const urls = APP_PAGES.map(
    (page) =>
      `<url>\n<loc>${pageUrl(page.path)}</loc>\n<changefreq>monthly</changefreq>\n<priority>${page.path === "" ? 1 : 0.6}</priority>\n</url>\n`,
  );
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("")}</urlset>\n`;
  return new Response(xml, {
    headers: { "content-type": "application/xml" },
  });
}

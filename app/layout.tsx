import type { Metadata, Viewport } from "next";
import ServiceWorker from "../components/service-worker";
import ThemeProvider from "../components/theme-provider";
import {
  pageMetadata,
  SITE_DESCRIPTION,
  SITE_JSON_LD,
  SITE_NAME,
  SITE_ORIGIN,
  SITE_TITLE,
} from "../src/site";
import "./globals.css";

// This is also the root route's metadata: a page that sets `openGraph` or `alternates` replaces the
// layout's whole object rather than merging into it, so app/page.tsx sets neither and this carries
// the root's canonical and card itself.
export const metadata: Metadata = {
  ...pageMetadata({
    path: "",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    absoluteTitle: true,
  }),
  // Relative metadata URLs resolve against this. Every one this app writes is already absolute, but
  // Next warns without it and a future relative one would otherwise resolve against localhost.
  metadataBase: new URL(SITE_ORIGIN),
  applicationName: SITE_NAME,
  // verification: { google: "<token from Search Console>" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f172a",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <body className="h-full bg-slate-50 text-slate-900 dark:bg-slate-900 dark:text-slate-100">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
        <ServiceWorker />
        {/* The app is a client-rendered map: the document a crawler is handed says almost nothing on
            its own, so what the thing IS gets stated here, where it does not depend on JS running. */}
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: a build-time constant, not input
          dangerouslySetInnerHTML={{ __html: JSON.stringify(SITE_JSON_LD) }}
        />
      </body>
    </html>
  );
}

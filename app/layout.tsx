import type { Metadata, Viewport } from "next";
import ServiceWorker from "../components/service-worker";
import ThemeProvider from "../components/theme-provider";
import {
  pageMetadata,
  SITE_DESCRIPTION,
  SITE_JSON_LD,
  SITE_NAME,
  SITE_TITLE,
  SITE_URL,
} from "../src/site";
import "./globals.css";

// Also the root page's metadata: a page setting `openGraph` or `alternates` replaces, not merges.
export const metadata: Metadata = {
  ...pageMetadata({
    path: "",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    absoluteTitle: true,
  }),
  // Next warns without it, and a relative metadata URL would otherwise resolve against localhost.
  metadataBase: new URL(SITE_URL),
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
        {/* The map is client-rendered, so this is what a crawler without JS learns about the app. */}
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: a build-time constant, not input
          dangerouslySetInnerHTML={{ __html: JSON.stringify(SITE_JSON_LD) }}
        />
      </body>
    </html>
  );
}

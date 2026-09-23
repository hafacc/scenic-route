import type { MetadataRoute } from "next";
import { SHARE_PARAMS } from "../src/share-target";

// URLs are relative: they resolve against the manifest, and the deploy injects an unseen basePath.
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Scenic Route",
    // iOS lists the app under this in Location Services, which the location banner must match.
    short_name: "Scenic Route",
    description: "Walking directions that pick shade, trees and water over the shortest line",
    start_url: ".",
    scope: ".",
    // Required for the browser to offer an install at all.
    display: "standalone",
    orientation: "any",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    // Android-only (iOS has no share target); GET because a static export has no server to post to.
    share_target: {
      action: ".",
      method: "GET",
      params: SHARE_PARAMS,
    },
    icons: [
      { src: "./icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "./icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Full-bleed: Android crops to the launcher's shape and puts a white plate behind an "any" icon.
      {
        src: "./icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

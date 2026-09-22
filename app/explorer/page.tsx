import type { Metadata } from "next";
import Explorer from "../../components/explorer/explorer";
import { pageMetadata } from "../../src/site";

export const metadata: Metadata = pageMetadata({
  path: "explorer",
  title: "Explorer: map layers and route sliders",
  description:
    "Toggle tree canopy, hourly building shade, landmarks, public art, historic districts and scaffolding on the map, and weight every routing factor by hand.",
});

export default function ExplorerPage() {
  return (
    <>
      {/* As on the root: the deck is client-rendered, so the served document would otherwise carry
          no heading at all. */}
      <h1 className="sr-only">
        Scenic Route Explorer: map layers and route sliders
      </h1>
      <Explorer />
    </>
  );
}

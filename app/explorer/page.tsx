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
      {/* The deck is client-rendered, so without this the served document has no heading. */}
      <h1 className="sr-only">
        Scenic Route Explorer: map layers and route sliders
      </h1>
      <Explorer />
    </>
  );
}

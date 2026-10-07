<script lang="ts">
import Explorer from "../../../components/explorer/explorer.svelte";
import PageHead from "../../../components/page-head.svelte";
import { pageMetadata } from "../../site";

const meta = pageMetadata({
  path: "explorer",
  title: "Explorer: map layers and route sliders",
  description:
    "Toggle tree canopy, hourly building shade, landmarks, public art, historic districts and scaffolding on the map, and weight every routing factor by hand.",
});
</script>

<PageHead {meta} />

<!-- The deck is client-rendered, so without this the served document has no heading. -->
<h1 class="sr-only">Scenic Route Explorer: map layers and route sliders</h1>
<Explorer />

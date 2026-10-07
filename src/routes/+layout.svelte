<script lang="ts">
import "../app.css";
import type { Snippet } from "svelte";
import ServiceWorker from "../../components/service-worker.svelte";
import { SITE_JSON_LD } from "../site";

const { children }: { children: Snippet } = $props();

// The closing tag is split so it cannot end this block.
const jsonLd = `<script type="application/ld+json">${JSON.stringify(SITE_JSON_LD)}</${"script"}>`;
</script>

{@render children()}
<ServiceWorker />
<!-- The map is client-rendered, so this is what a crawler without JS learns about the app. -->
{@html jsonLd}

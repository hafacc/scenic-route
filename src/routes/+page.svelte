<script lang="ts">
import Modes from "../../components/modes/modes.svelte";
import PageHead from "../../components/page-head.svelte";
import { HOME_META, SITE_TITLE } from "../site";
</script>

<PageHead meta={HOME_META} />

<!-- The deck is client-rendered, so without this the served document has no heading. -->
<h1 class="sr-only">{SITE_TITLE}</h1>
<Modes />

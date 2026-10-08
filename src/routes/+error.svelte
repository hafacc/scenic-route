<script lang="ts">
import { page } from "$app/state";
import NotFound from "../../components/not-found.svelte";
</script>

{#if page.status === 404}
  <NotFound />
{:else}
  <NotFound
    title="Something went wrong"
    message="This page could not be shown. Check your connection and try again, or start from the map."
  />
{/if}

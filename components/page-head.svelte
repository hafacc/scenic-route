<script lang="ts">
import { resolve } from "$app/paths";
import { type PageMeta, SITE_NAME, SITE_URL } from "../src/site";

const { meta }: { meta: PageMeta } = $props();

// The root's own URL loses its trailing slash, every other is untouched.
function bare(url: string): string {
  return url === `${SITE_URL}/` ? SITE_URL : url;
}
</script>

<svelte:head>
  <title>{meta.title}</title>
  <meta name="description" content={meta.description}>
  <meta name="application-name" content={SITE_NAME}>
  <link rel="manifest" href={resolve("/manifest.webmanifest")}>
  {#if meta.robots !== undefined}
    <meta name="robots" content={meta.robots}>
  {/if}
  <link rel="canonical" href={bare(meta.alternates.canonical)}>
  <meta property="og:title" content={meta.openGraph.title}>
  <meta property="og:description" content={meta.openGraph.description}>
  <meta property="og:url" content={bare(meta.openGraph.url)}>
  <meta property="og:site_name" content={meta.openGraph.siteName}>
  <meta property="og:locale" content={meta.openGraph.locale}>
  {#each meta.openGraph.images as image (image.url)}
    <meta property="og:image" content={image.url}>
    <meta property="og:image:width" content={String(image.width)}>
    <meta property="og:image:height" content={String(image.height)}>
    <meta property="og:image:alt" content={image.alt}>
  {/each}
  <meta property="og:type" content={meta.openGraph.type}>
  <meta name="twitter:card" content={meta.twitter.card}>
  <meta name="twitter:title" content={meta.twitter.title}>
  <meta name="twitter:description" content={meta.twitter.description}>
  {#each meta.twitter.images as image (image)}
    <meta name="twitter:image" content={image}>
  {/each}
</svelte:head>

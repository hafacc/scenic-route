<script lang="ts">
import { ABOUT_PAGE, LENSES_PAGE } from "../src/pages";
import { HOME_META, type PageMeta } from "../src/site";
import PageHead from "./page-head.svelte";

interface NotFoundProps {
  title?: string;
  message?: string;
}

// The defaults are out/404.html, which GitHub Pages serves for any miss; the error page words other failures.
const {
  title = "Page not found",
  message = "There is nothing at this address. The map is the place to start.",
}: NotFoundProps = $props();

const meta: PageMeta = $derived({ ...HOME_META, title, robots: "noindex" });
</script>

<PageHead {meta} />

<main class="mx-auto flex max-w-lg flex-col items-start gap-4 px-5 py-20">
  <h1 class="text-2xl font-semibold tracking-tight">{title}</h1>
  <p class="text-slate-600 dark:text-slate-300">{message}</p>
  <!-- Relative, so they're only right for a miss one level down. -->
  <div class="flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium">
    <a
      href={LENSES_PAGE.href}
      class="text-brand-600 hover:underline dark:text-brand-400"
    >
      Open the map
    </a>
    <a
      href={ABOUT_PAGE.href}
      class="text-brand-600 hover:underline dark:text-brand-400"
    >
      About Scenic Route
    </a>
  </div>
</main>

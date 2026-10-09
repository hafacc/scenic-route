<script lang="ts">
import { BsCircleHalf, FiMoon, FiSun } from "../src/icons/glyphs";
import type { IconData } from "../src/icons/types";
import {
  setThemeChoice,
  subscribeThemeChoice,
  type ThemeChoice,
  themeChoice,
} from "../src/theme/choice";
import { fromStore } from "./external-store.svelte";
import Icon from "./icon.svelte";

const META: Record<
  ThemeChoice,
  { label: string; next: ThemeChoice; icon: IconData }
> = {
  light: { label: "Light theme", next: "dark", icon: FiSun },
  dark: { label: "Dark theme", next: "system", icon: FiMoon },
  system: { label: "System theme", next: "light", icon: BsCircleHalf },
};

const { class: className }: { class?: string } = $props();

// `system` until hydrated, as the prerendered page cannot know the stored choice.
const theme = fromStore(subscribeThemeChoice, themeChoice, "system");
const current: ThemeChoice = $derived(theme.current);

// Stepped from the stored choice, which is ahead of `current` until the page has hydrated.
const handleClick = () => {
  setThemeChoice(META[themeChoice()].next);
};

const meta = $derived(META[current]);
</script>

<button
  type="button"
  onclick={handleClick}
  aria-label={`${meta.label}. Click to switch to ${META[meta.next].label.toLowerCase()}.`}
  title={`${meta.label} — click for ${META[meta.next].label.toLowerCase()}`}
  class={className ??
    "grid h-10 w-10 place-items-center rounded-full bg-white/85 text-slate-700 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white dark:bg-slate-800/80 dark:text-slate-100 dark:ring-white/10 dark:hover:bg-slate-800"}
>
  <Icon icon={meta.icon} class="h-4 w-4" aria-hidden="true" />
</button>

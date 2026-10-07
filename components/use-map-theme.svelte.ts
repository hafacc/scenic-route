// The resolved map theme as a reactive `current`.
import { currentTheme, subscribeTheme } from "../src/theme/current";
import type { ThemeName } from "../src/theme/palette";
import { fromStore, type StoreValue } from "./external-store.svelte";

// Reads the same `dark` class on <html> as the stylesheet, so components and tiles agree.
export function useMapTheme(): StoreValue<ThemeName> {
  return fromStore<ThemeName>(subscribeTheme, currentTheme, "light");
}

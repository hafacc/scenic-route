"use client";

import { useSyncExternalStore } from "react";
import { currentTheme, subscribeTheme } from "../src/theme/current";
import type { ThemeName } from "../src/theme/palette";

// Reads the same `dark` class on <html> as the stylesheet, so components and tiles agree.
export function useMapTheme(): ThemeName {
  return useSyncExternalStore(subscribeTheme, currentTheme, () => "light");
}

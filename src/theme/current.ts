"use client";

import type { ThemeName } from "./palette";

// Watches next-themes' `dark` class on <html> rather than a copy that could disagree with CSS.
const listeners = new Set<() => void>();

// The server render has no document, and a runtime can define one without the parts a browser has.
function root(): Element | null {
  try {
    return typeof document === "undefined"
      ? null
      : (document.documentElement ?? null);
  } catch {
    return null;
  }
}

function read(): ThemeName {
  return root()?.classList.contains("dark") ? "dark" : "light";
}

// The provider's inline script sets the class before paint; the first read is in a layer's effect.
let current: ThemeName = "light";

const watched = root();
if (watched !== null && typeof MutationObserver === "function") {
  current = read();
  new MutationObserver(() => {
    const now = read();
    if (now !== current) {
      current = now;
      for (const listener of listeners) {
        listener();
      }
    }
  }).observe(watched, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

export function currentTheme(): ThemeName {
  return current;
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The theme choice: the `class` attribute, a `system` default, and no transitions on a change.

export type ThemeChoice = "light" | "dark" | "system";

const STORAGE_KEY = "theme";
const DEFAULT: ThemeChoice = "system";
const DARK_QUERY = "(prefers-color-scheme: dark)";
const NO_TRANSITIONS =
  "*,*::before,*::after{-webkit-transition:none!important;-moz-transition:none!important;-o-transition:none!important;-ms-transition:none!important;transition:none!important}";

let stored: ThemeChoice = DEFAULT;
const listeners = new Set<() => void>();

function systemTheme(): "light" | "dark" {
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

// Returns the undo, which forces a style flush first so the change itself never animates.
function withoutTransitions(): () => void {
  const style = document.createElement("style");
  style.appendChild(document.createTextNode(NO_TRANSITIONS));
  document.head.appendChild(style);
  return () => {
    window.getComputedStyle(document.body);
    setTimeout(() => {
      document.head.removeChild(style);
    }, 1);
  };
}

// Anything else storage holds reads as the default, so no stray string becomes a class name.
function choiceOf(value: string | null): ThemeChoice {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : DEFAULT;
}

function apply(theme: ThemeChoice): void {
  const resolved = theme === "system" ? systemTheme() : theme;
  const restore = withoutTransitions();
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
  restore();
}

function adopt(theme: ThemeChoice): void {
  if (theme === stored) {
    return;
  }
  stored = theme;
  apply(theme);
  for (const listener of listeners) {
    listener();
  }
}

export function themeChoice(): ThemeChoice {
  return stored;
}

export function setThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Storage can be blocked; the choice still holds for this page.
  }
  adopt(choice);
}

export function subscribeThemeChoice(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The prerender has no window, and it is `system` there.
if (typeof window !== "undefined" && typeof document !== "undefined") {
  try {
    stored = choiceOf(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage can be blocked, which leaves the default.
  }
  apply(stored);
  window.matchMedia(DARK_QUERY).addEventListener("change", () => {
    if (stored === "system") {
      apply(stored);
    }
  });
  // Another tab's choice; a cleared key goes back to the default and is written again.
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) {
      return;
    }
    if (event.newValue) {
      adopt(choiceOf(event.newValue));
    } else {
      setThemeChoice(DEFAULT);
    }
  });
}

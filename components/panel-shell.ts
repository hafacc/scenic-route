// The class names the panel components share.
// Wider than its card on a phone, so only the card takes taps and the map's attribution stays reachable.
export const PANEL_WRAPPER =
  "pointer-events-none fixed bottom-0 left-1/2 z-[1000] w-full max-w-md -translate-x-1/2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:left-auto sm:right-4 sm:translate-x-0 sm:px-0";

// `100vh` overflows under browser chrome; 4rem clears the toolbar; no `overflow` for suggestions.
export const PANEL_CARD =
  "pointer-events-auto flex max-h-[calc(100dvh-env(safe-area-inset-top)-4rem-max(0.75rem,env(safe-area-inset-bottom)))] flex-col rounded-2xl bg-white/85 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10";

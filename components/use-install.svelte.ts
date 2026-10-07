// Whether the app is installed, and the browser's install prompt.
import { onMount } from "svelte";

// Chromium only. The saved event is the only way to prompt later, and is spent once prompted.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

export interface Install {
  readonly installable: boolean;
  install(): Promise<boolean>;
}

function isInstalled(): boolean {
  const nav: Navigator & { standalone?: boolean } = window.navigator;
  // `standalone` is iOS Safari's flag and the only signal a home-screen launch gives there.
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    nav.standalone === true
  );
}

// Read on mount since the server has no window, so the prerendered page assumes a tab.
export function useStandalone(): { readonly current: boolean } {
  let standalone = $state.raw(false);
  onMount(() => {
    standalone = isInstalled();
  });
  return {
    get current() {
      return standalone;
    },
  };
}

// `install` resolves false when there is no flow; the caller should explain the browser menu.
export function useInstall(): Install {
  let offer: BeforeInstallPromptEvent | null = null;
  let installed = $state.raw(false);

  onMount(() => {
    installed = isInstalled();
    const onOffer = (event: Event) => {
      event.preventDefault();
      offer = event as BeforeInstallPromptEvent;
    };
    const onInstalled = () => {
      offer = null;
      installed = true;
    };
    window.addEventListener("beforeinstallprompt", onOffer);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onOffer);
      window.removeEventListener("appinstalled", onInstalled);
    };
  });

  return {
    get installable() {
      return !installed;
    },
    async install() {
      const saved = offer;
      if (!saved) {
        return false;
      } else {
        // Dropped either way: the event is spent, and Chromium fires a fresh one next load.
        offer = null;
        try {
          await saved.prompt();
          return true;
        } catch {
          // Throws if already prompted or the gesture went stale; the instructions show instead.
          return false;
        }
      }
    },
  };
}

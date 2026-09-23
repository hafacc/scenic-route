"use client";

import { useCallback, useEffect, useState } from "react";

// Chromium only. The saved event is the only way to prompt later, and is spent once prompted.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

function isInstalled(): boolean {
  const nav: Navigator & { standalone?: boolean } = window.navigator;
  // `standalone` is iOS Safari's flag and the only signal a home-screen launch gives there.
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    nav.standalone === true
  );
}

// Read in an effect since the server has no window, so the first render assumes a tab.
export function useStandalone(): boolean {
  const [standalone, setStandalone] = useState<boolean>(false);
  useEffect(() => {
    setStandalone(isInstalled());
  }, []);
  return standalone;
}

// `install` resolves false when there is no flow; the caller should explain the browser menu.
export function useInstall(): {
  installable: boolean;
  install: () => Promise<boolean>;
} {
  const [offer, setOffer] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(false);

  useEffect(() => {
    setInstalled(isInstalled());
    const onOffer = (event: Event) => {
      event.preventDefault();
      setOffer(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setOffer(null);
      setInstalled(true);
    };
    window.addEventListener("beforeinstallprompt", onOffer);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onOffer);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!offer) {
      return false;
    } else {
      // Dropped either way: the event is spent, and Chromium fires a fresh one next load.
      setOffer(null);
      try {
        await offer.prompt();
        return true;
      } catch {
        // Throws if already prompted or the gesture went stale; the instructions show instead.
        return false;
      }
    }
  }, [offer]);

  return { installable: !installed, install };
}

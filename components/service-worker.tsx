"use client";

import { useEffect, useState } from "react";
import { FiX } from "react-icons/fi";
import { coverageBytes } from "../src/settings/offline";
import { settings, subscribeSettings } from "../src/settings/store";
import {
  dueForCheck,
  offersReload,
  type ReleaseReply,
  SW_RELEASE,
} from "../src/sw/update";

// Registered relative to pick up basePath; the worker is told its cap, since asking would wake it.

async function tellWorker(message: unknown): Promise<void> {
  const registration = await navigator.serviceWorker?.ready;
  registration?.active?.postMessage(message);
}

export function sendCoverage(coverage: string): void {
  void tellWorker({
    type: "overlay-cap",
    bytes: coverageBytes(coverage),
  }).catch(() => {});
}

export function clearOfflineMaps(): void {
  void tellWorker({ type: "clear-overlays" }).catch(() => {});
}

// A worker from an older deploy never answers, so the ask times out.
const REPLY_MS = 2000;

function askRelease(parked: ServiceWorker): Promise<number | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const giveUp = setTimeout(() => resolve(null), REPLY_MS);
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(giveUp);
      const reply = event.data as ReleaseReply | undefined;
      resolve(typeof reply?.release === "number" ? reply.release : null);
    };
    parked.postMessage({ type: "release" }, [channel.port2]);
  });
}

// The worker skips waiting only in answer to this; each page's controllerchange reloads it.
function takeUpdate(parked: ServiceWorker): void {
  parked.postMessage({ type: "skip-waiting" });
}

export default function ServiceWorker() {
  const [parked, setParked] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      // Fails on insecure origins or with workers disabled; only the install offer is lost.
      navigator.serviceWorker.register("sw.js").catch(() => {});
      // Sent on every load, since a newly activated worker was never told.
      sendCoverage(settings().coverage);
    }
    // Only the page can ask; a refusal is normal and leaves the caches evictable.
    void navigator.storage?.persist?.().catch(() => false);

    return subscribeSettings(() => {
      sendCoverage(settings().coverage);
    });
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return undefined;
    }
    let live = true;
    let registration: ServiceWorkerRegistration | null = null;
    // Taken at load, since `controller` is set either way by the time a controllerchange arrives.
    let controlled = navigator.serviceWorker.controller !== null;
    let reloading = false;
    // Registration just fetched sw.js, so the first re-check waits a full interval.
    let lastCheck = Date.now();

    const offer = async (waiting: ServiceWorker | null): Promise<void> => {
      // Nothing to take over from is a first install, not an update, and needs no reload.
      if (!waiting || !navigator.serviceWorker.controller) {
        return;
      }
      const release = await askRelease(waiting);
      if (live && release !== null && offersReload(release, SW_RELEASE)) {
        setParked(waiting);
      }
    };

    const offerOnceInstalled = (installing: ServiceWorker): void => {
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed") {
          void offer(registration?.waiting ?? null);
        }
      });
    };

    const onUpdateFound = (): void => {
      const installing = registration?.installing;
      if (installing) {
        offerOnceInstalled(installing);
      }
    };

    // Reload once: activation deletes the shell pages lazily import from, and it can fire twice.
    const onControllerChange = (): void => {
      if (!controlled) {
        controlled = true;
      } else if (!reloading) {
        reloading = true;
        window.location.reload();
      }
    };
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange,
    );

    const recheck = (): void => {
      if (document.visibilityState !== "visible" || !registration) {
        return;
      }
      const now = Date.now();
      if (dueForCheck(now, lastCheck)) {
        lastCheck = now;
        void registration.update().catch(() => {});
      }
    };

    navigator.serviceWorker.ready
      .then((ready) => {
        if (!live) {
          return;
        }
        registration = ready;
        ready.addEventListener("updatefound", onUpdateFound);
        // A worker that parked before this page opened fires no updatefound of its own.
        void offer(ready.waiting);
        // This navigation's own check may have started one before there was a listener.
        if (ready.installing) {
          offerOnceInstalled(ready.installing);
        }
      })
      .catch(() => {});
    document.addEventListener("visibilitychange", recheck);

    return () => {
      live = false;
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
      document.removeEventListener("visibilitychange", recheck);
      registration?.removeEventListener("updatefound", onUpdateFound);
    };
  }, []);

  if (!parked) {
    return null;
  }
  return (
    <div className="fixed inset-x-3 top-16 z-[1050] mx-auto flex w-fit items-center gap-3 rounded-2xl bg-slate-900/90 px-4 py-2.5 text-sm font-medium text-white shadow-xl backdrop-blur-md dark:bg-slate-100/95 dark:text-slate-900">
      <span>A new version of Scenic Route is ready.</span>
      <button
        type="button"
        onClick={() => takeUpdate(parked)}
        className="shrink-0 rounded-full bg-white/15 px-3 py-1 hover:bg-white/25 dark:bg-slate-900/10 dark:hover:bg-slate-900/20"
      >
        Reload
      </button>
      <button
        type="button"
        onClick={() => setParked(null)}
        aria-label="Dismiss"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-white/70 hover:bg-white/10 hover:text-white dark:text-slate-500 dark:hover:bg-slate-900/10 dark:hover:text-slate-900"
      >
        <FiX />
      </button>
    </div>
  );
}

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

// Registers ./sw.js, relative to the document so it picks up the basePath the Pages deploy injects.
// Its scope is its own directory, which is the site root, matching the manifest's.
//
// Also the page's half of the two settings the worker owns: it is TOLD its cap rather than asked for
// it, because it is stopped between requests and waking it to answer would put a round trip in front
// of every cache write. See the message handler in src/sw/worker.ts.
//
// And the page's half of the update offer: a worker parked in `waiting` is asked for its marker, and
// a raised one gets a banner offering the reload that lets it take over. See src/sw/update.ts.

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

// How long to wait for a parked worker to name its marker. Waking one is quick when it answers at
// all, and a worker from a deploy older than this message never will, so the ask gives up rather
// than leaving an offer that can no longer arrive pending for the life of the page.
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

// The tap. The worker skips its wait only in answer to this; the reload is left to the
// controllerchange listener every open page carries, since the hand-over reaches all of them.
function takeUpdate(parked: ServiceWorker): void {
  parked.postMessage({ type: "skip-waiting" });
}

export default function ServiceWorker() {
  const [parked, setParked] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      // Fails on an insecure origin and whenever the user has workers switched off; neither is worth
      // reporting, since the only thing lost is the browser's offer to install.
      navigator.serviceWorker.register("sw.js").catch(() => {});
      // Sent on every load, not only on a change: a worker that has just replaced an older one, or
      // that was installed before this setting existed, has never been told.
      sendCoverage(settings().coverage);
    }
    // Asks the browser not to evict this origin under storage pressure. Only the page can ask — the
    // worker's StorageManager has no `persist` — and only once the site looks like something the
    // reader means to keep, which is what installing it or granting a permission signals. A refusal
    // is the normal answer and costs nothing: the caches still work, they are just evictable.
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
    // Whether anything is in charge of this page. Taken at load, because by the time a
    // controllerchange arrives `controller` is set either way: a page that opened before there was
    // any worker is claimed by the first install, and that claim costs it nothing, since the shell
    // it is running out of is the one the deploy just precached.
    let controlled = navigator.serviceWorker.controller !== null;
    let reloading = false;
    // Registration has just run, so the browser holds a fresh copy of sw.js and the first re-check
    // belongs a whole interval away rather than at the first glance back at the app.
    let lastCheck = Date.now();

    const offer = async (waiting: ServiceWorker | null): Promise<void> => {
      // Nothing to take over FROM is a first install, not an update, and it needs no reload at all.
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

    // The reload, once per page rather than once per tap: skipWaiting hands the whole origin over,
    // and the activation behind that hand-over deletes the shell every open page is still lazily
    // importing chunks out of, so a page that did not ask for the update has to go too. The event
    // is known to fire more than once, and the second reload would land on a page already on its
    // way out.
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
        // And one the browser's own check on this navigation started fired it before there was a
        // listener, so it is picked up where it stands rather than waited on for the session.
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

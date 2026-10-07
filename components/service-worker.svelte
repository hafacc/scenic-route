<script lang="ts">
import { onMount } from "svelte";
import { FiX } from "../src/icons/glyphs";
import { settings, subscribeSettings } from "../src/settings/store";
import { registerWorker } from "../src/sw/control";
import { dueForCheck } from "../src/sw/update";
import Icon from "./icon.svelte";
import { sendCoverage } from "./sw-messages";

let parked = $state.raw<ServiceWorker | null>(null);
// The old worker finishes its cache writes before handing over, which can take seconds after a route.
let taking = $state.raw(false);

// A hand-over took 16 s on a slow laptop after a 39 MB cache write; past four times that it is stuck.
const TAKEOVER_WAIT_MS = 60_000;

// The worker skips waiting only in answer to this; each page's controllerchange reloads it.
function takeUpdate(): void {
  const asked = parked;
  if (!asked) {
    return;
  }
  taking = true;
  asked.postMessage({ type: "skip-waiting" });
  // A hand-over that never comes gives the button back; one that comes late still reloads.
  window.setTimeout(() => {
    if (parked === asked) {
      taking = false;
    }
  }, TAKEOVER_WAIT_MS);
}

onMount(() => {
  if ("serviceWorker" in navigator) {
    // Fails on insecure origins or with workers disabled; only the install offer is lost.
    registerWorker().catch(() => {});
    // Sent on every load, since a newly activated worker was never told.
    sendCoverage(settings().coverage);
  }
  // Only the page can ask; a refusal is normal and leaves the caches evictable.
  void navigator.storage?.persist?.().catch(() => false);

  return subscribeSettings(() => {
    sendCoverage(settings().coverage);
  });
});

onMount(() => {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  let live = true;
  let registration: ServiceWorkerRegistration | null = null;
  // Taken at load, since `controller` is set either way by the time a controllerchange arrives.
  let controlled = navigator.serviceWorker.controller !== null;
  let reloading = false;
  // Registration just fetched sw.js, so the first re-check waits a full interval.
  let lastCheck = Date.now();

  const offer = (waiting: ServiceWorker | null): void => {
    // Nothing to take over from is a first install, not an update, and needs no reload.
    if (live && waiting && navigator.serviceWorker.controller) {
      parked = waiting;
      taking = false; // a newer worker replaced the one asked
      // A discarded worker can take nothing over; its successor makes its own offer.
      waiting.addEventListener("statechange", () => {
        if (waiting.state === "redundant" && parked === waiting) {
          parked = null;
          taking = false;
        }
      });
    }
  };

  const offerOnceInstalled = (installing: ServiceWorker): void => {
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed") {
        offer(registration?.waiting ?? null);
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
      offer(ready.waiting);
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
});
</script>

{#if parked}
  <div
    class="fixed inset-x-3 top-16 z-[1050] mx-auto flex w-fit items-center gap-3 rounded-2xl bg-slate-900/90 px-4 py-2.5 text-sm font-medium text-white shadow-xl backdrop-blur-md dark:bg-slate-100/95 dark:text-slate-900"
  >
    <span>A new version of Scenic Route is ready.</span>
    <button
      type="button"
      onclick={takeUpdate}
      disabled={taking}
      aria-busy={taking}
      class="shrink-0 rounded-full bg-white/15 px-3 py-1 enabled:hover:bg-white/25 disabled:opacity-50 dark:bg-slate-900/10 dark:enabled:hover:bg-slate-900/20"
    >
      {taking ? "Reloading…" : "Reload"}
    </button>
    <button
      type="button"
      onclick={() => (parked = null)}
      aria-label="Dismiss"
      class="grid h-6 w-6 shrink-0 place-items-center rounded-full text-white/70 hover:bg-white/10 hover:text-white dark:text-slate-500 dark:hover:bg-slate-900/10 dark:hover:text-slate-900"
    >
      <Icon icon={FiX} />
    </button>
  </div>
{/if}

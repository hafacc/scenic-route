<script lang="ts">
import { onMount } from "svelte";
import { getPinnedTime, subscribeRouteTime } from "../src/route-time/store";
import {
  carriesState,
  type LatLng,
  linkState,
  replaceOwnKeys,
} from "../src/url-state";
import { fromStore } from "./external-store.svelte";

interface Clock {
  hour: number | null;
  day: string | null;
}

interface UrlSyncProps {
  start: LatLng | null;
  dest: LatLng | null;
  pin: LatLng | null;
  encode: (clock: Clock) => URLSearchParams;
  // Held off until the load hash is applied, so the first write can't overwrite the opened link.
  enabled: boolean;
}

// Its own component so the minute tick reruns only this. replaceState, or drags flood history.
const { start, dest, pin, encode, enabled }: UrlSyncProps = $props();

const pinned = fromStore(subscribeRouteTime, getPinnedTime);

// Once true the page is reloading into a new link, and a write would replace that link.
let adopting = false;

// View keys are read once and never kept; the rest is kept current once a place is set or a link brought it.
function write(clock: Clock): void {
  if (!enabled || adopting) {
    return;
  }
  const asked = start !== null || dest !== null || pin !== null;
  // Weights alone are local, so a hash that brought no state is given none.
  const next =
    asked || carriesState(window.location.hash)
      ? encode(clock)
      : new URLSearchParams();
  const hash = replaceOwnKeys(window.location.hash, next);
  if (hash !== window.location.hash) {
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search + hash,
    );
  }
}

// Rewritten when anything `write` reads moves: the places, what `encode` reads, the pinned clock.
$effect(() => {
  write(pinned.current);
});

const SEEN = "scenic-route:seen";

// Marks the history entry as one this page has stood on; true when it had not, as for a pasted link.
function arrive(): boolean {
  const entry: Record<string, unknown> | null = window.history.state;
  if (entry?.[SEEN] === true) {
    return false;
  }
  window.history.replaceState(
    { ...entry, [SEEN]: true },
    "",
    window.location.href,
  );
  return true;
}
onMount(() => {
  arrive();
});

// Fired only by a change the app didn't write, since replaceState fires none; so there is no loop.
function handleHashChange(event: HashChangeEvent): void {
  const fresh = arrive();
  const next = linkState(new URL(event.newURL).hash);
  if (fresh && next !== "" && next !== linkState(new URL(event.oldURL).hash)) {
    // A pasted or typed link opens as a fresh load opens it, through the one path that reads links.
    adopting = true;
    window.location.reload();
  } else {
    // A dialog flag, Back, or keys cut by hand: the state the app holds goes back into the hash.
    write(getPinnedTime());
  }
}
</script>

<svelte:window onhashchange={handleHashChange} />

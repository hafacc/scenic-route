// The deploy marker and the two rules a page applies to it. Kept out of the worker so both can be
// tested without a ServiceWorkerGlobalScope, and so the page can read the marker its own bundle was
// built with — which is what a parked worker's marker is compared against.
//
// A new worker installs and then parks in `waiting` until every page the old one controls has gone,
// because activating under a running page deletes the shell it is still lazily importing chunks out
// of. That is the right default and stays the default. What follows is the way out for the deploy
// that is worth interrupting a session for.

// Bump this by hand, in the same commit as such a deploy. The parked worker reports its copy when
// the page asks; a page whose copy is lower offers a one-tap reload, and nothing happens until the
// reader taps. Left alone — which is what nearly every deploy should do — the new worker lands
// silently on the next launch, exactly as before.
export const SW_RELEASE = 1;

// What comes back over the channel. A worker from a deploy older than this message sends nothing at
// all, so the page has to cope with silence either way.
export interface ReleaseReply {
  release: number;
}

// Strictly greater, so a rollback leaves the reader on the deploy the marker was last raised for.
export function offersReload(parked: number, running: number): boolean {
  return parked > running;
}

// How long between asking the browser to re-check sw.js. An installed app that is resumed rather
// than navigated fires no load, so without this nothing would ever notice a deploy; but each check
// is a network request and switching apps twice a minute is ordinary behaviour, so it cannot be
// short. Five minutes is far under how long a session lasts and far over how fast anyone flicks.
export const UPDATE_CHECK_MS = 5 * 60 * 1000;

export function dueForCheck(now: number, lastCheck: number): boolean {
  return now - lastCheck >= UPDATE_CHECK_MS;
}

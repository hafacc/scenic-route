// A new worker parks in `waiting` until its pages close; this marker is the opt-in way out.

// Bump by hand in the commit of a deploy worth interrupting a session for; the page offers a reload.
export const SW_RELEASE = 1;

// A worker from an older deploy sends nothing, so the page must cope with silence.
export interface ReleaseReply {
  release: number;
}

// Strictly greater, so a rollback isn't offered.
export function offersReload(parked: number, running: number): boolean {
  return parked > running;
}

// A resumed PWA fires no load event, so poll; long enough that app-switching is not a request storm.
export const UPDATE_CHECK_MS = 5 * 60 * 1000;

export function dueForCheck(now: number, lastCheck: number): boolean {
  return now - lastCheck >= UPDATE_CHECK_MS;
}

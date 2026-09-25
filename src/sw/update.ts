// A resumed PWA fires no load event, so poll; long enough that app-switching is not a request storm.
export const UPDATE_CHECK_MS = 5 * 60 * 1000;

export function dueForCheck(now: number, lastCheck: number): boolean {
  return now - lastCheck >= UPDATE_CHECK_MS;
}

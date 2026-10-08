import { coverageBytes } from "../src/settings/offline";

// The worker is told its cap, since asking would wake it.

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

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

// Resolves once the worker holds them, or never where no worker runs (the dev stub answers nothing).
export async function sendWalkHeat(
  city: string,
  version: string,
  points: Float64Array,
): Promise<void> {
  const registration = await navigator.serviceWorker?.ready;
  const worker = registration?.active;
  if (!worker) {
    return new Promise(() => {});
  }
  const channel = new MessageChannel();
  const kept = new Promise<void>((resolve) => {
    channel.port1.onmessage = () => resolve();
  });
  worker.postMessage({ type: "walk-heat", city, version, points }, [
    channel.port2,
  ]);
  return kept;
}

export function forgetWalkHeat(): void {
  void tellWorker({ type: "forget-walks" }).catch(() => {});
}

export function clearOfflineMaps(): void {
  void tellWorker({ type: "clear-overlays" }).catch(() => {});
}

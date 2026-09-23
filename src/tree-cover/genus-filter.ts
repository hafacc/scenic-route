// Every genus is on by default, so the overlay opens on the all-genera view.
import { GENUS_COUNT } from "./genus";

// A stable reference, so re-selecting all hands useSyncExternalStore its starting snapshot.
const ALL_GENERA: ReadonlySet<number> = new Set(
  Array.from({ length: GENUS_COUNT }, (_, id) => id),
);

// Toggles swap in a new Set, so useSyncExternalStore sees a fresh reference exactly on change.
let enabled: ReadonlySet<number> = ALL_GENERA;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getEnabledGenera(): ReadonlySet<number> {
  return enabled;
}

export function toggleGenus(id: number): void {
  const next = new Set(enabled);
  if (!next.delete(id)) {
    next.add(id);
  }
  enabled = next;
  notify();
}

export function setAllGenera(on: boolean): void {
  enabled = on ? ALL_GENERA : new Set();
  notify();
}

export function subscribeGenusFilter(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// How many streets this device remembers, as a reactive `current`.
import { walks } from "../src/walks/history";
import { fromStore, type StoreValue } from "./external-store.svelte";

export function useWalkCount(): StoreValue<number> {
  return fromStore(
    (notify) => walks.subscribe(notify),
    () => walks.count(),
    0,
  );
}

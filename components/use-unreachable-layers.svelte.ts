// The failing overlays as a reactive `current`.
import type { OverlayId } from "../src/overlays/registry";
import {
  subscribeUnreachableLayers,
  unreachableLayers,
} from "../src/overlays/status";
import { fromStore, type StoreValue } from "./external-store.svelte";

const EMPTY: ReadonlySet<OverlayId> = new Set();

export function useUnreachableLayers(): StoreValue<ReadonlySet<OverlayId>> {
  return fromStore(subscribeUnreachableLayers, unreachableLayers, EMPTY);
}

// The stored settings as a reactive `current`.
import {
  DEFAULT_SETTINGS,
  type Settings,
  settings,
  subscribeSettings,
} from "../src/settings/store";
import { fromStore, type StoreValue } from "./external-store.svelte";

export function useSettings(): StoreValue<Settings> {
  return fromStore(subscribeSettings, settings, DEFAULT_SETTINGS);
}

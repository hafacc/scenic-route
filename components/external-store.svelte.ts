// An outside store (subscribe plus get) read as a reactive `current`.
import { tick } from "svelte";
import { createSubscriber } from "svelte/reactivity";

export interface StoreValue<T> {
  readonly current: T;
}

// Hydration must see what the prerender drew, so this turns true only after the first read settles.
let hydrated = $state.raw(false);
let armed = false;

function arm(): void {
  if (!armed) {
    armed = true;
    // `tick` flushes the hydrating page's effects first, so they too see the server value.
    void tick().then(() => {
      hydrated = true;
    });
  }
}

// Without `serverValue` the prerender reads `get()`; values pass through untouched, never proxied.
export function fromStore<T>(
  subscribe: (notify: () => void) => () => void,
  get: () => T,
  ...server: [serverValue?: T]
): StoreValue<T> {
  const track = createSubscriber(subscribe);
  if (server.length === 0) {
    return {
      get current() {
        track();
        return get();
      },
    };
  }
  const serverValue = server[0] as T;
  if (typeof window === "undefined") {
    return { current: serverValue };
  }
  return {
    get current() {
      if (!hydrated) {
        arm();
        return serverValue;
      }
      track();
      return get();
    },
  };
}

// A dialog's open state kept in the URL hash.
import { onMount } from "svelte";
import { formatHash, hashParams } from "../src/url-state";

interface HashFlag {
  readonly open: boolean;
  set(open: boolean): void;
}

interface HashSection {
  readonly section: string | null;
  set(section: string | null): void;
}

// Keeps the entry's own state, which is where SvelteKit's router holds its history index.
function replaceHash(params: URLSearchParams): void {
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname + window.location.search + formatHash(params),
  );
}

// Close strips the key rather than popping, so a visitor who landed on it behaves the same.
export function useHashFlag(name: string): HashFlag {
  let open = $state.raw(false);

  onMount(() => {
    const sync = () => {
      open = hashParams(window.location.hash).has(name);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  });

  return {
    get open() {
      return open;
    },
    set(next) {
      const params = hashParams(window.location.hash);
      if (next === params.has(name)) {
        return;
      }
      if (next) {
        params.set(name, "1");
        window.location.hash = formatHash(params);
      } else {
        params.delete(name);
        // replaceState doesn't fire hashchange, so close by hand.
        replaceHash(params);
        open = false;
      }
    },
  };
}

// `null` is closed; the empty string is open with no section, as a bare `#settings` decodes.
export function useHashSection(name: string): HashSection {
  let section = $state.raw<string | null>(null);

  onMount(() => {
    const sync = () => {
      section = hashParams(window.location.hash).get(name);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  });

  return {
    get section() {
      return section;
    },
    set(next) {
      const params = hashParams(window.location.hash);
      if (next === null) {
        params.delete(name);
        // replaceState doesn't fire hashchange, so close by hand.
        replaceHash(params);
        section = null;
      } else {
        params.set(name, next);
        window.location.hash = formatHash(params);
      }
    },
  };
}

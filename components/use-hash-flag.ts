"use client";

import { useCallback, useEffect, useState } from "react";
import { formatHash, hashParams } from "../src/url-state";

// Close strips the key rather than popping, so a visitor who landed on it behaves the same.
export function useHashFlag(name: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const sync = () => setOpen(hashParams(window.location.hash).has(name));
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [name]);

  const set = useCallback(
    (next: boolean) => {
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
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search + formatHash(params),
        );
        setOpen(false);
      }
    },
    [name],
  );

  return [open, set];
}

// `null` is closed; the empty string is open with no section, as a bare `#settings` decodes.
export function useHashSection(
  name: string,
): [string | null, (section: string | null) => void] {
  const [section, setSection] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setSection(hashParams(window.location.hash).get(name));
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [name]);

  const set = useCallback(
    (next: string | null) => {
      const params = hashParams(window.location.hash);
      if (next === null) {
        params.delete(name);
        // replaceState doesn't fire hashchange, so close by hand.
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search + formatHash(params),
        );
        setSection(null);
      } else {
        params.set(name, next);
        window.location.hash = formatHash(params);
      }
    },
    [name],
  );

  return [section, set];
}

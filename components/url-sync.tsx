"use client";

import { useEffect, useState } from "react";
import { getPinnedTime, subscribeRouteTime } from "../src/route-time/store";
import { type LatLng, replaceOwnKeys } from "../src/url-state";

interface UrlSyncProps {
  start: LatLng | null;
  dest: LatLng | null;
  pin: LatLng | null;
  encode: (clock: {
    hour: number | null;
    day: string | null;
  }) => URLSearchParams;
  // Held off until the load hash is applied, so the first render can't overwrite the opened link.
  enabled: boolean;
}

// Its own component so the minute tick re-renders only this. replaceState, or drags flood history.
export default function UrlSync({
  start,
  dest,
  pin,
  encode,
  enabled,
}: UrlSyncProps) {
  const [, bump] = useState(0);
  useEffect(() => subscribeRouteTime(() => bump((value) => value + 1)), []);

  const { hour, day } = getPinnedTime();
  // No dep list: the write is a string compare against the live hash, cheaper than a dozen deps.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    // Weights alone are local: write once a route or place exists, then keep going to clear it.
    const asked = start !== null || dest !== null || pin !== null;
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    if (
      !asked &&
      !params.has("from") &&
      !params.has("to") &&
      !params.has("pin")
    ) {
      return;
    }
    const next = encode({ hour, day });
    const hash = replaceOwnKeys(window.location.hash, next);
    if (hash !== window.location.hash) {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search + hash,
      );
    }
  });

  return null;
}

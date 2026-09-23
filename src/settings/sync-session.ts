"use client";

import { watchSettings, writeSettings } from "../firebase";
import {
  adoptSettings,
  settings,
  settingsFromDocument,
  subscribeSettings,
} from "./store";
import { mergeSettings, settingsFromRemote } from "./sync";

// Signing in merges both sides per field (./sync.ts) and writes the result to both.

let stop: (() => void) | null = null;

// So the snapshot of our own write doesn't trigger another one.
let mirrored: string | null = null;
let pending: ReturnType<typeof setTimeout> | null = null;

// One slider drag is dozens of changes.
const SETTLE_MS = 800;

function push(uid: string): void {
  const encoded = JSON.stringify(settings());
  if (encoded === mirrored) {
    return;
  }
  mirrored = encoded;
  // Offline or undeployed rules; the settings are already saved locally.
  void writeSettings(uid, JSON.parse(encoded) as object).catch(() => {
    mirrored = null; // so the next change retries
  });
}

function pushSoon(uid: string): void {
  if (pending !== null) {
    clearTimeout(pending);
  }
  pending = setTimeout(() => {
    pending = null;
    push(uid);
  }, SETTLE_MS);
}

export function startSettingsSync(uid: string): void {
  stopSettingsSync();
  const unwatch = watchSettings(
    uid,
    (document) => {
      const remote = settingsFromRemote(document, settingsFromDocument);
      const merged = mergeSettings(settings(), remote);
      adoptSettings(merged);
      pushSoon(uid);
    },
    () => {
      // No rules or permission, so stop rather than failing on every later change.
      stopSettingsSync();
    },
  );
  const unsubscribe = subscribeSettings(() => {
    pushSoon(uid);
  });
  stop = () => {
    unwatch();
    unsubscribe();
  };
}

export function stopSettingsSync(): void {
  stop?.();
  stop = null;
  mirrored = null;
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
  }
}

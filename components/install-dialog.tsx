"use client";

import { useEffect, useState } from "react";
import { FiCheck, FiCopy, FiDownload, FiX } from "react-icons/fi";
import { inAppBrowser } from "./in-app-browser";
import { SHEET_SCROLL, Sheet } from "./sheet-shell";

interface InstallDialogProps {
  onClose: () => void;
}

const CONFIRM_MS = 2200;

// Read off the user agent: an install command is a menu item, not a feature-detectable API.
function steps(app: string | null): string[] {
  const agent = window.navigator.userAgent;
  // An iPad has reported itself as a Macintosh since iPadOS 13; the touch points give it away.
  const isIos =
    /iPhone|iPad|iPod/.test(agent) ||
    (/Macintosh/.test(agent) && window.navigator.maxTouchPoints > 1);
  if (app) {
    // App menus word it differently: Open in Safari, Open in browser, Open in external browser.
    const browser = isIos ? "Safari" : "Chrome";
    return [
      `The browser inside ${app} can't install web apps.`,
      `Tap the ⋯ or ⋮ menu and pick Open in ${browser}, or Open in browser.`,
      `No such option? Copy the link and paste it into ${browser}.`,
      "Install from there.",
    ];
  } else if (isIos) {
    // Since iOS 16.4 other browsers may offer Add to Home Screen, but Firefox doesn't.
    return /FxiOS/.test(agent)
      ? [
          "Firefox for iOS may not offer Add to Home Screen.",
          "Open this page in Safari.",
          "Tap Share, then Add to Home Screen.",
        ]
      : [
          "Tap Share — the box with an arrow out of the top.",
          // An app's SFSafariViewController passes for Safari but its Share sheet can't install.
          "Scroll down the list and pick Add to Home Screen. Not there? Open this page in Safari first.",
          "Tap Add.",
        ];
  } else if (/Firefox/.test(agent)) {
    return /Android/.test(agent)
      ? [
          "Open the ⋮ menu.",
          "Pick Install, or Add to Home screen on older versions.",
        ]
      : [
          "Firefox on the desktop can't install web apps.",
          "Open this page in Chrome, Edge or Safari to install it.",
        ];
  } else if (/Safari/.test(agent) && !/Chrome|Chromium|Android/.test(agent)) {
    return [
      "Open Safari's File menu.",
      "Pick Add to Dock. (Safari 17 and later.)",
    ];
  } else {
    return [
      "Open the browser's menu.",
      "Pick Install app, or Add to Home screen.",
    ];
  }
}

export default function InstallDialog({ onClose }: InstallDialogProps) {
  const app = inAppBrowser(window.navigator.userAgent);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (copied === "idle") {
      return;
    }
    const timer = setTimeout(() => setCopied("idle"), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <Sheet
      onClose={onClose}
      closeLabel="Close install instructions"
      labeledBy="install-title"
      width="md:max-w-sm"
    >
      <div className="flex shrink-0 items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-lg">
          <FiDownload className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            id="install-title"
            className="text-lg font-semibold tracking-tight"
          >
            Install Scenic Route
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {app
              ? "Open it in your browser first"
              : "This browser installs from its own menu"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-m-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
          aria-label="Close"
        >
          <FiX />
        </button>
      </div>
      <ol
        className={`mt-5 space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300 ${SHEET_SCROLL}`}
      >
        {steps(app).map((step, index) => (
          <li key={step} className="flex gap-3">
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-500 dark:bg-slate-700 dark:text-slate-300">
              {index + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>
      {app ? (
        <button
          type="button"
          onClick={() => void copy()}
          className="mt-5 inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-brand-50 px-4 py-2 text-sm font-medium text-brand-700 ring-1 ring-brand-100 transition hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-400 dark:ring-brand-500/20 dark:hover:bg-brand-500/20"
        >
          {copied === "copied" ? (
            <FiCheck aria-hidden="true" />
          ) : (
            <FiCopy aria-hidden="true" />
          )}
          <span aria-live="polite">
            {copied === "copied"
              ? "Link copied"
              : copied === "failed"
                ? "Couldn't copy the link"
                : "Copy link"}
          </span>
        </button>
      ) : null}
    </Sheet>
  );
}

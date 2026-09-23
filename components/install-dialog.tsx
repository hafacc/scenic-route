"use client";

import { FiDownload, FiX } from "react-icons/fi";
import { SHEET_SCROLL, Sheet } from "./sheet-shell";

interface InstallDialogProps {
  onClose: () => void;
}

// Where a browser hides its own install command, for the ones that never offer it to the page.
// Read off the user agent, which is the only thing that distinguishes them — none of this is
// feature-detectable, because the feature is a menu item rather than an API.
function steps(): string[] {
  const agent = window.navigator.userAgent;
  // An iPad has reported itself as a Macintosh since iPadOS 13; the touch points give it away.
  const isIos =
    /iPhone|iPad|iPod/.test(agent) ||
    (/Macintosh/.test(agent) && window.navigator.maxTouchPoints > 1);
  if (isIos) {
    // Since iOS 16.4 a browser other than Safari may carry Add to Home Screen in the share sheet,
    // but each one has to add it and Firefox is the long-standing holdout, so it is sent to Safari
    // rather than told to look for a command that may not be there.
    return /FxiOS/.test(agent)
      ? [
          "Firefox for iOS may not offer Add to Home Screen.",
          "Open this page in Safari.",
          "Tap Share, then Add to Home Screen.",
        ]
      : [
          "Tap Share — the box with an arrow out of the top.",
          "Scroll down the list and pick Add to Home Screen.",
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
  return (
    <Sheet
      onClose={onClose}
      closeLabel="Close install instructions"
      labelledBy="install-title"
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
            This browser installs from its own menu
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
        {steps().map((step, index) => (
          <li key={step} className="flex gap-3">
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-500 dark:bg-slate-700 dark:text-slate-300">
              {index + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>
    </Sheet>
  );
}

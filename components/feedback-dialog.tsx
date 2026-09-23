"use client";

import { useEffect, useRef, useState } from "react";
import { FiCheck, FiMessageSquare, FiSend, FiX } from "react-icons/fi";
import { sendFeedback } from "../src/firebase";
import { Sheet } from "./sheet-shell";

interface FeedbackDialogProps {
  onClose: () => void;
}

// A draft is not a preference, so it stays on this device rather than in the synced settings.
const DRAFT_KEY = "scenic-route:feedback-draft";

// Counted like the security rule: Firestore's string size() is UTF-8 bytes, not UTF-16 units.
const MAX_BYTES = 2000;
const COUNTER_FROM = 1800;

// A coarse UTF-16 cap that spares measuring a pasted document's bytes on every keystroke.
const MAX_CHARS = 2000;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function readDraft(): string {
  try {
    return window.localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(text: string): void {
  try {
    if (text) {
      window.localStorage.setItem(DRAFT_KEY, text);
    } else {
      window.localStorage.removeItem(DRAFT_KEY);
    }
  } catch {}
}

export default function FeedbackDialog({ onClose }: FeedbackDialogProps) {
  const [text, setText] = useState<string>(readDraft);
  const used = byteLength(text);
  const [sent, setSent] = useState<"online" | "offline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const openRef = useRef<boolean>(true);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Set on mount too, or a remount leaves it cleared and a refusal thinks the dialog is gone.
  useEffect(() => {
    openRef.current = true;
    return () => {
      openRef.current = false;
    };
  }, []);

  const handleChange = (next: string) => {
    setText(next);
    writeDraft(next);
  };

  // Never awaited: offline, the SDK queues the write in IndexedDB until next launch.
  const handleSend = () => {
    const note = text.trim();
    if (!note) {
      return;
    }
    sendFeedback(note).catch(() => {
      if (openRef.current) {
        setSent(null);
        setText(note);
        writeDraft(note);
        setError("Couldn't send. Your note is below — try again.");
      }
    });
    setError(null);
    setText("");
    writeDraft("");
    setSent(navigator.onLine ? "online" : "offline");
  };

  return (
    <Sheet
      onClose={onClose}
      closeLabel="Close feedback"
      labeledBy="feedback-title"
      width="md:max-w-md"
    >
      <div className="flex shrink-0 items-start gap-3">
        <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-md">
          <FiMessageSquare className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            id="feedback-title"
            className="text-base font-semibold text-slate-900 dark:text-slate-100"
          >
            Feedback
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Goes straight to the maintainer
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
      {sent ? (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mt-5 flex items-center gap-2.5 text-sm text-slate-700 dark:text-slate-200">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                <FiCheck className="h-4 w-4" />
              </span>
              {sent === "online"
                ? "Sent — thank you."
                : "Saved — it will be sent next time you're online."}
            </div>
            {/* Where IndexedDB is refused, Firestore's queue lasts only as long as the tab. */}
            {sent === "offline" ? (
              <p className="mt-2 pl-[2.625rem] text-xs text-slate-500 dark:text-slate-400">
                It waits in this browser, so if yours stores nothing between
                visits, keep the tab open until you are back online.
              </p>
            ) : null}
          </div>
          <div className="mt-5 flex shrink-0 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-br from-brand-500 to-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:from-brand-600 hover:to-brand-700"
            >
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          {/* The note shrinks before the sheet does, keeping Send above a phone keyboard. */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
            {error ? (
              <div className="mt-4 shrink-0 rounded-xl bg-rose-100 px-3 py-2 text-xs text-rose-800 dark:bg-rose-900/40 dark:text-rose-100">
                {error}
              </div>
            ) : null}
            <label className="mt-4 flex min-h-0 flex-col">
              <span className="sr-only">Your feedback</span>
              {/* 16px on a phone: iOS Safari zooms the page on a focused control with smaller text. */}
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(event) => handleChange(event.target.value)}
                placeholder="What's broken, confusing, or missing?"
                rows={6}
                maxLength={MAX_CHARS}
                className="min-h-20 w-full resize-none rounded-2xl border border-slate-200 bg-slate-50 p-3.5 text-base leading-relaxed text-slate-800 outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-brand-500 dark:focus:bg-slate-900 dark:focus:ring-brand-500/20 md:text-sm"
              />
            </label>
            {used >= COUNTER_FROM ? (
              <p className="mt-1 shrink-0 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500">
                {used.toLocaleString()} / {MAX_BYTES.toLocaleString()}
              </p>
            ) : null}
          </div>
          <div className="mt-4 flex shrink-0 items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSend}
              disabled={!text.trim() || used > MAX_BYTES}
              className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-br from-brand-500 to-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:from-brand-600 hover:to-brand-700 disabled:opacity-50"
            >
              <FiSend />
              Send
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

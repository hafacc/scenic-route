"use client";

import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { BsCircleHalf } from "react-icons/bs";
import { FiMoon, FiSun } from "react-icons/fi";

type ThemeChoice = "light" | "dark" | "system";

const META: Record<
  ThemeChoice,
  { label: string; next: ThemeChoice; Icon: typeof FiSun }
> = {
  light: { label: "Light theme", next: "dark", Icon: FiSun },
  dark: { label: "Dark theme", next: "system", Icon: FiMoon },
  system: { label: "System theme", next: "light", Icon: BsCircleHalf },
};

// next-themes returns whatever string is stored (undefined on the server), so unknowns fall back.
function toChoice(theme: string | undefined): ThemeChoice {
  return theme === "light" || theme === "dark" ? theme : "system";
}

export default function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState<boolean>(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // The stored theme can't render before mount without a hydration mismatch.
  const current: ThemeChoice = mounted ? toChoice(theme) : "system";

  // Stepped by the click, or two clicks in one React batch both step from one theme.
  const stepFrom = useRef<ThemeChoice>(current);
  useEffect(() => {
    stepFrom.current = current;
  }, [current]);

  const handleClick = () => {
    const target = META[stepFrom.current].next;
    stepFrom.current = target;
    setTheme(target);
  };

  const { label, next, Icon } = META[current];

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={`${label}. Click to switch to ${META[next].label.toLowerCase()}.`}
      title={`${label} — click for ${META[next].label.toLowerCase()}`}
      className={
        className ??
        "grid h-10 w-10 place-items-center rounded-full bg-white/85 text-slate-700 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white dark:bg-slate-800/80 dark:text-slate-100 dark:ring-white/10 dark:hover:bg-slate-800"
      }
      suppressHydrationWarning
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

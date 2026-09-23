"use client";

import { type ComponentType, useMemo, useState } from "react";
import { FiCheck, FiMap, FiSearch, FiX } from "react-icons/fi";
import { GiSuspensionBridge, GiTorch } from "react-icons/gi";
import { CITIES, type City } from "../src/cities";
import { SHEET_SCROLL, Sheet } from "./sheet-shell";

// The torch stands in for the Statue of Liberty, which react-icons has no icon for.
const CITY_ICONS: Record<
  string,
  ComponentType<{ className?: string; "aria-hidden"?: boolean }>
> = {
  nyc: GiTorch,
  sf: GiSuspensionBridge,
};

interface CityDialogProps {
  city: City;
  onSelect: (city: City) => void;
  onClose: () => void;
}

const OVERLAY_LABELS: Record<string, string> = {
  canopy: "Tree cover",
  genus: "Species",
  elevation: "Elevation",
  landmarks: "Landmarks",
  art: "Public art",
  ferries: "Ferries",
  highways: "Highways",
  commercial: "Shops",
  shade: "Shade",
  scaffolding: "Scaffolding",
};

// A plain substring, not fuzzy: on a list this short, fuzzy matches mostly surprise.
function matches(city: City, query: string): boolean {
  return city.name.toLowerCase().includes(query.trim().toLowerCase());
}

export default function CityDialog({
  city,
  onSelect,
  onClose,
}: CityDialogProps) {
  const [query, setQuery] = useState("");

  const shown = useMemo(
    () => CITIES.filter((entry) => matches(entry, query)),
    [query],
  );

  const searchable = CITIES.length > 8;

  return (
    <Sheet
      onClose={onClose}
      closeLabel="Close region picker"
      labeledBy="city-title"
      width="md:max-w-md"
    >
      <div className="flex shrink-0 items-start justify-between gap-3">
        <div>
          <h2
            id="city-title"
            className="text-lg font-semibold text-slate-800 dark:text-slate-100"
          >
            Choose a region
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            One region is active at a time — switching swaps the map, the
            overlays and the routing graph.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-m-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
        >
          <FiX />
        </button>
      </div>

      {searchable ? (
        <label className="mt-4 flex shrink-0 items-center gap-2 rounded-xl bg-slate-100 px-3 py-2 text-sm dark:bg-slate-700/60">
          <FiSearch className="shrink-0 text-slate-400" aria-hidden />
          {/* 16px on a phone: iOS Safari zooms the page on a focused control with smaller text. */}
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search regions"
            aria-label="Search regions"
            className="w-full bg-transparent text-base text-slate-700 outline-none placeholder:text-slate-400 dark:text-slate-100 md:text-sm"
          />
        </label>
      ) : null}

      <ul className={`mt-4 flex flex-col gap-1 ${SHEET_SCROLL}`}>
        {shown.map((entry) => {
          const active = entry.id === city.id;
          const Icon = CITY_ICONS[entry.id] ?? FiMap;
          return (
            <li key={entry.id}>
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  onSelect(entry);
                  onClose();
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-slate-100 dark:hover:bg-slate-700 ${
                  active ? "bg-slate-100 dark:bg-slate-700/70" : ""
                }`}
              >
                <Icon className="h-5 w-5 shrink-0 text-brand-600 dark:text-brand-400" />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium text-slate-800 dark:text-slate-100">
                    {entry.name}
                  </span>
                  <span className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                    {entry.overlays
                      .map((id) => OVERLAY_LABELS[id] ?? id)
                      .join(" · ")}
                  </span>
                </span>
                {active ? (
                  <FiCheck className="ml-auto shrink-0 text-brand-600 dark:text-brand-400" />
                ) : null}
              </button>
            </li>
          );
        })}
        {shown.length === 0 ? (
          <li className="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
            No region matches “{query.trim()}”.
          </li>
        ) : null}
      </ul>
    </Sheet>
  );
}

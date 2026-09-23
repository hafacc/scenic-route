"use client";

import { FcGoogle } from "react-icons/fc";
import {
  googleMapsTransitUrl,
  googleMapsWalkingUrl,
} from "../src/routing/google-maps";
import type { WaypointPlan } from "../src/routing/waypoints";
import type { LatLng } from "../src/url-state";

interface GoogleMapsButtonProps {
  // Planned in the routing worker; null until it lands, which disables the button.
  plan: WaypointPlan | null;
  start: LatLng;
  dest: LatLng;
  className?: string;
}

// The click only builds a URL so the tab opens inside the gesture; planning takes ~750 ms.
const FLOATING =
  "grid h-10 w-10 place-items-center rounded-full bg-white/85 text-slate-500 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white disabled:pointer-events-none disabled:opacity-50 dark:bg-slate-800/80 dark:text-slate-400 dark:ring-white/10 dark:hover:bg-slate-800";

export default function GoogleMapsButton({
  plan,
  start,
  dest,
  className,
}: GoogleMapsButtonProps) {
  const open = (): void => {
    if (plan) {
      const url = plan.rides
        ? googleMapsTransitUrl(start, dest)
        : googleMapsWalkingUrl(start, dest, plan.waypoints);
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const label = plan?.rides
    ? "Navigate by transit in Google Maps"
    : "Navigate this route in Google Maps";

  return (
    <button
      type="button"
      onClick={open}
      disabled={plan === null}
      aria-label={label}
      title={label}
      className={className ?? FLOATING}
    >
      <FcGoogle className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}

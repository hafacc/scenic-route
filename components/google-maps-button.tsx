"use client";

import { FcGoogle } from "react-icons/fc";
import { googleMapsWalkingUrl } from "../src/routing/google-maps";
import type { WaypointPlan } from "../src/routing/waypoints";
import type { LatLng } from "../src/url-state";

interface GoogleMapsButtonProps {
  // Planned in the routing worker, where the shade and shed fields the pins are priced against are
  // built; null until it lands, which is what the disabled state stands for.
  plan: WaypointPlan | null;
  start: LatLng; // the requested endpoints rather than the snapped ones — Google re-snaps anyway
  dest: LatLng;
  // The floating-control skin by default, for a button that sits on the map; a panel that holds it
  // in a row of its own icons hands over that row's.
  className?: string;
}

// Hands the route to Google Maps for turn-by-turn navigation, approximated by the nine waypoints its
// URL will take. Google's own multicoloured mark rather than the Maps pin: a pin among this app's own
// pins reads as one more piece of the map, where the brand mark says plainly that the tap leaves.
//
// The click does nothing but build a URL, so the new tab is opened straight out of the gesture and
// the popup blocker stays off it. Planning the pins is far too slow to do here — over New York at the
// app's default weights it takes 20 ms on a 2.6 km walk, 110 ms on a 5 km one and 750 ms on a 15 km
// one — and would price them against fields the page does not build.
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
      window.open(
        googleMapsWalkingUrl(start, dest, plan.waypoints),
        "_blank",
        "noopener,noreferrer",
      );
    }
  };

  return (
    <button
      type="button"
      onClick={open}
      disabled={plan === null}
      aria-label="Navigate this route in Google Maps"
      title="Navigate this route in Google Maps"
      className={className ?? FLOATING}
    >
      <FcGoogle className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}

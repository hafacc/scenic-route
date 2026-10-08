import type { City } from "../cities";
import { rainTau } from "../shade/phenology";
import type { OverlayId } from "./registry";

// Cover is drawn at exactly the weight the router shelters by (src/routing/cost.ts), unscaled, so the map shows what a route was priced on.

// A crown's weight is the share of rain it keeps off, and follows the leaf curve where the city has one.
export function treeCoverOpacity(city: City, date: Date): number {
  return rainTau(date, city);
}

// A deck keeps all the rain off.
export const SHED_OPACITY = 1;

// The layers that are cover overhead; a city offering either has something to shelter under.
const COVER_OVERLAYS: readonly OverlayId[] = ["treecover", "scaffolding"];

export function hasShelter(city: Pick<City, "overlays">): boolean {
  return COVER_OVERLAYS.some((id) => city.overlays.includes(id));
}

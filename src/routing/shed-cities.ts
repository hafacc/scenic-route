// Cities with a shed artifact under public/sheds/<city>/, each placed on its own graph.
export const SHED_CITIES = ["nyc"] as const;
export type ShedCity = (typeof SHED_CITIES)[number];

export function hasSheds(cityId: string): cityId is ShedCity {
  return (SHED_CITIES as readonly string[]).includes(cityId);
}

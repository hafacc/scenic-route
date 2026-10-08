// The active city, handed down through context.
import { createContext } from "svelte";
import { type City, DEFAULT_CITY } from "../src/cities";

const [cityGetter, setCityGetter, hasCity] = createContext<() => City>();

// A getter, so a consumer follows the city as it changes.
export function setCity(city: () => City): void {
  setCityGetter(city);
}

// Registry layers take no props, so they get the active city from here; the default without a provider.
export function useCity(): () => City {
  return hasCity() ? cityGetter() : () => DEFAULT_CITY;
}
